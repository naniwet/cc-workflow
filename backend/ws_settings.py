"""Per-workspace settings — read/write ~/.cc-workflow/workspaces.json.

Schema:
    {
      "<workspace-name>": {
        "provider": "deepseek",     # optional, mutable via PUT settings
        "engine":   "claude",       # set at create time, IMMUTABLE thereafter
        "trust":    true            # optional, mutable; bypasses tool approval
      },
      ...
    }

Fields:
    provider — soft config. Switched anytime via PUT /workspaces/{name}/settings.
               None or absent = fall back to global config.toml provider.
    engine   — bound to the workspace at creation. Only "claude" is supported
               since 2026-05-14 (codex was removed; see README). Field still
               written so older workspaces remain readable; engine_for falls
               back to DEFAULT_ENGINE for entries that predate this field.
    trust    — per-workspace tool-approval bypass. True → claude runs with
               --permission-mode bypassPermissions (no [Approve][Deny] prompts).

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
    """Always return 'acceptEdits' — never 'bypassPermissions'.

    Why not respect trust here:
    Claude CLI's 'bypassPermissions' refuses to run as uid 0 (root) since
    late-2026, breaking trust=on workspaces under the standard root-mode
    backend deployment. We don't need claude's own bypass anyway: when
    trust=on, the PreToolUse hook (scripts/cc-approve-hook.sh) short-
    circuits to exit-0 on CCW_TRUST=true, which has the same end effect
    (auto-approve Bash/WebFetch) without going through claude's root
    check.

    So trust is enforced via the env var + hook channel, not via the
    --permission-mode flag.

    The function name remains permission_mode_for/ for back-compat;
    semantically it's now "the always-safe mode that lets the hook do
    the trust gating".
    """
    return "acceptEdits"
