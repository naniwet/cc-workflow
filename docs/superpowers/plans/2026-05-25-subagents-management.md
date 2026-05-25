# Subagents Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA `#settings/agents` 子页 read/write `~/.claude/agents/*.md`(Claude Code 原生 subagent 文件)— 完整 CRUD,user-global 范围。

**Architecture:** 新模块 `backend/agents_store.py`(hand-roll YAML frontmatter parser + serialize + 4 CRUD function)+ `main.py` 加 3 endpoint(`GET /agents` list 全部、`PUT /agents/{name}` upsert、`DELETE /agents/{name}` 删) + PWA `#settings/agents` 路由 + render + handlers + Settings hub 加卡。

**Tech Stack:** Python 3.13 stdlib(无新依赖,避免 pyyaml)+ FastAPI + Pydantic v2 + `unittest.TestCase` + 原生 JS。

**Spec:** [`docs/superpowers/specs/2026-05-25-subagents-management-design.md`](../specs/2026-05-25-subagents-management-design.md)

---

## File Structure

**Created:**
- `backend/agents_store.py` — `Agent` dataclass + parser/serializer + 4 CRUD function
- `tests/test_agents_store.py` — 9 unit tests
- `tests/test_agents_endpoint.py` — 9 integration tests

**Modified:**
- `backend/main.py` — 3 endpoint + `AgentRequest` Pydantic model + 2 regex constants
- `pwa/app.js` — Settings hub 加 Agents 卡 + `#settings/agents` 路由 + `renderSettingsAgentsView` + edit/save/delete handlers + new-agent form

---

## Task 1: `agents_store.py` — parser + serializer + CRUD + 9 unit tests

**Files:**
- Create: `backend/agents_store.py`
- Create: `tests/test_agents_store.py`

- [ ] **Step 1: 写 9 个失败 unit tests**

Create `tests/test_agents_store.py`:

```python
"""Unit tests for backend/agents_store.py — Claude Code subagent
file CRUD + frontmatter round-trip."""
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import agents_store


@contextmanager
def _patched_dir():
    """临时把 _AGENTS_DIR 指到 tmp 目录。"""
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d) / "agents"
        with patch.object(agents_store, "_AGENTS_DIR", tmp):
            yield tmp


class FrontmatterParserTests(unittest.TestCase):
    def test_parse_three_fields_plus_body(self):
        text = (
            "---\n"
            "name: code-dev\n"
            "description: 代码开发员\n"
            "tools: Read, Edit, Bash\n"
            "---\n"
            "# 你的身份\n\n你是 dev。"
        )
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields["name"], "code-dev")
        self.assertEqual(fields["description"], "代码开发员")
        self.assertEqual(fields["tools"], "Read, Edit, Bash")
        self.assertIn("你是 dev", body)

    def test_parse_no_frontmatter_returns_empty_and_full_body(self):
        text = "no frontmatter just body"
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields, {})
        self.assertEqual(body, text)

    def test_parse_skips_blank_lines_and_comments(self):
        text = (
            "---\n"
            "\n"
            "# this is a comment\n"
            "name: foo\n"
            "---\n"
            "body"
        )
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields, {"name": "foo"})
        self.assertEqual(body, "body")


class SerializerTests(unittest.TestCase):
    def test_roundtrip_preserves_3_fields_and_body(self):
        agent = agents_store.Agent(
            name="t1",
            description="测试 agent",
            tools=["Read", "Bash"],
            system_prompt="body content",
        )
        text = agents_store._serialize(agent)
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields["name"], "t1")
        self.assertEqual(fields["description"], "测试 agent")
        self.assertEqual(fields["tools"], "Read, Bash")
        self.assertEqual(body, "body content")

    def test_roundtrip_preserves_extra_frontmatter(self):
        """e.g. `model:` 字段我们不暴露在 UI,但保留在 file 里 round-trip 不丢。"""
        agent = agents_store.Agent(
            name="t2",
            description="",
            tools=[],
            system_prompt="body",
            extra_frontmatter={"model": "claude-3-opus", "custom": "x"},
        )
        text = agents_store._serialize(agent)
        self.assertIn("model: claude-3-opus", text)
        self.assertIn("custom: x", text)


class ListAgentsTests(unittest.TestCase):
    def test_list_returns_empty_when_dir_missing(self):
        with _patched_dir():
            # 注意 _patched_dir 创建了 tmp/ 但里面 agents/ 不存在
            self.assertEqual(agents_store.list_agents(), [])

    def test_list_returns_parsed_agents(self):
        with _patched_dir() as d:
            d.mkdir()
            (d / "a.md").write_text(
                "---\nname: a\ndescription: A\ntools: Read\n---\nbody A",
                encoding="utf-8",
            )
            (d / "b.md").write_text(
                "---\nname: b\ndescription: B\ntools: Edit, Bash\n---\nbody B",
                encoding="utf-8",
            )
            agents = agents_store.list_agents()
            self.assertEqual(len(agents), 2)
            names = sorted(a.name for a in agents)
            self.assertEqual(names, ["a", "b"])

    def test_list_skips_bad_file_silently(self):
        """坏文件不应该让整个 list 炸 — 用户手编错了某个 file 时其它仍可见。"""
        with _patched_dir() as d:
            d.mkdir()
            (d / "good.md").write_text(
                "---\nname: good\ndescription: ok\ntools:\n---\nbody",
                encoding="utf-8",
            )
            # 写一个 binary file 让 read_text(utf-8) 抛 UnicodeDecodeError
            (d / "bad.md").write_bytes(b"\xff\xfe\x00\x00bin")
            agents = agents_store.list_agents()
            # bad.md 被 skip,good.md 正常返回
            names = [a.name for a in agents]
            self.assertEqual(names, ["good"])


class SaveAgentTests(unittest.TestCase):
    def test_save_atomic_write_round_trip(self):
        with _patched_dir() as d:
            agent = agents_store.Agent(
                name="x", description="desc", tools=["Read"], system_prompt="hi",
            )
            agents_store.save_agent(agent)
            self.assertTrue((d / "x.md").is_file())
            # round-trip via read_agent
            loaded = agents_store.read_agent("x")
            self.assertEqual(loaded.name, "x")
            self.assertEqual(loaded.description, "desc")
            self.assertEqual(loaded.tools, ["Read"])
            self.assertEqual(loaded.system_prompt, "hi")


class DeleteAgentTests(unittest.TestCase):
    def test_delete_existing_returns_true(self):
        with _patched_dir() as d:
            d.mkdir()
            (d / "x.md").write_text(
                "---\nname: x\n---\nbody", encoding="utf-8",
            )
            self.assertTrue(agents_store.delete_agent("x"))
            self.assertFalse((d / "x.md").exists())

    def test_delete_missing_returns_false(self):
        with _patched_dir():
            self.assertFalse(agents_store.delete_agent("nope"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认全失败**

```bash
python3 -m unittest discover -s tests -p 'test_agents_store.py' -v 2>&1 | tail -20
```

Expected: `ModuleNotFoundError: No module named 'backend.agents_store'` × 9。

- [ ] **Step 3: 实现 `backend/agents_store.py`**

Create file with exactly this content:

```python
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
```

- [ ] **Step 4: 跑测试,全绿**

```bash
python3 -m unittest discover -s tests -p 'test_agents_store.py' -v 2>&1 | tail -15
```

Expected: 9/9 pass。

- [ ] **Step 5: 全套件无回归**

```bash
python3 -m unittest discover -s tests 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add backend/agents_store.py tests/test_agents_store.py
git commit -m "$(cat <<'EOF'
feat(agents): 加 agents_store.py — Claude Code subagent CRUD 模块

read/write ~/.claude/agents/*.md。Hand-rolled YAML frontmatter parser
(30 行,避免引入 pyyaml — spec §2.2 / §3.3 复杂度有代价)。Agent
dataclass 含 extra_frontmatter 字段做 round-trip(future-proof,e.g.
`model:` 字段)。

list_agents 坏文件静默 skip(不让单文件错误炸整个列表)。save_agent
atomic tmp + rename。9 unit tests 覆盖:parse 3 路径 / serialize +
round-trip / list 空目录 / list 含坏文件 / save 写盘 / delete 存在
or 不存在。

spec §3.1。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend endpoints + 9 integration tests

**Files:**
- Modify: `backend/main.py`(加 `AgentRequest` Pydantic + 3 endpoint + 2 regex 常量)
- Create: `tests/test_agents_endpoint.py`

- [ ] **Step 1: 写 9 个失败 integration tests**

Create `tests/test_agents_endpoint.py`:

```python
"""Integration tests for /agents endpoints."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth, agents_store


class AgentsEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.agents_dir = Path(self.tmp.name) / "agents"
        self.patches = [
            patch.object(agents_store, "_AGENTS_DIR", self.agents_dir),
        ]
        for p in self.patches:
            p.start()
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    # --- GET /agents ---

    def test_get_returns_empty_when_dir_missing(self):
        r = self.client.get("/agents")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), [])

    def test_get_returns_list_of_agents(self):
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "a.md").write_text(
            "---\nname: a\ndescription: A\ntools: Read\n---\nbody A",
            encoding="utf-8",
        )
        (self.agents_dir / "b.md").write_text(
            "---\nname: b\ndescription: B\ntools: Edit, Bash\n---\nbody B",
            encoding="utf-8",
        )
        r = self.client.get("/agents")
        self.assertEqual(r.status_code, 200)
        agents = r.json()
        self.assertEqual(len(agents), 2)
        names = sorted(a["name"] for a in agents)
        self.assertEqual(names, ["a", "b"])
        # 字段完整
        a = next(a for a in agents if a["name"] == "a")
        self.assertEqual(a["description"], "A")
        self.assertEqual(a["tools"], ["Read"])
        self.assertEqual(a["system_prompt"], "body A")

    # --- PUT /agents/{name} ---

    def test_put_creates_new_agent(self):
        r = self.client.put(
            "/agents/test-one",
            json={"description": "d", "tools": ["Read"], "system_prompt": "p"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        path = self.agents_dir / "test-one.md"
        self.assertTrue(path.is_file())
        content = path.read_text(encoding="utf-8")
        self.assertIn("name: test-one", content)
        self.assertIn("description: d", content)
        self.assertIn("tools: Read", content)
        self.assertIn("p", content)

    def test_put_updates_existing_agent(self):
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "x.md").write_text(
            "---\nname: x\ndescription: old\ntools: Read\n---\nold body",
            encoding="utf-8",
        )
        r = self.client.put(
            "/agents/x",
            json={"description": "new", "tools": ["Bash"], "system_prompt": "new body"},
        )
        self.assertEqual(r.status_code, 200)
        content = (self.agents_dir / "x.md").read_text(encoding="utf-8")
        self.assertIn("description: new", content)
        self.assertIn("tools: Bash", content)
        self.assertIn("new body", content)
        self.assertNotIn("old body", content)

    def test_put_preserves_extra_frontmatter_round_trip(self):
        """已有文件含 model: 等 extra field,PUT 后保留。"""
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "x.md").write_text(
            "---\nname: x\ndescription: d\ntools: Read\nmodel: claude-3-opus\n---\nbody",
            encoding="utf-8",
        )
        r = self.client.put(
            "/agents/x",
            json={"description": "d2", "tools": ["Read"], "system_prompt": "body2"},
        )
        self.assertEqual(r.status_code, 200)
        content = (self.agents_dir / "x.md").read_text(encoding="utf-8")
        self.assertIn("model: claude-3-opus", content)
        self.assertIn("description: d2", content)

    def test_put_rejects_invalid_name(self):
        r = self.client.put(
            "/agents/Invalid_Name",
            json={"description": "d", "tools": [], "system_prompt": "p"},
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("invalid agent name", r.text)

    def test_put_rejects_invalid_tool(self):
        r = self.client.put(
            "/agents/ok-name",
            json={"description": "d", "tools": ["BadTool!"], "system_prompt": "p"},
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("invalid tool", r.text)

    # --- DELETE /agents/{name} ---

    def test_delete_removes_existing(self):
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "x.md").write_text(
            "---\nname: x\n---\nbody", encoding="utf-8",
        )
        r = self.client.delete("/agents/x")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse((self.agents_dir / "x.md").exists())

    def test_delete_missing_returns_404(self):
        r = self.client.delete("/agents/never-existed")
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认全失败**

```bash
python3 -m unittest discover -s tests -p 'test_agents_endpoint.py' -v 2>&1 | tail -20
```

Expected: 9 × 404(endpoints 不存在)or 405 / 422 之类的非 200 状态。

- [ ] **Step 3: 实现 endpoints in `backend/main.py`**

In `backend/main.py`,find a good location near `put_role_models`(end of role-models section)or `list_roundtable_models`. Add:

**3a. Top-level imports** — add `from . import agents_store` near other roundtable / role imports:

```bash
grep -n "from .roundtable import role_models_store" backend/main.py
```

After that line, add:

```python
from . import agents_store
```

**3b. 加 Pydantic model + 2 regex constants + 3 endpoint** — find an appropriate location after the role-models endpoints (search `def put_role_models`):

```python
# ============================================================================
# Subagents management(~/.claude/agents/*.md)— spec §3.2
# ============================================================================

_AGENT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_TOOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


class AgentRequest(BaseModel):
    description: str = Field(default="", max_length=500)
    tools: list[str] = Field(default_factory=list, max_length=50)
    system_prompt: str = Field(default="", max_length=50_000)


@app.get("/agents", dependencies=PROTECT)
def list_agents() -> list[dict]:
    """List all user-global subagents in ~/.claude/agents/."""
    import dataclasses
    return [dataclasses.asdict(a) for a in agents_store.list_agents()]


@app.put("/agents/{name}", dependencies=PROTECT)
def put_agent(name: str, req: AgentRequest) -> dict:
    """Create or update a subagent。Atomic write。"""
    if not _AGENT_NAME_RE.match(name):
        raise HTTPException(400, {
            "error": "invalid agent name",
            "must_match": _AGENT_NAME_RE.pattern,
            "got": name,
        })
    for t in req.tools:
        if not _TOOL_NAME_RE.match(t):
            raise HTTPException(400, {
                "error": "invalid tool name",
                "got": t,
            })
    # round-trip 保留 extra_frontmatter(已有文件的 `model:` 等)
    existing = agents_store.read_agent(name)
    extras = existing.extra_frontmatter if existing else {}
    agents_store.save_agent(agents_store.Agent(
        name=name,
        description=req.description,
        tools=req.tools,
        system_prompt=req.system_prompt,
        extra_frontmatter=extras,
    ))
    return {"ok": True, "name": name}


@app.delete("/agents/{name}", dependencies=PROTECT)
def delete_agent(name: str) -> dict:
    if not _AGENT_NAME_RE.match(name):
        raise HTTPException(400, {"error": "invalid agent name", "got": name})
    removed = agents_store.delete_agent(name)
    if not removed:
        raise HTTPException(404, {"error": "agent not found", "name": name})
    return {"ok": True, "name": name}
```

- [ ] **Step 4: 跑测试**

```bash
python3 -m unittest discover -s tests -p 'test_agents_endpoint.py' -v 2>&1 | tail -15
```

Expected: 9/9 pass。

- [ ] **Step 5: 全套件无回归**

```bash
python3 -m unittest discover -s tests 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_agents_endpoint.py
git commit -m "$(cat <<'EOF'
feat(main): 加 /agents endpoints — list / put / delete subagents

3 个 endpoint:
- GET /agents — 返回 ~/.claude/agents/*.md 全部 agent(空目录 → [])
- PUT /agents/{name} — create or update(REST upsert)。验证 name 合法
  (^[a-z0-9][a-z0-9-]{0,63}$)+ 每个 tool 是合法 identifier。已有文件
  的 extra_frontmatter(如 model:)round-trip 保留 — 不擦用户手编字段。
- DELETE /agents/{name} — unlink,not found → 404

9 个 integration tests 覆盖空目录 / list / 新建 / 更新 / extra round-trip
/ 非法名 400 / 非法 tool 400 / delete 存在 / delete 不存在。

spec §3.2。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: PWA `#settings/agents` page + Settings hub card

**Files:**
- Modify: `pwa/app.js`

PWA 无自动化测试 — `node --check` + ssh 实测。

- [ ] **Step 1: Settings hub 加 Agents 卡**

Find `renderSettingsView` in `pwa/app.js`(search `<a class="settings-card" href="#settings/providers">`). After the Providers card,add:

```html
<a class="settings-card" href="#settings/agents">
  <div class="settings-card-title"><strong>Subagents</strong></div>
  <div class="muted">管理 <code>~/.claude/agents/</code> 下的 Claude Code 子代理(code-dev / code-review / 你自己加的)</div>
</a>
```

- [ ] **Step 2: Dispatcher 加 agents 分支**

Find `renderSettingsSectionView`:

```javascript
function renderSettingsSectionView(section) {
  if (section === 'providers') return renderSettingsProvidersView();
  if (section === 'roles') return renderSettingsRolesView();
  if (section === 'agents') return renderSettingsAgentsView();    // ← 新
  ...
}
```

- [ ] **Step 3: 实现 `renderSettingsAgentsView` + 4 个 handler**

Find end of `_onRolePromptReset`(or any place after the roles handlers). Add module-level:

```javascript
// ---- #settings/agents — Claude Code subagent CRUD ---- //

async function renderSettingsAgentsView() {
  const view = $('view');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link">← Settings</a></p>
    <h3 style="margin:0 0 var(--space-2)">Subagents</h3>
    <p class="muted" style="margin:0 0 var(--space-3)">
      管理 user-global subagents(<code>~/.claude/agents/*.md</code>)。改完 Claude Code 立刻生效,无需重启 backend。
    </p>
    <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap">
      <button class="ws-new-btn" id="agent-new-btn" type="button">+ New agent</button>
    </div>
    <div id="agents-list" class="muted">加载中...</div>`;

  let agents;
  try {
    agents = await api('/agents');
  } catch (err) {
    $('agents-list').innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    return;
  }

  if (agents.length === 0) {
    $('agents-list').innerHTML = `<p class="muted">还没有 subagent。点 "+ New agent" 加一个,或 ssh 在 ~/.claude/agents/ 手编。</p>`;
  } else {
    $('agents-list').innerHTML = agents.map(_renderAgentCard).join('');
  }

  // Bind events
  $('agent-new-btn').addEventListener('click', _onAgentNewClick);
  for (const btn of document.querySelectorAll('.agent-save-btn')) {
    btn.addEventListener('click', _onAgentSave);
  }
  for (const btn of document.querySelectorAll('.agent-delete-btn')) {
    btn.addEventListener('click', _onAgentDelete);
  }
}

function _renderAgentCard(agent, isNew = false) {
  const nameHtml = isNew
    ? `<input data-agent-field="name" placeholder="新 agent 名(小写字母/数字/-)" pattern="[a-z0-9][a-z0-9-]*" required style="font-weight:bold;font-size:14px;padding:4px 6px">`
    : `<strong>${esc(agent.name)}</strong>`;
  const summaryDesc = isNew ? '<span class="muted">(新建)</span>' : `<span class="muted" style="font-size:12px;margin-left:8px">${esc(agent.description || '(no description)')}</span>`;
  const deleteBtn = isNew ? '' : `<button class="ws-new-btn agent-delete-btn" data-name="${esc(agent.name)}" type="button" style="background:transparent;color:var(--c-fg)">删除</button>`;
  return `
    <div class="agent-card" data-name="${esc(agent.name)}" data-is-new="${isNew ? '1' : '0'}"
         style="margin-bottom:var(--space-3);padding:var(--space-2);border:1px solid var(--c-border, #333);border-radius:6px">
      <details ${isNew ? 'open' : ''}>
        <summary style="cursor:pointer;user-select:none;list-style:none">
          ${nameHtml}
          ${summaryDesc}
        </summary>
        <div style="margin-top:var(--space-2);display:flex;flex-direction:column;gap:var(--space-2)">
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">description(main agent 看这个决定要不要 dispatch)</div>
            <textarea data-agent-field="description" rows="3"
                      style="width:100%;font-size:12px;box-sizing:border-box;resize:vertical">${esc(agent.description || '')}</textarea>
          </label>
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">tools(逗号分隔 — Read, Edit, Bash, Glob, Grep, WebFetch, Skill 等)</div>
            <input data-agent-field="tools" type="text"
                   style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;padding:4px 6px"
                   value="${esc((agent.tools || []).join(', '))}">
          </label>
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">system_prompt(markdown)</div>
            <textarea data-agent-field="system_prompt" rows="20"
                      style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;resize:vertical">${esc(agent.system_prompt || '')}</textarea>
          </label>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button class="ws-new-btn agent-save-btn" data-name="${esc(agent.name)}" type="button">保存</button>
            ${deleteBtn}
          </div>
        </div>
      </details>
    </div>`;
}

function _onAgentNewClick() {
  // 在 list 顶部 prepend 一张空卡片(isNew=true)
  const list = $('agents-list');
  // 如果 list 当前显示的是"还没有 subagent..." 文案,先清空
  if (list.querySelector('.agent-card') === null) {
    list.innerHTML = '';
  }
  const emptyAgent = { name: '', description: '', tools: [], system_prompt: '' };
  list.insertAdjacentHTML('afterbegin', _renderAgentCard(emptyAgent, true));
  const newCard = list.querySelector('.agent-card[data-is-new="1"]');
  newCard.querySelector('input[data-agent-field="name"]')?.focus();
  // 重新 bind 这张新卡的 save handler(delete 没有,新建不可删)
  newCard.querySelector('.agent-save-btn')?.addEventListener('click', _onAgentSave);
}

async function _onAgentSave(e) {
  const btn = e.currentTarget;
  const card = btn.closest('.agent-card');
  if (!card) return;
  const isNew = card.dataset.isNew === '1';
  let name;
  if (isNew) {
    const nameInput = card.querySelector('input[data-agent-field="name"]');
    name = (nameInput?.value || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      showError('agent name 必须匹配 [a-z0-9][a-z0-9-]* 且 ≤64 字');
      nameInput?.focus();
      return;
    }
  } else {
    name = btn.dataset.name;
  }

  const desc = card.querySelector('textarea[data-agent-field="description"]').value;
  const toolsRaw = card.querySelector('input[data-agent-field="tools"]').value;
  const tools = toolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const promptText = card.querySelector('textarea[data-agent-field="system_prompt"]').value;

  btn.disabled = true; btn.textContent = '保存中...';
  try {
    await api(`/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: desc, tools, system_prompt: promptText,
      }),
    });
    showToast('success', `agent "${name}" 已保存`, { ttl: 2500 });
    renderSettingsAgentsView();   // 刷新整页
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function _onAgentDelete(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.name;
  if (!confirm(`确定删除 subagent "${name}"?\n\n这会删 ~/.claude/agents/${name}.md 文件,Claude Code 之后不再认识这个 agent。`)) {
    return;
  }
  btn.disabled = true; btn.textContent = '删除中...';
  try {
    await api(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('success', `agent "${name}" 已删除`, { ttl: 2500 });
    renderSettingsAgentsView();
  } catch (err) {
    showError(`删除失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '删除';
  }
}
```

- [ ] **Step 4: 语法 check**

```bash
node --check pwa/app.js && echo OK
```

Expected: OK。

- [ ] **Step 5: Commit**

```bash
git add pwa/app.js
git commit -m "$(cat <<'EOF'
feat(pwa): 加 #settings/agents 页 — Claude Code subagent CRUD UI

Settings hub 加 "Subagents" 卡(跟 Providers / Roundtable Roles 同级)。
路由 #settings/agents 进入页面,展示 ~/.claude/agents/*.md 全部 agent
作为可折叠卡片;每张卡 4 个字段:name(只新建可编)/ description /
tools(逗号分隔)/ system_prompt(textarea rows=20 monospace)。

"+ New agent" 按钮在 list 顶 prepend 一张空卡。Save 调 PUT /agents/{name}
(create + update);Delete 调 DELETE /agents/{name}(有 confirm)。
保存 / 删除成功后 renderSettingsAgentsView() 全页刷新 — 显示状态跟
存盘一致(避免内存草稿跟文件漂移)。

Tools 输入是简单 comma-separated text(不做 multi-select widget,
spec §7 YAGNI),backend 验证每个 token 是合法 identifier。

spec §3.3。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 整体 smoke + final review

- [ ] **Step 1: full test battery**

```bash
python3 -m py_compile backend/*.py backend/roundtable/*.py && echo "py_compile OK"
python3 -m unittest discover -s tests 2>&1 | tail -5
node --check pwa/app.js && echo "pwa OK"
node --test tests/pwa-ui-contract.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)" | head
```

Expected:
- py_compile OK
- 全部测试 pass(80 prior + 9 store + 9 endpoint = 98)
- node check OK
- 18 pwa contract pass

- [ ] **Step 2: 用户手测说明**

ssh 上服务器:
1. `git pull && systemctl daemon-reload && systemctl restart cc-workflow`
2. PWA 打开 `#settings` → 看到 "Subagents" 卡
3. 点进去 → 看到现有 agents(如 code-dev / code-review)
4. 展开 code-dev → 改 description 一行 → 点保存 → toast + 页面刷新,新值仍在
5. ssh `cat ~/.claude/agents/code-dev.md | head -10` 验证文件已变,frontmatter 完整
6. 点 "+ New agent" → 输入 `tester` → desc / tools / prompt → 保存 → ssh 看 `~/.claude/agents/tester.md` 出现
7. 在 PWA 删掉 tester → ssh 看文件消失
8. 在某个 workspace 里跑 claude → 让它 Task tool dispatch 给 code-dev / code-review → 验证 customized prompt 生效(质量验证)

---

## Self-Review

**Spec coverage check:**

| Spec 章节 | Plan task |
|---|---|
| §3.1 agents_store.py | Task 1 |
| §3.2 endpoints + Pydantic + validation | Task 2 |
| §3.3 PWA #settings/agents 页 + Settings hub 卡 | Task 3 |
| §4 错误处理(空目录 / 坏文件 / 非法名 / 非法 tool / 404) | Task 1 + 2 测试覆盖 |
| §5 测试(9 store + 9 endpoint) | Task 1 + 2 |

✓ 全覆盖。

**Placeholder scan:** 无 TBD / TODO。每段代码完整可粘。

**Type consistency:**
- `Agent` dataclass — Task 1 定义,Task 2 endpoint 用 `dataclasses.asdict(a)` 序列化 — 一致 ✓
- `AgentRequest.tools: list[str]` ↔ PWA 发 `tools: tools` 数组 — 一致 ✓
- `_AGENT_NAME_RE` 在 Task 2(backend)+ Task 3(PWA 前端预校验)同一 regex `^[a-z0-9][a-z0-9-]{0,63}$` — 一致 ✓
- endpoint URL `/agents` + `/agents/{name}` — Task 2 backend + Task 3 PWA `api('/agents'...)` 一致 ✓
- field 名 `description` / `tools` / `system_prompt` — backend + PWA 全部 wire shape 一致 ✓
