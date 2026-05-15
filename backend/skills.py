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
  1. Plugin  — walked directly off disk under
               ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
               (was: read installed_plugins.json, but its installPath
               field is unreliable — see _iter_installed_plugins note)
  2. User    — ~/.claude/{commands,skills}/
  3. Project — <workspace>/.claude/{commands,skills}/  (if workspace set)

Plugin items get bare names (`xlsx`, `brainstorming`) rather than the
old `<plugin>:<name>` form. Claude CLI resolves bare names fine, and
on the anthropic-skills marketplace the "plugin name" we'd attach
diverges from what claude itself uses internally (one physical dir,
3 logical plugins). The `source` field still carries `plugin:<name>`
so the PWA can display which plugin a skill came from.
"""
from __future__ import annotations

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
    """Walk ~/.claude/plugins/cache/ to find installed plugin roots.

    Disk layout claude actually uses:
        cache/<marketplace>/<plugin>/<version>/
            ├── commands/
            └── skills/<skill>/SKILL.md

    Yields (plugin_name, install_root) for each plugin found, picking
    the latest-mtime version when multiple coexist.

    History (2026-05-15): previous impl read
    `~/.claude/plugins/installed_plugins.json` and trusted its
    `installPath` field. That broke on prod: 3 of 4 plugins had
    installPath strings pointing at directories that didn't exist on
    disk (anthropic-skills marketplace records its plugins under a
    different name in installed_plugins.json than the directory name
    on disk — the file is canonical for "intent", not for "location").
    Walking the filesystem asks "what's actually installed" without
    relying on stale or wrong metadata.

    Trade-off vs reading marketplace manifests:
      anthropic-skills bundles document-skills/example-skills/claude-api
      as 3 *logical* plugins sharing 1 physical install dir. Without
      reading the marketplace.json we report them as one physical
      plugin (`anthropic-agent-skills`). Skills surface once with bare
      names (`/xlsx` → claude resolves it). We lose "this skill
      belongs to which logical plugin" but gain a simpler list (31
      unique skills, not 65 with 3x duplication).

    Yields nothing when the cache dir doesn't exist (claude has never
    been initialized) — we don't want absence to 500 the skills
    endpoint.
    """
    cache = home / ".claude" / "plugins" / "cache"
    if not cache.is_dir():
        return
    for marketplace_dir in sorted(cache.iterdir()):
        if not marketplace_dir.is_dir() or marketplace_dir.name.startswith("."):
            continue
        for plugin_dir in sorted(marketplace_dir.iterdir()):
            if not plugin_dir.is_dir() or plugin_dir.name.startswith("."):
                continue
            versions = [
                v for v in plugin_dir.iterdir()
                if v.is_dir() and not v.name.startswith(".")
            ]
            if not versions:
                continue
            latest = max(versions, key=lambda p: p.stat().st_mtime)
            # Only yield plugins that actually contain commands or skills,
            # so empty/junk dirs don't pollute the namespace list.
            if (latest / "skills").is_dir() or (latest / "commands").is_dir():
                yield plugin_dir.name, latest


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
    #    Walks ~/.claude/plugins/cache/ directly (see
    #    _iter_installed_plugins note for why installed_plugins.json
    #    is no longer trusted as a source of truth).
    #    No name_prefix: slash skills surface with bare names
    #    (`/xlsx`, `/brainstorming`) which claude resolves correctly,
    #    instead of attaching a `<physical-plugin>:` prefix that may
    #    not match claude's internal display namespace.
    for plugin_name, install_path in _iter_installed_plugins(home):
        source = f"plugin:{plugin_name}"
        for s in _scan_commands_dir(install_path / "commands", source):
            found.setdefault(s["name"], s)    # first wins between plugins
        for s in _scan_skills_dir(install_path / "skills", source):
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
