# Roundtable 1v1 Adversarial Mode — Design

**Date:** 2026-05-26
**Status:** Drafted for user review
**Scope:** 在现有 roundtable 子系统下加一个 1v1 对抗 mode — 2 个立场死磕同一分歧轴,而不是 4 派开多视角。最大化复用 `debate.py` / synth / jsonl,新增 ~150-200 行。

---

## 1. Motivation

当前 4 派 roundtable 优势是**广**(发现你没想到的轴),但对"X 这事到底做不做"这类**二值决策**问题:

- 4 派同时上有 over-engineering 感(R1-R2-R3 + synth + reviewer 整套跑下来 9-13 个 LLM call)
- 4 派之间分歧轴**横向**多,而二值决策需要**纵向**深(一条轴逼到底)
- 用户脑里已经有 2 个候选立场时,4 派会"找轴而不是攻轴"

**1v1 解决:** 2 个立场死磕,深而不广。适用场景:**用/不用 X 框架、走 A 还是 B 方案、立项还是不立项**等用户已知"分歧轴在哪只是不知道哪端胜"的问题。

不适用:开放探索类("X 应该怎么设计")— 这种继续用 4 派。

---

## 2. Approach

### 2.1 6 个核心决策(全部锁定)

| Q | 决策 | 替代选项与拒绝理由 |
|---|---|---|
| **Q1 立场来源** | **用户写一个 question,backend framing 一次自动派生立场 A/B** | 拒绝"用户手写两个立场字符串"— 输入接口跟 round-table 不一致,每次多一步;拒绝"复用 4 派挑 2 个"— 不解决新对子需求 |
| **Q2 轮数结构** | **正方陈述 → 反方陈述 → 正方反驳 → 反方反驳 → 整理员综合** (2+2+1 = 5 LLM call) | 拒绝极简 3-call 版(不够把分歧逼到底);拒绝带 reviewer 的多轮 drill(等真有需求再加,YAGNI) |
| **Q3 基础设施** | **复用 `debate.py` 状态机 + jsonl + `synth.py` + PWA tab,只换 ROLES + 加 framing 步骤** | 拒绝完全独立子系统(造重复轮子);拒绝中间路(共享一半徒增 if-else 分支) |
| **Q4 PWA 入口** | **round-table tab 顶部加 mode 切换按钮(`圆桌` / `1v1 对抗`)** | 拒绝新 tab(入口收敛原则,#50 教训);拒绝下拉(模式切换=主动作,按钮更醒目) |
| **Q5 角色 prompt** | **1 套通用辩士 prompt 模板,立场字符串作为变量注入 system_prompt** | 拒绝写死 2 个 persona(同一 prompt 复用更省维护);拒绝用户自填 prompt(默认体验差) |
| **Q6 meta-role** | **复用整理员(整理 1v1 的分歧轴);不接审查员**(没多轮 drill) | 拒绝写专门版整理员(分歧轴抽取逻辑无差异) |

### 2.2 数据流

```
PWA round-table tab
  顶部 mode 按钮组:[圆桌 4 派] [1v1 对抗]
  ↓ 点 1v1
新建表单(跟 round-table 共享 question textarea + 附件 + 模型 picker)
  ↓ submit
POST /oneonone                   ← 新 endpoint
  body: { question, attachments?, role_models? }
  ↓
backend.oneonone.create_oneonone():
  1. framing call(轻量 LLM 调用 → 把 question 拆成"立场 A 字符串 / 立场 B 字符串")
  2. 构造 2 个 Role 实例:PROPONENT_A / PROPONENT_B
     - 共享同一 system_prompt 模板,变量 {stance}/{opponent_stance} 替换
  3. 调 debate.run_session(question, roles=[A, B], critique_rounds=2, ...)
     - debate.py 已经支持任意 ROLES 列表,只需让 critique_rounds=2 跑出 R2 反驳
     - reviewer=None(Q6 决策不接 reviewer)
  4. synth 同 round-table 路径,落 ~/.cc-state/roundtables/<session>.jsonl
  ↓
PWA poll session 进度 + 渲染 5 个 turn(R1 A / R1 B / R2 A / R2 B / synth)
```

### 2.3 复用清单(避免重复造)

| 复用对象 | 复用方式 |
|---|---|
| `debate.run_session` | 直接调,roles 参数传 [A, B],critique_rounds=2,reviewer=None |
| `synth.py` | 整理员通用,不动 |
| jsonl schema | 同 round-table,不区分(turn 字段 type 已支持 answer/critique/synthesis) |
| `~/.cc-state/roundtables/*.jsonl` 持久化 | 同路径 |
| PWA session 渲染 | 同 component,只多一个 mode 标签 chip |
| `role_models_store` | 1v1 角色 PROPONENT_A / PROPONENT_B 同样能 override model + prompt |
| 附件 / role_models | 同 round-table 入参签名 |

### 2.4 新增模块

```
backend/roundtable/oneonone.py    ← 新文件(~80 行)
  - PROPONENT_PROMPT_TEMPLATE: str  # {stance} / {opponent_stance} 变量
  - frame_stances(question, model_fn) -> tuple[str, str]
       # 一次 LLM 调用:question → ("立场 A 字符串", "立场 B 字符串")
  - make_proponent_roles(stance_a, stance_b) -> list[Role]
       # 2 个 Role 实例,name = "正方" / "反方"

backend/roundtable/roles.py       ← 不动,1v1 角色不走 ROLES global
backend/roundtable/debate.py      ← 不动,已支持任意 roles 列表
backend/main.py                   ← 加 POST /oneonone endpoint(~30 行)
                                    + 修 GET /roundtables/models 列出 1v1 角色
                                      让 #settings/roles 能 override 正方/反方
pwa/app.js                        ← 加 mode 切换 UI(~40 行)
                                    + 表单复用现有 component,只换 submit URL
```

---

## 3. Contracts

### 3.1 PROPONENT_PROMPT_TEMPLATE

跨主题通用辩士 prompt,**核心约束 4 条**:

1. **立场不可摇摆** — 整个对话坚持 {stance},哪怕被对方 attack 也不能临时变中立
2. **强 steel-man + 强 attack** — R2 反驳必须先承认对方最强点,再攻最弱点
3. **拒绝中立语**(LLM 默认味儿) — "看情况"、"两边都有道理"、"trade-off 视情况" 直接判废
4. **具体到可证伪** — 每个论点必须给出"如果 X 发生则我立场失效"的反例边界

Prompt 长度目标:300-400 字(参考 4 派 persona 量级)。

### 3.2 framing prompt(给 LLM 拆立场用)

```
用户提出一个决策问题。请把它框成两个**互斥**的具体立场:
- 立场 A: <一句话陈述,明确是"做 X / 走 A / 立项"那一端>
- 立场 B: <一句话陈述,明确是"不做 X / 走 B / 不立项"那一端>

输出 JSON: {"a": "...", "b": "..."}

约束:
- A / B 必须互斥,不能"都对" 也不能"都错"
- 不能写成开放性"如何 X" — 必须二值
- 如果问题本身不是二值决策(eg. "怎么设计 X"),返回 {"error": "non_binary_question", "hint": "..."} → backend 拒绝建 1v1
```

framing 用的 model:跟整理员同(`deepseek-v4-pro` default,可被 role_models 覆盖)。Framing 失败(non_binary_question)→ PWA 显示 hint 让用户改写或切回 4 派。

### 3.3 endpoint

```
POST /oneonone
  body:
    question: str
    attachments: list[str]?      # 同 roundtable
    role_models: dict[str,str]?  # per-session override("正方" / "反方")
  response:
    202 + session_jsonl_path / session_id
    400 if framing 判定 non_binary_question(带 hint)
```

复用 `/roundtables/<id>` 的 GET / SSE 路径来 poll 进度 — 1v1 session 落同一目录,只是 turn 数少。

### 3.4 jsonl 区分 1v1 vs 4 派

`Session.meta` 加 `mode: "roundtable" | "oneonone"` 字段(默认 "roundtable")。PWA 拿到后渲染时显示 chip。
不开新 schema 版本(向前兼容:旧 session 没 mode 字段 = roundtable)。

---

## 4. UX

### 4.1 round-table tab 顶部

```
[圆桌 4 派 ●] [1v1 对抗]      ← 切换按钮组,默认圆桌
```

切换 1v1 时:
- 表单 question textarea / 附件 / model picker 完全复用
- submit 按钮换 endpoint(POST /oneonone)
- 提示语换:"两个对立立场死磕同一轴。适合二值决策(做 / 不做)" 

### 4.2 session 详情页

- 5 个 turn 卡片:R1 正方 / R1 反方 / R2 正方反驳 / R2 反方反驳 / 整理员
- 跟 4 派 session 用同一 component,只差头部 chip 显示 "1v1 对抗 mode"

### 4.3 #settings/roles 页

显示 8 个角色:
- 4 派(极简 / 场景 / 借鉴 / 悲观)
- 整理员 / 审查员
- **新增:正方 / 反方**(分组 header "1v1 对抗 mode")

每个都能 override model + system_prompt(跟现有路径同)。

---

## 5. Test Plan

| 层 | 测试 |
|---|---|
| Unit | 1. `frame_stances` 给二值问题正确返回 (a, b);2. 给非二值问题返回 error;3. `make_proponent_roles` 把 stance 注入 prompt 不丢字段;4. PROPONENT_PROMPT_TEMPLATE 含 4 条核心约束 anchor |
| Integration | 5. POST /oneonone 全链:fake LLM → 落 jsonl → GET /roundtables/<id> 拿到 5 个 turn;6. framing 失败 → 400 + hint;7. role_models override 正方 model 生效 |
| E2E(手动) | 8. PWA 切到 1v1 → 提交真问题 → 看到 5 个 turn |

---

## 5.X Known UX / quality 限制(2026-05-26 self-review 补)

| 现象 | 决定 | 何时翻案 |
|---|---|---|
| Framing 同步阻塞 30-180s(v4-pro reasoning model thinking phase) | 接受 — POST /oneonone 必须等 framing 完才 202;实测 user 第一次跑没耐心可改成 background framing + jsonl `type="framing"` turn | 用户 > 3 次反馈"卡得不能忍" |
| Framing JSON 解析失败 retry 1 次仍挂 | 接受 fail → 500 + hint。**不再 retry**(成本控制 + 防 user 错以为系统通) | retry rate > 20% sessions |
| Synth 5 段对 1v1 "分歧轴" 段冗余(分歧轴 = 用户问题本身) | **接受冗余** — 不为 1v1 单写 synth prompt。可读性优先于精简,用户能看懂"分歧轴 = 立场 A vs 立场 B"就是 1v1 的本质 | 用户 > 3 次反馈"分歧轴段重复废话" |
| 辩士"立场不可摇摆 + 强 attack" 是逆 LLM 训练目标 prompt,实测可能效果不稳 | 接受 — 4 条约束已是 prompt engineering 最大努力。LLM 抽风时输出温和总结无法 100% 防 | 找到更强 prompt pattern 或 model 升级 |

## 6. Out of Scope / Future

| 后续可能项 | 为什么不做 |
|---|---|
| 多轮 drill(reviewer 续问) | 跟 Q2 决定的"5 call 一锤子"冲突,真高频再加 |
| 立场用户手填 | framing 失败时手动 fallback 路径可以走,但默认体验先用自动 |
| 多对多(3v3、立场组队) | 复杂度爆炸,场景未验证 |
| 立场自动学习(从用户历史决策提炼倾向) | 隐私 + 复杂度,YAGNI |

---

## 7. Self-Review(spec 阶段自查 4 问)

0. **沟通底线** — 6 个决策都摆了"为什么不选别的",no 隐含选项
1. **Unix** — `oneonone.py` 只做"立场拆 + role 构造",其余复用;不建 BaseMode 抽象
2. **TDD** — `frame_stances(question, model_fn)` 注入 model_fn 可 mock;`make_proponent_roles` 纯函数;POST 端用 fake submit(同 round-table 既有 pattern)
3. **架构** — `mode` 字段加进 `Session.meta` 是几乎不可逆(schema),但向前兼容(缺字段 = roundtable),反悔成本可控;术语:1v1 = "对抗 mode",正方/反方 = PROPONENT_A/B,英文 identifier 一致

---

## 8. Open Questions(等用户拍板)

- [ ] PROPONENT_PROMPT_TEMPLATE 的 4 条核心约束(§3.1)是否够?需不需要加第 5 条?
- [ ] framing 失败的 hint 文案怎么写?eg. "这问题不是二值决策。试试改成'用 / 不用 X' 这种"
- [ ] 1v1 在 #settings/roles 显示时的分组 header 用词:"1v1 对抗 mode" / "1v1 辩士" / 其它?

不阻塞 implementation,我开 plan 时给 default 值,你看了不爽就改。
