"""Roundtable orchestration: R1 (4 sequential) → 1 or 2 critique rounds
(4 sequential each) → synth.

Originally a 3-round port from AgentRoundtable. Generalized 2026-05-14
to support an optional extra critique round (the "deep dive" round) —
empirical finding from scripts/experiment-multi-round.py was that a
SECOND critique round with a different prompt shape (deep-dive instead
of fresh steel-man) genuinely extracts new content (most notably the
'收回 / 修正' shape: a persona conceding + introducing a new framing).

critique_rounds = 1   → current behavior. R2 alone, then synth.
critique_rounds = 2   → R2 (steel-man + attack) + R3 (deep-dive critique),
                        then synth. Adds 4 LLM calls (~45-60s) per session.

Persistence order matters: write to disk FIRST, then fire callback, then
update the in-memory Session. If anything between disk and memory crashes,
the jsonl is still complete.

Side effects all injected:
  - model_fn   : LLM egress
  - session_path : where jsonl lands
  - on_turn    : optional callback fired after each turn
  - clock      : function returning a float — testable via fixed iterator
"""
from __future__ import annotations

import time
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal, Optional

from .data import AgentTurn, Role, Session
from .io import append_turn, write_meta, read_session
from .model import ModelFn
from .synth import synthesize, build_follow_up_synth_prompt
from . import reviewer as reviewer_mod
from .roles import REVIEWER


_PESSIMIST_FAILURE_RE = re.compile(r"因.+?而崩\*\*\s*\([^)]*\)")


def _quality_issue(role: Role, content: str) -> str | None:
    """Return a human-readable issue when a turn violates a hard role guard.

    Keep this intentionally small: prompts remain the primary constraint;
    this only catches cheap, high-signal failures that are visible without
    semantic judging.
    """
    if role.name == "悲观派":
        matches = _PESSIMIST_FAILURE_RE.findall(content)
        if len(matches) < 2:
            return (
                "悲观派必须显式列出至少 2 个 "
                "'**A 因 X 而崩**(发生概率 + 影响范围)' 失败模式"
            )
    return None


def _call_role_with_quality_retry(
    role: Role,
    *,
    model_name: str,
    user_prompt: str,
    model_fn: ModelFn,
    max_quality_retries: int = 1,
) -> str:
    """Call one persona, retrying once when cheap role-level checks fail."""
    prompt = user_prompt
    last_content = ""
    for attempt in range(max_quality_retries + 1):
        last_content = model_fn(model_name, role.system_prompt, prompt, role.temperature)
        issue = _quality_issue(role, last_content)
        if issue is None:
            return last_content
        if attempt >= max_quality_retries:
            return last_content
        prompt = f"""{user_prompt}

---

你刚才的回答违反了硬约束: {issue}

请重写,只输出合格答案,不要解释违规原因。"""
    return last_content


def build_r1_user_prompt(question: str) -> str:
    return f"""问题:
{question}

---

请用 **≤ 200 字** 给出:

1. 你的**方案**(一句话)
2. 你的**理由**(一句话)

不要 "看情况"、"综合考虑"、"trade-off 视情况" 这类圆滑语言——
你的人设决定了你必须有锋利立场。强制简洁 = 强制立场鲜明。"""


def build_r2_user_prompt(question: str, others: dict[str, str]) -> str:
    """`others` maps role name → that role's R1 content. Speaker's own R1 is
    NOT passed in — keeping that exclusion in the caller is the invariant."""
    other_block = "\n\n".join(f"- **{name}**: {content}" for name, content in others.items())
    return f"""问题:
{question}

R1 其他三人的回答:

{other_block}

(自己的 R1 不重复给你)

---

请做两件事(共 **≤ 300 字**):

1. **Steel-man**:挑你**最赞同**的别人一点,说为什么这一点击中了你的盲区。
2. **Attack**:挑你**最反对**的别人一点,说为什么这一点不成立。

约束:
- 不允许 "都有道理"、"各有优劣"
- 不允许把别人观点改写得比原话弱再攻击
- **评价的是观点内容,不是说话人**。"我的人设和你对立所以反对你" 不算理由,会被判废。"""


def build_r3_critique_prompt(
    question: str,
    r1_all: dict[str, str],
    r2_others: dict[str, str],
    my_r2: str,
) -> str:
    """Deep-dive critique prompt — used when critique_rounds=2.

    Sourced from the experiment script (scripts/experiment-multi-round.py)
    that empirically showed this shape extracts new content (especially the
    'concede + reframe' path), where naively re-running build_r2_user_prompt
    just paraphrased R2. The persona is shown both rounds of context plus
    its OWN R2 (so it can avoid repeating itself), and steered toward one
    of three high-value actions: respond to attacks, deepen a divide,
    or retract.

    'judged void' (会被判废) is the actual instruction that pushed the LLM
    out of paraphrase mode in the experiment — leaving it in.
    """
    r1_block = "\n\n".join(f"- **{n}**: {c}" for n, c in r1_all.items())
    r2_block = "\n\n".join(f"- **{n}**: {c}" for n, c in r2_others.items())
    return f"""问题:
{question}

R1 四人初次回答(含你自己,作 context):

{r1_block}

R2 其他三人对 R1 的评论:

{r2_block}

你自己在 R2 说过(不要重复):

{my_r2}

---

这是**第 3 轮 critique**。**禁止重复**你在 R2 已经说过的论点。

请做以下任一(共 **≤ 300 字**),选最让你 itch 的那个:

(a) **回应别人对你 R1/R2 的攻击或 steel-man** — 反驳 / 承认 / 修正
(b) **挖一个 R2 没人深挖的具体分歧** — 把它说清楚
(c) **收回你 R2 的某个观点** — 看了别人 R2 反思后明确承认错

约束:
- 不允许 "都有道理"、"各有优劣"
- 不允许把别人观点改写得比原话弱再攻击
- **评价的是观点内容,不是说话人**
- **第 3 轮的存在意义就是逼你说新东西**,重复 R2 内容会被判废"""


def _run_follow_up_iteration(
    *,
    session: "Session",
    session_path: Path,
    question: str,
    roles: "list[Role]",
    synthesizer: "Role",
    model_fn: "ModelFn",
    overrides: dict[str, str],
    clock: Callable[[], float],
    round_no: int,
    follow_up_question: str,
    prior_synth: str,
    source: Literal["auto", "user"],
    on_turn: Optional[Callable[["AgentTurn"], None]],
) -> None:
    """跑一轮 follow-up:user_question(若 source=user)→ 4 派 follow_up × N → 新 synth。

    Module-level 版本(Task 6 重构),所有依赖显式传入,无 closure。
    被 _run_auto_drill_loop 和 continue_session 共用。"""

    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:  # noqa: BLE001
                pass
        session.turns.append(turn)

    def _model_for(role: Role) -> str:
        return overrides.get(role.name) or role.preferred_model

    if source == "user":
        _record(AgentTurn(
            round=round_no, role="__user__", type="user_question",
            content=follow_up_question, ts=clock(),
        ))

    def _follow_up_prompt_for(role: Role) -> str:
        return f"""原问题:{question}

上一次 synth(territory map):

{prior_synth}

新追问(来源 {"用户" if source == "user" else "自动追问"}):
{follow_up_question}

---

请用 **≤ 200 字** 针对这次追问回应,延续你的人设立场。
不要重复你在前面 round 已经说过的内容。"""

    with ThreadPoolExecutor(max_workers=max(1, len(roles))) as pool:
        futures = [
            pool.submit(
                _call_role_with_quality_retry,
                role, model_name=_model_for(role),
                user_prompt=_follow_up_prompt_for(role),
                model_fn=model_fn,
            )
            for role in roles
        ]
        for role, fut in zip(roles, futures):
            _record(AgentTurn(
                round=round_no, role=role.name, type="follow_up",
                content=fut.result(), ts=clock(),
            ))

    follow_up_turns = [
        t for t in session.turns if t.round == round_no and t.type == "follow_up"
    ]
    synth_text = model_fn(
        overrides.get(synthesizer.name) or synthesizer.preferred_model,
        synthesizer.system_prompt,
        build_follow_up_synth_prompt(
            original_question=question,
            prior_synth=prior_synth,
            follow_up_question=follow_up_question,
            follow_up_turns=follow_up_turns,
        ),
        synthesizer.temperature,
    )
    _record(AgentTurn(
        round=round_no, role=synthesizer.name, type="synth",
        content=synth_text, ts=clock(),
    ))


def _build_reviewer_prompt(question: str, last_synth: "AgentTurn", session: "Session") -> str:
    """构造审查员 prompt,loop body 和 post-loop final review 共用。"""
    prior_reviews = "\n\n".join(
        f"--- 上次 review (round {t.round}) ---\n{t.content}"
        for t in session.turns if t.type == "review"
    ) or "(无)"
    return f"""原始问题:
{question}

最新 synth:
{last_synth.content}

历史 review:
{prior_reviews}

按你的 system_prompt 输出判断。"""


def _run_auto_drill_loop(
    *,
    session: "Session",
    session_path: Path,
    question: str,
    roles: "list[Role]",
    synthesizer: "Role",
    reviewer: "Role",
    model_fn: "ModelFn",
    overrides: dict[str, str],
    clock: Callable[[], float],
    start_round: int,
    max_auto_drills: int,
    on_turn: Optional[Callable[["AgentTurn"], None]],
) -> None:
    """Auto-drill loop:审查员判断是否收敛,未收敛则跑 follow-up round + 新 synth,
    最多 max_auto_drills 次。loop 结束后若仍未收敛,补一次 final review 供 PWA
    渲染 "已达上限" banner。

    Module-level 版本(Task 6 重构),被 run_session 和 continue_session 共用。
    reviewer 参数显式注入(spec §3.3),让 customize 路径生效;module-level
    REVIEWER 常量仅作为 caller 默认 fallback,不在 loop 内部直接读。"""

    # `_record` 跟 _run_follow_up_iteration 里那个同构 — 都是 3 行
    # append_turn + on_turn callback + session.turns.append。CLAUDE.md §3.3:
    # 2 处重复不开抽象;真到 3 处再考虑抽 _make_recorder 工厂。
    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:  # noqa: BLE001
                pass
        session.turns.append(turn)

    next_round = start_round
    converged = False
    for _ in range(max_auto_drills):
        last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
        assert last_synth is not None, "auto-drill loop 之前必有 initial synth"

        verdict_text = model_fn(
            overrides.get(reviewer.name) or reviewer.preferred_model,
            reviewer.system_prompt,
            _build_reviewer_prompt(question, last_synth, session),
            reviewer.temperature,
        )
        verdict = reviewer_mod.parse_verdict(verdict_text)
        _record(AgentTurn(
            round=last_synth.round, role=reviewer.name, type="review",
            content=verdict_text, ts=clock(),
        ))
        if verdict.converged:
            converged = True
            break
        _run_follow_up_iteration(
            session=session,
            session_path=session_path,
            question=question,
            roles=roles,
            synthesizer=synthesizer,
            model_fn=model_fn,
            overrides=overrides,
            clock=clock,
            round_no=next_round,
            follow_up_question=verdict.next_question,
            prior_synth=last_synth.content,
            source="auto",
            on_turn=on_turn,
        )
        next_round += 1

    # 跑满 drill 上限但未收敛:补一次 final review,供 PWA 读取最后判断结果
    # (last review turn 是 NEEDS_DRILL → 前端可展示 "已达上限" banner + prefill next_q)
    if max_auto_drills > 0 and not converged:
        last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
        assert last_synth is not None, "post-loop final review 之前必有 synth"
        verdict_text = model_fn(
            overrides.get(reviewer.name) or reviewer.preferred_model,
            reviewer.system_prompt,
            _build_reviewer_prompt(question, last_synth, session),
            reviewer.temperature,
        )
        _record(AgentTurn(
            round=last_synth.round, role=reviewer.name, type="review",
            content=verdict_text, ts=clock(),
        ))


def run_session(
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    session_path: Path,
    *,
    role_model_overrides: Optional[dict[str, str]] = None,
    critique_rounds: int = 1,
    max_auto_drills: int = 3,
    reviewer: Optional[Role] = None,
    decider: Optional[Role] = None,        # opt-in,None = 不跑决断员
    mode: str = "roundtable",              # 透传给 decider prompt(决定是否要"胜方判定"段)
    on_turn: Optional[Callable[[AgentTurn], None]] = None,
    clock: Callable[[], float] = time.time,
) -> Session:
    """Run the roundtable end-to-end. Returns the completed Session.

    role_model_overrides: map role.name → model name. Missing roles fall
    back to that role's preferred_model. Empty dict / None = pure defaults.
    Validated by the caller (main.py) against MODEL_ENDPOINTS — trusted here.
    Role frozen dataclass stays untouched; we resolve per-call.

    critique_rounds: 1 (default) or 2.
      1 = R2 (steel-man + attack on R1) → synth. 9 LLM calls total.
      2 = R2 + R3 (deep-dive critique with 'don't repeat' guard) → synth.
          13 LLM calls total, +~45s wall clock.
    Values ≥ 3 caller's responsibility to reject — debate.py doesn't enforce.

    Round numbering on AgentTurn:
      - R1 answer turns:   round=1, type="answer"
      - critique turns:    round=2 (first critique), round=3 (deep-dive)
      - synth turn:        round = critique_rounds + 2
                           (N=1 → round=3, preserving the legacy jsonl shape;
                            N=2 → round=4, distinct from R3 critique turns)
    Synthesizer prompt itself doesn't care about round numbers — it walks
    turns by `t.type`. See synth.build_r3_user_prompt for the transcript
    assembly that's now round-agnostic.

    reviewer: 可选显式传入,缺省 fallback 到 module-level REVIEWER。
    spec §3.3 — 让 runner._customized_role_list 能给 auto-drill loop 注入
    customized reviewer(它的 system_prompt 可能被用户 override 了)。
    """
    if reviewer is None:
        reviewer = REVIEWER
    overrides = role_model_overrides or {}

    def model_for(role: Role) -> str:
        return overrides.get(role.name) or role.preferred_model

    session = Session(question=question, started_at=clock(), critique_rounds=critique_rounds)
    write_meta(session_path, session)

    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:    # noqa: BLE001 — broken callback must not crash session
                pass
        session.turns.append(turn)

    def _run_role_round(
        round_no: int,
        turn_type: str,
        prompt_for: Callable[[Role], str],
    ) -> None:
        """Run one persona round concurrently, then persist in role order."""
        max_workers = max(1, len(roles))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [
                pool.submit(
                    _call_role_with_quality_retry,
                    role,
                    model_name=model_for(role),
                    user_prompt=prompt_for(role),
                    model_fn=model_fn,
                )
                for role in roles
            ]
            for role, fut in zip(roles, futures):
                content = fut.result()
                _record(AgentTurn(
                    round=round_no,
                    role=role.name,
                    type=turn_type,
                    content=content,
                    ts=clock(),
                ))

    # --- Round 1: initial answers (every persona, no context but the question) #
    _run_role_round(
        1,
        "answer",
        lambda role: build_r1_user_prompt(question),
    )

    # --- Round 2: steel-man + attack on R1 others ------------------------- #
    r1_by_role = {t.role: t.content for t in session.turns if t.round == 1}
    def _r2_prompt(role: Role) -> str:
        others = {name: c for name, c in r1_by_role.items() if name != role.name}
        return build_r2_user_prompt(question, others)

    _run_role_round(2, "critique", _r2_prompt)

    # --- Round 3: deep-dive critique (optional) --------------------------- #
    if critique_rounds >= 2:
        r2_by_role = {t.role: t.content for t in session.turns if t.round == 2}
        def _r3_prompt(role: Role) -> str:
            others_r2 = {n: c for n, c in r2_by_role.items() if n != role.name}
            my_r2 = r2_by_role.get(role.name, "")
            return build_r3_critique_prompt(
                question=question,
                r1_all=r1_by_role,
                r2_others=others_r2,
                my_r2=my_r2,
            )

        _run_role_round(3, "critique", _r3_prompt)

    # --- Synth: 整理员 consolidates all critique rounds --------------------- #
    synth_round = critique_rounds + 2
    synth_text = synthesize(
        question, session.turns, synthesizer, model_fn,
        model_override=overrides.get(synthesizer.name),
    )
    _record(AgentTurn(round=synth_round, role=synthesizer.name, type="synth", content=synth_text, ts=clock()))

    # --- Auto-Drill Loop --------------------------------------------------- #
    # 结构:每次 iteration = review + 若 NEEDS_DRILL 则 drill。
    # max_auto_drills 限制 drill 次数。跑满 drills 后再做最后一次 review。
    # max_auto_drills=0 → 整个 loop 跳过(不做 review,不做 drill)。
    #
    # review 轮次 = drill 轮次 + 1,例:max=2, 全 NEEDS_DRILL:
    #   iter1: review1 → drill1
    #   iter2: review2 → drill2
    #   after-loop: review3   → 共 3 reviews, 2 drills
    _run_auto_drill_loop(
        session=session,
        session_path=session_path,
        question=question,
        roles=roles,
        synthesizer=synthesizer,
        reviewer=reviewer,
        model_fn=model_fn,
        overrides=overrides,
        clock=clock,
        start_round=synth_round + 1,
        max_auto_drills=max_auto_drills,
        on_turn=on_turn,
    )

    # --- Decider(opt-in)----------------------------------------------------
    # 在所有 synth / drill 完成后跑一次决断员,基于最终 synth 给出推荐。
    # 失败不影响 session(synth 已落) — verdict 段落 inline error 给用户。
    if decider is not None:
        from .decider import decide
        try:
            # 用 LAST synth turn 作为 synth_text(auto-drill 完后最新的)
            synth_turns = [t for t in session.turns if t.type == "synth"]
            last_synth = synth_turns[-1].content if synth_turns else ""
            verdict_text = decide(
                question=question, mode=mode,
                turns=session.turns, synth_text=last_synth,
                decider=decider, model_fn=model_fn,
                model_override=overrides.get(decider.name),
            )
        except Exception as e:    # noqa: BLE001 — verdict 失败不能拖死 session
            # 后端日志记录 traceback,journalctl -t cc-workflow 才能排查
            # (verdict 段 inline 给用户看的是文字摘要,不含 traceback)。
            import logging
            logging.getLogger(__name__).exception("decider failed on run_session")
            verdict_text = (
                f"## 推荐方案\n(决断员调用失败,无法生成推荐)\n\n"
                f"## 理由\n- 失败原因: {type(e).__name__}: {e}\n"
                f"- 重试方式:在 #settings/roles 把决断员 model 改成其它(eg. moonshot)再次新建会话\n"
            )
        # verdict 落最后:max(turn.round) + 1,这样 auto-drill / 续问的额外
        # round 也跑到 verdict 之前(决断员看完所有内容才出)。
        max_round = max((t.round for t in session.turns), default=synth_round)
        _record(AgentTurn(
            round=max_round + 1,
            role=decider.name, type="verdict", content=verdict_text, ts=clock(),
        ))

    return session


def continue_session(
    session_path: Path,
    follow_up_question: str,
    *,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    role_model_overrides: Optional[dict[str, str]] = None,
    max_auto_drills: int = 3,
    reviewer: Optional[Role] = None,
    decider: Optional[Role] = None,        # opt-in,跟 run_session 同款语义
    on_turn: Optional[Callable[[AgentTurn], None]] = None,
    clock: Callable[[], float] = time.time,
) -> Session:
    """用户续问:load 现有 session → 跑 user follow-up round + 新 synth +
    auto-drill loop(可能再 drill 0-N 次)。

    返回更新后的 Session(包括新 follow_up / synth / review turns)。

    reviewer: 可选显式传入,缺省 fallback 到 module-level REVIEWER —
    跟 run_session 同语义(spec §3.3)。
    """
    if reviewer is None:
        reviewer = REVIEWER
    session = read_session(session_path)
    question = session.question
    overrides = role_model_overrides or {}

    next_round = max((t.round for t in session.turns), default=0) + 1
    last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
    if last_synth is None:
        raise ValueError("session 没有 synth turn,不能续问")

    _run_follow_up_iteration(
        session=session,
        session_path=session_path,
        question=question,
        roles=roles,
        synthesizer=synthesizer,
        model_fn=model_fn,
        overrides=overrides,
        clock=clock,
        round_no=next_round,
        follow_up_question=follow_up_question,
        prior_synth=last_synth.content,
        source="user",
        on_turn=on_turn,
    )

    _run_auto_drill_loop(
        session=session,
        session_path=session_path,
        question=question,
        roles=roles,
        synthesizer=synthesizer,
        reviewer=reviewer,
        model_fn=model_fn,
        overrides=overrides,
        clock=clock,
        start_round=next_round + 1,
        max_auto_drills=max_auto_drills,
        on_turn=on_turn,
    )

    # 续问也跑决断员 — session.decider_enabled 是 source of truth(POST /continue
    # 不再传 enable_decider),只要原 session opt-in 过,续问就会基于新 synth
    # 重新出推荐。verdict 落 max(round)+1,PWA verdict_turns[-1] 自动取新的。
    # spec §2.1:续问触发新一轮 synth + 新一轮决断员(若 session opt-in 过)。
    if decider is not None and session.decider_enabled:
        from .decider import decide
        try:
            synth_turns = [t for t in session.turns if t.type == "synth"]
            last_synth = synth_turns[-1].content if synth_turns else ""
            verdict_text = decide(
                question=question, mode=session.mode,
                turns=session.turns, synth_text=last_synth,
                decider=decider, model_fn=model_fn,
                model_override=overrides.get(decider.name),
            )
        except Exception as e:    # noqa: BLE001
            import logging
            logging.getLogger(__name__).exception("decider failed on continue")
            verdict_text = (
                f"## 推荐方案\n(决断员调用失败,无法生成推荐)\n\n"
                f"## 理由\n- 失败原因: {type(e).__name__}: {e}\n"
                f"- 重试方式:在 #settings/roles 切换决断员 model 再次续问\n"
            )
        max_round = max((t.round for t in session.turns), default=next_round)
        new_verdict = AgentTurn(
            round=max_round + 1, role=decider.name, type="verdict",
            content=verdict_text, ts=clock(),
        )
        append_turn(session_path, new_verdict)
        if on_turn is not None:
            try:
                on_turn(new_verdict)
            except Exception:    # noqa: BLE001
                pass
        session.turns.append(new_verdict)

    return session
