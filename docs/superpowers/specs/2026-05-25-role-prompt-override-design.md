# Role Prompt Override + Roundtable Tab 入口 — Design

**Date:** 2026-05-25
**Status:** Approved for implementation (pending user review of this doc)
**Scope:** 扩 role overrides 让用户能改 system_prompt(不止 model);Roundtable 标签 toolbar 加 "⚙ 角色配置" 入口跳现有 `#settings/roles` 页。

---

## 1. Motivation

前面 role-models 配置页只允许覆盖每个角色的 **model**。但实际需求里:

1. **prompt 也该可覆盖** — 你是单用户,roles.py 头注释 "Do NOT edit the system_prompts here" 是**对 code-level 来源管理的告诫**(不要改 roles.py 这个文件、而是改 upstream re-copy),**不是禁止 runtime override**。两件事可以并存:
   - `roles.py` 的 system_prompt = source of truth(从 upstream 来,不在 PWA 改)
   - PWA `#settings/roles` 加一层 runtime override(用户可以 tune,清空就回 hardcode)
2. **位置发现成本高** — 配置藏在 `#settings/roles`,用户想 tune roundtable 行为先去 Roundtable 标签找,绕一圈才找到。

**目标:**
- (a) 让 system_prompt 跟 model 一样可被 persistent override
- (b) Roundtable 标签 toolbar 加按钮跳现有 settings 子页(双入口,不动 URL)

---

## 2. Approach: Nested Schema + Per-Role Customization at Runtime

### 2.1 核心架构

```
roles.py 的 Role(name, system_prompt, preferred_model, temperature)
       ↓
       │ (source of truth — 从 upstream 来,不在 PWA 改)
       ↓
~/.cc-workflow/role_models.json(schema 从 flat 升 nested)
       ↓
       │ runtime override 层
       ↓
PWA `#settings/roles` 页(可编辑 model + system_prompt)
       ↓
       │ POST /roundtables 触发时 ↓
       ↓
backend `_execute` 用 dataclasses.replace 构造 customized Role 列表
       ↓
debate.run_session 看到的就是用户 tune 过的 Role,prompt 自然走到所有 派/synth/reviewer
```

### 2.2 Schema 演进 — 向后兼容

**旧(flat dict):**
```json
{"极简派": "kimi-k2.6"}
```

**新(nested):**
```json
{
  "极简派": {"model": "kimi-k2.6"},
  "悲观派": {"system_prompt": "你是悲观派(定制版)..."},
  "借鉴派": {"model": "kimi-k2.6", "system_prompt": "..."}
}
```

**`load()` 自动升级:** 读到 string value 时 in-place 转成 `{"model": value}`。**不写回文件** —— 等用户下次保存才写新格式(避免 load 触发副作用)。

### 2.3 几乎不可逆决策(§3.2 第 1 级)

| 决策 | 选择 | 理由 |
|---|---|---|
| 同文件 `role_models.json` nested 升级,还是新文件 `role_prompts.json` | **同文件 nested** | 单一术语源 `role_overrides`(隐含的概念边界都已经是"role 级覆盖");两个文件 fragmentation,且 PWA 要拉两次 |
| 文件名是否改成 `role_overrides.json` 反映新语义 | **保留 `role_models.json` 文件名** | 几乎不可逆改动多一个(用户已有的旧文件路径);文件名 ≠ 内容语义,内容已经 nested 就够说明问题。代价:文件名跟 prompt override 字面不符,在文档注释里说明 |
| temperature 这次开不开 | **不开**(Q2=i 用户选) | YAGNI,等真 case 再加 |
| Roundtable 标签入口形式 | **toolbar 加 link button → 跳 `#settings/roles`** | 双入口,不动 URL;page 本身不复制 |
| 编辑 system_prompt 的 PWA 控件 | **`<details>` 折叠 + `<textarea rows="12">`** | 默认折叠(不占空间),展开后够大(prompt 几百到上千 char) |

### 2.4 跟之前 role-models 设计的关系

这是**前一版的纯增量扩展**(role-models spec / commit `97962d4`-`b87388d` 那次):
- 数据流不变(persistent > per-session > hardcode,但 per-session 当前 wire shape 只有 model;system_prompt 没暴露给 per-session,留作 future)
- `effective_model_for` 函数保留;新增 `effective_system_prompt_for`
- `_all_role_names()` helper 不变
- `create_roundtable` 现有的合并 + 校验逻辑扩展(校验 model 在 MODEL_ENDPOINTS;校验 system_prompt 非空)

---

## 3. Components

### 3.1 `backend/roundtable/role_models_store.py` schema upgrade

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

老 flat dict 格式(只有 model)load 时自动升级到 nested,但不写回文件 —
等用户下次 save 才落新格式(避免 load 副作用)。文件名保留 `role_models.json`
不改 — 跟 spec §2.3 提到的"几乎不可逆"决策对齐。
"""

def load() -> dict[str, dict]:
    """读全部 overrides;{} 当文件缺失/坏。返回的内层 dict 总是 {model?, system_prompt?}。"""
    raw = _read_raw()
    out: dict[str, dict] = {}
    for role_name, val in raw.items():
        if isinstance(val, str):
            # 老 flat dict,model 单值 — 升级到 nested
            out[role_name] = {"model": val}
        elif isinstance(val, dict):
            # 新 nested — 按字段过滤,丢未知 key
            cleaned: dict[str, str] = {}
            if isinstance(val.get("model"), str) and val["model"]:
                cleaned["model"] = val["model"]
            if isinstance(val.get("system_prompt"), str) and val["system_prompt"]:
                cleaned["system_prompt"] = val["system_prompt"]
            if cleaned:
                out[role_name] = cleaned
        # 其它类型(int / list / null)忽略
    return out


def save(data: dict[str, dict]) -> None:
    """Atomic tmp + os.replace。data 直接落盘(假设 caller 已经传 nested 格式)。"""
    # 跟现有 save 一致,不动


def effective_model_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name, {}).get("model") or hardcoded_default


def effective_system_prompt_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name, {}).get("system_prompt") or hardcoded_default
```

### 3.2 `_customized_roles()` helper + runner 改造

**File:** `backend/roundtable/runner.py`

```python
import dataclasses
from . import role_models_store


def _customize_role(role: Role) -> Role:
    """用 persistent override 替换 role.system_prompt;若无 override 返回原 role。
    model 不在这里 customize — 用现有的 role_models_overrides dict 路径解决。"""
    override_prompt = role_models_store.load().get(role.name, {}).get("system_prompt")
    if override_prompt:
        return dataclasses.replace(role, system_prompt=override_prompt)
    return role


def _customized_role_list() -> tuple[list[Role], Role, Role]:
    """构造一组 customized roles(ROLES + SYNTHESIZER + REVIEWER)。
    返回 (roles, synthesizer, reviewer) 三元组,给 _execute / continue_session 用。"""
    return (
        [_customize_role(r) for r in roles_mod.ROLES],
        _customize_role(roles_mod.SYNTHESIZER),
        _customize_role(roles_mod.REVIEWER),
    )
```

`_execute()` 函数体:把 `roles=roles_mod.ROLES` 改成 `roles, synthesizer, reviewer = _customized_role_list()`:

```python
def _execute(question, session_path, role_models, critique_rounds, on_complete):
    try:
        roles, synthesizer, reviewer = _customized_role_list()
        # NB: REVIEWER 给 auto-drill loop 用,不在 run_session 参数里 — run_session
        # 内部从 .roles import REVIEWER 拿。所以 customize 后还得 monkey-patch 或
        # 改 run_session signature。最简:run_session 加 reviewer 参数(下面 §3.3)
        run_session(
            question=question,
            roles=roles,
            synthesizer=synthesizer,
            reviewer=reviewer,    # ← 新增
            model_fn=call_model,
            session_path=session_path,
            role_model_overrides=role_models,
            critique_rounds=critique_rounds,
        )
    ...
```

`_execute_continue` 同改。

### 3.3 `run_session` / `continue_session` 接受 `reviewer` 参数

**File:** `backend/roundtable/debate.py`

**问题:** 当前 `_run_auto_drill_loop` 在 module-level 从 `from .roles import REVIEWER` 拿,**绕过了 customize 路径**。

**修法:** `run_session` / `continue_session` / `_run_auto_drill_loop` 都加 `reviewer: Role` 参数(显式注入),loop 不再从 module-level import。Module-level `REVIEWER` 仍是默认 source,但 runtime 走参数。

```python
def run_session(
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    session_path: Path,
    *,
    reviewer: Role | None = None,    # ← 新增,缺省回 module-level REVIEWER
    ...
):
    if reviewer is None:
        reviewer = REVIEWER    # 沿用旧行为
    ...
    _run_auto_drill_loop(
        ...
        reviewer=reviewer,
        ...
    )


def _run_auto_drill_loop(*, reviewer: Role, ...):
    """改用 reviewer 参数,不再从 .roles import。"""
```

注意 `continue_session` 同样改 — 加 `reviewer: Role | None = None` 参数,内部传给 `_run_auto_drill_loop`。

### 3.4 `GET /roundtables/models` 响应加 `default_system_prompt`

**File:** `backend/main.py:list_roundtable_models`

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

—— 现有调用方(PWA 新建表单 picker)只读 `default_model`,新字段不影响。新 `#settings/roles` 页读两个都用。

### 3.5 `PUT /settings/role-models` schema 改 nested

**File:** `backend/main.py`

```python
class RoleOverride(BaseModel):
    model: Optional[str] = None
    system_prompt: Optional[str] = Field(default=None, max_length=5000)


class RoleModelsRequest(BaseModel):
    # Schema 从 dict[str, str] 升 dict[str, RoleOverride]。空 dict = 清全部
    # override;某个 role 的内层 dict 空 = 清该 role 的 override。
    role_models: dict[str, RoleOverride] = Field(default_factory=dict)


@app.put("/settings/role-models", dependencies=PROTECT)
def put_role_models(req: RoleModelsRequest) -> dict:
    valid_roles = _all_role_names()
    valid_models = set(roundtable_model.MODEL_ENDPOINTS)

    cleaned: dict[str, dict] = {}
    for role_name, override in req.role_models.items():
        if role_name not in valid_roles:
            raise HTTPException(400, {"error": "unknown role", "got": role_name, "valid": sorted(valid_roles)})
        entry: dict[str, str] = {}
        if override.model:
            if override.model not in valid_models:
                raise HTTPException(400, {"error": "unknown model", "got": override.model, "valid": sorted(valid_models)})
            entry["model"] = override.model
        if override.system_prompt:
            stripped = override.system_prompt.strip()
            if not stripped:
                pass    # 空白 = 删 override,不报错
            else:
                entry["system_prompt"] = stripped
        if entry:
            cleaned[role_name] = entry

    role_models_store.save(cleaned)
    return {"ok": True, "role_models": cleaned}
```

注意:`role_models` 字段名保留 — backwards-compat with PWA 老客户端;内层结构改了但同一 endpoint。

### 3.6 PWA `#settings/roles` 页加 prompt 编辑

**File:** `pwa/app.js:renderSettingsRolesView`

每行的结构升级:

```html
<tr>
  <td>极简派 <span class="muted">(persona)</span></td>
  <td>
    <select data-role="极简派" class="role-model-select">
      <option value="deepseek-chat" selected>deepseek-chat</option>
      <option value="kimi-k2.6">kimi-k2.6</option>
      ...
    </select>
    <details class="role-prompt-toggle" style="margin-top:8px">
      <summary class="muted" style="font-size:11px;cursor:pointer">
        ▸ 自定义 system_prompt(可选,空 = 用默认)
      </summary>
      <textarea data-role-prompt="极简派" class="role-prompt-textarea"
                rows="12" style="width:100%;font-family:monospace;font-size:12px;margin-top:6px"
                placeholder="留空使用 roles.py 的默认 prompt">{当前 effective system_prompt}</textarea>
      <button type="button" class="role-prompt-reset" data-role="极简派"
              style="font-size:11px;margin-top:4px">重置为默认</button>
    </details>
  </td>
</tr>
```

**关键设计点:**
- textarea 显示的是 **effective** prompt(persistent override 有就用 override,否则 hardcode 默认)
- "重置为默认" 按钮:把该 textarea 内容**清空**(实际保存时空字符串 = 删 override,backend 自动 fallback)
- 保存时:把每行 dropdown + textarea 组成 `{role_name: {model, system_prompt?}}` 上传

`_onRolesSave` 改:

```javascript
async function _onRolesSave(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '保存中...';

  // 收集 model + prompt
  const role_models = {};
  for (const s of document.querySelectorAll('select.role-model-select')) {
    const role = s.dataset.role;
    role_models[role] = { model: s.value };
  }
  for (const ta of document.querySelectorAll('textarea[data-role-prompt]')) {
    const role = ta.dataset.rolePrompt;
    const prompt = ta.value.trim();
    if (!role_models[role]) role_models[role] = {};
    // 只有跟 default 不同(且非空)才作为 override 上传
    // 注:这里有点 tricky — 我们没存 default 在前端 state 里。最简单:**只要非空就传**,
    // backend 也会 dedup(persistent value 跟 hardcode 相同也只是无副作用)。
    if (prompt) {
      role_models[role].system_prompt = prompt;
    }
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

"重置为默认" 按钮 click handler:

```javascript
function _onRolePromptReset(e) {
  const role = e.currentTarget.dataset.role;
  const ta = document.querySelector(`textarea[data-role-prompt="${CSS.escape(role)}"]`);
  if (ta) { ta.value = ''; }
  // 不立即保存 — 用户还得点"保存"按钮提交。给一个 toast 提示。
  showToast('info', `${role} prompt 已清空 — 点保存才真正回默认`, { ttl: 2500 });
}
```

### 3.7 Roundtable tab toolbar 加入口

**File:** `pwa/app.js:renderRoundtablesView`(line 4274 附近 `<div class="ws-toolbar">`)

```html
<div class="ws-toolbar">
  <button class="ws-new-btn" type="button" id="rt-new-btn">+ 新开一场</button>
  <a href="#settings/roles" class="ws-toolbar-link" style="margin-left:8px;font-size:13px">
    ⚙ 角色配置
  </a>
</div>
```

—— 单纯加一个 `<a>` link,5 行改动,不动 URL,Settings 入口保留(双路径)。

---

## 4. Error Handling

| 场景 | 处理 |
|---|---|
| `role_models.json` 含老 flat string value | `load()` 自动转 nested,不写回文件,正常服务 |
| `role_models.json` 内层 value 类型异常(int / list / null) | `load()` 忽略该条目(safety fallback);不抛 |
| PUT 传未知 role name | 400 `unknown role` |
| PUT model 不在 MODEL_ENDPOINTS | 400 `unknown model` |
| PUT system_prompt 是纯空白 / 空串 | 静默处理(等于"删该 role 的 prompt override"),不抛 |
| PUT system_prompt > 5000 字符 | Pydantic 422(超过 `max_length=5000`)|
| `_customize_role` 收到未知 role(不该发生)| `dataclasses.replace` 仍工作,任意 role 都能 replace。defensive |
| PWA 用户没保存就关页 | localStorage 不缓存草稿,刷新或重进会丢未保存改动 —— 跟现有 model dropdown 行为一致(YAGNI 加 unsaved indicator)|

---

## 5. Testing

### 5.1 Unit(`tests/test_role_models_store.py` 扩)

- `load()` 老 flat dict format → 升级到 nested ✓
- `load()` mixed format(部分 string 部分 dict)→ 都升级 ✓
- `effective_system_prompt_for` 有 override / 无 override / role 不存在 → 3 fixture
- `load()` 非 string 非 dict value(noise)→ 静默忽略

### 5.2 Integration(`tests/test_role_models_endpoint.py` 扩)

- `GET /roundtables/models` 响应里每个 role 含 `default_system_prompt` 字段(effective 值)
- `PUT /settings/role-models` 接受 nested body + 校验 model + 校验 prompt 非空 + 保存到文件
- `PUT` system_prompt > 5000 → 422
- `PUT` 空 string prompt → 静默不存(等价 reset)

### 5.3 Runner/debate 改造测试(`tests/test_roundtable.py` 或 `test_role_models_endpoint.py` 扩)

- `_customize_role` 有 prompt override → 返回 customized Role(system_prompt 是新值,其他字段不变)
- `_customize_role` 无 override → 返回原 Role(identity equal — 用 `is` 检查避免无谓 clone)
- `run_session` 显式 reviewer 参数能透传到 auto-drill loop(用 fake reviewer with marker prompt,验证 model_fn 调用收到的 system 字符串 = marker)

### 5.4 Non-goals(不测)

- PWA textarea / details 折叠行为 — 没自动化设施
- temperature(未实现)

---

## 6. Migration & Rollout

- **零迁移文件:** `load()` 自动升级老 flat → nested,不写回文件。文件就一直保持原格式直到下次 PUT
- **回滚:** Pydantic 接 dict[str, str](老 wire shape) 反而会 422 — 因为 model 字段类型不对(老是 str,新是 dict)。**这是 break change**。如果回滚要兼容老 PWA,需要 endpoint 接受 union 类型。但单用户单机:PWA 跟 backend 同步更新,wire shape 改了无影响。**接受这个 break**
- **PWA 缓存:** SW 网络优先(`pwa/sw.js: cache:'no-store'`),用户刷新拿新 app.js,新 wire shape 立刻生效。无需手 reload

---

## 7. Non-Goals (YAGNI)

- ❌ temperature 编辑(Q2=i)
- ❌ per-session prompt override(per-session 走 POST /roundtables body,目前不暴露 prompt 字段,等真有 case)
- ❌ Per-roundtable-session"用过哪个 prompt"的历史 audit
- ❌ Prompt diff view(看跟默认 prompt 差什么)
- ❌ Multi-language prompt editor(syntax highlight / lint 啥的)
- ❌ Prompt template library 共享 / 导入导出

---

## 8. 工程方法论自检(CLAUDE.md §4)

| 原则 | 检查 |
|---|---|
| §0 沟通 | 3 个关键决策(Q1/Q2/Q3)已 Q&A 钉死;`roles.py:5-6` 头注释的语义重新解读,显式写明 |
| §1 Unix | `effective_model_for` + `effective_system_prompt_for` 两个职责小函数;`_customize_role` 单一职责;不引入"override registry" 抽象 |
| §2 TDD | 全部接口纯函数 / file IO 可注入,5 分钟内可测 |
| §3.1 trade-off | §2.3 表对比了同文件 nested vs 新文件;命名保留 `role_models.json` 不改 |
| §3.2 反悔成本 | wire shape 改成 nested(几乎不可逆,因为 PWA 跟 backend 同步发布)— spec 钉死;系统prompt textarea 上限 5000 ≈ 用户能舒服编辑的最大量 |
| §3.3 复杂度 | 没有引入新 capability layer(per-session prompt / template library 全是 non-goals);只增量 ~80 行 backend + ~50 行 PWA + ~30 行 doc |
| §3.4 通用语言 | `role override` 概念扩展(从 model-only 到 model + prompt),不引入 `role_overrides` / `role_settings` 等同义词;`effective_X_for` 统一命名 |
