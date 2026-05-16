# 01 · 概览三 tab(手机)— 设计规格

> 配套文件:`01-tabs-overview.html`(浏览器直接打开就能看,或者 nginx serve `/design/01-tabs-overview.html`)
>
> 这份文档讲**设计意图 + 与现状差异**。具体改哪几行 CSS / JS 由实施时判断,不预设。

---

## 1. 这张稿要解决什么

手机进 PWA 看到的第一屏。**1 秒内**要能扫到三件事:

1. **现在有什么在跑** — running 状态高亮
2. **有什么待我审批** — 顶部 pending 徽章(全局,跨 workspace)
3. **有什么失败了** — failed 状态红字

其他次要信息(engine 是哪个、cron 表达式、辩论的 round 数)排在视觉层级第二位。

---

## 2. 三个 tab 的共同结构

每个 tab 都是同一个外框:

```
┌─ topbar ─────────────────────┐
│ cc-workflow   [⚠1]  ● 在线   │  ← 顶部
├──────────────────────────────┤
│                              │
│  ...列表...                  │  ← 滚动区
│                              │
├──────────────────────────────┤
│  ▢ Workspaces                │  ← 底部 nav
│  ✓ Tasks                     │
│  ◌ Roundtable                │
└──────────────────────────────┘
```

**列表项最大字号 14px,次要字段 11px 或 10px**,用 mono font 显示技术信息(cron 表达式、run-id、engine 名)。

---

## 3. 关键设计决策(可争议项,展开 trade-off)

### 3.1 顶部 pending 徽章

**决策:** 顶部 status 区(原本只有"● 在线")加一个红色徽章 `⚠ N`,代表跨所有 workspace 的待审批数。

**收益:** 飞书推送进来时,用户不需要自己去 N 个 workspace 卡片里找哪个亮红。一键到全局待审列表。

**代价:** 多一个全局状态需要维护,后端要新增一个聚合查询。

**何时翻案:** 用户反馈"我宁愿一直在 workspace 卡片里点"——但当前预期场景是飞书推送驱动,徽章是顺手的入口。

**前端实现提示:** 仅在 `pendingApprovalsTotal > 0` 时渲染。点击行为暂未画 sheet,先跳到第一个 pending 的 workspace 卡片;sheet 设计放 02。

### 3.2 Workspace 卡片只露 1 行 runline

**决策:** 概览界面**不展开** stream,只显示 head + runline + (running 时多一行 preview)。

**收益:** 信息密度可控,5 个工作区一屏能看完。

**代价:** 看不到 thinking 文字、tool 参数细节。

**何时翻案:** 不翻案——这些细节属于"展开层级 1/2",放到 02(单 workspace 详细视图)里设计。

**与现状差异:** 当前 `renderMobileOverview`(`app.js:840`)的逻辑大致就是这样,但 running 卡片**没有 preview 行**,需要新增。preview 内容来自当前 turn 最后一个 tool_use 的标题(如 `Edit pwa/style.css`)或 thinking 的简略。

### 3.3 状态色映射(全 PWA 统一,几乎不可逆决策)

| 状态 | 颜色变量 | 用途 |
|---|---|---|
| running | `--accent-cyan` `#06b6d4` | 工作区在跑、cron 在跑、辩论进行中 |
| done | `--accent-green` `#22c55e` | 任务成功完成(cron / workspace run);roundtable 完成用中性 secondary 色,不染绿 |
| failed | `--accent-red` `#ef4444` | 错误 |
| queued / link | `--accent-blue` `#2f7eff` | 排队中、可点击信号 |
| paused | `--text-disabled` + `opacity: .55` | 暂停 |
| 借/借鉴派(roundtable) | `--accent-amber` `#f59e0b` | 仅 roundtable persona |
| 合/合成(roundtable) | `--accent-purple` `#a855f7` | 仅 roundtable synthesizer |

**这一表锁死**,后续任何新状态先看能不能套进现有色,实在不行再开新色。

### 3.4 左侧亮条提示 running

`box-shadow: inset 3px 0 0 var(--accent-cyan)` 加在 running 卡片左侧。

**比满边框软**,扫一眼就能在长列表里定位 running 项。已经在 02-08 几张稿里反复用到,定为通用模式。

### 3.5 Tasks 行加 `next-run` 时间

**决策:** cron 行除了"上次结果",还要显示"下次什么时候跑"(`下次 14:30 · in 2h`)。

**收益:** 用户最关心的是"还有多久跑",光看上次成功不够。

**代价:** 前端要解析 cron 算 next-fire(用 `cron-parser` 或后端预算好返回)。

**何时翻案:** 不翻——这是 cron 视图的核心信号。

### 3.6 Roundtable 4 persona 头像

辩论行里显示参与的 persona 头像列表(单字 + 颜色圆点):

| 字 | 全名 | 颜色 |
|---|---|---|
| 极 | 极简派 | green |
| 场 | 场景派 | cyan |
| 借 | 借鉴派 | amber |
| 悲 | 悲观派 | red |
| 合 | 合成派 | purple |

5 个固定颜色不复用其他语义。

---

## 4. 状态分类与视觉对应

### 4.1 Workspace 卡片状态

- **running** — cyan 左条 + cyan border + preview 行 + 脉冲点(`@keyframes pulse`)
- **running 含 pending approval** — runline 里加一行 "1 待审批"(红字)
- **done** — 默认样式
- **failed** — runline 里失败原因(短文字)
- **empty(没跑过)** — runline 替换成 `还没跑过 · 点击开始`(disabled 色)

### 4.2 Cron 行状态

- **running** — cyan 圆点 + cyan border + 计时(`1m24s`)
- **done(最近成功)** — green 圆点 + `done · 2m ago`
- **failed** — red 圆点 + `failed×N · retry`(连续失败几次)
- **paused** — 灰圆点 + `opacity .55` + `已暂停`

### 4.3 Roundtable 行状态

Roundtable 的产出**是辩论结果文档本身**,不是「采纳谁」的投票。所以只有三个客观状态:

- **active** — cyan 左条 + cyan border + `● round N/N` + persona avatars + "进行中"
- **done** — `✓ 完成` + persona avatars + 完成时间(用户点进去看 synthesizer 输出 + 各 persona 立场)
- **failed** — red border + `◯ 失败` + 失败原因(如 `借鉴派 · API 超时` / `合成超时`)

**不引入「采纳/分歧/已弃」这层维度** —— 那是给「方案投票」用的,roundtable 不做投票。用户对结果的态度(我接受 / 我不接受)属于用户脑里的事,不该在 PWA 上让用户去打标。

---

## 5. 与现状的差异概要

**不预设具体改哪行**,只列出需要新增的"概念":

| 概念 | 现状 | 设计要求 |
|---|---|---|
| 顶部 pending 徽章 | 不存在 | 新增 — 仅当总数 > 0 显示 |
| WS 卡片 running preview 行 | 没有 | 新增 — 显示最后一个 tool 标题 |
| WS 卡片 pending hint | 没有专门标记 | 在 runline 加红字"N 待审批" |
| Cron next-run 时间 | 现状未确认 | 必须显示,在 cron 表达式后面 |
| Cron failed×N retry 计数 | 现状未确认 | 必须显示连续失败次数 |
| Roundtable 行 persona avatars | 现状未确认 | active 时必须显示 4 个头像 |
| 左侧亮条 (running) | 仅 border | 改为 `inset 3px 0 0` 阴影,更柔和 |

**反之保留的现状:**
- 底部 nav 三 tab、SVG icon 不变
- 配色 token 不变,所有新色都从 `:root` 引用
- `data-tab` 路由不变
- 卡片点击进 detail 的行为不变(detail 视图属于 02 范畴,本稿不涉及)

---

## 6. 不在本稿范围

下面这些**故意不画**,放后面设计:

- 单 workspace 卡片展开后的 stream 渲染(02)
- 全局 pending sheet 长啥样(02)
- run-detail 详情页(03,大概率瘦身保留只读 transcript)
- 桌面端横向多列布局(04)
- 空状态(没工作区 / cookie 过期 / 后端 502) — 这个 P0 阶段先简单文字处理

---

## 7. 给实施方的提醒

按项目 `CLAUDE.md`:

- **沟通底线** — 实施过程中任何"现状跟稿子不一致 / 不知道怎么取舍"的地方,**回到 Cowork 这边讨论**,不要自己猜
- **Unix** — 每个 CSS class 只负责一件事(`.ws-card.running` 只管亮条, `.pending-badge` 只管徽章本身),不要为了少加一个 class 把多个状态揉进一个选择器
- **TDD** — 状态色映射(3.3 表)写一个单测固化:输入状态字符串 → 输出 CSS 变量名,别让"running 用了 amber"这种事悄悄发生
- **架构思维** — 状态色映射表(3.3)和 persona 头像表(3.6)属于"几乎不可逆决策",改名要全代码库一起改;放进 `pwa/style.css` 顶部注释里钉死

---

## 8. 验收

打开 PWA(手机),依次切三个 tab,看到的应该跟 `01-tabs-overview.html` 三张图**视觉一致**(允许细微像素差,但状态色 / 信息层级 / 顶部徽章必须严格匹配)。
