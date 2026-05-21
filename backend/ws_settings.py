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
import logging
import os
from pathlib import Path
from typing import Optional

from . import config

_logger = logging.getLogger(__name__)

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


_VALID_WORKTREE_MODES = ("auto", "off")


def worktree_mode_for(workspace: str) -> str:
    """Resolve per-workspace worktree mode.

    Returns "off" only when explicitly set; everything else (missing field,
    unknown workspace, invalid value, unreadable file) → "auto".

    "off" means runner.submit() will squash session_key to "default" so
    agent-run.sh runs in the workspace main dir (no git worktree). Used
    for notes/docs repos that don't need branch isolation.
    """
    val = (load().get(workspace) or {}).get("worktree_mode")
    if val in _VALID_WORKTREE_MODES:
        return val
    if val is not None:
        _logger.warning(
            "workspace %r has invalid worktree_mode %r — falling back to 'auto'",
            workspace, val,
        )
    return "auto"


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
    """Map trust=on/off → claude's `--permission-mode`, runtime-aware.

    Claude Code CLI accepts exactly four modes:
      `default` / `acceptEdits` / `plan` / `bypassPermissions`.
    (Earlier this file referenced `dontAsk` and `auto` — those were
    a hallucination, do NOT add them back. The CLI rejects them at
    arg-parse and `agent-run.sh`'s validator does too.)

    trust=off → `acceptEdits` always. Edit/Write auto-allowed; Bash /
                WebFetch hit L1 (sync_global_allow_rules planted the
                allow list so they pass), then fire PreToolUse hook
                → backend → PWA approval queue.
    trust=on  → depends on the backend's effective uid:
                  uid != 0 (ccw)  → `bypassPermissions` — claude
                                    skips L1 entirely.
                  uid == 0 (root) → `acceptEdits` — claude CLI
                                    refuses `bypassPermissions`
                                    under uid 0 for safety, so we
                                    fall back. Bash/Write/Read are
                                    in the global allow list and
                                    pass L1; the PreToolUse hook
                                    sees CCW_TRUST=on and
                                    auto-approves the rest.

    Known limitation under root + trust=on: some hardcoded protections
    claude has on its OWN config files (`~/.claude/settings.json` etc)
    cannot be bypassed by any mode. Writes to `~/.claude/skills/`,
    `~/.claude/commands/`, `~/.claude/agents/` are doc'd as allowed,
    so the common "install a skill" workflow should work; deeper
    `~/.claude/` writes may silently fail. Migrating the systemd
    service to a non-root user (see deploy/MIGRATE-TO-NONROOT.md,
    flagged EXPERIMENTAL) is the long-term fix.

    Runtime detection: uid is checked at call time so the same code
    works in either root or non-root deployment without edits.
    """
    if not trust_for(workspace):
        return "acceptEdits"
    if os.geteuid() == 0:
        return "acceptEdits"  # bypassPermissions rejected under uid 0; hook layer carries trust
    return "bypassPermissions"


# ---- global claude settings sync ----------------------------------------
#
# History note (2026-05-15):
# Earlier design wrote `.claude/settings.local.json` per-workspace, with
# the allow rules toggling on/off per trust state. That broke for
# session_key != "default" runs, because agent-run.sh creates a git
# worktree under WORKSPACES_DIR/.wt/<ws>-<session>/ and runs claude with
# that as cwd — but the per-workspace settings.local.json lives at
# WORKSPACES_DIR/<ws>/.claude/, which the worktree doesn't see.
#
# New design: a single ~/.claude/settings.json with a blanket allow list,
# applied globally. trust=on / trust=off differentiation moves entirely
# to the PreToolUse hook layer (cc-approve-hook.sh reads CCW_TRUST).
# Concept becomes cleaner:
#   L1 (claude settings)   — uniformly "allow these tool names"
#   L2 (PreToolUse hook)   — per-run trust decision (auto-approve or PWA)
# claude's L1 must allow first so the hook gets a chance to fire (if L1
# denies, the hook may not be consulted at all).

# Tool names with confirmed blanket-allow semantics under claude's
# settings.json `permissions.allow`. Verified 2026-05-15 against
# https://code.claude.com/docs/en/permissions — bare tool name equals
# `Tool(*)` and matches every invocation of that tool. MCP tools are
# excluded (dynamic; user adds mcp__server__action entries manually).
ALLOW_PATTERNS = [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "NotebookEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Task",
    "SlashCommand",
    "TodoWrite",
    "BashOutput",
    "KillShell",
]


def _claude_global_settings_path() -> Path:
    """~/.claude/settings.json — claude's user-level settings file."""
    return Path.home() / ".claude" / "settings.json"


def sync_global_allow_rules() -> None:
    """Ensure ~/.claude/settings.json#permissions.allow contains our
    blanket allow list. Preserves any other keys (especially the
    PreToolUse hook config installed by deploy/INSTALL.md — clobbering
    that would silently break the PWA approval queue).

    Called once at backend startup. Idempotent: re-running rewrites only
    `permissions.allow`, leaving `hooks`/`env`/anything else alone.

    Why global (not per-workspace): see the history note above —
    worktree-mode runs (session_key != "default") don't see
    per-workspace .claude/settings.local.json.

    Why we don't honor trust=on/off here: trust differentiation is the
    PreToolUse hook's job. L1 always allows; the hook decides whether
    to round-trip through PWA approval (trust=off) or auto-approve via
    backend (trust=on).
    """
    path = _claude_global_settings_path()
    if not path.parent.exists():
        # ~/.claude doesn't exist yet — claude has never been initialized
        # on this host. Skip silently; agent-run will fail loud later
        # with a more diagnosable error than a permission-mismatch tangle.
        return

    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(existing, dict):
                existing = {}
        except (OSError, json.JSONDecodeError):
            existing = {}

    perms = existing.setdefault("permissions", {})
    perms["allow"] = list(ALLOW_PATTERNS)

    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        # Best-effort — broken write surfaces as the user noticing
        # trust=on tools still prompt. Don't crash startup over it.
        try: tmp.unlink(missing_ok=True)
        except OSError: pass
