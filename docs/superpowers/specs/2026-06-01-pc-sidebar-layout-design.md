# PC 工作区侧边栏布局 — Design

**Date:** 2026-06-01
**Status:** Drafted for user review
**Scope:** 把 PC 端 Workspaces tab 从"卡片墙"(一进来铺一墙全功能卡)重做成 **左侧固定侧边栏 + 右侧主区**:侧边栏两级(workspace ▸ session,塌缩)导航 + 新建,主区默认聚焦 1 个、最多并排 2 个 pane。**只动 PC,移动端 carousel 一行不碰;只动 Workspaces tab;底层 workspace/session/run 数据模型不动。**

---

## 1. Motivation

PC 当前 overview = `renderDesktopOverview` 的卡片墙:每个 session 是一张全功能卡(header + timeline + 输入表单),`flex:1 1 0` 等权平铺铺满视口。重感的根因有三:

1. **每张卡满 chrome**:border + box-shadow + 圆角 + 内部 divider 多重分隔叠加,N 张卡 = N 份重复边框怼脸。
2. **每张卡底部常驻输入表单**:一面墙上 N 个输入框 + N 个 Run,信息密度爆炸。
3. **等权重、零层级**:没有任何东西告诉眼睛"看这个就行",是一堵均匀盒子墙。

移动端"还可以"正是因为 carousel **一次只显示一个 workspace**,天然有焦点。本设计把"专注单开"搬到 PC,同时保留 PC 大屏优势(侧边栏一眼扫所有 repo + 偶尔并排两个对比)。

**目标:** PC 进 Workspaces 默认是 **侧边栏 + 一个聚焦的对话**,而非一墙卡片;需要对比/并行时主动拖出第二个 pane。
**非目标:** 不动移动端;不动数据模型;不做 pane > 2、可调分隔条、侧边栏折叠成图标条(YAGNI,§9)。

---

## 2. 通用语言(术语,§3.4 几乎不可逆)

沿用现有核心术语,**不引入同义词**:

| 术语 | 含义 | 备注 |
|---|---|---|
| `workspace` | `~/workspaces/<name>/` 一个 git repo | 不变 |
| `session` | 一条对话线(session_key),一个 workspace 可有多条 | 不变;UI 里口语叫"对话" |
| `run` | 一次 agent-run 调用 | 不变 |
| **`pane`**(新增) | 主区里一个聚焦展开的 session 视图(= 现有 detail 卡) | 主区最多 2 个 pane |
| **`sidebar`**(新增) | 左侧固定导航栏 | PC-only |

UI 文案里 session 对用户叫"对话",但代码 / 标识符 / 本 spec 统一 `session` / `pane` / `sidebar`。

---

## 3. Approach

### 3.1 整体结构(PC-only,`min-width:769px`)

```
┌──────────┬──────────────────────────────────┐
│ sidebar  │  main(≤2 panes)                   │
│ ~220px   │                                    │
│ +新建     │  ┌── pane ───────────────────┐    │
│ ────────  │  │ workspace header          │    │
│ repo 树   │  │ 对话 timeline              │    │
│ (两级)    │  │ 输入框 + Run               │    │
│          │  └───────────────────────────┘    │
└──────────┴──────────────────────────────────┘
```

`renderWorkspacesView()` 现有分支不变:`matchMedia(max-width:768px)` → mobile;否则 → **新的 `renderDesktopSidebarLayout()`**(取代 `renderDesktopOverview`)。

### 3.2 侧边栏(A 两级 + 塌缩)

| 决策 | 选项 | 理由 |
|---|---|---|
| **组织方式** | **两级:workspace ▸ session** | session 离不开 workspace(每条对话绑 repo cwd),两级跟数据模型 1:1;"纯 session 扁平"只是把 repo 藏成标签,且碰 §3.4 通用语言风险 |
| **塌缩** | **只有 ≥2 条 session 的 repo 才展开**成树;单 session repo 就是一行 | A 的数据正确性 + B 的视觉清爽,两头都占 |
| **顶部** | `+ 新建 workspace`(复用现有 New workspace `<dialog>`) | 不重写表单 |
| **多 session repo 展开后** | 列各 session + `+ 新对话` | `+ 新对话` 创建新 session_key(沿用现有新建 session 路径) |
| **点击** | workspace/session → 在**当前 active pane** 聚焦它 | 单开主路径 |
| **拖拽** | workspace/session 拖到主区 → 开/替换 pane 2 | 用户原话"拖对话出来" |
| **⇲ 并排打开按钮**(§7-3 用户确认加) | 侧边栏项 hover 时右侧出现一个 `⇲` 小按钮,点它 = 等价于拖出来开第二 pane | 纯拖拽对触控板/不熟者不友好,给一个点击入口 |
| **当前聚焦项高亮** | active pane 对应的侧边栏项高亮 | 导航必须能看出主区在看哪个;**与早前"tile 不需要高亮"不冲突**(那是墙上格子靠点击直触发,这里是导航) |

### 3.3 主区 / 多开(A:MAX_PANES=2)

| 决策 | 选项 | 理由 |
|---|---|---|
| **pane 内容** | 复用 `workspaceColHtml(ws, data, {detail:true, sessionKey})` | 现有 detail 渲染,不新写 |
| **默认** | 1 个 pane,聚焦上次状态(§3.5) | 专注单开 |
| **上限** | 常量 `MAX_PANES = 2`,并排等宽 | 嫌"重"的根因就是塞太多;放开数量 = 回到墙。改一个常量 + 网格 CSS 即可放开到 N(轻易可逆) |
| **超限** | 已 2 个再开第 3 个 → **替换非 active 的那个**(拖拽时替换离拖入点近的) | 不无限增长 |
| **去重** | 同一 session 不能同时在两个 pane | reducer 保证 |
| **关闭** | 2 pane 时每个 pane 右上角 `×` → 回单开;1 pane 时不显示 `×` | 至少留 1 个 pane |

### 3.4 数据流

```
主 poll → refreshAll(已有 hash 去重)→ render()
  → renderWorkspacesView()
     → [PC] renderDesktopSidebarLayout(lastData, paneState)
          ├─ buildSidebarTree(workspaces, sessions)  [纯函数]
          │     → 渲染侧边栏(树 + 塌缩 + active 高亮)
          └─ paneState.panes.map(tileId =>
                workspaceColHtml(ws, groups[tileId], {detail:true, sessionKey}))
                → 渲染 1~2 个 pane

用户操作(点击 / 拖拽 / ⇲ / 关闭 / 新建)
  → dispatchPane(action)  →  paneStateReducer(state, action)  [纯函数]
  → 写 localStorage  →  重渲染
```

### 3.5 状态持久化(localStorage)

新 key `cc.pcLayout`(JSON):
```json
{
  "panes": ["cc-workflow::default", "notes::pwa-notes"],
  "activePaneIdx": 0,
  "expandedRepos": ["cc-workflow"]
}
```
- `panes`:开着的 pane,值用现有 `sessionTileId`(`parseSessionTileId` 反解)。
- 刷新/重进 → 恢复。若持久化里的 tileId 已不存在(repo/session 被删)→ 静默丢弃,回落到默认聚焦第一个 repo。
- 老的卡片墙 localStorage(布局/隐藏)**作废**,首次进入忽略即可(不迁移,见 §6)。

### 3.6 路由

| URL | 行为 |
|---|---|
| `#workspaces` | 侧边栏 + 主区,恢复 `cc.pcLayout` 上次状态(无则聚焦第一个 repo) |
| `#workspaces/<name>` | 进去 = 把该 repo 的默认 session 聚焦到 pane 1(深链:飞书/cron 通知点进来)。单 pane,不强制保留旧 pane |

mobile 路由不变。

---

## 4. 取代 / 删除的现有代码(反悔成本"痛但可行")

新布局取代卡片墙,以下 **PC-only** 代码被本次改动**孤立**(§4 外科手术:删本次造成的孤儿),一并清:

**删 / 改:**
- `renderDesktopOverview` → 重写为 `renderDesktopSidebarLayout`
- 行布局拖拽:`effectiveLayout` / `.ws-row` / `.ws-row-gap` / `onRowGapDragOver/Leave/Drop` 及相关 CSS(墙专用)
- workspace 隐藏:`_wsHidden` / hidden strip / `.ws-restore-btn` / `.ws-hide-btn`(墙专用)
- 卡片间拖拽重排:`onColDragStart` / `.ws-col` drag 相关(墙专用)
- 上述对应 CSS 段(`.ws-layout` / `.ws-row*` / `.ws-hidden-strip` 等)

**保留复用(不动):**
- `groupBySession` / `sessionChipLabel` / `sessionTileId` / `parseSessionTileId` / `tileKeyFor`
- `workspaceColHtml`(detail 分支)/ `bindWorkspaceColHandlers`
- New workspace `<dialog>` + `_newWsProviderPickerHtml`
- `renderMobileOverview` / 整个 mobile 路径
- 全部后端(零改动)

→ 刚做完的多 session 投入**不浪费**:session 数据从"墙上的 tile"改喂给 `buildSidebarTree` 变成"侧边栏的树",同一份数据换壳展示。

---

## 5. 纯函数 & 测试(TDD,§2)

进 `pwa/ui_contract.mjs`,单测进 `tests/pwa-ui-contract.test.mjs`:

### 5.1 `buildSidebarTree(workspaces, sessions)`
输入 = 现有 `lastData.workspaces` / `lastData.sessions`;输出:
```js
[
  { ws:'cc-workflow', tileId:'cc-workflow::default', sessionCount:3, expandable:true,
    sessions:[ {sessionKey, label, tileId}, ... ] },   // ≥2 才有 sessions
  { ws:'notes', tileId:'notes::pwa-notes', sessionCount:1, expandable:false, sessions:[] },
]
```
单测:① 单 session repo → expandable:false, sessions:[] ② 多 session repo → expandable:true + 正确 children ③ 无 run 的新 repo → 仍有一个默认 leaf ④ label 用 `sessionChipLabel`。

### 5.2 `paneStateReducer(state, action)`
`state = {panes:[tileId...], activePaneIdx}`,actions:
- `{type:'focus', tileId}` → 写进 active pane(若已在某 pane,只切 activePaneIdx,不重复)
- `{type:'openBeside', tileId, near?}` → panes<MAX 则 append 并设为 active;已满则替换非 active(或近 `near` 的);已存在则只 focus
- `{type:'close', idx}` → 删该 pane(仅 panes.length===2 时合法);剩下的成 active
- 不变量:panes 长度 ∈ [1,2];无重复 tileId;activePaneIdx 永远指向存在的 pane

单测:open→满→再 open 替换、close 回单开、focus 已开项不 dup、去重、MAX 边界。

### 5.3 不进单测的(集成 / 手动 smoke)
DOM 渲染、拖拽 dragstart/drop、localStorage 读写、CSS 布局 —— `node --check` + 手动浏览器 smoke。

---

## 6. Trade-off / 反悔成本

| 决策 | 反悔成本 | 何时翻案 |
|---|---|---|
| 删卡片墙换侧边栏 | **痛但可行**(模块边界) | 用户用一阵觉得侧边栏不如墙一眼全看 → 但 git 留着旧 `renderDesktopOverview` 可回滚 |
| 两级 vs 纯 session | **几乎不可逆**(通用语言)→ 选两级,不动术语 | 基本不翻 |
| MAX_PANES=2 | **轻易可逆** | 改常量 + 网格 CSS 放开到 N |
| ⇲ 并排按钮 | 轻易可逆 | 没人用就删 |
| localStorage 不迁移旧墙布局 | 轻易可逆 | 旧布局本就要废,无迁移价值 |

---

## 7. Open Questions(已定)

1. **`+ 新对话` 创建 session 的入口** —— **已定(用户)**:点 `+ 新对话` 直接建一个**自动命名**的新 session(如 `<ws>--2`),进 pane 聚焦,**不弹命名框**。
   - **session 重命名(改标题)→ 不进本 spec,列为 fast-follow。** 理由:① 要后端存 title(否则 mac/Android/飞书/cron 多端标题不同步,localStorage 只存本机不够);② 与布局正交(移动端、侧边栏都适用)。本次布局先用自动命名,重命名作为布局完成后的独立小 spec。
2. **窄桌面窗(769~900px)双开是否够宽**:两个 pane 各 ~380px,timeline 可读但偏窄。→ **接受**;真窄就别开第二个。不为此加响应式断点(YAGNI)。

---

## 8. Self-review(spec 自审)

- ✅ 无 TBD / 占位:Open Questions 2 条都给了倾向 + 不阻塞结论。
- ✅ 内部一致:§3 决策表 ↔ §4 删除清单 ↔ §5 测试 三处对得上(reducer/tree 是 §3 行为的纯函数化)。
- ✅ 范围聚焦:单一可实施单元(一个前端布局重做 + 2 个纯函数),不需拆子项目。
- ✅ 歧义消解:"对话"= session 已在 §2 钉死;"高亮"与早前"tile 不需要高亮"的区别已在 §3.2 说明。

---

## 9. 不做(YAGNI)

- pane > 2(常量留口,不实现)
- pane 间拖拽互换、可调分隔条、pane 大小记忆
- 侧边栏宽度可拖 / 折叠成图标条
- 移动端任何改动
- 旧墙布局 localStorage 迁移
