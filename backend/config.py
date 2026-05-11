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

STATE_DIR = Path(os.environ.get("CC_STATE_HOME", Path.home() / ".cc-state"))
RUNS_DB = STATE_DIR / "runs.db"
JOBS_DIR = STATE_DIR / "jobs"

REPO_ROOT = Path(__file__).resolve().parent.parent


def _resolve_agent_run() -> Path:
    """Prefer the installed binary; fall back to the in-repo script for dev."""
    for c in (Path("/usr/local/bin/agent-run"), REPO_ROOT / "agent-run.sh"):
        if c.exists():
            return c
    return REPO_ROOT / "agent-run.sh"  # let subprocess fail with a clear error


AGENT_RUN = _resolve_agent_run()

# ---------- server bind (dev-plan §9.4) ----------
# Phase 1 binds 0.0.0.0 for direct Mac-browser access (no nginx yet).
# Phase 3 switches back to 127.0.0.1 + nginx reverse proxy + HTTPS + auth.
# (HOST/PORT here are documentation only — uvicorn is launched by systemd
# with explicit --host/--port flags from deploy/cc-workflow.service.)
HOST = "0.0.0.0"
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
