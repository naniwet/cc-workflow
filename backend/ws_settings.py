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
    backend deployment. We don't need claude's own --flag bypass anyway:
    when trust=on, we write a project-level `.claude/settings.local.json`
    with `permissions.allow = ["*"]` (see sync_trust_to_claude_settings),
    which is claude's native way to declare "allow all tools without
    asking" and does NOT trigger the root check.

    The PreToolUse hook (cc-approve-hook.sh) is still wired in via
    `~/.claude/settings.json` and handles the trust=off case: it
    forwards Bash/WebFetch tool calls to the backend's approval queue
    so the PWA can show [Approve]/[Deny] buttons.

    Function name kept for back-compat; semantically it's now
    "always acceptEdits — trust is decided elsewhere".
    """
    return "acceptEdits"


# ---- project-level claude settings sync ---------------------------------

# Path of the per-workspace claude settings file we manage. claude reads
# this on startup as a project-level permission override; we write it
# when trust=on, delete it when trust=off. Using settings.local.json
# (not settings.json) so we don't conflict with anything the user might
# hand-author at the same path — local.json is claude's "machine-local
# override" slot and is in claude's default .gitignore.
_CLAUDE_SETTINGS_NAME = "settings.local.json"


def _claude_settings_path(workspace: str):
    return config.WORKSPACES_DIR / workspace / ".claude" / _CLAUDE_SETTINGS_NAME


def sync_trust_to_claude_settings(workspace: str) -> None:
    """Make the workspace's claude project settings reflect its trust state.

    trust=on  → write `.claude/settings.local.json` with allow=["*"], i.e.
                "all tools auto-approved without asking, via claude's
                native permission system" (not via our hook).
    trust=off → remove that file, so claude falls back to its default
                (= ask for Bash/WebFetch), and our hook handles the
                approval round-trip via PWA.

    Called by main.py whenever trust changes for a workspace, and at
    startup to backfill existing workspaces.

    Safe to call repeatedly: write is atomic (tmp + rename), unlink is
    missing_ok. Doesn't fail loud — broken file write surfaces as the
    user noticing trust=on isn't auto-approving and reading the log.
    """
    settings_path = _claude_settings_path(workspace)
    ws_root = config.WORKSPACES_DIR / workspace
    if not ws_root.is_dir():
        return  # workspace gone; nothing to sync
    if trust_for(workspace):
        body = {
            "_managed_by": "cc-workflow",
            "_doc": (
                "Auto-generated. Toggle trust via the workspace ⋯ menu "
                "in the PWA; don't hand-edit this file. trust=on writes "
                "allow=['*'] (auto-approve all tools); trust=off deletes "
                "it (default ask-for-Bash, mediated by PWA approval)."
            ),
            "permissions": {"allow": ["*"]},
        }
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = settings_path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, settings_path)
        except OSError:
            # Best-effort. If permissions or disk fail, log and move on —
            # trust=on simply won't be auto-approved until the user
            # re-toggles after the underlying issue is fixed.
            try: tmp.unlink(missing_ok=True)
            except OSError: pass
    else:
        try:
            settings_path.unlink(missing_ok=True)
        except OSError:
            pass
        # Tidy up empty .claude/ dir if we just removed the only thing.
        # Failure (non-empty / not exists) is fine — we don't own the dir.
        try:
            settings_path.parent.rmdir()
        except OSError:
            pass


def sync_all_trust_to_claude_settings() -> None:
    """Backfill every existing workspace's settings.local.json from current
    trust state. Run at backend startup so a fresh deploy / new install
    of this code immediately reflects the trust matrix without waiting
    for the user to re-toggle each workspace."""
    from . import ui_cards
    for ws in ui_cards._discover_workspaces():
        try:
            sync_trust_to_claude_settings(ws)
        except Exception:    # noqa: BLE001 — never let a single broken ws break startup
            pass
