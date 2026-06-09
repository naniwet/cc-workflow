# Subagents Management — Design

**Date:** 2026-05-25
**Status:** Approved for implementation (pending user review of this doc)
**Scope:** PWA 加 `#settings/agents` 子页管理 `~/.claude/agents/*.md`(user-global 范围)— 完整 CRUD(list / edit / create / delete)。不发明新概念,只是不用 ssh 就能编辑 Claude Code 原生 subagent 文件。

---

## 1. Motivation

用户已经手工建了 `code-dev` / `code-reviewer` 两个 subagent(分工:dev 写代码 + 测试,review 独立审计)。Claude Code 引擎自动读 `~/.claude/agents/*.md`,main agent 通过 Task tool dispatch 给它们。

**痛点:** 编辑这些 agent 文件要 ssh + vim:
- prompt tune 不顺手
- 想加新 agent(比如 `tester` / `docs-writer`)要敲命令
- 不同 prompt 版本无法快速对比

**目标:** PWA `#settings/agents` 子页提供完整 CRUD,管理 user-global subagents。

**非目标(spec §7):**
- per-workspace agents(`<workspace>/.claude/agents/`)— YAGNI,user-global 价值最大
- subagent 调度 / 触发 — 那是 Claude Code 引擎的事
- markdown 预览 / 语法高亮 — UI 复杂度不值
- 版本历史 / undo

---

## 2. Approach: 直接 read/write Claude Code 原生文件

### 2.1 数据模型 — 复用 Claude Code 已有的 `.md` 格式

每个 subagent 是一个 `.md` 文件:

```markdown
---
name: code-reviewer
description: 独立审计员 subagent. Use when...
tools: Read, Glob, Grep, Bash
---

# 你的身份
...
```

YAML frontmatter 之间是 `---` markers,后面是 markdown body(= system_prompt)。

**字段:**

| 字段 | 类型 | 限制 |
|---|---|---|
| `name` | filesafe string | `^[a-z0-9][a-z0-9-]{0,63}$`(filename 用) |
| `description` | string | max 500 chars(main agent 看这个决定要不要 dispatch) |
| `tools` | comma-separated string | 各 token `^[A-Za-z][A-Za-z0-9_]*$`(包括 `mcp__*`)|
| `system_prompt`(body) | markdown | max 50,000 chars(prompt 一般几百到几千字符,留 10x 余量)|

### 2.2 几乎不可逆决策(§3.2 第 1 级)

| 决策 | 选择 | 理由 |
|---|---|---|
| 文件路径 | `~/.claude/agents/<name>.md` | Claude Code 引擎认这个路径 — 没有别的选择 |
| Frontmatter 格式 | YAML(stdlib 不带,**hand-roll 简单 parser**)| 字段就 3 个 flat key:value,~30 行 parser 够。避免引入 pyyaml 依赖(§3.3 复杂度有代价)|
| 不接受 `model` field | YAML 里如果有 `model:`,parser 静默丢(不强报错) | 跟 Claude Code 自己的处理对齐:Claude Code 接受 model field,但我们的 UI 不暴露(YAGNI)。保留它就 round-trip 不丢数据 |
| 范围 | 仅 user-global,不做 per-workspace(Q1=a)| YAGNI;两层引擎都读,user-global 改动覆盖面广 |
| PWA 路由 | `#settings/agents` | 跟 `#settings/providers` 同级 |
| 完整 CRUD | List + Edit + Create + Delete(Q3=c)| 文件操作不复杂,完整 CRUD 比 ssh+vim 节省时间 |
| 多 file 修改顺序 | 一次保存只动一个 file | 避免 partial-write 半成品状态;简单且符合 §1 Unix 单一职责 |

### 2.3 数据流

```
PWA #settings/agents
   ↓ GET /agents
backend agents_store.list_agents()
   → scan ~/.claude/agents/*.md
   → parse each (frontmatter + body)
   → return [{name, description, tools[], system_prompt}, ...]
   ↓
PWA 渲染列表 + 每个 agent 一张可折叠卡

[User clicks Edit + Save]
   ↓ PUT /agents/{name}
backend agents_store.save_agent({...})
   → validate
   → atomic tmp + rename → ~/.claude/agents/{name}.md
   → 返回保存后的 agent

[User clicks "+ New"]
   ↓ PWA 弹空 form,Save 走 PUT
   ↓ backend 验证 name 不冲突(否则 409)

[User clicks Delete]
   ↓ DELETE /agents/{name}
backend agents_store.delete_agent(name)
   → unlink ~/.claude/agents/{name}.md
   → 返回 {ok: true}
```

### 2.4 跟 PWA 现有模块的关系

类似 `#settings/roles` 跟 role_models_store 的关系:
- backend 新模块 `agents_store.py`(纯 file IO + 验证)
- backend `main.py` 加 4 个 endpoint
- PWA `#settings/agents` 路由 + render function + handlers
- **没有任何 cross-feature 耦合** — subagents 跟 roundtable role overrides 是两套东西

---

## 3. Components

### 3.1 `backend/agents_store.py` — 新模块

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
flat string field(name / description / tools)+ 可选 model(我们不
渲染但 round-trip 保留)。
"""
from __future__ import annotations

import re
import os
from dataclasses import dataclass, field
from pathlib import Path

_AGENTS_DIR = Path.home() / ".claude" / "agents"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_TOOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


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
    fields: dict[str, str] = {}
    for line in raw.split("\n"):
        if not line.strip() or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        fields[key.strip()] = val.strip()
    return fields, body


def _serialize(agent: Agent) -> str:
    """Agent → file content。保留 extra_frontmatter 字段,顺序固定为
    name / description / tools / <extras 按字母序>。"""
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


def list_agents() -> list[Agent]:
    """List all subagents in ~/.claude/agents/。dir 不存在返回 []。"""
    if not _AGENTS_DIR.is_dir():
        return []
    out: list[Agent] = []
    for path in sorted(_AGENTS_DIR.glob("*.md")):
        try:
            agent = _read_agent_file(path)
            out.append(agent)
        except (OSError, ValueError):
            # 坏文件静默 skip(可能用户手编错了),不应 break 整个 list
            continue
    return out


def _read_agent_file(path: Path) -> Agent:
    text = path.read_text(encoding="utf-8")
    fields, body = _parse_frontmatter(text)
    tools_raw = fields.pop("tools", "")
    tools = [t.strip() for t in tools_raw.split(",") if t.strip()]
    name = fields.pop("name", path.stem)
    description = fields.pop("description", "")
    return Agent(
        name=name,
        description=description,
        tools=tools,
        system_prompt=body,
        extra_frontmatter=fields,
    )


def read_agent(name: str) -> Agent | None:
    """Read one by name。Not found → None。"""
    if not _NAME_RE.match(name):
        return None
    path = _AGENTS_DIR / f"{name}.md"
    if not path.is_file():
        return None
    return _read_agent_file(path)


def save_agent(agent: Agent) -> None:
    """Atomic tmp + rename。Caller 已经验证过 name / tools。"""
    _AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _AGENTS_DIR / f"{agent.name}.md"
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(_serialize(agent), encoding="utf-8")
    os.replace(tmp, path)


def delete_agent(name: str) -> bool:
    """Unlink。Return True if removed, False if not found。"""
    if not _NAME_RE.match(name):
        return False
    path = _AGENTS_DIR / f"{name}.md"
    if not path.is_file():
        return False
    path.unlink()
    return True
```

### 3.2 Backend endpoints(`backend/main.py`)

```python
class AgentRequest(BaseModel):
    description: str = Field(default="", max_length=500)
    tools: list[str] = Field(default_factory=list, max_length=50)
    system_prompt: str = Field(default="", max_length=50_000)


_AGENT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_TOOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


@app.get("/agents", dependencies=PROTECT)
def list_agents() -> list[dict]:
    """List all user-global subagents in ~/.claude/agents/."""
    return [dataclasses.asdict(a) for a in agents_store.list_agents()]


@app.put("/agents/{name}", dependencies=PROTECT)
def put_agent(name: str, req: AgentRequest) -> dict:
    """Create or update a subagent。Atomic write。"""
    if not _AGENT_NAME_RE.match(name):
        raise HTTPException(400, {"error": "invalid agent name",
                                  "must_match": _AGENT_NAME_RE.pattern})
    for t in req.tools:
        if not _TOOL_NAME_RE.match(t):
            raise HTTPException(400, {"error": "invalid tool name", "got": t})
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
        raise HTTPException(400, {"error": "invalid agent name"})
    removed = agents_store.delete_agent(name)
    if not removed:
        raise HTTPException(404, {"error": "agent not found", "name": name})
    return {"ok": True, "name": name}
```

注意:**没有 POST /agents**(用 PUT /agents/{name} 同时担任 create + update)。这是 standard REST upsert,简化 API surface。

### 3.3 PWA `#settings/agents` 页

**路由 + dispatcher:**

```javascript
// renderSettingsView 加一张卡:
<a class="settings-card" href="#settings/agents">
  <div class="settings-card-title"><strong>Subagents</strong></div>
  <div class="muted">管理 ~/.claude/agents/ 下的 Claude Code 子代理(code-dev / code-reviewer / 你自己加的)</div>
</a>

// renderSettingsSectionView 加 dispatch:
if (section === 'agents') return renderSettingsAgentsView();
```

**`renderSettingsAgentsView`(`pwa/app.js`):**

```html
<p><a href="#settings" class="back-link">← Settings</a></p>
<h3>Subagents</h3>
<p class="muted">管理 user-global subagents(`~/.claude/agents/*.md`)。改完 Claude Code 立刻生效,无需重启 backend。</p>

<div style="display:flex;gap:8px;margin-bottom:12px">
  <button class="ws-new-btn" id="agent-new-btn">+ New agent</button>
</div>

<div id="agents-list">
  <!-- 每个 agent 一张卡 -->
  <div class="agent-card" data-name="code-dev">
    <details>
      <summary>
        <strong>code-dev</strong>
        <span class="muted">代码开发员 subagent...</span>
      </summary>
      <!-- expanded:edit form -->
      <label>description<textarea data-agent-field="description" rows="3">...</textarea></label>
      <label>tools(逗号分隔)<input data-agent-field="tools" value="Read, Edit, Bash..."></label>
      <label>system_prompt<textarea data-agent-field="system_prompt" rows="20" style="font-family:monospace">...</textarea></label>
      <div>
        <button class="ws-new-btn agent-save-btn" data-name="code-dev">保存</button>
        <button class="ws-new-btn agent-delete-btn" data-name="code-dev" style="background:transparent;color:var(--c-fg)">删除</button>
      </div>
    </details>
  </div>
  <!-- ... more cards ... -->
</div>
```

**"+ New agent" 行为:** 弹一个空卡片(临时,DOM 里),name 是 text input(只有新建时可编辑;已有 agent name 是 readonly),Save 时校验 name 不冲突再 PUT。

**Tools input:** 简单 comma-separated text input。placeholder 显示 `Read, Edit, Bash, Glob, Grep`,backend 验证每个 token 是合法 identifier。**不做 multi-select widget**(v1 YAGNI)。

### 3.4 测试

#### 3.4.1 `tests/test_agents_store.py`(新文件)— 9 unit tests

- `_parse_frontmatter` 正常路径(3 个 field + body)
- `_parse_frontmatter` 无 frontmatter(全部 body)
- `_parse_frontmatter` 注释行 / 空行被 skip
- `_serialize` round-trip(parse → serialize → parse 等价)
- `_serialize` 保留 `extra_frontmatter`(round-trip 不丢 `model:` 等)
- `list_agents()` 目录不存在返回 []
- `list_agents()` 含坏文件 → skip 不抛
- `save_agent` atomic write(tmp + replace)
- `delete_agent` 删存在 / 不存在

#### 3.4.2 `tests/test_agents_endpoint.py`(新文件)— 7 integration tests

- `GET /agents` 空目录 → `[]`
- `GET /agents` 含 2 个文件 → 返回 2 个 Agent dict
- `PUT /agents/<name>` 新建 → 200 + 文件落盘
- `PUT /agents/<name>` 更新已有 → 200 + 内容刷新
- `PUT /agents/<bad-name>` → 400 invalid name
- `PUT /agents/<name>` tools 含非法 token → 400 invalid tool
- `DELETE /agents/<name>` 删存在 → 200
- `DELETE /agents/<name>` 删不存在 → 404
- `PUT` 时已有 agent 含 `model:` extra → save 后 round-trip 保留

(其实是 9 个,先列 7 个核心)

---

## 4. Error Handling

| 场景 | 处理 |
|---|---|
| `~/.claude/agents/` 不存在 | `list_agents()` 返回 `[]`(可能 Claude Code 还没初始化过)|
| `~/.claude/agents/<x>.md` 坏 frontmatter | `_read_agent_file` 尽量 parse;无 frontmatter → 空 fields + 全 body;parse error 在 `list_agents()` 静默 skip |
| `PUT /agents/<name>` name 非法 | 400 |
| `PUT /agents/<name>` tools 含非法 token | 400(精确指出哪个) |
| `PUT` system_prompt > 50KB | Pydantic 自动 422 |
| `DELETE` 文件不存在 | 404 |
| 文件 write 失败(权限 / 磁盘满) | 500 + OSError 内容 |
| 并发 PUT 同 agent | atomic tmp+rename,最后写的赢(同 ws_settings 模式,单用户单机 acceptable) |

---

## 5. Testing 总结

总 16 个测试(9 store + 7 endpoint;实际可能 8-10 个 endpoint 看边界扩 case)。

Non-goals(不测):
- PWA UI 渲染 — 无自动化设施
- 真实 Claude Code 集成(改 agent → Claude 引擎下次 invocation 看到新 prompt)— Claude Code 自己的事,不在我们覆盖面

---

## 6. Migration & Rollout

- **零迁移** — 新功能,无旧数据
- **回滚** — 删 4 个 endpoint + agents_store.py + PWA 页 + settings hub 卡。文件 `~/.claude/agents/*.md` 留盘,Claude Code 继续读它们
- **依赖顺序** — 先 store 模块(Task 1)→ endpoint(Task 2)→ PWA(Task 3)

---

## 7. Non-Goals (YAGNI)

- ❌ per-workspace agents(Q1=a,user-global only)
- ❌ Tools multi-select UI(逗号分隔文本输入够用)
- ❌ Markdown preview / syntax highlight 编辑器
- ❌ 拖拽排序 agents
- ❌ Import / export agents(用户 ssh `cp` 即可)
- ❌ 版本历史 / undo
- ❌ Frontmatter `model:` 字段编辑(不暴露在 UI,但 round-trip 保留)
- ❌ Dispatch / invoke agents from PWA — 那是 Claude Code 引擎自己干的事

---

## 8. 工程方法论自检(CLAUDE.md §4)

| 原则 | 检查 |
|---|---|
| §0 沟通 | 3 个关键决策(Q1=a / Q2=a / Q3=c)已显式 Q&A 钉死;extra_frontmatter round-trip 保留的语义说清 |
| §1 Unix | `agents_store.py` 一个职责:read/write `.md` 文件;parser 不偷玩(就 30 行);不做 BaseStorage 抽象 |
| §2 TDD | 全部 file IO + 纯函数 parse / serialize,5 分钟可 unit;endpoint 也是经典 TestClient + temp dir |
| §3.1 trade-off | hand-roll YAML parser vs 引入 pyyaml — §2.2 已列。spec §2.3 没有第三方依赖比依赖 update 风险小 |
| §3.2 反悔成本 | 文件路径(`.claude/agents/`)受 Claude Code 引擎限制,不可逆但**不是我们的决定**;PWA 路由 / endpoint URL 是几乎不可逆(§3.2 第 1 级),spec 钉死 |
| §3.3 复杂度 | 不引入 pyyaml(配置文件 deps 长期维护成本)、不做 multi-select widget、不做 markdown preview |
| §3.4 通用语言 | `subagent` / `agent` 跟 Claude Code 官方一致(Anthropic 文档用 "subagent");PWA UI 用 "Subagents",中文备注但术语不翻 |
