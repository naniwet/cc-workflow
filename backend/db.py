"""SQLite DAL for runs.db. Schema per dev-plan §4.5.

Phase 1 reads/writes the `runs` table only. The `sessions` and
`push_subscriptions` tables are created up front (idempotent CREATE IF NOT
EXISTS) so later phases (P0-4 / P0-6) don't need a migration step.
"""
from __future__ import annotations

import sqlite3
import time
import uuid
from contextlib import contextmanager
from typing import Iterator, Optional

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    engine TEXT NOT NULL,
    session_key TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    output TEXT,
    pr_url TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    elapsed_s INTEGER,
    tokens_used INTEGER,
    cost_usd REAL,
    source TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    claude_session_id TEXT,
    codex_session_id TEXT,
    last_active_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace, started_at);
"""


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.RUNS_DB, isolation_level=None, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init() -> None:
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.executescript(SCHEMA)


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


def insert_queued_run(
    *,
    run_id: str,
    workspace: str,
    engine: str,
    session_key: Optional[str],
    prompt: str,
    source: str,
) -> None:
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "INSERT INTO runs (id, workspace, engine, session_key, prompt, "
            "status, started_at, source) "
            "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
            (run_id, workspace, engine, session_key, prompt, now, source),
        )


def set_running(run_id: str) -> None:
    with _conn() as c:
        c.execute("UPDATE runs SET status='running' WHERE id=?", (run_id,))


def finish_run(
    *,
    run_id: str,
    exit_code: int,
    output: str,
    pr_url: Optional[str] = None,
) -> None:
    now = int(time.time())
    status = "done" if exit_code == 0 else "failed"
    with _conn() as c:
        c.execute(
            "UPDATE runs "
            "SET status=?, exit_code=?, output=?, pr_url=?, "
            "    finished_at=?, elapsed_s=? - started_at "
            "WHERE id=?",
            (status, exit_code, output, pr_url, now, now, run_id),
        )


def get_run(run_id: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    return dict(row) if row else None


# Columns returned by /sessions endpoint. Keeping the projection narrow keeps
# response size predictable and avoids leaking the full prompt by default.
_RUN_SUMMARY_COLS = (
    "id, workspace, engine, session_key, status, "
    "exit_code, started_at, finished_at, elapsed_s, source"
)


def list_sessions_view() -> dict:
    """Shape: {active, queued, recent} — dev-plan §4.2.

    active = status='running'
    queued = status='queued'
    recent = last 10 done|failed by started_at desc
    """
    with _conn() as c:
        active = [
            dict(r)
            for r in c.execute(
                f"SELECT {_RUN_SUMMARY_COLS} FROM runs "
                "WHERE status='running' ORDER BY started_at DESC"
            )
        ]
        queued = [
            dict(r)
            for r in c.execute(
                f"SELECT {_RUN_SUMMARY_COLS} FROM runs "
                "WHERE status='queued' ORDER BY started_at DESC"
            )
        ]
        recent = [
            dict(r)
            for r in c.execute(
                f"SELECT {_RUN_SUMMARY_COLS} FROM runs "
                "WHERE status IN ('done','failed') "
                "ORDER BY started_at DESC LIMIT 10"
            )
        ]
    return {"active": active, "queued": queued, "recent": recent}
