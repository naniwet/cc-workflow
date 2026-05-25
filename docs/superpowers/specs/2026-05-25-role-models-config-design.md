# Role-Models Config Page — Design

**Date:** 2026-05-25
**Status:** Approved for implementation (pending user review of this doc)
**Scope:** 加独立 PWA 设置页让用户配置每个 roundtable role 的默认 model,不依赖"新建 session"才能配。顺手修 REVIEWER 漏报 bug。

---

## 1. Motivation

当前用户切角色默认 model 的唯一路径:**打开新建 roundtable 表单 → 用 per-role dropdown 选 model → 提交一次 session 才能"用上"**。这有 3 个痛点:

1. **每次新建都要重选** — `role_models` 是 per-session 字段,不持久化,下次又是 hardcode 默认
2. **没法预先配** — 想用 Kimi 跑借鉴派的话,必须先开 session 才能切,做不到"先配好,以后所有 session 自动用"
3. **REVIEWER 漏在 `/roundtables/models` 里** — Task 3 加 REVIEWER 时没同步更新 endpoint,所以即使 per-session 表单也切不了 REVIEWER 的 model(用户也确实没注意到这个 bug)

**目标:** 加一层 "persistent role model 默认" 配置,让用户在独立设置页一次配好,所有后续 session 自动继承。per-session override 仍然能用(临时换个模型试)。

---

## 2. Approach: 3-Level Model Precedence + 持久化 JSON

### 2.1 model 解析优先级(高 → 低)

```
1. per-session role_models (POST /roundtables body)    ← 现有,临时一次性
2. persistent role_models.json (新)                     ← 新增,用户配的默认
3. role.preferred_model (hardcode in roles.py)          ← 现有,fallback
```

实例:`PRECEDENT.preferred_model="kimi-k2.6"`(hardcode);用户在设置页改成 `"deepseek-chat"`(persistent);某次新建 session 又临时 override 成 `"moonshot-v1-32k"`(per-session) → 这次跑的是 moonshot-v1-32k。

### 2.2 数据流

```
~/.cc-workflow/role_models.json
  {"极简派": "kimi-k2.6", "悲观派": "deepseek-reasoner", ...}
  (空 dict 或缺 key = 跟 hardcode 一致)
       ↑                                      ↑
       │ load on every request               │ write atomic
       │                                      │
       └─── GET /roundtables/models ◄─────────┴─── PUT /settings/role-models
                  │
                  │ returns: roles[].default_model 已经是 effective
                  │
                  ▼
              PWA #settings/roles 页 显示当前 effective default + 提供 dropdown 改
              PWA 新建 round 表单也读这个 endpoint(沿用现状)
```

### 2.3 几乎不可逆决策(§3.2 第 1 级)

| 决策 | 选择 | 理由 |
|---|---|---|
| 持久化文件名 | `~/.cc-workflow/role_models.json` | 跟 `providers.json` / `workspaces.json` 同目录同命名风格;独立文件不混入 providers.json |
| JSON schema | flat dict `{role_name: model_name}` | 简单可读,unknown role / unknown model 在 backend 校验 |
| Field name | `role_models`(persistent)跟 `role_models`(POST body)同名 | §3.4 通用语言 — 一个概念一个名 |
| Settings 页路由 | `#settings/roles` | 跟 `#settings/providers` 同级 |
| REVIEWER 暴露 | 跟 SYNTHESIZER 同列在 `/roundtables/models.roles[]`,kind="reviewer" | 让 PWA picker 显示三类元角色(persona / synthesizer / reviewer) |

---

## 3. Components

### 3.1 Persistent storage helper(`backend/roundtable/role_models_store.py` — 新文件)

```python
"""Read / write ~/.cc-workflow/role_models.json — persistent per-role model
defaults. Schema: {"<role-name>": "<model-name>"}. Missing keys / unknown
roles / unknown models silently fall through to the role's hardcoded
preferred_model. Validation lives in main.py at the API surface (PUT
endpoint rejects unknown models with 400) — this module is pure read/write.
"""

def load() -> dict[str, str]: ...    # {} on missing/unreadable
def save(data: dict[str, str]) -> None: ...    # atomic write
def effective_model_for(role_name: str, hardcoded_default: str) -> str:
    """role_models.json 里的值 > hardcoded_default。"""
```

3 个纯函数,5 分钟可写单测。

### 3.2 Backend endpoints

**`GET /roundtables/models`(修)** — 加 REVIEWER + 把 `default_model` 改成 effective:

```python
roles = [
    {"name": r.name, "default_model": role_models_store.effective_model_for(r.name, r.preferred_model), "kind": "persona"}
    for r in roundtable_roles.ROLES
] + [
    {
        "name": roundtable_roles.SYNTHESIZER.name,
        "default_model": role_models_store.effective_model_for(SYNTHESIZER.name, SYNTHESIZER.preferred_model),
        "kind": "synthesizer",
    },
    {
        "name": roundtable_roles.REVIEWER.name,
        "default_model": role_models_store.effective_model_for(REVIEWER.name, REVIEWER.preferred_model),
        "kind": "reviewer",
    },
]
```

**`PUT /settings/role-models`(新)** — 接收 `{role_name: model_name}` 字典:

```python
class RoleModelsRequest(BaseModel):
    role_models: dict[str, str] = Field(default_factory=dict)
    # Empty dict 允许 — "清空所有 override 用 hardcode"。

@app.put("/settings/role-models", dependencies=PROTECT)
def put_role_models(req: RoleModelsRequest) -> dict:
    # 校验 role / model 都存在,否则 400。空 string value = 删该 key。
    # atomic save 后 return 当前 effective map(让 PWA refresh)。
```

**`POST /roundtables` 调用 `run_session` 时怎么合并:**

backend 在 `create_roundtable` 里读 persistent + merge:

```python
persistent = role_models_store.load()
merged = {**persistent, **(req.role_models or {})}    # per-session 覆盖 persistent
roundtable_runner.submit(req.question, role_models=merged, critique_rounds=req.critique_rounds)
```

注意:`runner.submit` → `_execute` → `run_session(role_model_overrides=merged)` 的链路本来就支持 dict[str, str],无改动。

### 3.3 PWA 设置页(`pwa/app.js` 新增渲染 + 路由)

`#settings/roles` 路由,渲染 6 行:

```
极简派         [model dropdown]    [重置默认]
场景派         [model dropdown]    [重置默认]
借鉴派         [model dropdown]    [重置默认]
悲观派         [model dropdown]    [重置默认]
整理员         [model dropdown]    [重置默认]
审查员         [model dropdown]    [重置默认]

[全部重置]    [保存]
```

- Dropdown 选项 = `GET /roundtables/models` 返回的 `models[]`(全部支持的 model)
- 当前 default = 显示在 dropdown 选中状态
- "重置默认" = 把该 role 的 dropdown 切回 hardcoded preferred_model(在 PWA 端 reset,提交保存才落库)
- "保存" = `PUT /settings/role-models` 一次性发整个 dict
- PWA 不维护单独的 "saved vs unsaved" 状态机 — 简单点,每次进页面重新 fetch

### 3.4 修 `/roundtables/models` REVIEWER 漏报

§3.2 GET endpoint 改动里同时把 REVIEWER 加进 `roles[]` 数组,`kind="reviewer"`。

PWA 新建 roundtable 表单已有的 picker 会自动拿到 REVIEWER 的选项(picker 是 data-driven,不写死 role 列表)— 这是顺带的 UX 改进。

---

## 4. Error Handling

| 场景 | 处理 |
|---|---|
| `role_models.json` 不存在 | `load()` 返回 `{}` |
| JSON parse error / 权限读不出 | `load()` 返回 `{}`(沿用 `providers.json` 的容错模式)+ log warning |
| `PUT /settings/role-models` 传未知 role | 400 `{"error": "unknown role", "got": ..., "valid": [...]}` |
| `PUT` 传未知 model(不在 MODEL_ENDPOINTS) | 400 `{"error": "unknown model", "got": ..., "valid": [...]}` |
| `PUT` body 是空 dict `{}` | 写入空 dict — 等于"清空所有 override 回 hardcode";不报错 |
| 并发 `PUT` race | atomic tmp + os.replace(沿用 `ws_settings.save()` 模式) |
| Persistent map 里有 role 名变了的"幽灵 key" | `load()` 不验证 key 合法性;`effective_model_for(role, default)` 只查找,找不到回 default,幽灵 key 自然失效;启动也不报错 |

---

## 5. Testing

### 5.1 Unit(`tests/test_role_models_store.py` — 新文件)

- `effective_model_for(role, default)` 已配 → 返回配的
- `effective_model_for` 未配 → 返回 default
- `load()` 文件缺失 → `{}`
- `load()` JSON 坏 → `{}` + warning
- `save()` 然后 `load()` round-trip 一致

### 5.2 Integration(`tests/test_role_models_endpoint.py` — 新文件)

- `GET /roundtables/models` 返回 6 个 roles(含 REVIEWER, kind="reviewer")
- `GET /roundtables/models` `default_model` 反映 persistent override
- `PUT /settings/role-models` 写入 → 下次 GET 拿到新值
- `PUT` 传未知 role → 400
- `PUT` 传未知 model → 400
- `PUT` 空 dict → 写入空(并清掉之前的 override)
- `POST /roundtables` per-session role_models override persistent(用 mock submit 验证传给 runner 的 merged dict)

7 个 integration test 覆盖端到端。

### 5.3 Non-goals(明确不测)

- PWA UI 渲染(无 jsdom 设施)— 靠 node --check + ssh 手动验证
- 文件锁竞争 — 单用户单机不可能 truly 并发 PUT

---

## 6. Migration & Rollout

- **零迁移:** 老安装没 `role_models.json` 文件 → `load()` 返回 `{}` → effective = hardcode = 现状行为
- **回滚:** 删 endpoint + 删持久化文件;PWA 页路由失效(回 404 友好提示)。runner 调用链路不变
- **依赖顺序:** §3.1 helper → §3.2 backend endpoints → §3.3 PWA 页

---

## 7. Non-Goals (YAGNI)

- ❌ 不暴露 system_prompt 配置(roles.py 头明文 "Do NOT edit the system_prompts here";product IP)
- ❌ 不暴露 temperature 配置(踩坑面大于收益,YAGNI)
- ❌ 不做"按 workspace 配 role_models"(roundtable 本来就跟 workspace 没强绑定;单用户一份默认够)
- ❌ 不做"批量导入/导出 role_models"(单用户单机,直接编辑 JSON 文件)
- ❌ 不做"role_models 历史版本"(用户改错了改回来即可)

---

## 8. 工程方法论自检(CLAUDE.md §4)

| 原则 | 检查 |
|---|---|
| §0 沟通 | 2 个关键决策(Q1=a, Q2=a)已 Q&A;system_prompt 不暴露的理由显式 |
| §1 Unix | `role_models_store.py` 三个纯函数,单一职责;PWA 页是独立路由,跟其他 settings 独立 |
| §2 TDD | 全部接口纯函数 / file IO;5 分钟可写单测,5 个 unit + 7 个 integration |
| §3.1 trade-off | §2 已对比 3-level precedence vs 替换 hardcode;不替换 hardcode 因为留 fallback 更安全 |
| §3.2 反悔成本 | 字段名 / 路由 / 文件名(几乎不可逆)— spec 钉死 |
| §3.3 复杂度 | 1 新文件 helper + 1 新 endpoint + 1 PWA 页 + 修 1 个 bug;~130 行 |
| §3.4 通用语言 | `role_models` 单一术语(POST body + persistent + endpoint 都用),不引入 `role_overrides` / `role_config` 等同义词 |
