# Role-Models Config Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加 `~/.cc-workflow/role_models.json` 持久化层 + `PUT /settings/role-models` endpoint + `#settings/roles` PWA 页,让用户独立配置每个 roundtable role 的默认 model。顺手修 `/roundtables/models` 漏报 REVIEWER 的 bug。

**Architecture:** 新增 `backend/roundtable/role_models_store.py`(纯 load/save/lookup)→ 修 `GET /roundtables/models` 用 effective default + 加 REVIEWER → 加 `PUT /settings/role-models` → `create_roundtable` 合并 persistent + per-session → PWA 加 `#settings/roles` 路由(挂到现有 settings hub)。

**Tech Stack:** Python 3.13 + FastAPI + Pydantic v2 + `unittest.TestCase` + 原生 JS。

**Spec:** [`docs/superpowers/specs/2026-05-25-role-models-config-design.md`](../specs/2026-05-25-role-models-config-design.md)

---

## File Structure

**Created:**
- `backend/roundtable/role_models_store.py` — `load()` / `save()` / `effective_model_for()` 纯函数
- `tests/test_role_models_store.py` — 5 unit
- `tests/test_role_models_endpoint.py` — 7 integration

**Modified:**
- `backend/main.py` — `GET /roundtables/models` 加 REVIEWER + 用 effective default;新 `PUT /settings/role-models`;`create_roundtable` 合并 persistent + per-session
- `pwa/app.js` — settings hub 加 Roles 卡片;`#settings/roles` 路由 + 渲染函数 + 保存 handler

---

## Task 1: `role_models_store.py` — load/save/lookup 纯函数

**Files:**
- Create: `backend/roundtable/role_models_store.py`
- Create: `tests/test_role_models_store.py`

- [ ] **Step 1: 写 5 个失败单测**

```python
# tests/test_role_models_store.py
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.roundtable import role_models_store


@contextmanager
def _patched_path(content: dict | None):
    """临时把 _PATH 指到 tmp 文件;content=None → 文件不存在。"""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "role_models.json"
        if content is not None:
            p.write_text(json.dumps(content), encoding="utf-8")
        with patch.object(role_models_store, "_PATH", p):
            yield p


class RoleModelsStoreTests(unittest.TestCase):
    def test_load_returns_empty_when_file_missing(self):
        with _patched_path(None):
            self.assertEqual(role_models_store.load(), {})

    def test_load_returns_dict_when_file_present(self):
        with _patched_path({"极简派": "kimi-k2.6"}):
            self.assertEqual(role_models_store.load(), {"极简派": "kimi-k2.6"})

    def test_load_returns_empty_on_corrupt_json(self):
        with _patched_path(None) as p:
            p.write_text("{not json", encoding="utf-8")
            with self.assertLogs("backend.roundtable.role_models_store", level="WARNING"):
                self.assertEqual(role_models_store.load(), {})

    def test_save_then_load_roundtrip(self):
        with _patched_path(None):
            role_models_store.save({"借鉴派": "kimi-k2.6", "悲观派": "deepseek-reasoner"})
            self.assertEqual(
                role_models_store.load(),
                {"借鉴派": "kimi-k2.6", "悲观派": "deepseek-reasoner"},
            )

    def test_effective_model_for_uses_override_when_present(self):
        with _patched_path({"极简派": "kimi-k2.6"}):
            self.assertEqual(
                role_models_store.effective_model_for("极简派", "deepseek-chat"),
                "kimi-k2.6",
            )
            self.assertEqual(
                role_models_store.effective_model_for("场景派", "deepseek-chat"),
                "deepseek-chat",
            )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试,确认 5 个失败**(模块不存在)

```bash
python3 -m unittest discover -s tests -p 'test_role_models_store.py' -v 2>&1 | tail -10
```

Expected: `ModuleNotFoundError: No module named 'backend.roundtable.role_models_store'` × 5

- [ ] **Step 3: 实现 `role_models_store.py`**

```python
# backend/roundtable/role_models_store.py
"""Persistent per-role model overrides.

Schema (~/.cc-workflow/role_models.json):
    {"<role-name>": "<model-name>", ...}

空 dict / 缺 key / unknown role / unknown model 一律 fall through 到
role.preferred_model(hardcode in roles.py)。validation 在 main.py
API surface 做(PUT endpoint 校验 model 在 MODEL_ENDPOINTS 里),
这里是纯 read/write。

跟 backend/ws_settings.py 一样的容错策略:文件读不出 → {} + warning,
启动失败比降级危险。spec §3.1。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from .. import config

_logger = logging.getLogger(__name__)

_PATH = config.CCW_DIR / "role_models.json"


def load() -> dict[str, str]:
    """Return the full overrides dict; {} when file missing / unreadable."""
    if not _PATH.exists():
        return {}
    try:
        data = json.loads(_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            _logger.warning("role_models.json 不是 dict,忽略: %r", data)
            return {}
        return {str(k): str(v) for k, v in data.items()}
    except (OSError, json.JSONDecodeError) as e:
        _logger.warning("role_models.json 读不出 (%s),fallback {}", e)
        return {}


def save(data: dict[str, str]) -> None:
    """Atomic write — temp + os.replace 防 race。"""
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _PATH)


def effective_model_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name) or hardcoded_default
```

- [ ] **Step 4: 跑测试 — 5/5 pass**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_store.py' -v 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/roundtable/role_models_store.py tests/test_role_models_store.py
git commit -m "$(cat <<'EOF'
feat(roundtable): 加 role_models_store.py — persistent role-model overrides

3 纯函数:load / save(atomic)/ effective_model_for。schema 是
~/.cc-workflow/role_models.json 里的 flat dict {role_name: model_name}。
文件缺失 / JSON 坏 / 非 dict 一律 fallback 到 {}。5 unit 覆盖。

spec §3.1。下一步 backend endpoints 改造接这个 store。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 修 `GET /roundtables/models` — 加 REVIEWER + 用 effective default

**Files:**
- Modify: `backend/main.py:1609-1639`(`list_roundtable_models` 函数)
- Modify: `tests/test_role_models_endpoint.py`(创建文件,加 2 个 test)

- [ ] **Step 1: 创建 test 文件 + 写 2 个失败测试**

```python
# tests/test_role_models_endpoint.py
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth, config
from backend.roundtable import role_models_store


class RoundtableModelsEndpointTests(unittest.TestCase):
    """`GET /roundtables/models` — 含 REVIEWER + effective default。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.role_models_file = self.tmp_path / "role_models.json"
        self.patches = [
            patch.object(role_models_store, "_PATH", self.role_models_file),
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

    def test_models_endpoint_includes_reviewer_role(self):
        r = self.client.get("/roundtables/models")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        role_names = [role["name"] for role in body["roles"]]
        self.assertIn("审查员", role_names)
        reviewer = next(role for role in body["roles"] if role["name"] == "审查员")
        self.assertEqual(reviewer["kind"], "reviewer")

    def test_models_endpoint_uses_persistent_override(self):
        # 写入 override → GET 返回的 default_model 反映该 override
        self.role_models_file.write_text(
            json.dumps({"极简派": "kimi-k2.6"}), encoding="utf-8",
        )
        r = self.client.get("/roundtables/models")
        body = r.json()
        minimalist = next(role for role in body["roles"] if role["name"] == "极简派")
        self.assertEqual(minimalist["default_model"], "kimi-k2.6")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_endpoint.py' -v 2>&1 | tail -10
```

Expected: `test_models_endpoint_includes_reviewer_role` 失败(审查员 不在列表里),`test_models_endpoint_uses_persistent_override` 失败(`default_model` 仍是 hardcode)。

- [ ] **Step 3: 修 `list_roundtable_models`**

`backend/main.py:1609` 附近,顶部 imports 加:

```python
from .roundtable import role_models_store
```

(放在已有的 `from .roundtable import io as roundtable_io` 等同段。)

修改 `list_roundtable_models` 函数体:

```python
@app.get("/roundtables/models", dependencies=PROTECT)
def list_roundtable_models() -> dict:
    """Surface model registry + role defaults so PWA can render per-role
    model selector. `default_model` 字段已经是 effective default
    (= persistent override > role.preferred_model)。

    Adding a new model = append to MODEL_ENDPOINTS in model.py (code-as-
    registry). Adding a new role = edit roles.py (no schema migration).
    """
    def _role_entry(r, kind: str) -> dict:
        return {
            "name": r.name,
            "default_model": role_models_store.effective_model_for(
                r.name, r.preferred_model,
            ),
            "kind": kind,
        }

    return {
        "models": [
            {"name": m, "endpoint": ep}
            for m, ep in sorted(roundtable_model.MODEL_ENDPOINTS.items())
        ],
        "roles": (
            [_role_entry(r, "persona") for r in roundtable_roles.ROLES]
            + [_role_entry(roundtable_roles.SYNTHESIZER, "synthesizer")]
            + [_role_entry(roundtable_roles.REVIEWER, "reviewer")]
        ),
    }
```

- [ ] **Step 4: 跑测试 — 2/2 pass**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_endpoint.py' -v 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_role_models_endpoint.py
git commit -m "$(cat <<'EOF'
fix(main): /roundtables/models 加 REVIEWER + 用 effective default

之前 Task 3 加 REVIEWER 时漏更新这个 endpoint(发现于 final review)。
顺手把 default_model 从 hardcode preferred_model 改成 effective default
(role_models_store 的 persistent override 优先)。kind="reviewer" 让
PWA picker 跟 persona / synthesizer 区分对待。

2 个 endpoint 测试:含 REVIEWER + persistent override 生效。

spec §3.2 + §3.4。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `PUT /settings/role-models` 新 endpoint

**Files:**
- Modify: `backend/main.py`(加 `RoleModelsRequest` + `put_role_models` endpoint)
- Modify: `tests/test_role_models_endpoint.py`(append 5 endpoint 测试)

- [ ] **Step 1: 写 5 个失败测试**

Append 到 `tests/test_role_models_endpoint.py`(在 `if __name__` 之前,新 class):

```python
class PutRoleModelsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.role_models_file = self.tmp_path / "role_models.json"
        self.patches = [
            patch.object(role_models_store, "_PATH", self.role_models_file),
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

    def test_put_writes_overrides_to_file(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": "kimi-k2.6"}},
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
        self.assertEqual(data, {"极简派": "kimi-k2.6"})

    def test_put_empty_dict_clears_all_overrides(self):
        # 先写入一个 override,然后 PUT 空 dict 应该清掉
        self.role_models_file.write_text(
            json.dumps({"极简派": "kimi-k2.6"}), encoding="utf-8",
        )
        r = self.client.put("/settings/role-models", json={"role_models": {}})
        self.assertEqual(r.status_code, 200)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
        self.assertEqual(data, {})

    def test_put_rejects_unknown_role(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"幻觉派": "kimi-k2.6"}},
        )
        self.assertEqual(r.status_code, 400, r.text)
        body = r.json()
        self.assertIn("unknown role", str(body))

    def test_put_rejects_unknown_model(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": "gpt-5-turbo-pro"}},
        )
        self.assertEqual(r.status_code, 400, r.text)
        body = r.json()
        self.assertIn("unknown model", str(body))

    def test_put_returns_current_effective_map(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": "kimi-k2.6"}},
        )
        self.assertEqual(r.status_code, 200)
        # 响应 body 至少含写入的那一对(让 PWA 可以 confirm)
        body = r.json()
        self.assertEqual(body.get("role_models"), {"极简派": "kimi-k2.6"})
```

- [ ] **Step 2: 跑测试,确认 5 个失败**(endpoint 不存在)

```bash
python3 -m unittest tests.test_role_models_endpoint -v 2>&1 | tail -10
```

- [ ] **Step 3: 实现 `PUT /settings/role-models` endpoint**

`backend/main.py` 找一个合适的位置(`/roundtables/models` endpoint 之后,`POST /roundtables` 之前)加:

```python
class RoleModelsRequest(BaseModel):
    role_models: dict[str, str] = Field(default_factory=dict)


@app.put("/settings/role-models", dependencies=PROTECT)
def put_role_models(req: RoleModelsRequest) -> dict:
    """更新 persistent per-role model overrides。

    Body: {"role_models": {"<role>": "<model>", ...}}
    空 dict = 清掉所有 override,所有 role 回 hardcode 默认。

    校验:role 必须是已知 role(ROLES + SYNTHESIZER + REVIEWER),
    model 必须在 MODEL_ENDPOINTS 里。任一失败 → 400 不写入。
    """
    valid_roles = (
        {r.name for r in roundtable_roles.ROLES}
        | {roundtable_roles.SYNTHESIZER.name}
        | {roundtable_roles.REVIEWER.name}
    )
    valid_models = set(roundtable_model.MODEL_ENDPOINTS)

    for role_name, model_name in req.role_models.items():
        if role_name not in valid_roles:
            raise HTTPException(400, {
                "error": "unknown role",
                "got": role_name,
                "valid": sorted(valid_roles),
            })
        if model_name not in valid_models:
            raise HTTPException(400, {
                "error": "unknown model",
                "got": model_name,
                "valid": sorted(valid_models),
            })

    role_models_store.save(req.role_models)
    return {"ok": True, "role_models": req.role_models}
```

- [ ] **Step 4: 跑测试**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_endpoint.py' -v 2>&1 | tail -10
```

Expected: 7 个全过(2 个 Task 2 + 5 个新增)。

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_role_models_endpoint.py
git commit -m "$(cat <<'EOF'
feat(main): 加 PUT /settings/role-models endpoint

接受 {role_models: {role: model}} 字典,校验 role 和 model 都已知,
原子写到 ~/.cc-workflow/role_models.json。空 dict = 清所有 override。

5 个 endpoint 测试覆盖:写入 / 空清空 / 未知 role 400 / 未知 model
400 / 返回 effective map。

spec §3.2。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `create_roundtable` 合并 persistent + per-session role_models

**Files:**
- Modify: `backend/main.py:1642-1663`(`create_roundtable`)
- Modify: `tests/test_role_models_endpoint.py`(append 1 merge 测试)

- [ ] **Step 1: 写失败测试**

Append 到 `PutRoleModelsTests` 同文件 (新 class):

```python
class CreateRoundtableMergesRoleModelsTests(unittest.TestCase):
    """POST /roundtables 把 per-session role_models 跟 persistent 合并 —
    per-session 字段覆盖 persistent。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.role_models_file = self.tmp_path / "role_models.json"
        self.patches = [
            patch.object(role_models_store, "_PATH", self.role_models_file),
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

    def test_per_session_role_models_override_persistent(self):
        self.role_models_file.write_text(
            json.dumps({"极简派": "kimi-k2.6", "悲观派": "deepseek-reasoner"}),
            encoding="utf-8",
        )
        from unittest.mock import patch as _patch, MagicMock
        captured = {}
        def _fake_submit(*args, **kwargs):
            captured.update(kwargs)
            return Path("/tmp/fake-session.jsonl")
        with _patch("backend.main.roundtable_runner.submit", side_effect=_fake_submit):
            r = self.client.post(
                "/roundtables",
                json={
                    "question": "Q?",
                    "role_models": {"极简派": "moonshot-v1-32k"},  # 覆盖 persistent
                },
            )
        self.assertEqual(r.status_code, 202, r.text)
        merged = captured["role_models"]
        # per-session 字段覆盖,persistent 其他 key 保留
        self.assertEqual(merged["极简派"], "moonshot-v1-32k")
        self.assertEqual(merged["悲观派"], "deepseek-reasoner")
```

- [ ] **Step 2: 跑测试,确认失败**

Expected:`merged["悲观派"]` 是 `None` 或不在 dict 里(因为现在没合并 persistent)。

- [ ] **Step 3: 改 `create_roundtable`**

`backend/main.py:1642` 附近,在调 `roundtable_runner.submit(...)` 前加合并:

```python
@app.post("/roundtables", dependencies=PROTECT, status_code=202)
def create_roundtable(req: NewRoundtableRequest) -> dict:
    """Kick off a new roundtable session. role_models 解析三层:
    per-session (req.role_models) > persistent (role_models.json) > hardcode。
    """
    persistent = role_models_store.load()
    merged = {**persistent, **(req.role_models or {})}

    if merged:
        valid_roles = (
            {r.name for r in roundtable_roles.ROLES}
            | {roundtable_roles.SYNTHESIZER.name}
            | {roundtable_roles.REVIEWER.name}
        )
        for role_name, model_name in merged.items():
            if role_name not in valid_roles:
                raise HTTPException(400, {"error": f"unknown role: {role_name!r}"})
            if model_name not in roundtable_model.MODEL_ENDPOINTS:
                raise HTTPException(400, {
                    "error": f"unknown model: {model_name!r}",
                    "known": sorted(roundtable_model.MODEL_ENDPOINTS),
                })
    path = roundtable_runner.submit(
        req.question.strip(),
        role_models=merged,
        critique_rounds=req.critique_rounds,
    )
    return {"id": path.stem, "status": "queued", "question": req.question}
```

注意:旧代码 `if req.role_models:` 校验改成 `if merged:`,且 valid_roles 加上 REVIEWER(之前 PUT endpoint 里也是同样校验三件套)。

- [ ] **Step 4: 跑测试 — 所有 test_role_models_endpoint 都过**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_endpoint.py' -v 2>&1 | tail -10
python3 -m unittest discover -s tests 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_role_models_endpoint.py
git commit -m "$(cat <<'EOF'
feat(main): create_roundtable 合并 persistent + per-session role_models

三层 model 优先级生效:per-session (POST body) > persistent
(role_models.json) > hardcode (roles.py)。 现有 per-session
override 行为不变,但现在会在 persistent 基础上合并。

校验扩到 REVIEWER(之前漏)。1 个 endpoint 测试覆盖 merge 行为
+ 验证 persistent 没被 per-session 显式提到的 key 保留下来。

spec §3.2。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: PWA `#settings/roles` 路由 + 渲染 + 保存

**Files:**
- Modify: `pwa/app.js`(settings hub 加 Roles 卡片 + 新路由 + 渲染函数 + 保存 handler)

PWA 无自动化测试,靠 node --check + ssh 实测。

- [ ] **Step 1: 修 settings hub**

`pwa/app.js:5000` 附近 `renderSettingsView`,在 `<a class="settings-card" href="#settings/providers">` 同段加 Roles 卡片:

```html
<a class="settings-card" href="#settings/roles">
  <div class="settings-card-title"><strong>Roundtable Roles</strong></div>
  <div class="muted">每个角色(极简派 / 场景派 / 借鉴派 / 悲观派 / 整理员 / 审查员)默认用哪个 model</div>
</a>
```

- [ ] **Step 2: dispatcher 加 roles 分支**

`pwa/app.js:5016` `renderSettingsSectionView`:

```javascript
function renderSettingsSectionView(section) {
  if (section === 'providers') return renderSettingsProvidersView();
  if (section === 'roles') return renderSettingsRolesView();   // ← 新
  // 未知 section → 退回 hub(避免白屏)
  window.history.replaceState(null, '', '#settings');
  renderSettingsView();
}
```

- [ ] **Step 3: 实现 `renderSettingsRolesView`**

在 `renderSettingsProvidersView` 之后(或文件末尾合适位置)加:

```javascript
async function renderSettingsRolesView() {
  const view = $('view');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link">← Settings</a></p>
    <h3 style="margin:0 0 var(--space-2)">Roundtable Roles</h3>
    <p class="muted" style="margin:0 0 var(--space-3)">配每个角色默认用哪个 model。新建 round 表单的 per-role 下拉仍可临时 override 这里的默认。</p>
    <div id="roles-table" class="muted">加载中...</div>`;

  let data;
  try {
    data = await api('/roundtables/models');
  } catch (err) {
    $('roles-table').innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    return;
  }

  const allModels = data.models || [];
  const allRoles = data.roles || [];

  const rows = allRoles.map(role => {
    const opts = allModels.map(m =>
      `<option value="${esc(m.name)}" ${m.name === role.default_model ? 'selected' : ''}>${esc(m.name)}</option>`
    ).join('');
    return `
      <tr>
        <td>${esc(role.name)} <span class="muted" style="font-size:11px">(${esc(role.kind)})</span></td>
        <td><select data-role="${esc(role.name)}" class="role-model-select">${opts}</select></td>
      </tr>`;
  }).join('');

  $('roles-table').innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead><tr><th style="text-align:left">角色</th><th style="text-align:left">默认 model</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:var(--space-3);display:flex;gap:var(--space-2)">
      <button class="ws-new-btn" id="roles-save-btn" type="button">保存</button>
      <button class="ws-cancel-btn" id="roles-reset-btn" type="button">全部重置(回 hardcode)</button>
    </div>`;

  $('roles-save-btn').addEventListener('click', _onRolesSave);
  $('roles-reset-btn').addEventListener('click', _onRolesReset);
}

async function _onRolesSave(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '保存中...';
  // 收集所有 <select data-role>,组成 {role: model}
  const selects = document.querySelectorAll('select.role-model-select');
  const role_models = {};
  for (const s of selects) {
    role_models[s.dataset.role] = s.value;
  }
  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models }),
    });
    showToast('success', 'role-models 已保存', { ttl: 2500 });
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function _onRolesReset(e) {
  if (!confirm('清空所有 role override,所有角色回到 hardcode 默认?')) return;
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '清空中...';
  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models: {} }),
    });
    showToast('success', '已清空所有 override', { ttl: 2500 });
    renderSettingsRolesView();    // 刷新当前页
  } catch (err) {
    showError(`清空失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '全部重置(回 hardcode)';
  }
}
```

注意:如果 PWA 没有 `ws-cancel-btn` 这种 class,用 inline style 或 `ws-new-btn` 都可以;参考 `renderSettingsProvidersView` 里用的按钮 class。

- [ ] **Step 4: 语法 check**

```bash
node --check pwa/app.js && echo OK
```

- [ ] **Step 5: Commit**

```bash
git add pwa/app.js
git commit -m "$(cat <<'EOF'
feat(pwa): 加 #settings/roles 页 — 配 roundtable 每角色默认 model

settings hub 加 "Roundtable Roles" 卡片入口。新页面渲染 6 个角色
(4 派 + 整理员 + 审查员)+ 每个 role 一个 model dropdown。
"保存" 按钮 PUT /settings/role-models,"全部重置" 清空所有 override。

spec §3.3。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 整体 smoke

- [ ] **Step 1: Full test battery**

```bash
python3 -m py_compile backend/*.py backend/roundtable/*.py && echo "py_compile OK"
python3 -m unittest discover -s tests 2>&1 | tail -5
node --check pwa/app.js && echo "pwa OK"
node --test tests/pwa-ui-contract.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)" | head
```

Expected:
- py_compile: OK
- ~50 tests pass (42 prior + 5 store + 7 endpoint + 1 merge = 55 nominal)
- node check: OK
- pwa contract: 18 pass

- [ ] **Step 2: 服务器端实测说明(用户做)**

ssh 上服务器:
1. `git pull && systemctl restart cc-workflow`
2. 浏览器打开 `#settings`,看到新"Roundtable Roles"卡片
3. 点进去,改某个角色的 model 比如把"借鉴派"切到 deepseek-chat,点保存
4. 看 `~/.cc-workflow/role_models.json` 内容是不是 `{"借鉴派": "deepseek-chat"}`
5. 新建一个 roundtable session,看借鉴派实际跑的是 deepseek-chat(不是 hardcode 的 kimi-k2.6)
6. "全部重置" 看是不是清空

---

## Self-Review

**Spec coverage check:**

| Spec 章节 | Plan task |
|---|---|
| §3.1 role_models_store.py | Task 1 |
| §3.2 GET /roundtables/models(REVIEWER + effective) | Task 2 |
| §3.2 PUT /settings/role-models | Task 3 |
| §3.2 create_roundtable 合并 | Task 4 |
| §3.3 PWA `#settings/roles` 页 | Task 5 |
| §4 错误处理 | Task 1 fallback + Task 3 400 validation |
| §5.1 unit | Task 1 |
| §5.2 integration | Task 2 + 3 + 4 |

✓ 全覆盖。

**Placeholder scan:** 无 TBD / TODO,每段代码都是可粘贴的完整代码。

**Type consistency:**
- `role_models: dict[str, str]` — Task 3 `RoleModelsRequest.role_models`、Task 4 `NewRoundtableRequest.role_models`(现有)、Task 5 PWA `JSON.stringify({role_models})` — 全一致 ✓
- `effective_model_for(role_name, hardcoded_default)` — Task 1 定义,Task 2 用,签名一致 ✓
- `_PATH` — Task 1 module-level constant,所有 test 通过 `patch.object` 重定向 ✓
