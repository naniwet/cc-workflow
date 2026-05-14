"""Per-workspace settings — read/write ~/.cc-workflow/workspaces.json.

Schema:
    {
      "<workspace-name>": {
        "provider": "deepseek",     # optional, mutable via PUT settings
        "engine":   "claude"        # set at create time, IMMUTABLE thereafter
      },
      ...
    }

Fields:
    provider — soft config. Switched anytime via PUT /workspaces/{name}/settings.
               None or absent = fall back to global config.toml provider.
    engine   — bound to the workspace at creation. claude or codex. No PUT
               endpoint can change it: to switch engines, delete + recreate
               the workspace. Older workspaces that predate this field fall
               back to DEFAULT_ENGINE.

Why a module of its own:
    main.py (REST handlers) and im_feishu.py (Feishu webhook +
    card-callback's submit_run action) both need to read these. Pulling
    the helpers out of main.py avoids a circular import path through
    main → im_feishu → main.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from . import config

# DOM path — single source of truth used by both main.py and im_feishu.py.
_PATH = config.CCW_DIR / "workspaces.json"

# Workspaces created before the "engine" field existed fall back to claude.
# Anyone wanting codex on an existing workspace recreates it.
DEFAULT_ENGINE = "claude"


def load() -> dict:
    """Return the entire settings dict; {} when file is missing or unreadable."""
    if not _PATH.exists():
        return {}
    try:
        return json.loads(_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save(data: dict) -> None:
    """Atomic write (tmp + os.replace) so concurrent PUTs don't tear the file."""
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _PATH)


def provider_for(workspace: str, override: Optional[str] = None) -> Optional[str]:
    """Provider resolution: explicit override > workspace setting > None.

    Returning None tells agent-run.sh to fall back to global config.toml's
    [provider] field.
    """
    if override:
        return override
    return (load().get(workspace) or {}).get("provider")


def engine_for(workspace: str) -> str:
    """Engine resolution: workspace setting > DEFAULT_ENGINE.

    No override parameter — engine is workspace-level, not per-run. Every
    runner.submit() call site that takes engine should call this rather
    than accepting an `engine` from user input.
    """
    return (load().get(workspace) or {}).get("engine") or DEFAULT_ENGINE


def trust_for(workspace: str) -> bool:
    """Trust resolution for tool permissions:
        per-workspace `trust` field > config.toml `default_trust` > False.

    When True, agent-run is invoked with `--permission-mode bypassPermissions`
    (claude auto-approves every tool including Bash / Edit / WebFetch).
    When False, the default `acceptEdits` is used — Edit/Write auto-approved,
    others fall through to "please approve" text in headless mode.

    (The codex-forces-true short-circuit was removed 2026-05-14 along with
    codex engine support. See README "engine 现状".)
    """
    ws = (load().get(workspace) or {}).get("trust")
    if isinstance(ws, bool):
        return ws
    cfg = (config.load_config() or {})
    cfg_default = cfg.get("default_trust")
    if isinstance(cfg_default, bool):
        return cfg_default
    return False


def permission_mode_for(workspace: str) -> str:
    """Map trust → claude --permission-mode value. Used by main.py before
    handing off to runner.submit()."""
    return "bypassPermissions" if trust_for(workspace) else "acceptEdits"
