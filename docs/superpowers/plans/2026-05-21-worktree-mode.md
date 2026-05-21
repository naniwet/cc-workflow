# Worktree Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace `worktree_mode: "auto" | "off"` toggle. `off` 让所有 run 跑 workspace 主目录(不开 worktree),给笔记/文档仓库用。

**Architecture:** 加 1 个 schema 字段、1 个纯函数 `ws_settings.worktree_mode_for()`、`runner.submit()` 顶部 3 行把 session_key 压成 `"default"`(当 mode=off)。`agent-run.sh` 一字不改。PWA 新建表单加 checkbox,workspace 卡片菜单加 toggle。

**Tech Stack:** FastAPI + Pydantic v2 + 原生 JS PWA。测试用 `unittest.TestCase` + monkeypatch(沿用 `tests/test_loops.py` 模式)。

**Spec:** [`docs/superpowers/specs/2026-05-21-worktree-mode-design.md`](../specs/2026-05-21-worktree-mode-design.md)

---

## File Structure

**Modified:**
- `backend/ws_settings.py` — 加 `worktree_mode_for()` 纯函数
- `backend/runner.py` — `submit()` 顶部加 session_key squash
- `backend/main.py` — `NewWorkspaceRequest` / `create_workspace` / `WorkspaceSettingsRequest` / `put_workspace_settings` 各加 worktree_mode 处理
- `pwa/app.js` — 2 处 new-ws 表单加 checkbox;workspace 卡片菜单加 toggle 按钮 + handler
- `CLAUDE.md` — "trust 是两层串联"段后加一段 worktree_mode 说明

**Created:**
- `tests/test_ws_settings.py` — `worktree_mode_for()` 单测
- `tests/test_runner_worktree.py` — runner.submit 的 session_key squash 单测
- `tests/test_create_workspace_worktree.py` — POST/PUT 接口 integration 测试

**Files that change together stay together** — 5 backend 改动都在一个 PR,2 PWA 改动在同一 PR,文档改在同一 PR。建议**全部一个 PR**(改动总量小,review 容易)。

---

## Task 1: 加 `worktree_mode_for()` 纯函数

**Files:**
- Create: `tests/test_ws_settings.py`
- Modify: `backend/ws_settings.py`(尾部加一个函数)

- [ ] **Step 1: 写 4 个失败测试 — 覆盖 4 条 fallback 路径**

```python
# tests/test_ws_settings.py
import json
import logging
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import ws_settings


class WorktreeModeForTests(unittest.TestCase):
    def _patch_path(self, tmp_path: Path):
        return patch.object(ws_settings, "_PATH", tmp_path / "workspaces.json")

    def test_returns_off_when_field_set(self):
        with self.tmp() as tmp:
            (tmp / "workspaces.json").write_text(
                json.dumps({"notes": {"worktree_mode": "off"}}),
                encoding="utf-8",
            )
            self.assertEqual(ws_settings.worktree_mode_for("notes"), "off")

    def test_returns_auto_when_field_set(self):
        with self.tmp() as tmp:
            (tmp / "workspaces.json").write_text(
                json.dumps({"code": {"worktree_mode": "auto"}}),
                encoding="utf-8",
            )
            self.assertEqual(ws_settings.worktree_mode_for("code"), "auto")

    def test_returns_auto_when_field_missing(self):
        with self.tmp() as tmp:
            (tmp / "workspaces.json").write_text(
                json.dumps({"legacy": {"trust": True}}),
                encoding="utf-8",
            )
            self.assertEqual(ws_settings.worktree_mode_for("legacy"), "auto")

    def test_returns_auto_when_value_garbage(self):
        with self.tmp() as tmp:
            (tmp / "workspaces.json").write_text(
                json.dumps({"weird": {"worktree_mode": "on"}}),
                encoding="utf-8",
            )
            with self.assertLogs("backend.ws_settings", level="WARNING") as cm:
                self.assertEqual(ws_settings.worktree_mode_for("weird"), "auto")
            self.assertTrue(any("worktree_mode" in msg for msg in cm.output))

    def test_returns_auto_when_workspace_unknown(self):
        with self.tmp() as tmp:
            (tmp / "workspaces.json").write_text(
                json.dumps({}), encoding="utf-8",
            )
            self.assertEqual(ws_settings.worktree_mode_for("never-heard-of"), "auto")

    # tmp_path helper — context manager that monkeypatches _PATH
    from contextlib import contextmanager
    @contextmanager
    def tmp(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            with self._patch_path(p):
                yield p


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试,确认 5 个全失败**

Run: `python3 -m unittest tests.test_ws_settings -v`
Expected: 5 failures,错误信息含 `AttributeError: module 'backend.ws_settings' has no attribute 'worktree_mode_for'`

- [ ] **Step 3: 实现 `worktree_mode_for()`**

在 `backend/ws_settings.py` 尾部(`save()` 后,`provider_for()` 前)加:

```python
import logging

_logger = logging.getLogger(__name__)

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
```

注意:`import logging` 加在文件顶部 import 区(目前已有 `import os`/`import json`,放它们旁边)。

- [ ] **Step 4: 跑测试,确认 5 个全过**

Run: `python3 -m unittest tests.test_ws_settings -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add backend/ws_settings.py tests/test_ws_settings.py
git commit -m "feat(ws_settings): 加 worktree_mode_for() 纯函数

每条 fallback 路径独立单测(缺字段 / 非法值 / 未知 ws / 文件读不出)。
非法值落 warning log,不抛异常 — 单用户单机项目降级比 crash 安全。"
```

---

## Task 2: `runner.submit()` 顶部 squash session_key

**Files:**
- Create: `tests/test_runner_worktree.py`
- Modify: `backend/runner.py`(`submit()` 函数顶部,`db.insert_queued_run` 之前)

- [ ] **Step 1: 写失败测试 — 2 个 case(mode=off squash;mode=auto 不动)**

```python
# tests/test_runner_worktree.py
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import runner


class SubmitSquashesSessionKeyWhenWorktreeOff(unittest.TestCase):
    def _patches(self, mode):
        """所有 IO 都打掉,只剩 squash 逻辑可观测。"""
        return (
            patch.object(runner.db, "insert_queued_run"),
            patch.object(runner.threading, "Thread"),
            patch.object(runner.ws_settings, "worktree_mode_for", return_value=mode),
        )

    def _captured_kwargs(self, mode, session_key):
        patches = self._patches(mode)
        with patches[0] as q, patches[1] as th, patches[2]:
            runner.submit(
                run_id="r-1",
                workspace="ws",
                prompt="hi",
                engine="claude",
                session_key=session_key,
                source="pwa",
            )
            # session_key 传给 db 的值和给线程的值都要校验
            q_kw = q.call_args.kwargs
            th_args = th.call_args.kwargs["args"]
            return q_kw["session_key"], th_args[4]  # _execute 的 session_key 在 args[4]

    def test_off_squashes_to_default(self):
        db_sk, thread_sk = self._captured_kwargs("off", session_key="pwa-myws")
        self.assertEqual(db_sk, "default")
        self.assertEqual(thread_sk, "default")

    def test_auto_passes_through(self):
        db_sk, thread_sk = self._captured_kwargs("auto", session_key="pwa-myws")
        self.assertEqual(db_sk, "pwa-myws")
        self.assertEqual(thread_sk, "pwa-myws")

    def test_off_with_none_session_key_stays_default(self):
        db_sk, thread_sk = self._captured_kwargs("off", session_key=None)
        # None → squash 后还是 "default"(原 None 走 agent-run.sh 也是 default 行为)
        self.assertEqual(db_sk, "default")
        self.assertEqual(thread_sk, "default")


if __name__ == "__main__":
    unittest.main()
```

注意:测试里 `th_args[4]` 对应 `_execute()` 第 5 个位置参数 session_key,看 `runner.py:63`(`args=(run_id, workspace, prompt, engine, session_key, ...)`)即 index 4。

- [ ] **Step 2: 跑测试,确认 3 个全失败**

Run: `python3 -m unittest tests.test_runner_worktree -v`
Expected: 3 failures(assertEqual 失败,因为目前 session_key 原样传递)

- [ ] **Step 3: 加 squash 逻辑**

在 `backend/runner.py` 文件顶部 import 区加 `ws_settings`:

```python
from . import config, db, ws_settings
```

然后在 `submit()` 函数最开头(`db.insert_queued_run` 之前)加:

```python
def submit(
    *,
    run_id: str,
    workspace: str,
    prompt: str,
    engine: str,
    session_key: Optional[str],
    source: str,
    provider: Optional[str] = None,
    permission_mode: Optional[str] = None,
    trust: bool = False,
    job_name: Optional[str] = None,
    on_finish: Optional[OnFinish] = None,
) -> None:
    # worktree_mode=off 把 session_key 压成 "default" — agent-run.sh 看到
    # default 就跑 workspace 主目录不开 worktree(见 agent-run.sh:354)。
    # 副作用:同 ws 下所有触发源共用同一个 claude session。这正是 off
    # 模式的预期语义(笔记/文档仓库不需要 session 隔离)。
    if ws_settings.worktree_mode_for(workspace) == "off":
        session_key = "default"
    db.insert_queued_run(
        run_id=run_id,
        ...
```

- [ ] **Step 4: 跑测试,确认 3 个全过 + 全部回归测试**

```bash
python3 -m unittest tests.test_runner_worktree -v
python3 -m unittest tests.test_loops -v
python3 -m unittest tests.test_ws_settings -v
```
Expected: 全 pass

- [ ] **Step 5: Commit**

```bash
git add backend/runner.py tests/test_runner_worktree.py
git commit -m "feat(runner): worktree_mode=off 时 squash session_key 到 default

agent-run.sh 一字不改 — 它看到 session_key=default 就跑主目录不开
worktree。db row 也存 squash 后的值,运行视图跟实际行为一致。"
```

---

## Task 3: `NewWorkspaceRequest` + `create_workspace` 写入字段

**Files:**
- Create: `tests/test_create_workspace_worktree.py`
- Modify: `backend/main.py` 行 508-522(`NewWorkspaceRequest`)、行 1232-1244(`create_workspace` 的 settings 写入段)

- [ ] **Step 1: 写失败测试**

```python
# tests/test_create_workspace_worktree.py
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from backend import main, ws_settings, config


class CreateWorkspaceWorktreeMode(unittest.TestCase):
    """POST /workspaces 写入 worktree_mode 到 workspaces.json。
    完全沙箱:workspaces dir / ws_settings file 都重定到 tmp。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.ws_dir = self.tmp_path / "workspaces"
        self.ws_dir.mkdir()
        self.cfg_file = self.tmp_path / "workspaces.json"

        self.patches = [
            patch.object(config, "WORKSPACES_DIR", self.ws_dir),
            patch.object(ws_settings, "_PATH", self.cfg_file),
            # 让 _list_provider_names 返回空 list 也行(只测 trust+worktree_mode 路径)
            patch.object(main, "_list_provider_names", return_value=[]),
        ]
        for p in self.patches:
            p.start()
        self.client = TestClient(main.app, headers=self._auth_header())

    def _auth_header(self):
        # PROTECT 用 X-CCW-Session;test 模式下绕过 — 沿用 test_loops 的方式
        # (如果 test_loops 直接调函数没走 HTTP,这里 TestClient 需要绕过)
        # 简化:走 TestClient + 提供 cookie。
        return {}

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _post(self, body):
        return self.client.post("/workspaces", json=body)

    def test_creates_with_explicit_off(self):
        r = self._post({"name": "notes", "engine": "claude", "worktree_mode": "off"})
        self.assertEqual(r.status_code, 201, r.text)
        data = json.loads(self.cfg_file.read_text(encoding="utf-8"))
        self.assertEqual(data["notes"]["worktree_mode"], "off")

    def test_creates_with_default_auto_not_persisted(self):
        # 默认 auto 不应写入 — 跟 trust 一致(None / 默认值不写,留给 fallback)
        r = self._post({"name": "code", "engine": "claude"})
        self.assertEqual(r.status_code, 201, r.text)
        data = json.loads(self.cfg_file.read_text(encoding="utf-8"))
        self.assertNotIn("worktree_mode", data.get("code", {}))

    def test_rejects_bogus_value(self):
        r = self._post({"name": "bad", "engine": "claude", "worktree_mode": "yolo"})
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
```

注意:`TestClient` 调用前要先看 `backend/main.py` 的 auth 中间件 `PROTECT` 是怎么实现的。如果用 cookie / session secret,在 setUp 里 monkey-patch 绕过(给一个允许全通过的 `PROTECT = []`)。

实操:在 setUp 里加 `patch.object(main, "PROTECT", [])` 即可绕过 — 等 patches 列表里加这一行。

- [ ] **Step 2: 跑测试,确认 3 个失败**

Run: `python3 -m unittest tests.test_create_workspace_worktree -v`
Expected: 3 failures(422 → 200 because Pydantic 还不知道 worktree_mode 字段;字段没写入 file)

- [ ] **Step 3: 加 schema 字段**

`backend/main.py:508` `NewWorkspaceRequest`,在 `trust` 字段下面加:

```python
class NewWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    provider: Optional[str] = Field(default=None, max_length=64)
    engine: Literal["claude"] = "claude"
    trust: Optional[bool] = None
    # worktree_mode: "off" 让所有 run 跑 workspace 主目录(不开 worktree)。
    # 笔记 / 文档仓库这种单分支线性提交的仓库选这个。默认 "auto" = 现有行为
    # (session_key != default 时建 worktree)。Mutable post-creation
    # via PUT /workspaces/{name}/settings,跟 trust 一致。
    worktree_mode: Literal["auto", "off"] = "auto"
```

`backend/main.py:1232-1244` `create_workspace` 的 settings 写入段,在 `if req.trust is not None` 之后加:

```python
    if req.trust is not None:
        settings["trust"] = bool(req.trust)
    # 跟 trust 一致:默认 "auto" 不写,让 worktree_mode_for() 走 fallback。
    # 只有显式选 "off" 时才落到 workspaces.json,避免冻结当前默认。
    if req.worktree_mode == "off":
        settings["worktree_mode"] = "off"
```

`create_workspace` 的返回值 dict(行 1251-1254)加上 worktree_mode 字段也对称一下:

```python
    return {
        "ok": True, "name": req.name, "path": str(target),
        "provider": req.provider, "engine": req.engine, "trust": req.trust,
        "worktree_mode": req.worktree_mode,
    }
```

- [ ] **Step 4: 跑测试**

Run: `python3 -m unittest tests.test_create_workspace_worktree -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_create_workspace_worktree.py
git commit -m "feat(main): POST /workspaces 接受 worktree_mode

默认 'auto' 不写入 workspaces.json(跟 trust None 一致的 fallback 语义);
显式 'off' 才落字段。非法值 Pydantic 422 自动拒。"
```

---

## Task 4: `PUT /workspaces/{name}/settings` 允许 mutate `worktree_mode`

**Files:**
- Modify: `backend/main.py` 行 751-759(`WorkspaceSettingsRequest`)、行 793-797(`put_workspace_settings`)
- Modify: `tests/test_create_workspace_worktree.py`(扩 PUT 路径测试)

- [ ] **Step 1: 写失败测试 — 加到现有 test 类**

```python
# 加到 CreateWorkspaceWorktreeMode 类内
def test_put_settings_flip_to_off(self):
    self._post({"name": "ws", "engine": "claude"})
    r = self.client.put(
        "/workspaces/ws/settings",
        json={"worktree_mode": "off"},
    )
    self.assertEqual(r.status_code, 200, r.text)
    data = json.loads(self.cfg_file.read_text(encoding="utf-8"))
    self.assertEqual(data["ws"]["worktree_mode"], "off")

def test_put_settings_flip_to_auto_removes_field(self):
    # 先建一个 off,再翻回 auto — 字段应被删掉(跟 trust=None 模式一致)
    self._post({"name": "ws", "engine": "claude", "worktree_mode": "off"})
    r = self.client.put(
        "/workspaces/ws/settings",
        json={"worktree_mode": "auto"},
    )
    self.assertEqual(r.status_code, 200)
    data = json.loads(self.cfg_file.read_text(encoding="utf-8"))
    self.assertNotIn("worktree_mode", data.get("ws", {}))

def test_put_settings_bogus_value_422(self):
    self._post({"name": "ws", "engine": "claude"})
    r = self.client.put("/workspaces/ws/settings", json={"worktree_mode": "yolo"})
    self.assertEqual(r.status_code, 422)
```

- [ ] **Step 2: 跑测试,确认 3 个失败**

Run: `python3 -m unittest tests.test_create_workspace_worktree -v`
Expected: 3 failures

- [ ] **Step 3: 加字段 + mutate 逻辑**

`backend/main.py:751` `WorkspaceSettingsRequest`,trust 字段下面加:

```python
class WorkspaceSettingsRequest(BaseModel):
    provider: Optional[str] = Field(default=None, max_length=64)
    trust: Optional[bool] = None
    # worktree_mode: "auto" → 删字段(走 fallback);"off" → 写字段;
    # 缺字段 → 不动(沿用 trust / provider 的 model_fields_set 语义)。
    worktree_mode: Optional[Literal["auto", "off"]] = None
```

`backend/main.py:793-797` `put_workspace_settings`,在 trust 处理之后加:

```python
    if "trust" in sent:
        if body.trust is None:
            current.pop("trust", None)
        else:
            current["trust"] = bool(body.trust)

    if "worktree_mode" in sent:
        if body.worktree_mode == "off":
            current["worktree_mode"] = "off"
        else:
            # "auto" 或 None → 删字段,让 worktree_mode_for() 走 fallback。
            current.pop("worktree_mode", None)
```

- [ ] **Step 4: 跑测试**

Run: `python3 -m unittest tests.test_create_workspace_worktree -v`
Expected: 全 pass(包括 Task 3 的 3 个 + Task 4 的 3 个)

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_create_workspace_worktree.py
git commit -m "feat(main): PUT settings 允许翻转 worktree_mode

跟 trust 一致的语义:auto 删字段走 fallback,off 写字段。
mutate 时该 ws 正有 run 在跑不加锁 — 当前 run 按启动时读到的
mode 跑完,下次 run 才生效。"
```

---

## Task 5: PWA 新建表单加 worktree_mode checkbox(2 处)

**Files:**
- Modify: `pwa/app.js:1067-1090`(PC overview dialog 表单)、`pwa/app.js:1280-1296`(mobile/single-col 表单)、`pwa/app.js:2440-2466`(`onAddWorkspace` 提交逻辑)

PWA 没有单测,改动靠 review + 手动验证。无 TDD red 步骤。

- [ ] **Step 1: PC overview 表单加 checkbox**

在 `pwa/app.js:1077-1079` 的 trust checkbox 下面加一段(每个 form 一个):

```html
        <label class="inline-check">
          <input type="checkbox" name="worktree_mode_off">
          这个 workspace 不需要 worktree 隔离(笔记 / 文档仓库选这个)
        </label>
```

- [ ] **Step 2: Mobile/single-col 表单加 checkbox**

`pwa/app.js:1289-1290`(`<label class="inline-check">` 这块)下面加同样一段。

- [ ] **Step 3: 改 `onAddWorkspace` 提交逻辑**

`pwa/app.js:2440` 附近,改 body 组装:

```javascript
  const trust = !!form.elements.trust?.checked;
  // checkbox 勾上 = mode "off",不勾 = "auto"。
  const worktreeMode = form.elements.worktree_mode_off?.checked ? "off" : "auto";
  if (!name) return;
  ...
    await api('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, engine, trust, worktree_mode: worktreeMode }),
    });
```

- [ ] **Step 4: 本地语法 check**

```bash
node --check pwa/app.js
```
Expected: 无输出(parse OK)

- [ ] **Step 5: 手动验证(说明,不必跑)**

ssh 部署后:
1. 打开 PWA,点 "+ New workspace"
2. 勾上"不需要 worktree 隔离",创建 ws "test-notes"
3. ssh 看 `~/.cc-workflow/workspaces.json`:`"test-notes": {"engine": "claude", "worktree_mode": "off"}`
4. PWA 触发一次 run,ssh 检查没有 `~/workspaces/.wt/test-notes-*/` 目录

- [ ] **Step 6: Commit**

```bash
git add pwa/app.js
git commit -m "feat(pwa): 新建 workspace 加 worktree_mode checkbox

PC overview + mobile/single-col 两个表单都加。勾上 = 'off' = 笔记/文档
仓库不要 worktree 隔离;默认不勾 = 'auto' = 当前行为。"
```

---

## Task 6: workspace 卡片菜单加 toggle

**Files:**
- Modify: `pwa/app.js`(`ws-trust-toggle` 附近 2 处:行 2582-2588 + 行 2956 附近)、加 `onWorktreeModeToggleClick` handler

- [ ] **Step 1: 在 ws-trust-toggle 旁边加 worktree-mode toggle 按钮(PC 卡片)**

`pwa/app.js:2570` 附近 `_workspaceTopBarHtml` 这种函数里,先读出 worktree_mode:

```javascript
  const trustOnPC = effectiveTrust(name);
  const worktreeOff = (lastData.wsSettings[name]?.worktree_mode === "off");
```

然后在 trust toggle button 下面加:

```html
            <button class="ws-worktree-mode-toggle ws-menu-item" type="button"
                    data-ws="${esc(name)}" data-mode="${worktreeOff ? 'off' : 'auto'}">
              ${worktreeOff ? '🗒️' : '🌿'}
              <span>Worktree 隔离 <strong>${worktreeOff ? 'OFF' : 'ON'}</strong></span>
            </button>
```

(若 ICONS 集有合适的就用 ICONS,没有就 emoji。emoji 跟其他按钮风格不冲突 —— 看实际渲染调整。)

- [ ] **Step 2: 同位置 mobile/single-col 也加(行 2956 附近 `ws-trust-toggle` 的 mobile 副本)**

读 `worktreeOff` 跟 step 1 一样,按钮也照搬。

- [ ] **Step 3: 加 click handler**

`pwa/app.js:2351` `onTrustToggleClick` 后面加:

```javascript
async function onWorktreeModeToggleClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  const wasOff = btn.dataset.mode === 'off';
  const next = wasOff ? 'auto' : 'off';
  btn.disabled = true;
  try {
    await api(`/workspaces/${encodeURIComponent(name)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktree_mode: next }),
    });
    showToast('success', `${name}: worktree ${next === 'off' ? 'OFF (主目录)' : 'ON (隔离)'}`, { ttl: 2500 });
    refreshAll();
  } catch (err) {
    showError(`save worktree_mode failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
```

- [ ] **Step 4: 注册 handler — 跟 trust toggle 在同一处**

`pwa/app.js:1619-1623`(`for (const b of root.querySelectorAll('.ws-trust-toggle'))` 这段下面):

```javascript
  for (const b of root.querySelectorAll('.ws-worktree-mode-toggle')) {
    b.addEventListener('click', onWorktreeModeToggleClick);
    _addTapFallback(b, onWorktreeModeToggleClick);
  }
```

`_addTapFallback` 是 trust toggle 已经用的,直接复用。

- [ ] **Step 5: 语法 check**

```bash
node --check pwa/app.js
```
Expected: 无输出

- [ ] **Step 6: 手动验证(说明)**

ssh 部署后:
1. 打开 PWA,选一个 workspace 卡片菜单
2. 看到 "Worktree 隔离 ON / OFF" 按钮,点一下
3. toast 显示切换成功
4. ssh 看 `~/.cc-workflow/workspaces.json` 字段变化对

- [ ] **Step 7: Commit**

```bash
git add pwa/app.js
git commit -m "feat(pwa): workspace 卡片菜单加 worktree 隔离 toggle

跟 trust toggle 对称的模式 — 点一下调 PUT settings 翻转。
PC 卡片菜单 + mobile/single-col 都加。"
```

---

## Task 7: 更新 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`(在"### 4. trust 是两层串联,不是单点开关"段之后)

- [ ] **Step 1: 加新一节**

在 `CLAUDE.md` 现有 "### 4. trust 是两层串联" 段之后,加一节(继续往后排序号或保留现号也行,看现有结构):

```markdown
### 4.5 worktree_mode:per-workspace 关 worktree 的开关

`workspaces.json` 字段 `worktree_mode`:
- `"auto"`(默认 / 缺字段)→ 当前行为:`session_key != "default"` 时 agent-run.sh 建 worktree
- `"off"` → `runner.submit()` 把 session_key 压成 `"default"`,所有 run 跑 workspace 主目录,**不开 worktree**

用例:笔记 / 文档仓库这种单分支线性提交的,worktree 没意义反而碍事。

**副作用:** off 模式下 PWA / 飞书 / cron 在同一 ws 共用同一个 claude session(session_key 都被压成 default)。这正是 off 的预期语义。需要"关 worktree 但保留 session 分离"时再考虑给 agent-run.sh 加 `--no-worktree` flag(目前 YAGNI)。

**切换时的老 worktree 处理:** auto → off 翻转后,老的 `~/workspaces/.wt/<ws>-*/` worktree 留着不动,backend 不主动清。用户自己决定 merge(`POST /workspaces/<ws>/merge-session-branch`)还是删(`git worktree remove`)。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): 加 worktree_mode 一节

trust 段之后,说明 auto/off 两个值如何映射到运行时,以及切换时
老 worktree 的处理路径。"
```

---

## Task 8: 整体 smoke + 服务器 acceptance

- [ ] **Step 1: 全部 backend 测试跑一遍**

```bash
python3 -m unittest discover -s tests -v
```
Expected: 全 pass

- [ ] **Step 2: 全部 Python 编译 check**

```bash
python3 -m py_compile backend/*.py backend/roundtable/*.py
```
Expected: 无输出

- [ ] **Step 3: PWA 语法 check**

```bash
node --check pwa/app.js
node --test tests/pwa-ui-contract.test.mjs
```
Expected: 全 pass

- [ ] **Step 4: 服务器端 acceptance**(必须 ssh 跑)

```bash
ssh <server> 'cd /path/to/cc-workflow && bash tests/test_agent_run.sh'
```
Expected: pass。`agent-run.sh` 没改,理论上不会回归 — 但走一遍验证 deploy。

- [ ] **Step 5: 服务器端冒烟测试**

ssh 上去手动:
1. `systemctl restart cc-workflow`
2. `curl -s -X POST localhost:8765/workspaces -H 'Content-Type: application/json' -H 'X-CCW-Session: <secret>' -d '{"name":"smoke-notes","engine":"claude","worktree_mode":"off"}'`
3. 看 `~/.cc-workflow/workspaces.json` 含 `"smoke-notes": {"engine":"claude","worktree_mode":"off"}`
4. `curl -s -X POST localhost:8765/run -H ... -d '{"workspace":"smoke-notes","prompt":"echo hi"}'`(用一个能在 5s 跑完的 prompt)
5. 跑完后:
   - `ls ~/workspaces/.wt/` 不应出现 `smoke-notes-*`
   - `git -C ~/workspaces/smoke-notes log --oneline` 应该有 prompt 的 commit
6. PUT settings 翻 auto:`curl -s -X PUT localhost:8765/workspaces/smoke-notes/settings -d '{"worktree_mode":"auto"}'`
7. 再触发一次,这次 `~/workspaces/.wt/smoke-notes-default*` 不出现(session_key 还是 default,看是不是有别的触发源);若从 PWA 触发,应出现 `smoke-notes-pwa-smoke-notes/` worktree

---

## Self-Review

**Spec coverage check:**

| Spec 章节 | 实现位置 |
|---|---|
| §3.1 Schema(`NewWorkspaceRequest` / `workspaces.json`) | Task 3 |
| §3.2 #1 `NewWorkspaceRequest` 加字段 | Task 3 |
| §3.2 #2 `create_workspace` 写入 | Task 3 |
| §3.2 #3 `worktree_mode_for()` | Task 1 |
| §3.2 #4 `runner.submit()` squash | Task 2 |
| §3.2 #5 `PUT settings` 接受字段 | Task 4 |
| §3.3 #6 新建表单 checkbox | Task 5 |
| §3.3 #7 卡片菜单 toggle | Task 6 |
| §3.4 #8 CLAUDE.md 文档 | Task 7 |
| §4 错误处理(缺字段 / 非法值 / 读不出文件) | Task 1 测试覆盖 |
| §5.1 unit | Task 1 |
| §5.2 integration | Task 3 + 4 |
| §5.3 runner | Task 2 |
| §5.4 acceptance(不新增) | Task 8 step 4 跑现有 |

✓ 全覆盖。

**Placeholder scan:** 无 TBD / TODO / "implement later"。每步代码块都是完整可粘的代码。

**Type consistency:**
- `worktree_mode_for()` 返回 `str`(`"auto"` / `"off"`),Task 2 测试和 squash 逻辑用 `== "off"` 比较 ✓
- `WorkspaceSettingsRequest.worktree_mode` 是 `Optional[Literal["auto", "off"]]`,跟 `NewWorkspaceRequest.worktree_mode: Literal["auto", "off"]` 类型一致(PUT 多个 `None` 表示"不动") ✓
- PWA 提交字段 `worktree_mode: "auto" | "off"` 跟 backend 一致 ✓
