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


def search_runs(q: str, limit: int = 50) -> list[dict]:
    """Full-text-ish search 历史 prompt + output。

    用 SQLite LIKE %q%,不上 FTS5 — 单用户单机预计 runs < 10k,LIKE 几 ms,
    上 FTS5 多一套 trigger / backfill / virtual table,KISS 决策(将来 runs
    多了再升级)。返回字段跟 _RUN_SUMMARY_COLS 对齐 + 高亮 snippet。
    """
    if not q or len(q.strip()) < 2:
        return []
    pat = f"%{q.strip()}%"
    with _conn() as c:
        rows = c.execute(
            "SELECT id, workspace, status, source, started_at, finished_at, "
            "elapsed_s, exit_code, "
            "substr(prompt, 1, 240) AS prompt_preview, "
            "CASE WHEN length(output) <= 240 THEN output "
            "     ELSE substr(output, 1, 120) || char(10) || '…' || char(10) || substr(output, -120) "
            "END AS output_preview "
            "FROM runs "
            "WHERE prompt LIKE ? OR output LIKE ? "
            "ORDER BY started_at DESC "
            "LIMIT ?",
            (pat, pat, limit),
        ).fetchall()
    return [dict(r) for r in rows]


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


def delete_runs_for_workspace(workspace: str) -> int:
    """Drop all run history rows for `workspace`. Called from
    DELETE /workspaces/{name} so phantom history doesn't keep that name
    visible in the PWA via the /sessions endpoint. Returns the count
    of rows removed."""
    with _conn() as c:
        cur = c.execute("DELETE FROM runs WHERE workspace = ?", (workspace,))
        # autocommit is on (isolation_level=None) — no explicit commit needed
        return cur.rowcount or 0


def delete_runs_for_session(workspace: str, session_key: str) -> list[str]:
    """删除 (workspace, session_key) 这一对的所有 runs,返回被删 run 的 id 列表。

    给 DELETE /workspaces/{name}/session(PWA "New chat")用:之前只清
    sessions.json 的 claude_session_id 让下次 agent-run 不带 --resume,
    runs.db 里的历史 run 完全不动 —— 前端 /sessions 拉回来还显示。设计图
    §3.1 要求"旧 turn 立刻从 UI 消失,不留痕迹",所以现在直接 DELETE。

    只删 (workspace, session_key) 这一对 —— cron loop 和飞书的 session_key
    不一样,他们的历史 run 不受影响。

    返回 id 列表让调用方做 log 文件清理(stream-jsonl 在
    ~/.cc-state/logs/run-<id>.stream.jsonl,db 行没了还留着就是孤儿)。
    """
    with _conn() as c:
        rows = c.execute(
            "SELECT id FROM runs WHERE workspace = ? AND session_key = ?",
            (workspace, session_key),
        ).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            c.execute(
                "DELETE FROM runs WHERE workspace = ? AND session_key = ?",
                (workspace, session_key),
            )
        return ids


def list_sessions_for_workspace(workspace: str) -> list[dict]:
    """列一个 workspace 下所有 distinct session_key + 聚合元数据。

    给 GET /workspaces/{ws}/sessions 用 —— PWA 多 session UI 的读模型。
    每个 session_key = 一条独立工作线(自己的 --resume 链 + worktree + 分支)。

    返回每项:{session_key, run_count, last_started_at, last_status}
    按 last_started_at 降序(最近活动的 session 排前)。

    worktree 探测(有没有 .wt/<ws>-<key>/ 目录)不在这里 —— 那是 filesystem
    层,留给 main.py endpoint 拼,db 只管 runs 表聚合。
    """
    with _conn() as c:
        rows = c.execute(
            "SELECT session_key, "
            "COUNT(*) AS run_count, "
            "MAX(started_at) AS last_started_at "
            "FROM runs WHERE workspace = ? AND session_key IS NOT NULL "
            "GROUP BY session_key "
            "ORDER BY last_started_at DESC",
            (workspace,),
        ).fetchall()
        out = []
        for r in rows:
            # 最近一条 run 的 status —— 单独查(GROUP BY 里取不到"最新行的列")
            last = c.execute(
                "SELECT status FROM runs WHERE workspace = ? AND session_key = ? "
                "ORDER BY started_at DESC LIMIT 1",
                (workspace, r["session_key"]),
            ).fetchone()
            out.append({
                "session_key": r["session_key"],
                "run_count": r["run_count"],
                "last_started_at": r["last_started_at"],
                "last_status": last["status"] if last else None,
            })
        return out


# Columns returned by /sessions endpoint.
#
# Q1 PWA polish: prompt + output snippet added so the workspace timeline
# can render chat-bubble previews inline (you don't have to navigate to
# the detail page to see what Claude said back). Both are capped at 200
# chars via SQL substr so response size stays bounded:
#   10 rows × 3 buckets × ~400 bytes/row ≈ 12 KB worst case, fine for 3s
#   polling.
# Originally excluded to "avoid leaking prompt by default" — that concern
# doesn't apply to a single-user system behind basic auth.
_RUN_SUMMARY_COLS = (
    "id, workspace, engine, session_key, status, "
    "exit_code, started_at, finished_at, elapsed_s, source, "
    "substr(prompt, 1, 200) AS prompt, "
    # Output preview: head + tail with an elision in the middle, so the
    # timeline row shows both the opener (how claude frames the reply)
    # AND the closer (conclusion / next step / "what should we do" —
    # which is what the user actually has to act on). Short outputs
    # (<= 200) show in full; only long ones get the head…tail trick.
    # Prompt stays head-only (prompts are usually user-written, the
    # opener is the salient part).
    "CASE WHEN length(output) <= 200 THEN output "
    "ELSE substr(output, 1, 100) || char(10) || '…' || char(10) || substr(output, -100) "
    "END AS output_preview"
)

# list_sessions_view 的 recent 用 window function 时,外层 SELECT 要按"列名"
# 重选(剥掉内层算的 rn)。这里是 _RUN_SUMMARY_COLS 产出的列名(prompt /
# output_preview 是 AS 别名,其余原名)。改 _RUN_SUMMARY_COLS 的列要同步这里。
_RECENT_OUTER_COLS = (
    "id, workspace, engine, session_key, status, "
    "exit_code, started_at, finished_at, elapsed_s, source, "
    "prompt, output_preview"
)
# 每个 workspace 在 recent 里保留的最近 done|failed 条数上限。
_RECENT_PER_WS = 20


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
        # recent = 每个 workspace 各保留最近 N 条 done|failed(按 workspace 分区,
        # 不是全局 LIMIT)。旧版全局 LIMIT 10 有个数据可见性 bug:别的 workspace
        # 跑 10+ 次就把安静 workspace 的历史挤出 top-10 → 该 workspace 时间线变空
        # (用户报"昨天对话今天刷新没了")。window function 按 workspace 分区取
        # 各自最近 N,payload 仍有界(N × workspace 数,单用户场景很小)。
        # ORDER BY started_at DESC, id DESC:同秒入库的 run 用 id 做稳定 tiebreaker。
        recent = [
            dict(r)
            for r in c.execute(
                f"SELECT {_RECENT_OUTER_COLS} FROM ("
                f"  SELECT {_RUN_SUMMARY_COLS}, ROW_NUMBER() OVER ("
                "     PARTITION BY workspace ORDER BY started_at DESC, id DESC"
                "  ) AS rn "
                "  FROM runs WHERE status IN ('done','failed')"
                ") WHERE rn <= ? ORDER BY started_at DESC, id DESC",
                (_RECENT_PER_WS,),
            )
        ]
    return {"active": active, "queued": queued, "recent": recent}


def fail_stale_runs(*, reason: str) -> list[str]:
    """Mark all status='running'|'queued' rows as failed. Returns the IDs.

    Called at backend startup — see main._reap_orphan_runs for the
    invariant ("systemd restart kills the cgroup, so every prior
    subprocess is dead"). Idempotent: a second call right after the
    first returns []. exit_code 137 (SIGKILL convention) communicates
    the cause to anyone reading the run detail.
    """
    now = int(time.time())
    with _conn() as c:
        ids = [
            row["id"]
            for row in c.execute(
                "SELECT id FROM runs WHERE status IN ('running','queued')"
            )
        ]
        if not ids:
            return []
        c.execute(
            "UPDATE runs SET status='failed', exit_code=137, finished_at=?, "
            "output=COALESCE(output, '') || ? "
            "WHERE status IN ('running','queued')",
            (now, f"\n[reaped at backend startup: {reason}]\n"),
        )
    return ids


def active_in_workspace(workspace: str) -> list[dict]:
    """Queued + running runs for `workspace`, newest first.

    Used by POST /run to reject a second submit while one is already in
    flight (same session_key would race the first claude --resume call).
    Returns full _RUN_SUMMARY_COLS rows so the caller can surface the
    blocking run's id to the user.
    """
    with _conn() as c:
        return [
            dict(r)
            for r in c.execute(
                f"SELECT {_RUN_SUMMARY_COLS} FROM runs "
                "WHERE workspace=? AND status IN ('queued','running') "
                "ORDER BY started_at DESC",
                (workspace,),
            )
        ]
