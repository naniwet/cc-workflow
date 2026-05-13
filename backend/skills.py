"""Slash-command (skill) discovery — for the PWA's `/` autocomplete menu.

cc-workflow doesn't EXECUTE skills; that's `claude -p`'s job (verified
2026-05-13 — see commit log for the canary test). This module just
enumerates what skills exist so the PWA can:
  1. Show a "what commands do I have?" picker when the user types `/`
  2. Auto-complete the name once they pick one

Three sources, precedence highest-first (matches Claude Code's own rule):
  1. Project-level   <workspace>/.claude/commands/*.md
  2. User-level      ~/.claude/commands/*.md
  3. Plugin-level    ~/.claude/plugins/<plugin>/commands/*.md
                     ~/.claude/plugins/<plugin>/.claude/commands/*.md
                     (both layouts exist in the wild — we try each)

Frontmatter: standard `--- ... ---` block at the top. We only need
`description`. Body after the second `---` is just searched for
`$ARGUMENTS` / `{N}` to compute has_args (so the UI knows whether
to leave the cursor after a trailing space).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

# Args placeholder patterns Claude Code recognizes. We don't need to resolve
# them — just detect whether the skill takes args, so the autocomplete UI
# can insert "/foo " (with space) vs "/foo" (no space).
_ARGS_RE = re.compile(r"\$ARGUMENTS|\{[0-9]+\}")

# Optional frontmatter block: --- key: value ... --- body
_FRONT_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)", re.DOTALL)


def _parse_skill_file(path: Path) -> Optional[dict]:
    """One .md file → {name, description, has_args}. Returns None on any
    read error — a single corrupt skill shouldn't poison the whole list."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    description = ""
    body = text
    m = _FRONT_RE.match(text)
    if m:
        # Minimal YAML-ish: only the "description" line. Skip anything else
        # (model:, tools:, etc.) — we don't need them for autocomplete.
        for line in m.group(1).splitlines():
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            if k.strip() == "description":
                description = v.strip().strip('"').strip("'")
                break
        body = m.group(2)
    return {
        "name": path.stem,
        "description": description,
        "has_args": bool(_ARGS_RE.search(body)),
    }


def _scan_dir(d: Path, source: str) -> list[dict]:
    """Scan one commands dir. Returns [] when the dir doesn't exist (silent —
    we probe optional paths so absence is not an error)."""
    out: list[dict] = []
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.md")):
        parsed = _parse_skill_file(f)
        if parsed is None:
            continue
        parsed["source"] = source
        out.append(parsed)
    return out


def scan_skills(workspace_path: Optional[Path] = None) -> list[dict]:
    """Discover all available slash-commands.

    Returns a list of {name, description, has_args, source}. Sorted by name.

    Precedence: project (if workspace_path given) > user > plugin. Lower-
    precedence dupes are dropped silently (matches Claude Code's own
    behavior where a project skill shadows a user one of the same name).
    """
    found: dict[str, dict] = {}    # name → skill dict

    # 1. Plugins (lowest priority — overridden below)
    plugins_root = Path.home() / ".claude" / "plugins"
    if plugins_root.is_dir():
        for plugin_dir in sorted(plugins_root.iterdir()):
            if not plugin_dir.is_dir() or plugin_dir.name.startswith("."):
                continue
            source = f"plugin:{plugin_dir.name}"
            # Two common layouts — try both, dedupe at the name level
            for sub in (plugin_dir / "commands", plugin_dir / ".claude" / "commands"):
                for s in _scan_dir(sub, source):
                    found.setdefault(s["name"], s)    # first wins inside plugin layer

    # 2. User-level (overrides plugins)
    for s in _scan_dir(Path.home() / ".claude" / "commands", "user"):
        found[s["name"]] = s

    # 3. Project-level (overrides everything)
    if workspace_path:
        for s in _scan_dir(workspace_path / ".claude" / "commands", "project"):
            found[s["name"]] = s

    return sorted(found.values(), key=lambda x: x["name"])
