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
from typing import Optional

from .data import AgentTurn, Role, Session
from .io import append_turn, write_meta
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
    """
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

    def _run_follow_up_iteration(
        round_no: int,
        follow_up_question: str,
        prior_synth: str,
        source: str,                     # "auto" | "user"
    ) -> None:
        """跑一轮 follow-up:user_question(若 source=user)→ 4 派 follow_up
        × N → 新 synth。auto-drill loop 和 /continue 都调这个。"""
        if source == "user":
            _record(AgentTurn(
                round=round_no, role="__user__", type="user_question",
                content=follow_up_question, ts=clock(),
            ))

        def _follow_up_prompt(role: Role) -> str:
            return f"""原问题:{question}

上一次 synth(territory map):

{prior_synth}

新追问(来源 {"用户" if source == "user" else "自动追问"}):
{follow_up_question}

---

请用 **≤ 200 字** 针对这次追问回应,延续你的人设立场。
不要重复你在前面 round 已经说过的内容。"""

        _run_role_round(round_no, "follow_up", _follow_up_prompt)

        # 新 synth
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
        _record(AgentTurn(round=round_no, role=synthesizer.name, type="synth", content=synth_text, ts=clock()))

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
    next_round = synth_round + 1
    converged = False
    for _ in range(max_auto_drills):
        last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
        assert last_synth is not None, "auto-drill loop 之前必有 initial synth"

        prior_reviews = "\n\n".join(
            f"--- 上次 review (round {t.round}) ---\n{t.content}"
            for t in session.turns if t.type == "review"
        ) or "(无)"

        reviewer_prompt = f"""原始问题:
{question}

最新 synth:
{last_synth.content}

历史 review:
{prior_reviews}

按你的 system_prompt 输出判断。"""

        verdict_text = model_fn(
            overrides.get(REVIEWER.name) or REVIEWER.preferred_model,
            REVIEWER.system_prompt,
            reviewer_prompt,
            REVIEWER.temperature,
        )
        verdict = reviewer_mod.parse_verdict(verdict_text)
        _record(AgentTurn(
            round=last_synth.round, role=REVIEWER.name, type="review",
            content=verdict_text, ts=clock(),
        ))
        if verdict.converged:
            converged = True
            break
        _run_follow_up_iteration(
            round_no=next_round,
            follow_up_question=verdict.next_question,
            prior_synth=last_synth.content,
            source="auto",
        )
        next_round += 1

    # 跑满 drill 上限但未收敛:补一次 final review,供 PWA 读取最后判断结果
    # (last review turn 是 NEEDS_DRILL → 前端可展示 "已达上限" banner + prefill next_q)
    # TODO Task 6: 这段跟 loop body 重复 — 等 _run_auto_drill_loop 提到 module-level
    # 后用统一 helper 调一次,避免改 reviewer_prompt 格式时漏改这一处。
    if max_auto_drills > 0 and not converged:
        last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
        assert last_synth is not None, "post-loop final review 之前必有 synth"
        prior_reviews = "\n\n".join(
            f"--- 上次 review (round {t.round}) ---\n{t.content}"
            for t in session.turns if t.type == "review"
        ) or "(无)"
        reviewer_prompt = f"""原始问题:
{question}

最新 synth:
{last_synth.content}

历史 review:
{prior_reviews}

按你的 system_prompt 输出判断。"""
        verdict_text = model_fn(
            overrides.get(REVIEWER.name) or REVIEWER.preferred_model,
            REVIEWER.system_prompt,
            reviewer_prompt,
            REVIEWER.temperature,
        )
        _record(AgentTurn(
            round=last_synth.round, role=REVIEWER.name, type="review",
            content=verdict_text, ts=clock(),
        ))

    return session
