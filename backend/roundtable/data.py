"""Core data types for a roundtable session.

Verbatim copy of AgentRoundtable's data.py (terms are ubiquitous language —
do NOT introduce synonyms; no `task` / `query` / `agent`).

Invariants enforced by the type system:
  - Role and AgentTurn are immutable (frozen dataclasses).
Invariants enforced by the orchestrator (debate.run_session), not here:
  - Session.turns is append-only.
  - AgentTurn.round walks 1 → 2 → 3 → ... monotonically. Auto-drill /
    续问 会让 round 超过 critique_rounds + 2(原来的 synth round)。
  - LAST type="synth" turn 是当前 synth;earlier synth turns 是历史
    (auto-drill / 续问 后产生新 synth,前面的 synth 留着不删 — 旧代码
    `r3_turns[-1]` 这种 last-wins 写法保持有效,旧 session 兼容)。
  - 同 round 内,type 出现顺序:user_question(可选)→ answer/follow_up
    × N 派 → synth → review。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

TurnType = Literal["answer", "critique", "synth", "review", "follow_up", "user_question"]


@dataclass(frozen=True)
class Role:
    name: str
    system_prompt: str
    preferred_model: str = "deepseek-chat"
    temperature: float = 0.7


@dataclass(frozen=True)
class AgentTurn:
    round: int
    role: str
    type: TurnType
    content: str
    ts: float


@dataclass
class Session:
    question: str
    started_at: float
    turns: list[AgentTurn] = field(default_factory=list)
    # How many critique rounds were configured for this session. 1 = legacy
    # (R2 alone). 2 = R2 + R3 deep-dive. Stored in the meta line so PWA can
    # compute the right "x/N turns" progress fraction. Old jsonl files
    # don't carry this; read_session defaults to 1 for back-compat.
    critique_rounds: int = 1
