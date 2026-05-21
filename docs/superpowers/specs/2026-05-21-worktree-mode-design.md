# Worktree Mode — Design

**Date:** 2026-05-21
**Status:** Approved for implementation
**Scope:** Per-workspace toggle to disable git worktree isolation for workspaces that don't need it (笔记 / 文档仓库).

---

## 1. Motivation

当前 `agent-run.sh:354-367` 的规则:**`session_key != "default"` → 建独立 git worktree**(`~/workspaces/.wt/<ws>-<key>/`) + 分支(`cc/<ws>-<key>`)。

4 个触发源默认 `session_key`:

| 触发源 | session_key | worktree |
|---|---|---|
| PWA `Run` | `pwa-<ws>` | ✓ |
| 飞书 `@bot` | `feishu-<chat_id>` | ✓ |
| 飞书 `/run` & cron loop | loop name | ✓ |
| 直接 `POST /run` 不传 | `null` → `default` | ✗ |

**问题:** 部分 workspace(笔记、文档、单分支线性提交的仓库)根本不需要分支隔离 —— worktree 反而带来 `.wt/` 目录维护、`cc/*` 分支堆积、`merge_pwa_to_main` 手动操作等负担。

**目标:** workspace 配置加一个开关,关掉 worktree 模式后所有 run 直接落主目录。

---

## 2. Approach: Backend-Layer Session-Key Squash

### 2.1 选定方案的理由(对比 3 个候选)

| 方案 | 改动面 | session 隔离 | 选 / 不选 |
|---|---|---|---|
| **A. backend 重写 session_key** | NewWorkspaceRequest +1 字段、`workspaces.json` +1 字段、`runner.submit()` +3 行、PWA 表单 +1 控件、`agent-run.sh` **零改动** | 关 worktree 时所有触发源共用同一个 claude session(off 模式语义对齐) | ✅ **选这个** |
| B. `agent-run.sh --no-worktree` flag | 改 `agent-run.sh` signature → 必须 ssh 跑 acceptance | session 仍按触发源隔离 | ❌ 改关键路径风险 / 当前需求用不上 |
| C. `agent-run.sh --workdir=<path>` 显式参数 | 改动最大 | 最干净的层次划分 | ❌ §3.3 复杂度有代价,YAGNI |

**收益(A):** `agent-run.sh` 零风险;实现极小;关 worktree 的副作用(共用 session)正好匹配用户场景(笔记/文档仓库不需要 session 隔离)。

**代价(A):** 关 worktree 后,PWA / 飞书 / cron 在同一 ws 上跑会**复用同一个 claude session**(因为 session_key 被压成 `"default"`)。文档写明。

**何时翻案:** 哪天有人想"关 worktree 但仍要 session 分离" → 升级到方案 C。

### 2.2 数据流

```
4 个触发源 → runner.submit(workspace, prompt, session_key, ...)
                ↓
           ws_settings.worktree_mode_for(workspace)
                ↓
       mode == "off"? → 强制覆盖 session_key = "default"
                ↓
           agent-run.sh <ws> "<prompt>" <session_key>
                ↓
       session_key == "default" → 跑 ~/workspaces/<ws>/ 主目录(现有逻辑)
       session_key != "default" → .wt/<ws>-<key>/ + cc/* 分支(现有逻辑)
```

**`agent-run.sh` 一字不改。** worktree 决策全部上移到 `runner.submit()`。

---

## 3. Components

### 3.1 Schema 改动

**`NewWorkspaceRequest`(`backend/main.py:508`):**

```python
worktree_mode: Literal["auto", "off"] = "auto"
```

**`workspaces.json` per-ws entry:**

```json
{
  "name": "my-notes",
  "provider": null,
  "engine": "claude",
  "trust": false,
  "worktree_mode": "off"
}
```

老 entry 不带 `worktree_mode` 字段 → 视为 `"auto"`(向后兼容,**零迁移**)。

**字段命名理由(§3.4 通用语言,几乎不可逆):** `worktree_mode` 而非 `worktree: bool` —— 留扩展位,未来若加方案 B 或 C 可扩成 `"auto" | "off" | "isolated-no-branch"` 等。

### 3.2 Backend 改动(5 处)

1. **`backend/main.py:508` `NewWorkspaceRequest`** — 加 `worktree_mode` 字段。
2. **`backend/main.py:1197` `create_workspace`** — 写入 `workspaces.json`(跟 `trust` / `provider` 同位置)。
3. **`backend/ws_settings.py`** — 加纯函数:
   ```python
   def worktree_mode_for(ws: str) -> Literal["auto", "off"]:
       """读 workspaces.json,缺字段 / 非法值 / 文件读不出 → 返回 'auto'。"""
   ```
4. **`backend/runner.py:submit()`** — 调 agent-run 前 3 行:
   ```python
   if ws_settings.worktree_mode_for(workspace) == "off":
       session_key = "default"
   ```
5. **`PUT /workspaces/{name}/settings`** — 允许 mutate 已有 ws 的 `worktree_mode`(同 `trust`)。

### 3.3 PWA 改动(2 处)

6. **新建 workspace 表单**(`pwa/app.js:2440` 附近) — 加 checkbox:
   ```
   [ ] 这个 workspace 不需要 worktree 隔离(笔记 / 文档仓库选这个)
   ```
   默认不勾(= `"auto"`)。`body` 里追加 `worktree_mode: checked ? "off" : "auto"`。

7. **workspace 卡片菜单 toggle**(`pwa/app.js:2584` / `:2956` 附近,跟 `ws-trust-toggle` 对齐的模式) — 加一个 `ws-worktree-mode-toggle` 按钮,点击调 `PUT /workspaces/{name}/settings` 翻转。不做独立 settings 页 —— 现有项目模式是"per-setting toggle 进卡片菜单",保持一致。

### 3.4 文档(1 处)

8. **`CLAUDE.md` 加一段** —— 在"trust 是两层串联"段之后,说明 `worktree_mode` 两个值如何映射到运行时,并写明切换时老 worktree 的处理路径。

---

## 4. Error Handling & Edge Cases

| 场景 | 处理 |
|---|---|
| `workspaces.json` 缺 `worktree_mode` 字段 | `worktree_mode_for()` 返回 `"auto"`(向后兼容) |
| `worktree_mode` 值非法(老用户手编 `"on"`) | `worktree_mode_for()` 返回 `"auto"` + log warning;**不抛异常**(单用户单机项目,启动失败比降级危险) |
| `workspaces.json` 整体读不出来(权限 / JSON 坏) | `worktree_mode_for()` 返回 `"auto"`(沿用 `_load_providers_json` 的"出错回退默认"模式) |
| `POST /workspaces` 给非法 `worktree_mode` | Pydantic `Literal` 校验自动 422 |
| `PUT /workspaces/{name}/settings` 翻转 mode 时该 ws 正有 run 在跑 | 不加锁,允许翻 —— 当前 run 按它启动时读到的 mode 跑完,下次 run 才生效。理由:`trust` 当前也是这逻辑,术语一致。 |
| 翻转 auto → off 后老 `.wt/<ws>-*/` worktree 怎么办 | **backend 不主动清。** 文档写明手动处理路径(`git worktree remove` 或 `merge_pwa_to_main` 端点) |

**关于 off 模式下的并发:** 不算 failure mode —— `agent-run.sh` 现有的 `flock` 已经是 per-workspace 串行,off 模式恰好走同一 workdir,flock 自然顶住。

---

## 5. Testing

### 5.1 Unit(`tests/test_ws_settings.py` 新增 / 扩展)

- `worktree_mode_for("ws-with-off")` → `"off"`
- `worktree_mode_for("ws-with-auto")` → `"auto"`
- `worktree_mode_for("ws-without-field")` → `"auto"`
- `worktree_mode_for("ws-with-garbage-value")` → `"auto"`(+ 验证 warning log)
- 用 `tmp_path` fixture 注入假 `workspaces.json`,纯文件 IO,< 10ms

### 5.2 Integration(`tests/test_main.py` 新增)

- `POST /workspaces` with `worktree_mode="off"` → `workspaces.json` 落字段正确
- `POST /workspaces` with `worktree_mode="bogus"` → 422
- `PUT /workspaces/<name>/settings` 切换 mode → 读回一致

### 5.3 Runner 行为(`tests/test_runner.py` 新增 / 扩展)

- Fake `worktree_mode_for` 返回 `"off"` + 假 subprocess → 验证 agent-run.sh 收到的 session_key 是 `"default"`
- 返回 `"auto"` → 验证 session_key 原样透传

### 5.4 Acceptance(ssh 跑)

不新增。`agent-run.sh` 没改,`tests/test_agent_run.sh` 覆盖度不变。

---

## 6. Migration & Rollout

- **零迁移**:老 `workspaces.json` 不带字段 → 视为 `"auto"` = 当前行为。
- **回滚:** 删字段 + 还原 5 处 backend 改动即可,不会破坏老数据。
- **DB:** 无 schema 改动。

---

## 7. Non-Goals(YAGNI)

- ❌ 不做"关 worktree 但保留 session 分离"(方案 C)
- ❌ 不做"PWA 一键清理老 worktree"按钮(用户能 ssh)
- ❌ 不做"全局 default_worktree_mode"配置(per-workspace 已经够 —— config.toml 不需要再加)
- ❌ 不做"flock 粒度细化"(目前 per-workspace flock 已经够,不为关 worktree 模式做特殊处理)

---

## 8. 工程方法论自检(CLAUDE.md §4)

| 原则 | 检查 |
|---|---|
| §0 沟通 | 副作用("off 模式共用 session")已在 §2.1 显式列出 |
| §1 Unix | `worktree_mode_for(ws)` 是纯函数,单一职责;`runner.submit()` 仍是单一执行入口 |
| §2 TDD | 接口纯读 → 5 分钟可写 unit;runner 通过注入 fake `worktree_mode_for` 测试 |
| §3.1 trade-off | §2.1 已对比 3 个候选 |
| §3.2 反悔成本 | 字段名 `worktree_mode`(几乎不可逆,已多方权衡定);schema 加字段(2 级);PWA 控件位置(3 级) |
| §3.3 复杂度 | 仅 1 个新字段 + 1 个纯函数 + 3 行 runner 逻辑 + 1 个表单控件;无新抽象基类 / 无配置自动发现 |
| §3.4 通用语言 | `worktree_mode` 与 §"通用语言"表里 `worktree` 一致,不引入 "isolation" / "branching" 等同义词 |
