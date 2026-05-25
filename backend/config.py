"""Config loader for cc-workflow backend.

Reads ~/.cc-workflow/{config.toml,secrets.toml}. LLM provider env vars live
in ~/.cc-workflow/providers.json and are read by agent-run.sh, not here.
"""
from __future__ import annotations

import os
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover — fallback for 3.10 and below
    import tomli as tomllib  # type: ignore[no-redef]

# ---------- paths ----------

CCW_DIR = Path(os.environ.get("CC_WORKFLOW_HOME", Path.home() / ".cc-workflow"))
CONFIG_TOML = CCW_DIR / "config.toml"
SECRETS_TOML = CCW_DIR / "secrets.toml"
PROVIDERS_FILE = CCW_DIR / "providers.json"     # ccswitch-style profiles, read by llm.py + workspace settings

STATE_DIR = Path(os.environ.get("CC_STATE_HOME", Path.home() / ".cc-state"))
RUNS_DB = STATE_DIR / "runs.db"
JOBS_DIR = STATE_DIR / "jobs"
# Session id storage — keyed by session_key, written by agent-run.sh's
# save_session_id(). Read by both agent-run (for --resume) and backend's
# DELETE /workspaces/{name}/session (to clear an over-long session).
SESSIONS_FILE = STATE_DIR / "sessions.json"
# Roundtable (multi-agent debate) jsonl storage. Each session is one
# <slug>.jsonl with a meta header + 9 turn lines. Static — backend
# scans this dir for the list view, reads one file for the detail view.
ROUNDTABLES_DIR = STATE_DIR / "roundtables"
# PWA 上传文件落地路径 — `<ws>/<turn_uuid>/<filename>`。在 workspace 仓库外面,
# 不进 git。每周由 cron(/etc/cron.d/cc-loops 里那行 find -mtime +7 -delete)
# 清理 7 天以上文件。详细约束见 backend/main.py:post_uploads + CLAUDE.md §7。
UPLOADS_DIR = STATE_DIR / "uploads"

# Roundtable 文件上传专属顶层目录。**不**在 UPLOADS_DIR 下,因为
# _WS_NAME_RE 允许下划线 / 包含 "roundtable" 的字符串作为 workspace 名,
# 共用 uploads/ 子目录会名字冲突。spec §2.3。
# 每周 cron 清 7 天以上(实现:加进 cc-loops cron 的 find 命令覆盖路径)。
ROUNDTABLE_UPLOADS_DIR = STATE_DIR / "roundtable-uploads"

# Where agent-run.sh resolves <workspace> names — must match agent-run.sh's
# WORKSPACES_DIR constant. Used by ui_cards.run_form_card() to populate the
# workspace dropdown.
WORKSPACES_DIR = Path(os.environ.get("WORKSPACES_HOME", Path.home() / "workspaces"))

REPO_ROOT = Path(__file__).resolve().parent.parent


def _resolve_agent_run() -> Path:
    """Prefer the installed binary; fall back to the in-repo script for dev."""
    for c in (Path("/usr/local/bin/agent-run"), REPO_ROOT / "agent-run.sh"):
        if c.exists():
            return c
    return REPO_ROOT / "agent-run.sh"  # let subprocess fail with a clear error


AGENT_RUN = _resolve_agent_run()

# ---------- server bind (dev-plan §9.4) ----------
# Backend binds 127.0.0.1; public traffic comes through nginx on :80
# (deploy/nginx.conf reverse-proxies to here). HOST/PORT here are
# documentation only — uvicorn is launched by systemd with explicit
# --host/--port flags from deploy/cc-workflow.service.
HOST = "127.0.0.1"
PORT = 8765

# ---------- toml loaders ----------


def _load_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def load_config() -> dict:
    return _load_toml(CONFIG_TOML)


def load_secrets() -> dict:
    return _load_toml(SECRETS_TOML)
