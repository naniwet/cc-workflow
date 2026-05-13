"""Core data types for a roundtable session.

Verbatim copy of AgentRoundtable's data.py (terms are ubiquitous language —
do NOT introduce synonyms; no `task` / `query` / `agent`).

Invariants enforced by the type system:
  - Role and AgentTurn are immutable (frozen dataclasses).
Invariants enforced by the orchestrator (debate.run_session), not here:
  - Session.turns is append-only.
  - AgentTurn.round walks 1 → 2 → 3 monotonically.
  - Exactly one type="synth" turn per Session, and it is the last turn.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

TurnType = Literal["answer", "critique", "synth"]


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
