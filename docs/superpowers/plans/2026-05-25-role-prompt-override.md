# Role Prompt Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩 `role_models.json` schema 从 flat `{role: str}` 升 nested `{role: {model?, system_prompt?}}`,允许 PWA 编辑每角色的 system_prompt。Roundtable 标签 toolbar 加 "⚙ 角色配置" 入口。

**Architecture:** schema 同文件 in-place 升级(`load()` 自动转 nested,不写回文件)+ `effective_system_prompt_for()` 新函数 + `runner._execute` 用 `dataclasses.replace` 构造 customized Role 列表 + `run_session` / `continue_session` 加显式 `reviewer` 参数让 auto-drill loop 也用 customized reviewer + PWA settings 页 `<details>` 折叠的 textarea + Roundtable tab 加 link button。

**Tech Stack:** Python 3.13 + FastAPI + Pydantic v2 + `unittest.TestCase` + 原生 JS。

**Spec:** [`docs/superpowers/specs/2026-05-25-role-prompt-override-design.md`](../specs/2026-05-25-role-prompt-override-design.md)

---

## File Structure

**Modified:**
- `backend/roundtable/role_models_store.py` — `load()` 自动升级 nested + 新增 `effective_system_prompt_for()`
- `backend/roundtable/debate.py` — `run_session` / `continue_session` / `_run_auto_drill_loop` 加 `reviewer: Role` 参数(显式注入,缺省 fallback 到 module-level REVIEWER)
- `backend/roundtable/runner.py` — `_customize_role()` + `_customized_role_list()` helpers;`_execute` / `_execute_continue` 用 customized roles
- `backend/main.py` — `GET /roundtables/models` 加 `default_system_prompt` 字段;`PUT /settings/role-models` schema 改 nested(`RoleOverride` Pydantic 子 model)
- `pwa/app.js` — `#settings/roles` 每行加 `<details>` 折叠 + textarea;`_onRolesSave` 收集嵌套 dict;Roundtable tab toolbar 加 link;wire shape 改 nested
- `tests/test_role_models_store.py` — 加 schema 升级 / `effective_system_prompt_for` 测试
- `tests/test_role_models_endpoint.py` — endpoint 测试改 nested schema + 新增 prompt 相关 case

**No new files.**

---

## Task 1: `role_models_store.py` schema upgrade + nested load + new `effective_system_prompt_for`

**Files:**
- Modify: `backend/roundtable/role_models_store.py`
- Modify: `tests/test_role_models_store.py`

- [ ] **Step 1: 修改现有 5 个测试 + 加 4 个新测试**

老测试用的 wire shape 是 `{"极简派": "kimi-k2.6"}` flat dict — load 返回 `dict[str, str]`,save 接 `dict[str, str]`。要测的新行为:
- load 接 flat 也接 nested,返回 always `dict[str, dict]`
- mixed format 也能处理
- save 接 nested
- `effective_system_prompt_for` 新函数

旧测试需要改 return 值的 expected — 从 `{"极简派": "kimi-k2.6"}` 改成 `{"极简派": {"model": "kimi-k2.6"}}`。

完整新版 `tests/test_role_models_store.py`:

```python
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

    def test_load_returns_nested_dict_when_file_present(self):
        with _patched_path({"极简派": {"model": "kimi-k2.6"}}):
            self.assertEqual(role_models_store.load(), {"极简派": {"model": "kimi-k2.6"}})

    def test_load_upgrades_old_flat_format(self):
        """老 flat dict {role: str} → 自动升级 {role: {model: str}}"""
        with _patched_path({"极简派": "kimi-k2.6"}):
            self.assertEqual(role_models_store.load(), {"极简派": {"model": "kimi-k2.6"}})

    def test_load_handles_mixed_format(self):
        """同文件混合(部分 flat string、部分 nested dict)都正确处理。"""
        with _patched_path({
            "极简派": "kimi-k2.6",       # 老格式
            "悲观派": {"model": "deepseek-reasoner"},   # 新格式
            "借鉴派": {"system_prompt": "你是借鉴派(自定义)..."},  # 仅 prompt
        }):
            out = role_models_store.load()
            self.assertEqual(out["极简派"], {"model": "kimi-k2.6"})
            self.assertEqual(out["悲观派"], {"model": "deepseek-reasoner"})
            self.assertEqual(out["借鉴派"], {"system_prompt": "你是借鉴派(自定义)..."})

    def test_load_skips_garbage_values(self):
        """value 不是 string 也不是 dict(int / list / null)→ 静默忽略。"""
        with _patched_path({
            "极简派": "kimi-k2.6",
            "noise1": 42,
            "noise2": ["array"],
            "noise3": None,
        }):
            out = role_models_store.load()
            self.assertIn("极简派", out)
            self.assertNotIn("noise1", out)
            self.assertNotIn("noise2", out)
            self.assertNotIn("noise3", out)

    def test_load_strips_unknown_inner_keys(self):
        """nested dict 内层未知 key(将来 temperature 等)被 strip。当前接受 model + system_prompt。"""
        with _patched_path({"极简派": {"model": "kimi-k2.6", "temperature": 0.7, "unknown_field": "x"}}):
            out = role_models_store.load()
            self.assertEqual(out["极简派"], {"model": "kimi-k2.6"})

    def test_load_drops_empty_string_inner_values(self):
        """内层 model 或 system_prompt 是空 string → 视为没设置,过滤。"""
        with _patched_path({"极简派": {"model": "", "system_prompt": ""}}):
            out = role_models_store.load()
            # 空 entry → 不出现在结果里
            self.assertNotIn("极简派", out)

    def test_load_returns_empty_on_corrupt_json(self):
        with _patched_path(None) as p:
            p.write_text("{not json", encoding="utf-8")
            with self.assertLogs("backend.roundtable.role_models_store", level="WARNING"):
                self.assertEqual(role_models_store.load(), {})

    def test_save_then_load_roundtrip_nested(self):
        with _patched_path(None):
            role_models_store.save({
                "借鉴派": {"model": "kimi-k2.6"},
                "悲观派": {"model": "deepseek-reasoner", "system_prompt": "..."},
            })
            self.assertEqual(role_models_store.load(), {
                "借鉴派": {"model": "kimi-k2.6"},
                "悲观派": {"model": "deepseek-reasoner", "system_prompt": "..."},
            })

    def test_effective_model_for_uses_override_when_present(self):
        with _patched_path({"极简派": {"model": "kimi-k2.6"}}):
            self.assertEqual(
                role_models_store.effective_model_for("极简派", "deepseek-chat"),
                "kimi-k2.6",
            )
            self.assertEqual(
                role_models_store.effective_model_for("场景派", "deepseek-chat"),
                "deepseek-chat",
            )

    def test_effective_system_prompt_for_uses_override_when_present(self):
        with _patched_path({"极简派": {"system_prompt": "自定义 prompt"}}):
            self.assertEqual(
                role_models_store.effective_system_prompt_for("极简派", "default"),
                "自定义 prompt",
            )

    def test_effective_system_prompt_for_falls_back_to_default(self):
        with _patched_path({"极简派": {"model": "kimi-k2.6"}}):
            # 只有 model override,没 prompt override → 回 default
            self.assertEqual(
                role_models_store.effective_system_prompt_for("极简派", "default"),
                "default",
            )

    def test_effective_system_prompt_for_unknown_role_returns_default(self):
        with _patched_path({}):
            self.assertEqual(
                role_models_store.effective_system_prompt_for("场景派", "default"),
                "default",
            )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试,确认部分失败**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_store.py' -v 2>&1 | tail -20
```

Expected: 旧的 `test_load_returns_dict_when_file_present` 失败(因为 expected `{"极简派": "kimi-k2.6"}` 但新 load 返回 `{"极简派": {"model": "kimi-k2.6"}}`);新的 `test_load_upgrades_old_flat_format` 等 4-5 个全失败。

—— 这些都是预期失败,接下来 impl 修。

- [ ] **Step 3: 实现新的 `role_models_store.py`**

完整新版:

```python
"""Persistent per-role overrides(model + system_prompt;temperature 未来扩)。

Schema(~/.cc-workflow/role_models.json):
    {
      "<role-name>": {
        "model": "<model-name>",            # optional
        "system_prompt": "<prompt-text>",   # optional
      },
      ...
    }

老 flat dict 格式(`{role: model}` 只 model 一个)load 时自动升级到 nested,
但不写回文件 — 等用户下次 save 才落新格式(避免 load 副作用)。文件名保留
`role_models.json` 不改 — 跟 spec §2.3 的"几乎不可逆"决策对齐。

跟 backend/ws_settings.py 一样的容错策略:文件读不出 → {} + warning,
启动失败比降级危险。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from .. import config

_logger = logging.getLogger(__name__)

_PATH = config.CCW_DIR / "role_models.json"

# 接受的内层字段白名单 — 未知 key 在 load() 阶段过滤
_KNOWN_FIELDS = ("model", "system_prompt")


def _read_raw() -> dict:
    """读 JSON 文件,返回顶层 dict;{} on missing / unreadable / non-dict。"""
    if not _PATH.exists():
        return {}
    try:
        data = json.loads(_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            _logger.warning("role_models.json 不是 dict,忽略: %r", data)
            return {}
        return data
    except (OSError, json.JSONDecodeError) as e:
        _logger.warning("role_models.json 读不出 (%s),fallback {}", e)
        return {}


def load() -> dict[str, dict]:
    """Return overrides dict;always nested shape {role: {model?, system_prompt?}}。
    老 flat string value 自动升级到 {"model": value};未知 key 过滤;空 entry 丢。"""
    raw = _read_raw()
    out: dict[str, dict] = {}
    for role_name, val in raw.items():
        if isinstance(val, str):
            # 老 flat format,model 单值
            if val:
                out[role_name] = {"model": val}
        elif isinstance(val, dict):
            cleaned: dict[str, str] = {}
            for field in _KNOWN_FIELDS:
                v = val.get(field)
                if isinstance(v, str) and v:
                    cleaned[field] = v
            if cleaned:
                out[role_name] = cleaned
        # 其它类型(int / list / null)静默忽略
    return out


def save(data: dict[str, dict]) -> None:
    """Atomic write — temp + os.replace 防 race。
    Caller 已经传 nested 格式;这里不做 schema 升级 / 验证(那是 endpoint 的事)。"""
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _PATH)


def effective_model_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name, {}).get("model") or hardcoded_default


def effective_system_prompt_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name, {}).get("system_prompt") or hardcoded_default
```

- [ ] **Step 4: 跑测试,全过**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_store.py' -v 2>&1 | tail -20
```

Expected: 13 tests pass(8 原本就有 + 5 新增,排版数字大概会差几个,但应该全过)

- [ ] **Step 5: 跑全套件确认无回归**

```bash
python3 -m unittest discover -s tests 2>&1 | tail -5
```

⚠️ **预期会有回归** — `test_role_models_endpoint.py` 测试 PUT endpoint 时用的是老 wire shape `{"极简派": "kimi-k2.6"}`,现在 `RoleModelsRequest.role_models` 还是 `dict[str, str]`,所以接口测试还没破。但 GET endpoint 测试如果断言了完整 response 结构可能受影响。如果有回归,Task 1 不修(留给 Task 3),只确认是哪些 endpoint 测试受影响,在 commit message 里备注下。

- [ ] **Step 6: Commit**

```bash
git add backend/roundtable/role_models_store.py tests/test_role_models_store.py
git commit -m "$(cat <<'EOF'
refactor(roundtable): role_models_store schema 从 flat 升 nested

schema:{role: str} → {role: {model?, system_prompt?}}。load() 自动
升级老 flat 格式到 nested(in-place,不写回文件;下次 PUT 才落新格式)。
未知内层字段过滤(将来 temperature 等);空 entry 丢;非 string/dict
value 静默忽略。

新增 effective_system_prompt_for() 跟 effective_model_for() 配对。

13 个单测:flat → nested 升级、mixed format、garbage 过滤、空值丢、
两个 effective_X_for 各路径。

接口 wire shape 暂未跟着改(Task 3 跟新 endpoint schema 一起处理),
预期 test_role_models_endpoint.py 有部分回归 — 见下个 commit。

spec §3.1。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `_customize_role` helper + runner / debate.py 加显式 reviewer 参数

**Files:**
- Modify: `backend/roundtable/runner.py`
- Modify: `backend/roundtable/debate.py`
- Modify: `tests/test_roundtable.py`(扩 1-2 个测试)

- [ ] **Step 1: 写 2 个失败测试** — append 到 `tests/test_roundtable.py`(`ContinueSessionTests` 之后,`if __name__` 之前):

```python
class RoleCustomizationTests(unittest.TestCase):
    """`runner._customize_role` 用 role_models_store 的 system_prompt override
    把 Role.system_prompt 替换。"""

    def test_customize_role_with_prompt_override_replaces_prompt(self):
        from unittest.mock import patch
        from backend.roundtable import runner, role_models_store
        from backend.roundtable.data import Role
        original = Role(name="极简派", system_prompt="default prompt", preferred_model="m")
        with patch.object(role_models_store, "load",
                          return_value={"极简派": {"system_prompt": "customized!"}}):
            result = runner._customize_role(original)
        self.assertEqual(result.system_prompt, "customized!")
        self.assertEqual(result.name, "极简派")
        self.assertEqual(result.preferred_model, "m")    # 其他字段保留

    def test_customize_role_without_override_returns_same_instance(self):
        from unittest.mock import patch
        from backend.roundtable import runner, role_models_store
        from backend.roundtable.data import Role
        original = Role(name="极简派", system_prompt="default prompt", preferred_model="m")
        with patch.object(role_models_store, "load", return_value={"极简派": {"model": "kimi-k2.6"}}):
            # 只有 model override 没 prompt override → 返回原 Role(身份相等)
            result = runner._customize_role(original)
        self.assertIs(result, original)
```

注意:`assertIs` 验证身份相等(没生成新对象)。这是个性能 + 语义双优化 — 没必要 replace 的时候不 replace。

- [ ] **Step 2: 跑测试确认失败**

```bash
python3 -m unittest tests.test_roundtable.RoleCustomizationTests -v 2>&1 | tail -10
```

Expected: ImportError on `runner._customize_role`.

- [ ] **Step 3: 实现 `_customize_role` + customize helpers in runner.py**

`backend/roundtable/runner.py` 顶部 imports 加:

```python
import dataclasses
from . import role_models_store
```

(放在 `from . import roles as roles_mod` 同段。)

在 `submit` 函数前 / `_execute` 前的 module-level 加:

```python
def _customize_role(role: Role) -> Role:
    """用 persistent override 替换 role.system_prompt;若无 override 返回
    原 role(身份不变)。model 不在这里 customize — 用现有的
    role_models_overrides dict 路径解决。"""
    override_prompt = role_models_store.load().get(role.name, {}).get("system_prompt")
    if override_prompt:
        return dataclasses.replace(role, system_prompt=override_prompt)
    return role


def _customized_role_list() -> tuple[list[Role], Role, Role]:
    """构造一组 customized roles(ROLES + SYNTHESIZER + REVIEWER)。
    返回 (roles, synthesizer, reviewer) 三元组,给 _execute / _execute_continue 用。"""
    return (
        [_customize_role(r) for r in roles_mod.ROLES],
        _customize_role(roles_mod.SYNTHESIZER),
        _customize_role(roles_mod.REVIEWER),
    )
```

也加 import `from .data import Role`(顶部,如果还没有的话)。

- [ ] **Step 4: 跑测试,确认新 2 个测试过**

```bash
python3 -m unittest tests.test_roundtable.RoleCustomizationTests -v 2>&1 | tail -10
```

- [ ] **Step 5: 修改 `_execute` 和 `_execute_continue` 用 customized roles**

`backend/roundtable/runner.py` 找到 `_execute` 函数(line ~86),修改 `run_session` 调用:

```python
def _execute(question, session_path, role_models, critique_rounds, on_complete):
    """Run the debate end-to-end..."""
    try:
        roles, synthesizer, reviewer = _customized_role_list()
        run_session(
            question=question,
            roles=roles,
            synthesizer=synthesizer,
            model_fn=call_model,
            session_path=session_path,
            role_model_overrides=role_models,
            critique_rounds=critique_rounds,
            reviewer=reviewer,    # ← 新增
        )
    except ModelError as e:
        ...
```

同样改 `_execute_continue`:

```python
def _execute_continue(session_path, follow_up_question, role_models, on_complete):
    """..."""
    from .debate import continue_session
    try:
        roles, synthesizer, reviewer = _customized_role_list()
        continue_session(
            session_path=session_path,
            follow_up_question=follow_up_question,
            roles=roles,
            synthesizer=synthesizer,
            model_fn=call_model,
            role_model_overrides=role_models,
            reviewer=reviewer,    # ← 新增
        )
    ...
```

- [ ] **Step 6: 给 debate.py `run_session` / `continue_session` / `_run_auto_drill_loop` 加 reviewer 参数**

`backend/roundtable/debate.py` 找到 `run_session` 签名(line ~182):

```python
def run_session(
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    session_path: Path,
    *,
    role_model_overrides: Optional[dict[str, str]] = None,
    critique_rounds: int = 1,
    max_auto_drills: int = 3,
    reviewer: Optional[Role] = None,    # ← 新增,缺省 fallback REVIEWER
    on_turn: Optional[Callable[[AgentTurn], None]] = None,
    clock: Callable[[], float] = time.time,
) -> Session:
    """..."""
    if reviewer is None:
        reviewer = REVIEWER    # 沿用旧行为,module-level 默认
    overrides = role_model_overrides or {}
    ...
```

然后在最后调 `_run_auto_drill_loop` 的地方:

```python
    _run_auto_drill_loop(
        session=session,
        ...
        reviewer=reviewer,    # ← 新增
        ...
    )
```

`continue_session` 同样改(加 `reviewer: Optional[Role] = None` 参数 + `if None: reviewer = REVIEWER` + 传给 `_run_auto_drill_loop`)。

`_run_auto_drill_loop` 函数签名加 `reviewer: Role` 参数(放在 kwargs-only 段):

```python
def _run_auto_drill_loop(
    *,
    session: Session,
    session_path: Path,
    question: str,
    roles: list[Role],
    synthesizer: Role,
    reviewer: Role,    # ← 新增(non-optional,caller 必须传)
    model_fn: ModelFn,
    overrides: dict[str, str],
    clock: Callable[[], float],
    start_round: int,
    max_auto_drills: int,
    on_turn: Optional[Callable[[AgentTurn], None]],
) -> None:
    ...
```

然后函数体里所有用到 `REVIEWER` 全局常量的地方改用 `reviewer` 参数:

```python
verdict_text = model_fn(
    overrides.get(reviewer.name) or reviewer.preferred_model,    # 改 REVIEWER.name → reviewer.name 等
    reviewer.system_prompt,
    reviewer_prompt,
    reviewer.temperature,
)
verdict = reviewer_mod.parse_verdict(verdict_text)
_record(AgentTurn(
    round=last_synth.round, role=reviewer.name, type="review",
    content=verdict_text, ts=clock(),
))
```

Module-level `from .roles import REVIEWER` import 保留 — 缺省 fallback 用。

- [ ] **Step 7: 跑全部 roundtable 测试,确认无回归**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' 2>&1 | tail -10
```

旧测试不传 `reviewer` 参数 → 缺省 fallback 到 module-level `REVIEWER`,行为不变,应该全过。

- [ ] **Step 8: Commit**

```bash
git add backend/roundtable/runner.py backend/roundtable/debate.py tests/test_roundtable.py
git commit -m "$(cat <<'EOF'
feat(roundtable): runner.py 加 _customize_role + debate.py 加显式 reviewer 参数

_customize_role 用 role_models_store 的 system_prompt override
通过 dataclasses.replace 替换 Role.system_prompt,无 override 时
返回原 Role 身份(性能 + 语义双优化)。

run_session / continue_session / _run_auto_drill_loop 加显式 reviewer
参数,缺省 fallback 到 module-level REVIEWER 不破坏现有调用。这样
auto-drill loop 也能用 customized reviewer(否则它从 from .roles import
REVIEWER 拿,绕过 override)。

_execute / _execute_continue 用 _customized_role_list() 构造 customized
列表,prompt override 自然透传到所有 派 / synth / reviewer。

2 个新单测覆盖 _customize_role 两条路径(有 prompt override 替换 / 无
override 身份返回)。

spec §3.2 + §3.3。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `GET /roundtables/models` + `PUT /settings/role-models` schema 改 nested

**Files:**
- Modify: `backend/main.py`
- Modify: `tests/test_role_models_endpoint.py`(更新 nested schema 测试)

- [ ] **Step 1: 改测试 — 现有 endpoint 测试要适应 nested wire shape**

读 `tests/test_role_models_endpoint.py` 当前内容,改:

旧 wire shape:
```python
self.client.put("/settings/role-models", json={"role_models": {"极简派": "kimi-k2.6"}})
```

新 wire shape:
```python
self.client.put("/settings/role-models", json={"role_models": {"极简派": {"model": "kimi-k2.6"}}})
```

每个测试方法都要改 wire shape。同时新增以下测试 case:

```python
# (append 到 PutRoleModelsTests class)

def test_put_writes_prompt_override(self):
    r = self.client.put(
        "/settings/role-models",
        json={"role_models": {"极简派": {"system_prompt": "自定义 prompt"}}},
    )
    self.assertEqual(r.status_code, 200, r.text)
    data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
    self.assertEqual(data["极简派"]["system_prompt"], "自定义 prompt")

def test_put_writes_both_model_and_prompt(self):
    r = self.client.put(
        "/settings/role-models",
        json={"role_models": {"极简派": {"model": "kimi-k2.6", "system_prompt": "..."}}},
    )
    self.assertEqual(r.status_code, 200)
    data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
    self.assertEqual(data["极简派"]["model"], "kimi-k2.6")
    self.assertEqual(data["极简派"]["system_prompt"], "...")

def test_put_empty_prompt_treated_as_no_override(self):
    """空白 system_prompt → 静默不存(等价 reset)。不抛 400。"""
    r = self.client.put(
        "/settings/role-models",
        json={"role_models": {"极简派": {"system_prompt": "   "}}},   # 纯空白
    )
    self.assertEqual(r.status_code, 200, r.text)
    data = json.loads(self.role_models_file.read_text(encoding="utf-8")) if self.role_models_file.exists() else {}
    self.assertNotIn("极简派", data)    # 没 entry

def test_put_prompt_too_long_422(self):
    """system_prompt > 5000 字符 → Pydantic max_length 422。"""
    r = self.client.put(
        "/settings/role-models",
        json={"role_models": {"极简派": {"system_prompt": "x" * 5001}}},
    )
    self.assertEqual(r.status_code, 422)
```

同时在 `RoundtableModelsEndpointTests` 加 1 个测试:

```python
def test_models_endpoint_includes_default_system_prompt(self):
    """GET /roundtables/models 响应每个 role 含 default_system_prompt 字段。"""
    r = self.client.get("/roundtables/models")
    self.assertEqual(r.status_code, 200)
    body = r.json()
    for role in body["roles"]:
        self.assertIn("default_system_prompt", role)
        self.assertIsInstance(role["default_system_prompt"], str)
        self.assertGreater(len(role["default_system_prompt"]), 0)  # hardcode prompts 都非空
```

更新 `test_per_session_role_models_override_persistent` (在 `CreateRoundtableMergesRoleModelsTests`) 的 wire shape:

```python
def test_per_session_role_models_override_persistent(self):
    self.role_models_file.write_text(
        json.dumps({
            "极简派": {"model": "kimi-k2.6"},
            "悲观派": {"model": "deepseek-reasoner"},
        }),
        encoding="utf-8",
    )
    ...
```

—— 注意 `req.role_models` 是 per-session POST body,目前 wire shape 我们不改(spec §7 non-goal:per-session prompt 不暴露)。所以 `POST /roundtables` body 的 `role_models` 还是 `dict[str, str]`(model 只),没问题 — `NewRoundtableRequest.role_models: Optional[dict[str, str]]` 不动。

但是这个测试的 `_capture_submit` 验证 merged dict 时,新逻辑下 persistent 是 nested,per-session 是 flat,合并起来怎么处理?

`create_roundtable` 当前逻辑:
```python
persistent = role_models_store.load()    # nested dict[str, dict]
merged = {**persistent, **(req.role_models or {})}   # mix nested + flat??
```

这里 mixing nested 和 flat 是 bug。需要重新设计 merge 逻辑(下一步)。

- [ ] **Step 2: 跑测试,确认部分失败**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_endpoint.py' -v 2>&1 | tail -20
```

Expected: 几个老的 `test_put_*` 失败(wire shape 老 vs 新),新增的 5 个测试也失败(endpoint 还没改)。

- [ ] **Step 3: 实现 endpoint 改造**

`backend/main.py` 找到 `RoleModelsRequest`,改成:

```python
class RoleOverride(BaseModel):
    model: Optional[str] = None
    system_prompt: Optional[str] = Field(default=None, max_length=5000)


class RoleModelsRequest(BaseModel):
    # Schema 从 dict[str, str] 升 dict[str, RoleOverride]。空 dict = 清全部
    # override;某个 role 的内层 dict 空 = 清该 role 的 override。
    role_models: dict[str, RoleOverride] = Field(default_factory=dict)
```

`put_role_models` 函数体改:

```python
@app.put("/settings/role-models", dependencies=PROTECT)
def put_role_models(req: RoleModelsRequest) -> dict:
    valid_roles = _all_role_names()
    valid_models = set(roundtable_model.MODEL_ENDPOINTS)

    cleaned: dict[str, dict] = {}
    for role_name, override in req.role_models.items():
        if role_name not in valid_roles:
            raise HTTPException(400, {
                "error": "unknown role", "got": role_name, "valid": sorted(valid_roles),
            })
        entry: dict[str, str] = {}
        if override.model:
            if override.model not in valid_models:
                raise HTTPException(400, {
                    "error": "unknown model", "got": override.model, "valid": sorted(valid_models),
                })
            entry["model"] = override.model
        if override.system_prompt:
            stripped = override.system_prompt.strip()
            if stripped:    # 纯空白不存,等价 reset
                entry["system_prompt"] = stripped
        if entry:
            cleaned[role_name] = entry

    role_models_store.save(cleaned)
    return {"ok": True, "role_models": cleaned}
```

`list_roundtable_models` 函数体改 `_role_entry`:

```python
def _role_entry(r, kind: str) -> dict:
    return {
        "name": r.name,
        "default_model": role_models_store.effective_model_for(r.name, r.preferred_model),
        "default_system_prompt": role_models_store.effective_system_prompt_for(
            r.name, r.system_prompt,
        ),
        "kind": kind,
    }
```

`create_roundtable` 改 merge 逻辑 —— per-session 仍然 flat,要合到 nested 的 model 部分(不动 prompt):

```python
@app.post("/roundtables", dependencies=PROTECT, status_code=202)
def create_roundtable(req: NewRoundtableRequest) -> dict:
    """..."""
    persistent = role_models_store.load()    # dict[str, dict] (nested)
    # per-session 只能 override model(spec §7 non-goal:per-session prompt 不暴露)
    # 把 persistent 的 model 部分跟 per-session merge,prompt 部分保持 persistent
    merged_models: dict[str, str] = {}
    for role_name, entry in persistent.items():
        if "model" in entry:
            merged_models[role_name] = entry["model"]
    if req.role_models:
        merged_models.update(req.role_models)

    if req.role_models:
        valid_roles = _all_role_names()
        for role_name, model_name in req.role_models.items():
            if role_name not in valid_roles:
                raise HTTPException(400, {"error": f"unknown role: {role_name!r}"})
            if model_name not in roundtable_model.MODEL_ENDPOINTS:
                raise HTTPException(400, {
                    "error": f"unknown model: {model_name!r}",
                    "known": sorted(roundtable_model.MODEL_ENDPOINTS),
                })

    # ... attachments enrichment 不动 ...

    path = roundtable_runner.submit(
        enriched_question,
        role_models=merged_models,   # flat dict[str, str],跟现有 submit signature 一致
        critique_rounds=req.critique_rounds,
    )
    return {"id": path.stem, "status": "queued", "question": req.question}
```

—— **关键设计**:`runner.submit` signature 不动(还是接 `role_models: dict[str, str]`,只 model 维度);prompt override 通过 `runner._customize_role`(Task 2)的独立路径生效,不走 submit signature。两个 override 走两个独立 path,互不干扰。

- [ ] **Step 4: 跑测试,确认全过**

```bash
python3 -m unittest discover -s tests -p 'test_role_models_endpoint.py' -v 2>&1 | tail -15
python3 -m unittest discover -s tests 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_role_models_endpoint.py
git commit -m "$(cat <<'EOF'
feat(main): role-models endpoint schema 改 nested + 加 prompt 字段

PUT /settings/role-models wire shape 从 {role: str} 升 {role: {model?,
system_prompt?}}。RoleOverride Pydantic submodel 校验:model 必须在
MODEL_ENDPOINTS,system_prompt max_length=5000;空白 prompt 静默不存
等价 reset。

GET /roundtables/models 响应每个 role 多 default_system_prompt 字段
(用 effective_system_prompt_for 解析)。

create_roundtable 合并逻辑改 — persistent 是 nested,per-session 是
flat(spec §7:per-session prompt 不暴露)。从 persistent 抽 model
部分跟 per-session merge,跟 runner.submit signature(model 维度
flat dict)对齐。prompt override 走 _customize_role 独立 path,不走
submit signature。

5 个新单测覆盖 prompt 写入 / 空白等价 reset / 超长 422 / GET 含
default_system_prompt 字段。

spec §3.4 + §3.5。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: PWA `#settings/roles` 加 prompt 编辑 + Roundtable tab 加入口

**Files:**
- Modify: `pwa/app.js`

PWA 无自动化测,`node --check` + ssh 实测。

- [ ] **Step 1: 改 `renderSettingsRolesView`,每行加 `<details>` + textarea**

找到 `renderSettingsRolesView`(用 `grep -n "renderSettingsRolesView" pwa/app.js`)。改 `rows.map` 部分:

```javascript
const rows = allRoles.map(role => {
  const opts = allModels.map(m =>
    `<option value="${esc(m.name)}" ${m.name === role.default_model ? 'selected' : ''}>${esc(m.name)}</option>`
  ).join('');
  return `
    <tr style="vertical-align:top">
      <td style="padding-top:8px">${esc(role.name)} <span class="muted" style="font-size:11px">(${esc(role.kind)})</span></td>
      <td>
        <select data-role="${esc(role.name)}" class="role-model-select">${opts}</select>
        <details class="role-prompt-toggle" style="margin-top:8px">
          <summary class="muted" style="font-size:11px;cursor:pointer">
            ▸ 自定义 system_prompt(可选,清空 = 用默认)
          </summary>
          <textarea data-role-prompt="${esc(role.name)}" class="role-prompt-textarea"
                    rows="12"
                    style="width:100%;font-family:monospace;font-size:12px;margin-top:6px;box-sizing:border-box"
                    placeholder="留空使用 roles.py 的默认 prompt">${esc(role.default_system_prompt || '')}</textarea>
          <button type="button" class="role-prompt-reset" data-role="${esc(role.name)}"
                  style="font-size:11px;margin-top:4px">重置为默认(清空 textarea)</button>
        </details>
      </td>
    </tr>`;
}).join('');
```

注意:textarea 初值是 `role.default_system_prompt`(后端返回的 effective)。如果用户没 override,这就是 hardcode 默认;有 override 就是 override 值。textarea 显示什么 = 当前生效的 prompt。

- [ ] **Step 2: 改 `_onRolesSave` 收集 nested wire shape**

```javascript
async function _onRolesSave(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '保存中...';

  // 收集 nested {role: {model?, system_prompt?}}
  const role_models = {};
  for (const s of document.querySelectorAll('select.role-model-select')) {
    const role = s.dataset.role;
    if (!role_models[role]) role_models[role] = {};
    role_models[role].model = s.value;
  }
  for (const ta of document.querySelectorAll('textarea[data-role-prompt]')) {
    const role = ta.dataset.rolePrompt;
    const prompt = ta.value.trim();
    if (!role_models[role]) role_models[role] = {};
    if (prompt) {
      role_models[role].system_prompt = prompt;
    }
    // 空 prompt 不加字段 → backend 看到只有 model 没 prompt → 清掉 prompt override
  }

  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models }),
    });
    showToast('success', 'role overrides 已保存', { ttl: 2500 });
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}
```

- [ ] **Step 3: 加 `_onRolePromptReset` handler + 绑定**

在 `_onRolesReset` 之后 / 文件其他地方加:

```javascript
function _onRolePromptReset(e) {
  const role = e.currentTarget.dataset.role;
  const ta = document.querySelector(`textarea[data-role-prompt="${CSS.escape(role)}"]`);
  if (ta) { ta.value = ''; ta.focus(); }
  // 不立即调 API — 用户得点"保存"才真正提交。给个 toast 提示。
  showToast('info', `${role} prompt 已清空 — 点保存才真正回默认`, { ttl: 2500 });
}
```

在 `renderSettingsRolesView` 末尾的 event 绑定那里加:

```javascript
$('roles-save-btn').addEventListener('click', _onRolesSave);
$('roles-reset-btn').addEventListener('click', _onRolesReset);
for (const btn of document.querySelectorAll('.role-prompt-reset')) {
  btn.addEventListener('click', _onRolePromptReset);    // ← 新增
}
```

- [ ] **Step 4: Roundtable tab toolbar 加 link**

找到 `renderRoundtablesView` 里的 `<div class="ws-toolbar">` block(line 4275 附近):

```javascript
<div class="ws-toolbar">
  <button class="ws-new-btn" type="button" id="rt-new-btn">+ 新开一场</button>
  <a href="#settings/roles" class="ws-toolbar-link"
     style="margin-left:12px;font-size:13px;text-decoration:none;color:var(--accent)">
    ⚙ 角色配置
  </a>
</div>
```

- [ ] **Step 5: 语法 check**

```bash
node --check pwa/app.js && echo OK
```

- [ ] **Step 6: Commit**

```bash
git add pwa/app.js
git commit -m "$(cat <<'EOF'
feat(pwa): #settings/roles 加 system_prompt textarea + Roundtable tab 加入口

每个角色行加 <details> 折叠的 textarea(rows=12,等宽字体,默认显示
当前 effective prompt)+ "重置为默认"按钮(清空 textarea + toast 提
示要点保存才真正生效)。

_onRolesSave 现在收集 nested wire shape({role: {model, system_prompt?}})
直接发给改造后的 PUT endpoint。

Roundtable 标签 toolbar 加 "⚙ 角色配置" link 跳现有 #settings/roles
(双入口设计,不动 URL)。

spec §3.6 + §3.7。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 整体 smoke + final review

- [ ] **Step 1: full test battery**

```bash
python3 -m py_compile backend/*.py backend/roundtable/*.py && echo "py_compile OK"
python3 -m unittest discover -s tests 2>&1 | tail -5
node --check pwa/app.js && echo "pwa OK"
node --test tests/pwa-ui-contract.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)" | head
```

Expected:
- py_compile OK
- 全部测试 pass(63 + Task 1 增 5 + Task 2 增 2 + Task 3 增 5 ≈ 75)
- node check OK
- 18 pwa contract pass

- [ ] **Step 2: ssh 端手测说明(用户做)**

```bash
ssh ... && cd /root/projects/cc-workflow && git pull
systemctl restart cc-workflow
```

PWA 验证:
1. Roundtable 标签 toolbar 看到 "⚙ 角色配置" 链接
2. 点进去 → 6 个角色每行 有 model dropdown + "▸ 自定义 system_prompt" 折叠
3. 展开某派(比如借鉴派),textarea 显示当前 prompt(几百字符的完整 prompt)
4. 改一两句 → 保存 → toast 成功
5. ssh `cat ~/.cc-workflow/role_models.json` 看新格式 `{借鉴派: {model: ..., system_prompt: "..."}}` 写入
6. 新建一个 roundtable session 让借鉴派出场 → 看派的 R1 答案应该 reflect 自定义 prompt 风格(质量验证)
7. 回 settings/roles → 点借鉴派的"重置为默认"按钮 → textarea 清空 → 点保存 → ssh 看 json 里借鉴派的 system_prompt 字段被删

老 flat format 兼容验证:
```bash
# 手编 ~/.cc-workflow/role_models.json 写老格式:
echo '{"极简派": "kimi-k2.6"}' > ~/.cc-workflow/role_models.json
# 不重启,PWA 打开 #settings/roles → 极简派 dropdown 显示 kimi-k2.6(load 升级生效)
# 点保存 → ssh 看 json 升成 nested 格式
```

---

## Self-Review

**Spec coverage check:**

| Spec 章节 | Plan task |
|---|---|
| §3.1 role_models_store 升级 | Task 1 |
| §3.2 _customize_role + _customized_role_list | Task 2 |
| §3.3 run_session / continue_session / _run_auto_drill_loop reviewer 参数 | Task 2 |
| §3.4 GET /roundtables/models default_system_prompt | Task 3 |
| §3.5 PUT /settings/role-models nested + RoleOverride 校验 | Task 3 |
| §3.6 PWA #settings/roles textarea + reset | Task 4 |
| §3.7 Roundtable tab toolbar link | Task 4 |
| §4 错误处理(各 fallback 路径) | Task 1 + 3 测试覆盖 |
| §5 测试(store unit + endpoint integration + customize unit) | Task 1 + 2 + 3 |

✓ 全覆盖。

**Placeholder scan:** 无 TBD / TODO。每步代码块都是完整可粘的代码。

**Type consistency:**

- `dict[str, dict]` — Task 1 `load()` 返回,Task 3 backend store 入,Task 4 PWA `role_models` 发送 — 一致 ✓
- `RoleOverride.model: Optional[str]` + `system_prompt: Optional[str]` — Task 3 backend,Task 4 PWA JSON 字段名一致 ✓
- `reviewer: Optional[Role] = None` — Task 2 在 `run_session` / `continue_session` 加,`_run_auto_drill_loop` 内部 `reviewer: Role`(non-optional,caller 保证) ✓
- `_customize_role(role) -> Role` — Task 2 定义,_execute / _execute_continue 调用,签名一致 ✓
- `default_system_prompt` — Task 3 GET 端点字段名,Task 4 PWA 读 `role.default_system_prompt`,一致 ✓
