# Standard Roundtable Mode — Design

**Date:** 2026-05-26
**Status:** **PARKED — 2026-05-26 user review rejected**
**Scope:** 把现有 roundtable 从"固定四派评审"升级成一个真正的圆桌系统:圆桌是讨论协议,桌型(mode)决定如何组桌、主持、交锋和收束。当前 4 派保留为 preset;1v1 对抗成为同一入口下的强对抗桌型;新增默认的"自动圆桌"模式。

---

## Review Outcome(2026-05-26 user 选择 a:保持现状)

**核心拒绝理由:**

1. **4 派 verbatim prompt 是 actual product IP**(roles.py 头注释明说)。把它降级成 "preset" = 稀释 IP 换抽象,trade-off 不划算。
2. **主持人是 god class** — 4 个职责(诊断 / 组桌 / 控场 / 收束)塞同一 LLM 角色,失败模式难定位。
3. **JSON contract 失败模式没说**。当前 4 派 / synth 用 markdown `##` 段 parser,无 JSON 解析风险。引入 moderator JSON 输出 = 新故障类,spec 没给 fallback。
4. **动态角色"质量"不可测**。LLM 生成的 1 句话 stance_hint vs 4 派的 400 字精雕 prompt 是 quality regression,parser 层非空校验不能等价"对问题合适"。
5. **Moderator 跟整理员"分歧轴"职责重叠**(spec §5.3 / §6) — Single Source of Truth 违反。
6. **MVP §9.1 scope 实际是 v1**(7 个 item,几乎完整 feature)。真 MVP 应该 1-2 个垂直切片验证假设。
7. **"圆桌不是真正的圆桌" motivation 站不住** — 此前讨论已结论 free-form 圆桌会跑题 / 不可测 / token 不可控,batched 才有产品价值。本 spec 没解决 free-form 问题(只把角色生成动态化),motivation 引用错。

**保留这份 spec 的理由:** §3.2 几乎不可逆决策的"trade-off 显式 + 何时翻案"值得留作历史档案。如果半年内发现"用户真的想要动态角色"的需求信号 > 50% sessions,可以重启这份 spec,但要先解决以上 7 条。

**当前现状:** 4 派评议 + 1v1 对抗 + 整理员 + 审查员的 product matrix 已覆盖 90% 决策辅助场景。下一步会加"决断员"opt-in 元角色(解决"我希望出结果"诉求),而不是重新设计整个 roundtable 抽象。

---

---

## 1. Motivation

当前 roundtable 的产品价值已经成立:4 个固定角色从不同偏见出发,整理员给出共识 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动。它适合工程决策扫盲区。

但它还不是真正意义上的"圆桌":

- 角色固定,所有问题都由同一组人讨论。
- 流程固定,R1/R2/R3 更像多视角评审,不是主持人控场的会议。
- 分歧推进发生在预设轮次里,而不是由主持人根据内容点名追问。
- "圆桌"这个名字承载了更大的期待:用户会期待一桌适合这个问题的人,而不是永远四个固定 persona。

**目标:** 把 roundtable 抽象从"固定角色组合"提升为"讨论协议"。

新定义:

```
圆桌 Roundtable
= 问题识别
+ 组桌
+ 主持
+ 多方发言
+ 分歧推进
+ 纪要收束
```

当前实现变成其中一个桌型:

```
四派评审
= 极简派 + 场景派 + 借鉴派 + 悲观派 + 整理员 + 审查员
```

---

## 2. Product Model

### 2.1 核心概念

| 概念 | 含义 |
|---|---|
| 圆桌 | 总入口和总系统。不是某一组角色,而是一套讨论引擎。 |
| 桌型 | 一种讨论协议,决定角色来源、轮次结构、主持策略和输出结构。 |
| 自动圆桌 | 默认桌型。系统根据问题动态选择 3-5 个参会角色,由主持人推进讨论。 |
| 四派评审 | 当前固定四派实现。适合工程/产品决策扫盲区。 |
| 1v1 对抗 | 两个互斥立场沿一条分歧轴深挖。适合 A/B、做/不做、立项/不立项。 |
| 主持人 | 控场元角色。负责问题诊断、组桌、提炼分歧、点名追问,不参与观点竞争。 |
| 整理员 | 最终纪要元角色。负责把讨论整理成决策地图,不做无条件裁判。 |
| 审查员 | 收敛判断元角色。负责判断纪要是否足够清晰,必要时触发续问。 |

### 2.2 信息架构

```
圆桌
├─ 自动圆桌      默认
├─ 四派评审      当前实现迁移过来
└─ 1v1 对抗      强对抗模式
```

| 桌型 | 适合场景 | 本质 | 产物 |
|---|---|---|---|
| 自动圆桌 | 问题复杂,用户还不知道有哪些关键分歧 | 找轴 | 圆桌纪要 + 决策路径 |
| 四派评审 | 工程/产品决策,需要稳定偏见扫盲区 | 扫盲区 | 多视角风险 + 条件性结论 |
| 1v1 对抗 | 已知 A/B 两端,想逼出哪边更站得住 | 攻轴 | 正反论证 + 胜负条件 |

### 2.3 推荐默认

默认桌型应为 **自动圆桌**。

理由:

- 它最符合"圆桌"这个名字。
- 它能覆盖用户不知道该找谁讨论的问题。
- 它让当前四派从"唯一圆桌"降级为"经典模板",概念更顺。
- 它给 1v1 对抗留下自然位置:不是另一个产品,而是同一系统的桌型。

---

## 3. Auto Roundtable Protocol

### 3.1 流程

```
1. 用户输入问题
2. 主持人做问题诊断
3. 主持人生成本场桌型
4. 3-5 个参会角色开场
5. 主持人提炼第一轮分歧
6. 点名 2-3 个角色围绕最大分歧交锋
7. 必要时追问缺失事实
8. 整理员输出圆桌纪要
9. 审查员判断是否收敛(可复用现有 auto-drill)
```

关键变化:Round 2 不再是所有角色机械互评,而是主持人基于第一轮内容选择"最值得推进的分歧轴",再点名相关角色交锋。

### 3.2 LLM 调用预算

标准深度建议控制在 7-10 次调用:

| 调用 | 作用 |
|---|---|
| 1 | 主持人诊断 + 组桌 |
| 2-5 | 3-4 个角色开场 |
| 6 | 主持人提炼分歧轴 + 点名追问 |
| 7-8 | 被点名角色交锋 |
| 9 | 整理员输出圆桌纪要 |
| 10 | 审查员判断是否收敛(可选,沿用现有机制) |

如果主持人选择 5 个角色,标准深度大约 10-11 调用,与当前 9-13 调用相近,但信息更集中。

### 3.3 深度档位

| 深度 | 角色数 | 交锋轮 | 审查员 | 适合 |
|---|---:|---:|---|---|
| 快速 | 3 | 0-1 | 可关 | 快速找方向 |
| 标准 | 4 | 1 | 开 | 默认 |
| 深挖 | 5 | 2 | 开 + auto-drill | 高成本决策 |

MVP 可以先只实现"标准",UI 预留深度控件。

---

## 4. Moderator

### 4.1 职责

主持人是标准圆桌的核心。它不参与观点竞争,只负责控场。

职责分四类:

| 阶段 | 职责 |
|---|---|
| 问题诊断 | 判断问题类型:决策 / 设计 / 排障 / 规划 / 复盘 / 开放探索。判断是否适合圆桌,是否更适合 1v1。 |
| 组桌 | 选择 3-5 个参会角色。说明每个角色代表的利益、风险或视角。 |
| 控场 | 第一轮后提炼最大分歧,点名相关角色回应,禁止泛泛而谈。 |
| 收束 | 给整理员提供讨论结构:问题类型、参会角色、核心分歧、缺失事实。 |

### 4.2 主持人输出 contract

`moderation_plan` 建议输出 JSON,后端解析后写入 session meta,同时作为后续 prompt 上下文。

```json
{
  "problem_type": "technical_product_decision",
  "recommended_mode": "auto_roundtable",
  "reason": "这是一个同时涉及用户价值、工程成本和长期维护的产品技术决策。",
  "roles": [
    {
      "name": "产品负责人",
      "stance_hint": "优先考虑用户价值、分发路径、留存和产品定位。",
      "must_answer": "这个方案带来的用户可见价值是什么?",
      "anti_pattern": "不能只说用户会喜欢,必须落到触达或留存机制。"
    }
  ],
  "opening_question": "请各自说明你支持或反对该方案的最强理由。",
  "success_criteria": [
    "明确短期收益和长期维护成本的取舍",
    "列出会改变结论的关键事实"
  ]
}
```

字段约束:

- `roles.length`: 快速 3,标准 4,深挖 5。
- `name`: 2-8 个中文字符或短中文短语,必须是职责而非抽象人格。
- `stance_hint`: 说明这个角色代表的视角,不能是空泛"综合考虑"。
- `must_answer`: 这个角色必须回答的尖锐问题。
- `anti_pattern`: 明确禁止的泛泛回答方式。
- `recommended_mode`: 如果主持人认为更适合 1v1,可返回 `oneonone` 并给出原因;MVP 可先只展示建议,不自动改路由。

### 4.3 动态角色示例

问题:要不要把 PWA 改成 Native App?

```text
产品负责人:用户价值、分发路径、留存
工程负责人:迁移成本、维护复杂度
增长负责人:安装转化、触达渠道
风险负责人:审核、平台锁定、长期成本
用户代表:真实使用摩擦
```

问题:要不要引入事件总线?

```text
极简工程师:反对不必要抽象
平台架构师:关注系统边界和扩展
业务开发者:关注日常开发成本
故障响应负责人:关注可观测性和排障
长期维护者:关注演进和迁移成本
```

---

## 5. Round Structure

### 5.1 Round 0: 主持人诊断 / 组桌

输入:

- 用户问题
- 附件摘要 / 全文(沿用 roundtable attachments)
- 用户选择的深度
- 可选 role/model override

输出:

- `moderation_plan`
- 动态角色列表
- 本场讨论目标

持久化:

- 写入 session meta 的 `moderator` 字段。
- 同时 append 一个 `type="moderation_plan"` turn,方便详情页展示和历史回放。

### 5.2 Round 1: 开场立场

每个动态角色并发回答。

每个角色 prompt 应包括:

- 用户原始问题
- 主持人诊断
- 本角色的 `stance_hint`
- 本角色的 `must_answer`
- 本角色的 `anti_pattern`

输出要求:

- 只从本角色视角回答。
- 必须给出一个明确倾向。
- 必须列出一个会改变自己判断的事实。
- 禁止"看情况"式中立话术。

### 5.3 Moderator Probe: 提炼分歧 / 点名追问

主持人读取 Round 1,输出:

```json
{
  "consensus": ["..."],
  "disagreement_axes": [
    {
      "axis": "短期交付速度 vs 长期维护成本",
      "side_a": "先保持 PWA,少维护一套客户端",
      "side_b": "转 Native,换取更强系统能力和分发触达",
      "why_it_matters": "这决定了团队是否愿意用长期工程成本换取用户触达。"
    }
  ],
  "selected_axis": "短期交付速度 vs 长期维护成本",
  "probes": [
    {
      "to": "工程负责人",
      "question": "请具体估算迁移后每月多出的维护面在哪里。"
    },
    {
      "to": "增长负责人",
      "question": "请说明 Native 带来的新增触达是否足以抵消安装摩擦。"
    }
  ]
}
```

MVP 只要求 2 个 probe。深挖模式可 3 个。

### 5.4 Round 2: 点名交锋

只有被主持人点名的角色回答。

回答要求:

- 必须回应主持人的 probe。
- 必须引用至少一个其他角色的观点。
- 必须说明自己是否改变或收窄了原立场。

### 5.5 Synth: 圆桌纪要

整理员读取:

- 用户问题
- 主持人诊断
- 动态角色定义
- Round 1 开场
- Moderator probe
- Round 2 点名交锋

输出"圆桌纪要"。

---

## 6. Roundtable Memo

标准圆桌的最终产物不叫"整理员综合",建议叫 **圆桌纪要**。

结构:

```markdown
## 一句话摘要
[这场讨论把问题收束成什么判断路径]

## 主持人诊断
- 问题类型:
- 为什么这样组桌:

## 参会角色
- 角色 A:代表什么视角,本场最强贡献是什么
- 角色 B:...

## 共识
- ...

## 核心分歧轴
- 轴一:
  - A 端:
  - B 端:
  - 本质取舍:

## 各方最强论点
- 角色 A:
- 角色 B:

## 条件性结论
- 如果你更重视 X,倾向 A。
- 如果你更重视 Y,倾向 B。

## 缺失事实
- 哪些事实确认后会改变结论。

## 下一步行动
- 1-3 个低成本验证动作。
```

保留现有 synth 的精神:不做无条件裁判,给出条件性决策路径。

---

## 7. UX

### 7.1 新建圆桌 dialog

```text
新开一场圆桌

问题
[ textarea ]

桌型
[ 自动圆桌 ] [ 四派评审 ] [ 1V1 对抗 ]

深度
[ 快速 ] [ 标准 ] [ 深挖 ]

参考文件
[ upload ]

高级
▸ 模型配置
▸ 固定某些角色
▸ 禁用自动追问

[开始]
```

桌型说明:

```text
自动圆桌:
系统会根据问题自动选择 3-5 个参会角色,并由主持人推进分歧。

四派评审:
固定使用极简派 / 场景派 / 借鉴派 / 悲观派,适合工程决策扫盲区。

1V1 对抗:
把问题拆成正反两端,适合"做/不做""A/B"这类二值决策。
```

### 7.2 列表页

每条 session 显示 mode chip:

```text
[自动圆桌] 是否应该把 PWA 改成 Native App?
主持人:产品/技术决策 · 4 角色 · 7/9 轮
```

旧 session 没有 mode 字段时显示 `[四派评审]`。

### 7.3 详情页

详情页默认先展示产物,再展示过程。

```text
问题标题

[自动圆桌] [标准深度] [运行中/完成]
主持人判断:技术/产品决策
参会角色:产品负责人、工程负责人、增长负责人、风险负责人

圆桌纪要
...

讨论过程
▸ 主持人组桌
▸ Round 1 开场立场
▸ 主持人提炼
▸ Round 2 点名交锋
▸ 原始 markdown
```

移动端:

- 圆桌纪要默认展开。
- 讨论过程默认折叠。
- 每个角色发言用单列卡片。

桌面端:

- 圆桌纪要在上方或左侧优先显示。
- 讨论过程按 round 分组。
- 主持人节点用不同样式,避免和参会角色混在一起。

---

## 8. Backend Contracts

### 8.1 Session meta

给 `Session` meta 增加向前兼容字段:

```json
{
  "mode": "auto_roundtable",
  "table_type": "auto",
  "depth": "standard",
  "moderator": {
    "problem_type": "technical_product_decision",
    "reason": "...",
    "selected_roles": [...]
  }
}
```

兼容规则:

- 旧 session 缺 `mode` => `classic_four_roles`。
- 当前 `/roundtables` 仍列同一目录下所有 session。
- `GET /roundtables/{id}` 返回 `mode`, `depth`, `moderator` 给 PWA 渲染。

### 8.2 Turn types

新增 turn types:

| type | role | 含义 |
|---|---|---|
| `moderation_plan` | `主持人` | 问题诊断 + 组桌结果 |
| `moderator_probe` | `主持人` | 第一轮后的分歧提炼和点名追问 |
| `answer` | 动态角色名 | 开场立场 |
| `critique` | 动态角色名 | 被点名交锋 |
| `synth` | `整理员` | 圆桌纪要 |
| `review` | `审查员` | 收敛判断 |

现有 turn types 保留。

### 8.3 Suggested modules

```text
backend/roundtable/moderator.py
  - MODERATOR Role
  - parse_moderation_plan(raw) -> ModerationPlan
  - build_moderation_prompt(question, depth, attachments_context)
  - build_probe_prompt(question, plan, r1_turns)

backend/roundtable/auto.py
  - run_auto_roundtable(...)
  - make_dynamic_roles(plan) -> list[Role]

backend/roundtable/synth.py
  - add build_roundtable_memo_prompt(...)
  - keep existing classic synth path

backend/main.py
  - POST /roundtables accepts mode/depth
  - GET /roundtables/{id} includes mode/depth/moderator
```

Avoid creating a separate top-level subsystem. It should live under `backend/roundtable/` and reuse jsonl persistence, model registry, attachments, role model overrides, and polling UI.

---

## 9. Implementation Strategy

### 9.1 MVP

MVP scope:

1. Keep current implementation as `classic_four_roles`.
2. Add `auto_roundtable` mode.
3. Add `moderator.py`.
4. Moderator does only two things:
   - diagnose + choose roles
   - after Round 1, pick one disagreement axis and 2 probe targets
5. Dynamic roles are generated from moderator plan.
6. Synth output becomes "圆桌纪要" for auto mode.
7. PWA adds table-type switch.

Out of MVP:

- User manually editing dynamic roles before start.
- Multi-table comparisons.
- Moderator automatically switching to 1v1.
- Rich visual graph of disagreement axes.

### 9.2 Migration

Rename current UI label:

```text
圆桌 -> 四派评审
```

But keep route names initially:

- `/roundtables`
- `/roundtables/{id}`

This avoids a broad API migration. "Roundtable" remains the system name; "四派评审" is just one mode.

### 9.3 Suggested order

1. Data model: add optional `mode`, `depth`, `moderator` fields to session meta.
2. Moderator parser tests.
3. Auto roundtable orchestration tests with fake model.
4. API accepts `mode` and dispatches classic vs auto.
5. PWA form mode switch.
6. PWA detail rendering for auto mode.
7. Manual E2E with one real question.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Dynamic roles become vague | Require `must_answer` and `anti_pattern` per role; parser rejects empty/generic roles. |
| Moderator adds latency | Keep one moderation call; cache plan in meta; standard mode still near current call budget. |
| UI gets conceptually crowded | Present three modes as桌型, not separate products. Default to 自动圆桌; hide advanced controls. |
| Existing four派 users lose muscle memory | Keep current behavior under 四派评审 preset; old sessions render as 四派评审. |
| Synth prompt not suited to dynamic roles | Add auto-mode memo prompt but preserve existing classic synth parser for old mode. |
| Hard to test with LLM output | Parser functions are pure and tested with fixture strings; orchestration accepts injected model_fn like current debate tests. |

---

## 11. Open Questions

- 自动圆桌的默认角色数:标准模式固定 4,还是由主持人在 3-5 内选择?
- 主持人是否可以建议"这个问题更适合 1v1",并让 PWA 提示用户切换?
- 圆桌纪要是否沿用现有 `parse_synthesis` 的 5 段结构,还是为 auto mode 新增 parser?
- 角色模型配置是否暴露动态角色?MVP 建议不暴露,只暴露主持人 / 整理员 / 审查员和四派 / 1v1 固定角色。
- "四派评审"这个命名是否最终确定?备选:经典四派、多视角评审、工程四派。

---

## 12. Recommendation

推荐把产品概念定为:

```text
圆桌是讨论引擎。
桌型决定讨论协议。
主持人负责控场。
整理员负责纪要。
审查员负责收敛。
```

第一版落地:

- 默认:自动圆桌
- 保留:四派评审
- 并列:1v1 对抗

这样既不浪费现有四派的产品价值,也不会让"四派"继续冒充整个圆桌。1v1 也能自然归位:它不是圆桌的竞品,而是圆桌系统里的强对抗桌型。
