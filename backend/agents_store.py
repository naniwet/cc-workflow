"""Claude Code subagent management(user-global `~/.claude/agents/*.md`)。

Format:每个文件 YAML frontmatter + markdown body:
    ---
    name: code-dev
    description: ...
    tools: Read, Edit, Bash
    ---

    [markdown system_prompt body]

Hand-rolled parser — 不引入 pyyaml(spec §2.2):frontmatter 就 3 个
flat string field(name / description / tools)+ 可选 model 等(我们
不渲染但 round-trip 保留)。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

_AGENTS_DIR = Path.home() / ".claude" / "agents"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


@dataclass
class Agent:
    name: str
    description: str = ""
    tools: list[str] = field(default_factory=list)
    system_prompt: str = ""
    # 保留未识别的 frontmatter field(round-trip 不丢数据,e.g. `model:`)
    extra_frontmatter: dict[str, str] = field(default_factory=dict)


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Parse '---\\n<yaml>\\n---\\n<body>' → ({fields}, body)。
    没 frontmatter → ({}, full text)。"""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw, body = m.group(1), m.group(2)
    fields_out: dict[str, str] = {}
    for line in raw.split("\n"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        fields_out[key.strip()] = val.strip()
    return fields_out, body


def _serialize(agent: Agent) -> str:
    """Agent → file content。固定顺序 name / description / tools / extras。
    extras 按 key 字母序保证 round-trip 稳定。"""
    lines = [
        "---",
        f"name: {agent.name}",
        f"description: {agent.description}",
        f"tools: {', '.join(agent.tools)}",
    ]
    for key in sorted(agent.extra_frontmatter):
        lines.append(f"{key}: {agent.extra_frontmatter[key]}")
    lines.append("---")
    lines.append("")
    return "\n".join(lines) + agent.system_prompt


def _read_agent_file(path: Path) -> Agent:
    text = path.read_text(encoding="utf-8")
    fields_out, body = _parse_frontmatter(text)
    tools_raw = fields_out.pop("tools", "")
    tools = [t.strip() for t in tools_raw.split(",") if t.strip()]
    name = fields_out.pop("name", path.stem)
    description = fields_out.pop("description", "")
    return Agent(
        name=name,
        description=description,
        tools=tools,
        system_prompt=body,
        extra_frontmatter=fields_out,
    )


def list_agents() -> list[Agent]:
    """List all subagents in ~/.claude/agents/。dir 不存在返回 [];
    坏文件静默 skip(让其它 agent 仍可见,而不是整个列表炸)。"""
    if not _AGENTS_DIR.is_dir():
        return []
    out: list[Agent] = []
    for path in sorted(_AGENTS_DIR.glob("*.md")):
        try:
            out.append(_read_agent_file(path))
        except (OSError, ValueError, UnicodeDecodeError):
            continue
    return out


def read_agent(name: str) -> Agent | None:
    """Read one by name。Not found / 非法名 → None。"""
    if not _NAME_RE.match(name):
        return None
    path = _AGENTS_DIR / f"{name}.md"
    if not path.is_file():
        return None
    try:
        return _read_agent_file(path)
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def save_agent(agent: Agent) -> None:
    """Atomic tmp + rename。Caller 已经验证过 name / tools(endpoint 那层)。"""
    _AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _AGENTS_DIR / f"{agent.name}.md"
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(_serialize(agent), encoding="utf-8")
    os.replace(tmp, path)


def delete_agent(name: str) -> bool:
    """Unlink。Return True if removed, False if not found / 非法名。"""
    if not _NAME_RE.match(name):
        return False
    path = _AGENTS_DIR / f"{name}.md"
    if not path.is_file():
        return False
    path.unlink()
    return True
