# PC 工作区侧边栏布局 — Implementation Plan

**基于 spec:** `docs/superpowers/specs/2026-06-01-pc-sidebar-layout-design.md`(已审批)

**改动文件(全部前端,后端零改动):**

- `pwa/ui_contract.mjs` — 加 2 个纯函数 `buildSidebarTree` / `paneStateReducer` + 常量 `MAX_PANES`
- `tests/pwa-ui-contract.test.mjs` — 加纯函数单测(现有 29 个 → 预计 ~40 个)
- `pwa/app.js` — 删卡片墙(`renderDesktopOverview` / 行布局拖拽 / hidden strip / 卡片拖拽) + 写 `renderDesktopSidebarLayout` + pane 状态 / 持久化 / 事件
- `pwa/style.css` — 删墙专用 CSS + 加 sidebar / pane 网格 CSS
- `pwa/sw.js` — bump `VERSION` `cc-v107` → `cc-v108`

**关键事实(拆任务前先知道):**

- 现有 `pwa-ui-contract.test.mjs` = **29 个 `test()`**(spec §5 / 任务前提核对一致),ESM,`node --test tests/pwa-ui-contract.test.mjs` 跑。
- `app.js:1044 renderWorkspacesView()` 分叉:`matchMedia(max-width:768px)` → `renderMobileOverview`(mobile,**不碰**),else → `renderDesktopOverview`(PC,**本次取代**)。
- 要删的墙代码(`effectiveLayout` / `_wsHidden` / `_wsLayout` / `onRowGap*` / `onCol*` 拖拽 / hidden strip)经核查**只被 PC overview 用**;mobile 走 `_isMobileViewport`→`_mobileWsCardHtml`,不依赖它们。
- `workspaceColHtml` 里的 `dragHandle` / `hideBtn` 只在 `!detail`(overview)分支发射,`detail`/mobile 分支为空 → 删它们不影响 detail/mobile pane 渲染。
- `.ws-col` 本身是 detail + mobile + pane 共用,**绝不能删**;只删 overview 专用的 `.ws-row*` / `.ws-layout` / `.ws-hidden-strip` / `.ws-restore-btn` / 卡片拖拽 CSS(`.ws-col.dragging` / `.drop-target-*` / `body.is-dragging`)。
- 复用不动:`groupBySession` / `sessionChipLabel` / `sessionTileId` / `parseSessionTileId` / `tileKeyFor` / `workspaceColHtml`(detail 分支)/ `bindWorkspaceColHandlers` / New workspace `<dialog>` + `_newWsProviderPickerHtml`。

---

## Task 列表

### Task 1: `paneStateReducer` 写失败测试(RED)
- **做什么:** 在 `tests/pwa-ui-contract.test.mjs` 顶部 import 加 `paneStateReducer` 和 `MAX_PANES`(从 `../pwa/ui_contract.mjs`)。按 spec §5.2 加单测块(覆盖 5 case):
  - `focus`:写进 active pane;已在某 pane 则只切 `activePaneIdx`,不重复加。
  - `openBeside`:`panes<MAX` → append 并设 active;已满 → 替换非 active 的那个;已存在 → 只 focus 不 dup。
  - `close`:仅 `panes.length===2` 时合法,删该 idx,剩下的成 active;`length===1` 时 close 是 no-op(至少留 1)。
  - 去重:任何 action 后 `panes` 无重复 tileId。
  - 不变量:`panes` 长度 ∈ [1,2];`activePaneIdx` 永远指向存在的 pane。
- **测试(RED):** 跑 `node --test tests/pwa-ui-contract.test.mjs` → 因 `paneStateReducer` / `MAX_PANES` 未导出而 **import 报错 / 全红**。先确认它真红。
- **依赖:** 无
- **预估:** ~4 min
- **可并行:** 跟 Task 3(buildSidebarTree 测试)无依赖,可并行

### Task 2: `paneStateReducer` + `MAX_PANES` 实现(GREEN)
- **做什么:** 在 `pwa/ui_contract.mjs` 加 `export const MAX_PANES = 2;` + `export function paneStateReducer(state, action)`(纯函数,无 IO / 无 localStorage,只 state→state)。`state = {panes:[tileId...], activePaneIdx}`。按 spec §3.3 / §5.2 行为实现 `focus` / `openBeside` / `close` 三个 action type,保证三条不变量。
- **测试(GREEN):** Task 1 的单测全绿;`node --test` 通过。
- **依赖:** Task 1
- **预估:** ~5 min
- **可并行:** 否(依赖 Task 1)

### Task 3: `buildSidebarTree` 写失败测试(RED)
- **做什么:** 在 `tests/pwa-ui-contract.test.mjs` import 加 `buildSidebarTree`。按 spec §5.1 加单测块(覆盖 4 case),输入用 `lastData.workspaces` / `lastData.sessions` 同形状的 fixture:
  - ① 单 session repo → `expandable:false`, `sessions:[]`。
  - ② 多 session(≥2)repo → `expandable:true` + 正确 children(每个 `{sessionKey, label, tileId}`)。
  - ③ 无 run 的新 repo → 仍有一个默认 leaf(`tileId = sessionTileId(ws, 'pwa-<ws>')`)。
  - ④ children 的 `label` 用 `sessionChipLabel(ws, sessionKey)` 派生。
- **测试(RED):** `node --test` → `buildSidebarTree` 未导出,该块全红。确认真红。
- **依赖:** 无
- **预估:** ~5 min
- **可并行:** 跟 Task 1 / 2 无依赖,可并行

### Task 4: `buildSidebarTree` 实现(GREEN)
- **做什么:** 在 `pwa/ui_contract.mjs` 加 `export function buildSidebarTree(workspaces, sessions)`(纯函数,无 IO)。输出 spec §5.1 的数组形状:每个 entry `{ws, tileId, sessionCount, expandable, sessions}`,`expandable` = `sessionCount>=2`,`sessions` 仅 expandable 时填 `{sessionKey, label, tileId}`。复用现有 `sessionTileId` / `sessionChipLabel`(同文件已有,直接调)。注意与 `tileKeyFor` 的归桶语义一致:cron / 飞书 session 不进树。
- **测试(GREEN):** Task 3 单测全绿;`node --test` 通过。
- **依赖:** Task 3
- **预估:** ~5 min
- **可并行:** 否(依赖 Task 3)

> **Review checkpoint A:** Task 2 + 4 后 dispatch `code-reviewer` 审一次两个纯函数(签名 / 不变量 / 与现有 `tileKeyFor` 归桶语义一致性),通过再进 DOM 层。两个纯函数是地基,DOM 全靠它们,在这里钉死收益最大。

### Task 5: 删卡片墙代码(核查依赖 → 删孤儿)
- **做什么:** 删 `pwa/app.js` 中**仅 PC overview 用**的墙代码(spec §4)。删前已核查过依赖边界(见本 plan 顶部"关键事实"),删除清单:
  - `renderDesktopOverview`(整函数,1056–1186)
  - 行布局拖拽:`effectiveLayout`(874)/ `_removeFromLayout` / `_findLayoutCoord` / `reorderWorkspaceTo` / `onRowGapDragOver` / `onRowGapDragLeave` / `onRowGapDrop` / `onColDragOver` / `onColDragLeave` / `onColDrop` / `onHandleDragStart` / `onHandleDragEnd` / `setupDragReorder`
  - 布局状态:`_wsLayout` / `WS_MAX_PER_ROW` / `_sanitizeLayout` / `loadWsLayout` / `saveWsLayout` + 启动期 `loadWsLayout()` 调用
  - 隐藏:`_wsHidden` / `loadWsHidden` / `saveWsHidden` + `loadWsHidden()` 调用 / `onHideBtnClick` / `onRestoreBtnClick`
  - `workspaceColHtml` 内 overview 专用发射:`dragHandle`(2793-2795)/ `hideBtn`(2797-2801)两段及其在 header 模板里的插值点。
  - `bindOverviewHandlers` 暂留壳(下一 task 重写它绑 sidebar),删 `setupDragReorder()` 调用。
  - **暂不删** `renderWorkspacesView` 里 `renderDesktopOverview()` 调用 —— 改成调 `renderDesktopSidebarLayout()`(在 Task 7),本 task 先让分支临时指向一个空 stub,保证 `node --check` 过。
- **测试(GREEN):** `node --check pwa/app.js` 通过(无未定义引用、无孤儿调用残留)。这是删除任务的"绿"标准。
- **依赖:** Review checkpoint A 通过(纯函数定稿后才动 DOM,避免删了又因 reducer 改签名返工)
- **预估:** ~5 min
- **可并行:** 否

### Task 6: pane 状态持久化 + dispatch 接线(localStorage)
- **做什么:** 在 `pwa/app.js` 加 pane 状态管理(spec §3.5):
  - 模块级 `let paneState`,从 `localStorage['cc.pcLayout']` 读(JSON:`{panes, activePaneIdx, expandedRepos}`),无则默认 `{panes:[第一个 repo 的默认 tileId], activePaneIdx:0, expandedRepos:[]}`。
  - `loadPcLayout()` / `savePcLayout()`(包 try/catch,private-mode / quota 静默跳过,跟现有 `saveWsLayout` 同风格)。
  - 加载时校验:`panes` 里已不存在的 tileId(repo/session 被删)静默丢弃,回落到聚焦第一个 repo(spec §3.5)。校验逻辑用一个小纯辅助 `_prunePanes(panes, validTileIds)` —— **可选**:若觉得值得测,抽进 `ui_contract.mjs` 加 2 个单测;否则内联(spec §5.3 把 localStorage 读写归到手动 smoke,内联可接受,但 prune 是纯逻辑、建议抽测)。
  - `dispatchPane(action)`:调 `paneStateReducer(paneState, action)` → 写回 `paneState` → `savePcLayout()` → 重渲染 `renderDesktopSidebarLayout()`。
- **测试(GREEN):** `node --check pwa/app.js` 通过;若抽了 `_prunePanes` 则它的单测进 `pwa-ui-contract.test.mjs` 并绿。
- **依赖:** Task 2(`paneStateReducer`)、Task 5(墙代码删掉腾出空间)
- **预估:** ~5 min
- **可并行:** 否

### Task 7: `renderDesktopSidebarLayout` — 侧边栏渲染 + active 高亮
- **做什么:** 在 `pwa/app.js` 写 `renderDesktopSidebarLayout()`(取代墙)的**侧边栏半边**:
  - `renderWorkspacesView` 的 PC 分支改调 `renderDesktopSidebarLayout()`(替换 Task 5 的 stub)。
  - 调 `buildSidebarTree(lastData.workspaces, lastData.sessions)` → 渲染左栏:顶部 `+ 新建 workspace`(复用现有 `<dialog>` + `_newWsProviderPickerHtml`,不重写表单)、repo 树(单 session = 一行;≥2 = 可塌缩树,展开态读 `paneState.expandedRepos`)、多 session repo 展开后列各 session + `+ 新对话`。
  - active pane 对应的侧边栏项加高亮 class(spec §3.2)。
  - 侧边栏项 hover 出 `⇲` 并排打开按钮(spec §3.2 / §7-3)。
  - 主区半边本 task 先留容器占位(下一 task 填 pane)。
- **测试(GREEN):** `node --check pwa/app.js` 通过。(DOM 渲染走手动 smoke,spec §5.3。)
- **依赖:** Task 4(`buildSidebarTree`)、Task 6(`paneState` / `dispatchPane`)
- **预估:** ~5 min
- **可并行:** 否

### Task 8: `renderDesktopSidebarLayout` — 主区 pane 渲染(1~2 pane)
- **做什么:** 在 `renderDesktopSidebarLayout()` 填主区:
  - `paneState.panes.map(tileId => parseSessionTileId(tileId) → workspaceColHtml(ws, groups[tileId], {detail:true, sessionKey}))` 渲染 1~2 个 pane(spec §3.3 / §3.4)。
  - 2 pane 时并排等宽(网格,CSS 在 Task 11);各 pane 右上角 `×` 关闭(`dispatchPane({type:'close', idx})`);1 pane 时不显示 `×`。
  - 渲染后调 `bindWorkspaceColHandlers(主区容器)`(复用现有,pane 内 form / approve / 折叠等全靠它)。
- **测试(GREEN):** `node --check pwa/app.js` 通过。
- **依赖:** Task 7
- **预估:** ~5 min
- **可并行:** 否

### Task 9: 侧边栏交互事件(点击 / 拖拽 / ⇲ / 关闭 / 新建对话 / 塌缩)
- **做什么:** 在 `pwa/app.js` 绑 sidebar + pane 的事件(重写后的 `bindOverviewHandlers` 或新 binder):
  - 点 workspace/session 项 → `dispatchPane({type:'focus', tileId})`(聚焦到 active pane,spec §3.2)。
  - 拖 workspace/session 项到主区 → `dispatchPane({type:'openBeside', tileId, near})`(开/替换 pane 2)。
  - `⇲` 按钮点击 → 等价 `openBeside`(spec §7-3)。
  - pane `×` → `dispatchPane({type:'close', idx})`(Task 8 已接,这里确认 binder 覆盖)。
  - `+ 新对话` → 自动命名新 session(`<ws>--2` 递增,沿用现有新建 session 路径,**不弹命名框**,spec §7-1)→ 聚焦到 pane。
  - repo 塌缩三角点击 → toggle `paneState.expandedRepos` → `savePcLayout()` → 重渲染。
- **测试(GREEN):** `node --check pwa/app.js` 通过。(拖拽 / 点击走手动 smoke,spec §5.3。)
- **依赖:** Task 7、Task 8
- **预估:** ~5 min
- **可并行:** 否

### Task 10: 深链路由 `#workspaces/<name>`
- **做什么:** 在 `pwa/app.js` 处理 `#workspaces/<name>` 深链(spec §3.6):进去 = 把该 repo 的默认 session 聚焦到 pane 1(单 pane,不强制保留旧 pane)。确认 `#workspaces`(无 name)恢复 `cc.pcLayout` 上次状态、无则聚焦第一个 repo。**mobile 路由不变**(只在 PC 分支处理)。
- **测试(GREEN):** `node --check pwa/app.js` 通过。(路由跳转走手动 smoke。)
- **依赖:** Task 6、Task 7
- **预估:** ~4 min
- **可并行:** 否

### Task 11: sidebar + pane 网格 CSS;删墙专用 CSS
- **做什么:** 在 `pwa/style.css`:
  - **加:** sidebar 布局(`~220px` 固定左栏,PC-only `min-width:769px`)、repo 树缩进 / 塌缩三角 / active 高亮 / hover `⇲`、主区网格(1 pane 全宽 / 2 pane 等宽并排)、pane `×` 定位。
  - **删:** 墙专用 CSS(`.ws-layout` / `.ws-row` / `.ws-row .ws-col` / `.ws-row-gap` / `.ws-hidden-strip` / `.ws-restore-btn` / `.ws-col.dragging` / `.ws-col.drop-target-*` / `body.is-dragging` 相关)。**保留** `.ws-col` 本体 / `.ws-col-detail`(detail + mobile + pane 共用)/ `.ws-toolbar`(若新布局复用顶部条则保留,否则删)。
- **测试(GREEN):** 无自动化(CSS)→ 手动浏览器 smoke;改了 shell 文件,触发 Task 12 的 SW bump。
- **依赖:** Task 7 / 8 / 9(class 名要跟渲染对齐,CSS 最后写避免改 class 来回返工)
- **预估:** ~5 min
- **可并行:** 否

> **Review checkpoint B:** Task 11 后 dispatch `code-reviewer` 审一次整体(删除是否干净无残留 / 新 DOM 与纯函数契约对齐 / mobile 路径确实没被波及 / CSS 没误删 detail 共用段)。通过再 smoke + commit。

### Task 12: 整体 smoke + SW bump + commit
- **做什么:** bump `pwa/sw.js` `VERSION` `cc-v107` → `cc-v108`(改了 app.js / style.css 这两个 shell 文件,SW 必须 bump,见 CLAUDE.md §5)。跑全套 smoke。
- **测试(整体 smoke):**
  - `node --check pwa/app.js` → OK
  - `node --test tests/pwa-ui-contract.test.mjs` → 全绿(29 旧 + 新增纯函数 case)
  - `python3 -m py_compile backend/*.py backend/roundtable/*.py` → OK(确认后端零改动、无连带)
  - `grep -n "cc-v108" pwa/sw.js` → 确认已 bump
- **手动 smoke 清单(给用户,服务器 / 浏览器):** PC 进 `#workspaces` 看到侧边栏 + 1 pane → 点另一 repo 聚焦切换 → 拖 / `⇲` 开第二 pane → 关一个回单开 → `+ 新对话` 自动命名进 pane → 刷新恢复上次 panes → 深链 `#workspaces/<name>` → mobile(窄屏)carousel 一切如旧。
- **依赖:** Review checkpoint B 通过
- **预估:** ~4 min(bump 1 行 + 跑命令)
- **可并行:** 否

---

## 依赖图

```
Task 1 (reducer RED) → Task 2 (reducer GREEN) ┐
Task 3 (tree RED)    → Task 4 (tree GREEN)    ┘→ [Review A]
                                                    ↓
                                                 Task 5 (删墙)
                                                    ↓
                                                 Task 6 (pane 状态/持久化)
                                                    ↓
                                                 Task 7 (sidebar 渲染)
                                                    ↓
                                          ┌─ Task 8 (pane 渲染)
                                          ├─ Task 9 (交互事件)   [8/9/10 都挂 7]
                                          └─ Task 10 (深链路由)
                                                    ↓
                                                 Task 11 (CSS)
                                                    ↓
                                              [Review B]
                                                    ↓
                                                 Task 12 (smoke + SW bump + commit)
```

**可并行:** (Task 1+2) 跟 (Task 3+4) 两条纯函数线互不依赖,可并行。Task 8 / 9 / 10 都只依赖 Task 7,理论可并行,但都改同一个 `renderDesktopSidebarLayout` / 同一文件,串行做更稳(单用户单机,并行收益有限)。

## Review checkpoint 汇总

- **Review A**(Task 2 + 4 后):审 2 个纯函数 —— 地基,DOM 全靠它,签名定死收益最大。
- **Review B**(Task 11 后):审整体 —— 删除干净度 + DOM/契约对齐 + mobile 未被波及 + CSS 没误删共用段。

## 范围外(spec §7 已划走,本 plan 不含)

- session 重命名 / 改标题 —— fast-follow,独立 spec(要后端存 title,与布局正交)。
- pane > 2、可调分隔条、侧边栏折叠成图标条、移动端任何改动、旧墙 localStorage 迁移(YAGNI,spec §9)。
