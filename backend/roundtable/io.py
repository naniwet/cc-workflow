"""jsonl persistence for roundtable sessions.

Schema (unchanged from AgentRoundtable):
  Line 1   : meta   {"_meta": true, "question": "...", "started_at": ..., "version": "v0"}
  Line 2+  : turns  {"round": 1, "role": "...", "type": "answer", "content": "...", "ts": ...}

Path: <sessions_dir>/YYYYMMDD-HHMMSS-<slug>.jsonl  (UTC).
sessions_dir is supplied by callers (backend uses config.ROUNDTABLES_DIR).
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict
from pathlib import Path

from .data import AgentTurn, Session

SCHEMA_VERSION = "v0"
_SLUG_MAX = 24


def session_path_for(question: str, started_at: float, sessions_dir: Path) -> Path:
    """Compose '<dir>/YYYYMMDD-HHMMSS-<slug>.jsonl' (UTC).

    If that path already exists, append a small numeric suffix instead of
    returning a name that would be truncated by write_meta().
    """
    ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime(started_at))
    slug = _slugify(question)
    stem = f"{ts}-{slug}" if slug else ts
    path = sessions_dir / f"{stem}.jsonl"
    if not path.exists():
        return path
    for i in range(2, 1000):
        candidate = sessions_dir / f"{stem}-{i}.jsonl"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"too many roundtable session name collisions for {stem!r}")


def session_id_from_path(path: Path) -> str:
    """Return the slug-bearing stem used as the session id in URLs.
    `20260513-151021-foo.jsonl` → `20260513-151021-foo`."""
    return path.stem


def _slugify(text: str) -> str:
    # \w under Python's default `re` flags is Unicode-aware, so Chinese stays.
    slug = re.sub(r"[^\w-]+", "-", text.strip(), flags=re.UNICODE)
    slug = re.sub(r"-+", "-", slug).strip("-")
    slug = slug[:_SLUG_MAX].strip("-")
    return slug


def write_meta(session_path: Path, session: Session) -> None:
    """Write the meta line. Truncates any existing file at this path."""
    session_path.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "_meta": True,
        "question": session.question,
        "started_at": session.started_at,
        "critique_rounds": session.critique_rounds,
        "mode": session.mode,
        "decider_enabled": session.decider_enabled,
        "version": SCHEMA_VERSION,
    }
    with session_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps(meta, ensure_ascii=False) + "\n")


def append_turn(session_path: Path, turn: AgentTurn) -> None:
    """Append one turn as a single JSON line. Flushes implicitly on close."""
    with session_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(asdict(turn), ensure_ascii=False) + "\n")


def read_session(session_path: Path) -> Session:
    """Read jsonl back into a Session. Requires the meta line."""
    with session_path.open(encoding="utf-8") as f:
        lines = [line for line in f if line.strip()]

    if not lines:
        raise ValueError(f"empty session file, expected meta line: {session_path}")

    head = json.loads(lines[0])
    if not head.get("_meta"):
        raise ValueError(f"missing meta line in session file: {session_path}")

    session = Session(
        question=head["question"],
        started_at=head["started_at"],
        critique_rounds=head.get("critique_rounds", 1),    # legacy jsonl default
        mode=head.get("mode", "roundtable"),               # legacy jsonl default
        decider_enabled=head.get("decider_enabled", False),  # legacy = off
    )
    for line in lines[1:]:
        rec = json.loads(line)
        session.turns.append(
            AgentTurn(
                round=rec["round"],
                role=rec["role"],
                type=rec["type"],
                content=rec["content"],
                ts=rec["ts"],
            )
        )
    return session


def write_error_marker(session_path: Path, error: str) -> None:
    """Append a synthetic error line so the PWA detail view can show what
    blew up partway through a session. Format: a turn with role='__error__'."""
    with session_path.open("a", encoding="utf-8") as f:
        f.write(
            json.dumps(
                {
                    "round": 0,
                    "role": "__error__",
                    "type": "answer",
                    "content": error,
                    "ts": time.time(),
                },
                ensure_ascii=False,
            )
            + "\n"
        )
