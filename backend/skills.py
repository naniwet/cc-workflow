"""Slash-command (skill) discovery — for the PWA's `/` autocomplete menu.

cc-workflow doesn't EXECUTE skills; that's `claude -p`'s job (verified
2026-05-13 — see commit log for the canary test). This module just
enumerates what's available so the PWA can:
  1. Show a "what's installed?" picker when the user types `/`
  2. Auto-complete the name once they pick one

Two file shapes are scanned:

  • Slash commands — single .md file per command
        <root>/commands/<name>.md
    name = filename stem, e.g. `commands/review.md` → `/review`

  • Skills — one dir per skill, with a SKILL.md inside
        <root>/skills/<name>/SKILL.md
    name = frontmatter `name:` if present, else parent dir name

Both formats share a `--- ... ---` YAML-ish frontmatter block. We only
need a few keys:
  - `description`       — shown in the autocomplete row
  - `name`              — overrides the dir/filename (SKILL.md only)
  - `argument-hint`     — presence ⇒ has_args = True (SKILL.md only)
Body after the second `---` is also searched for `$ARGUMENTS` / `{N}`
so commands that don't declare it explicitly are still detected.

Three sources, lowest-precedence first (higher overwrites):
  1. Plugin  — driven by ~/.claude/plugins/installed_plugins.json so
               we follow Claude Code's actual install paths (under
               .../cache/<marketplace>/<plugin>/<version>/) instead of
               guessing at the layout
  2. User    — ~/.claude/{commands,skills}/
  3. Project — <workspace>/.claude/{commands,skills}/  (if workspace set)

Plugin items (both commands and skills) are namespaced as `<plugin>:<name>`
to match Claude Code's slash invocation syntax (e.g. `/engineering:tech-debt`,
`/product-management:brainstorm`). User and project items stay bare.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterator, Optional

# Args placeholder patterns Claude Code recognizes in command bodies. We
# don't resolve them — just detect whether the command takes args, so the
# autocomplete UI can decide between "/foo " (with space) and "/foo".
_ARGS_RE = re.compile(r"\$ARGUMENTS|\{[0-9]+\}")

# Optional frontmatter block: --- key: value ... --- body
_FRONT_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)", re.DOTALL)


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Return (frontmatter_kv, body). frontmatter_kv is {} when there's no
    `--- ... ---` block. We parse it as flat `key: value` lines and ignore
    anything more YAML-ish (lists, nesting) — none of the keys we need
    use those shapes."""
    m = _FRONT_RE.match(text)
    if not m:
        return {}, text
    kv: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        kv[k.strip()] = v.strip().strip('"').strip("'")
    return kv, m.group(2)


def _parse_command_file(path: Path) -> Optional[dict]:
    """One <name>.md slash-command file → {name, description, has_args}.
    Returns None on read failure — a single corrupt file shouldn't poison
    the whole list."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm, body = _parse_frontmatter(text)
    return {
        "name": path.stem,
        "description": fm.get("description", ""),
        "has_args": bool(_ARGS_RE.search(body)),
    }


def _parse_skill_md(path: Path, fallback_name: str) -> Optional[dict]:
    """One SKILL.md → {name, description, has_args}. Frontmatter `name:`
    wins over fallback_name (the parent dir name). `argument-hint:` is
    treated as a has_args signal even when the body doesn't reference
    `$ARGUMENTS` explicitly."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm, body = _parse_frontmatter(text)
    return {
        "name": fm.get("name") or fallback_name,
        "description": fm.get("description", ""),
        "has_args": bool(fm.get("argument-hint")) or bool(_ARGS_RE.search(body)),
    }


def _scan_commands_dir(d: Path, source: str, name_prefix: str = "") -> list[dict]:
    """Scan one `commands/` dir for *.md slash commands. Returns [] when
    the dir doesn't exist — we probe optional paths so absence is normal.

    name_prefix is prepended to the command name — used to namespace
    plugin commands as `<plugin>:<command>`.
    """
    out: list[dict] = []
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.md")):
        parsed = _parse_command_file(f)
        if parsed is None:
            continue
        parsed["name"] = f"{name_prefix}{parsed['name']}"
        parsed["source"] = source
        out.append(parsed)
    return out


def _scan_skills_dir(parent: Path, source: str, name_prefix: str = "") -> list[dict]:
    """Scan one `skills/` dir for <name>/SKILL.md entries.

    name_prefix is prepended to the resulting `name` field — used to
    namespace plugin skills as `<plugin>:<skill>` so they're directly
    invokable as `/<plugin>:<skill>`.
    """
    out: list[dict] = []
    if not parent.is_dir():
        return out
    for child in sorted(parent.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        skill_file = child / "SKILL.md"
        if not skill_file.is_file():
            continue
        parsed = _parse_skill_md(skill_file, fallback_name=child.name)
        if parsed is None:
            continue
        parsed["name"] = f"{name_prefix}{parsed['name']}"
        parsed["source"] = source
        out.append(parsed)
    return out


def _iter_installed_plugins(home: Path) -> Iterator[tuple[str, Path]]:
    """Yield (namespace, install_path) for every plugin in
    ~/.claude/plugins/installed_plugins.json.

    namespace = the part before '@' in keys like
    'engineering@knowledge-work-plugins' — that's what Claude Code uses
    in slash invocations (`/engineering:tech-debt`).

    Yields nothing (silently) when the registry file is missing or
    malformed — we don't want a corrupt registry to 500 the skills
    endpoint.
    """
    f = home / ".claude" / "plugins" / "installed_plugins.json"
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, dict):
        return
    for full_name, installs in plugins.items():
        if not isinstance(installs, list) or not installs:
            continue
        first = installs[0]
        if not isinstance(first, dict):
            continue
        install_path = first.get("installPath")
        if not isinstance(install_path, str) or not install_path:
            continue
        namespace = full_name.split("@", 1)[0]
        yield namespace, Path(install_path)


def scan_skills(workspace_path: Optional[Path] = None) -> list[dict]:
    """Discover all available slash-commands and skills.

    Returns a list of `{name, description, has_args, source}` sorted by name.

    Sources (lowest-precedence first, higher overwrites):
      1. Plugin commands + skills (via installed_plugins.json)
      2. User commands + skills   (~/.claude/{commands,skills})
      3. Project commands + skills (<workspace>/.claude/{commands,skills})

    Plugin items get namespaced as `<plugin>:<name>` so they're directly
    usable as slash invocations (matches Claude Code's display).
    """
    home = Path.home()
    found: dict[str, dict] = {}    # name → skill dict

    # 1. Plugin layer (lowest priority — overridden below).
    #    Driven by installed_plugins.json: plugin roots live under
    #    .../cache/<marketplace>/<plugin>/<version>/ so we can't just
    #    iterate ~/.claude/plugins/* directly.
    for namespace, install_path in _iter_installed_plugins(home):
        source = f"plugin:{namespace}"
        prefix = f"{namespace}:"
        for s in _scan_commands_dir(install_path / "commands", source, name_prefix=prefix):
            found.setdefault(s["name"], s)    # first wins between plugins
        for s in _scan_skills_dir(install_path / "skills", source, name_prefix=prefix):
            found.setdefault(s["name"], s)

    # 2. User-level (overrides plugins).
    for s in _scan_commands_dir(home / ".claude" / "commands", "user"):
        found[s["name"]] = s
    for s in _scan_skills_dir(home / ".claude" / "skills", "user"):
        found[s["name"]] = s

    # 3. Project-level (overrides everything).
    if workspace_path:
        for s in _scan_commands_dir(workspace_path / ".claude" / "commands", "project"):
            found[s["name"]] = s
        for s in _scan_skills_dir(workspace_path / ".claude" / "skills", "project"):
            found[s["name"]] = s

    return sorted(found.values(), key=lambda x: x["name"])
