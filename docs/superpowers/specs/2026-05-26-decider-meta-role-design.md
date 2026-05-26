# Decider (决断员) Opt-in Meta-role — Design

**Date:** 2026-05-26
**Status:** Drafted for user review
**Scope:** 在 4 派评议 / 1v1 对抗两种 mode 下,加一个 opt-in 的"决断员"元角色。用户勾选时,synth 之后再跑一次 LLM,产物是"推荐方案 + 理由 + 代价 + 备选"(1v1 额外含"胜方判定")。**不动现有 synth 的"不替用户拍板"原则** — 决断员是 additional output,默认关。

---

## 1. Motivation

当前 synth 的 IP 是"条件性结论":

> 不允许说"最终建议 X",只允许说"如果你更重视 A,倾向 X"

适合**决策辅助**(用户保留拍板权),不适合**决策自动化**(用户要 AI 给答案)。

用户实际反馈:
- "有时候确实希望出结果" — 用户希望在 synth 之上加一层 "推荐"
- 1v1 跑完正反辩,**没胜方判定** — 用户花了 5 个 call 还得自己判输赢
- 4 派 跑完分歧轴,**没排序**— 用户面对几个 trade-off 不知道该投哪一票

**目标:** 不破坏现有 synth 设计 IP 的前提下,**额外**给一个"AI 拍板"输出。用户 opt-in,知道自己在让 AI 决定 → 不会无意识依赖。

---

## 2. Approach

### 2.1 核心设计

| 决策 | 选项 | 理由 |
|---|---|---|
| **触发方式** | **新建表单 checkbox "我要最终结果"**,默认关 | opt-in 让用户清楚自己在请求 AI 拍板 |
| **跑在哪一步** | **synth 之后**,reads synth + R1/R2 | synth 仍纯条件结论;决断员是 derived output |
| **4 派 / 1v1 都支持** | ✅ 一个 prompt 模板,mode 不同时输出 schema 微调 | Unix:同一职责复用 |
| **失败影响** | 决断员挂 → 整个 session 仍正常(synth 已落)| 异步级联失败,新增的元角色不能拖死现有路径 |
| **#settings/roles 可 override** | ✅ 加"决断员"角色,跟整理员 / 审查员同列 | 用户能调 model + system_prompt |
| **续问怎么处理** | 续问触发新一轮 synth + 新一轮决断员(若 session 是 opt-in 过的) | session-level flag 持久化,续问保留同样 opt-in 状态 |

### 2.2 数据流

```
[现有流程,opt-in 时不动]
question + R1 + R2 + synth → 落 jsonl

[opt-in 加这一步]
synth 写完 → 触发决断员 prompt → 输出 verdict markdown
           → append 一个 type="verdict" turn,role="决断员"
           → PWA 渲染 verdict block

[1v1 mode]
verdict 额外含"胜方判定"段(正方 / 反方 / 平手 + 关键击穿点)

[4 派 mode]
verdict 只含"推荐方案 / 理由 / 代价 / 备选"4 段
```

### 2.3 复用清单

- `debate.run_session` — 不动,加个 `decider: Optional[Role]` 参数
- `Session.meta` 加 `decider_enabled: bool`(向前兼容,缺字段 = false)
- `synth.py` — 不动,decider 自己一个 module
- `role_models_store` — 决断员 model / system_prompt override 走同款路径
- PWA detail render — 加 verdict block(类似 synth block)

### 2.4 新增模块

```
backend/roundtable/decider.py    ~80 行
  - DECIDER Role(name="决断员", system_prompt=...)
  - DECIDER_PROMPT_TEMPLATE 跟 PROPONENT 一样接 mode 参数
  - build_decider_user_prompt(question, mode, r1_r2_turns, synth_turn) -> str
  - run_decider(...) -> AgentTurn  # 内部调 model_fn,append type="verdict"

backend/roundtable/debate.py     +20 行
  - run_session 加 decider 参数,synth 后条件触发
  
backend/main.py                  +30 行
  - NewRoundtableRequest / NewOneOnOneRequest 加 enable_decider: bool
  - GET /roundtables/{id} 返 decider 段
  - GET /roundtables/models 加"决断员" entry
  
pwa/app.js                       +50 行
  - 新建表单加 checkbox "我要最终结果"
  - detail view 加 verdict block(在 synth 之下)
```

---

## 3. Contracts

### 3.1 DECIDER_PROMPT_TEMPLATE

```text
你是决断员。所有其他角色已经发言,整理员已经给出分歧轴 / 条件性结论。
现在用户**明确要求你拍板** — 你的职责不是再重新讨论,而是基于已有
讨论给出一个**具体推荐**,并说清楚 trade-off。

# 你必须遵守

1. **推荐必须具体**:不允许"看情况选 A 或 B",必须选一个
2. **理由必须基于讨论**:引用 R1/R2/synth 里的具体论点,不允许凭空发挥
3. **代价必须显式**:选了 X 你必须接受什么 Y(用户会不会后悔)
4. **备选必须存在**:如果 X 实现不了,fallback Z 是什么
5. **拒绝中立语**:出现"两边都有道理"、"可以折中"判废

# 输出格式严格按下面 markdown(parser 按 ## 段切)

## 推荐方案
[一句话 + 1 行展开。eg. "做 X,先 spike 2 周验证假设 A,再决定 scale"]

## 理由
- 基于哪些 R1/R2/synth 论点(具体引用,不泛指)
- 为什么这个方案胜出而不是另一个

## 代价
- 选了这个方案,你必须接受的事:1-3 条具体的(不是"难度大"这种泛指)

## 备选
- 如果推荐方案行不通,fallback 是 Y 因为 ...

# 如果是 1v1 mode,额外加:

## 胜方判定
- 正方 / 反方 / 平手
- 关键击穿点:对方 R2 反驳里 [具体某句] 没站住,因为 [具体理由]
```

### 3.2 Endpoint

```
POST /roundtables  body 加 enable_decider: bool = false
POST /oneonone     body 加 enable_decider: bool = false
GET  /roundtables/{id} 返 verdict 字段:
   {
     "verdict": { "raw": "...", "parsed": { "推荐方案": [...], ... } } | null,
     ...
   }
```

### 3.3 Turn type

加 `verdict` 到 `TurnType` Literal:`Literal["answer", "critique", "synth", "review", "follow_up", "user_question", "verdict"]`

### 3.4 Session.meta

```json
{
  "decider_enabled": true,
  ...
}
```

旧 session 没字段 → false,渲染时不显示 verdict block。

---

## 4. UX

### 4.1 新建表单

```text
模式 [4 派评议 ●] [1v1 对抗]
问题 [textarea]
参考文件 [...]
辩论轮数 [1 / 2]
☐ 我要最终结果(AI 拍板,在 synth 之上额外给推荐方案)
> 提示:勾选后 AI 会替你做选择。慎用 — synth 的"条件性结论"已经
       足够给决策路径,决断员是给"我现在就必须出结果"的场景。
```

### 4.2 Detail view

```text
[mode chip] [status]

整理员综合
  共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动

[opt-in 时显示]
决断员推荐  ⚠ AI 拍板,仅供参考
  推荐方案: ...
  理由: ...
  代价: ...
  备选: ...
  [1v1] 胜方判定: ...
```

视觉上 verdict block 用**警示色边框**(eg. 橙色)区分于 synth(默认色) — 让用户每次看到都意识到"这是 AI 拍的不是我拍的"。

### 4.3 #settings/roles

加"决断员"分组(kind="decider"):
- model picker(默认 v4-pro)
- system_prompt textarea(默认 DECIDER_PROMPT_TEMPLATE)

---

## 5. Test Plan

| 层 | 测试 |
|---|---|
| Unit | 1. `build_decider_user_prompt` 4 派 / 1v1 输出含正确 anchor;2. parser 解析 4 段 / 5 段;3. DECIDER prompt 含 5 条核心约束 |
| Integration | 4. POST /roundtables enable_decider=true → run_session 完后有 type="verdict" turn;5. enable_decider=false → 无 verdict turn;6. 1v1 同样路径;7. 决断员 LLM 挂 → synth 仍完整,verdict 缺(graceful degradation) |
| E2E manual | 8. PWA 勾 checkbox → detail page 看到 verdict block |

---

## 6. Out of Scope / Future

| 后续 | 为什么不做 |
|---|---|
| 决断员置信度评分 | LLM 自评置信度可靠性低,YAGNI |
| 多个决断员投票 | 复杂度爆炸,N×M 维护负担 |
| 决断员"反悔"机制(发现推荐错了 retract) | 没场景验证 |
| Default 决断员 enabled | 破坏 synth IP(用户每次都被 AI 拍板)— 必须 opt-in |

---

## 7. Self-Review(spec §7 4 问)

0. **沟通底线** — opt-in 而不是 default 是显式决策;synth IP 不动;trade-off 摊出
1. **Unix** — `decider.py` 只做"基于已有讨论给推荐",synth / debate / review 不动
2. **TDD** — `build_decider_user_prompt(question, mode, turns, synth)` 纯函数;`run_decider(model_fn=...)` 注入 LLM 可 mock
3. **架构** —
   - `enable_decider` schema 字段是几乎不可逆(向前兼容缺字段 = false,反悔成本可控)
   - `verdict` turn type 加一个 Literal value,2 个 mode 共用同一 turn type 不分裂
   - 通用语言:**决断员 / verdict / 推荐方案** 是新词,跟现有"整理员 / synth / 条件性结论"对位

---

## 8. Open Questions(等用户拍板)

- [ ] verdict block UI 是否用警示色边框?或更显眼的"AI 拍板"标签?
- [ ] checkbox 文案 "我要最终结果" vs "让 AI 替我拍板" vs "AI 决断模式"?
- [ ] 1v1 mode 是否**默认勾上** enable_decider?理由:1v1 本来就是"想要胜方判定",不勾 = 1v1 又退化成 synth-as-result
- [ ] 决断员失败时(LLM 抽风 / API down),verdict 段是否显示 error 还是干脆不渲染?

---

## 9. Implementation Order

1. `decider.py` 模块 + 4-5 unit test
2. `Session.meta.decider_enabled` 字段(类似 mode 字段的 in-memory migration pattern)
3. `debate.run_session` 加 decider 参数,synth 后条件触发
4. POST /roundtables /oneonone 加 enable_decider 透传
5. GET /roundtables/{id} 返 verdict 段
6. GET /roundtables/models 加"决断员" entry
7. PWA 新建表单 checkbox + detail render verdict block
8. #settings/roles 加 decider 分组
9. Smoke + push
