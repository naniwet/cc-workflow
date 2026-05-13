"""3-round orchestration: R1 (4 sequential) → R2 (4 sequential) → R3 (整理员).

Ported from AgentRoundtable's debate.py; logic unchanged.

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
from collections.abc import Callable
from pathlib import Path
from typing import Optional

from .data import AgentTurn, Role, Session
from .io import append_turn, write_meta
from .model import ModelFn
from .synth import synthesize


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


def run_session(
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    session_path: Path,
    *,
    on_turn: Optional[Callable[[AgentTurn], None]] = None,
    clock: Callable[[], float] = time.time,
) -> Session:
    session = Session(question=question, started_at=clock())
    write_meta(session_path, session)

    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:    # noqa: BLE001 — broken callback must not crash session
                pass
        session.turns.append(turn)

    # --- Round 1 ---------------------------------------------------------- #
    for role in roles:
        user_prompt = build_r1_user_prompt(question)
        content = model_fn(role.preferred_model, role.system_prompt, user_prompt, role.temperature)
        _record(AgentTurn(round=1, role=role.name, type="answer", content=content, ts=clock()))

    # --- Round 2 ---------------------------------------------------------- #
    r1_by_role = {t.role: t.content for t in session.turns if t.round == 1}
    for role in roles:
        others = {name: c for name, c in r1_by_role.items() if name != role.name}
        user_prompt = build_r2_user_prompt(question, others)
        content = model_fn(role.preferred_model, role.system_prompt, user_prompt, role.temperature)
        _record(AgentTurn(round=2, role=role.name, type="critique", content=content, ts=clock()))

    # --- Round 3 ---------------------------------------------------------- #
    synth_text = synthesize(question, session.turns, synthesizer, model_fn)
    _record(AgentTurn(round=3, role=synthesizer.name, type="synth", content=synth_text, ts=clock()))

    return session
