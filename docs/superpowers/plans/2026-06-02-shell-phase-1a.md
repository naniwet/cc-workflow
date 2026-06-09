# PWA 统一 Shell — 阶段 1a 实施 Plan

**基于 spec:** `docs/superpowers/specs/2026-06-02-pwa-unified-shell-program-design.md`(已审批,§2 术语 / §4 组件契约 / §5 阶段 1)

**阶段 1a 范围:** 公共组件首批(shell + nav-model)+ Workspaces 接入 + 去卡片视觉 + composer + 移动端走 shell drawer。
**不在 1a(阶段 1b,本 plan 不拆):** coding 报文流(`formatToolUse` / `renderEditDiff` / `pairToolEvents` / tool block 配对)、markdown 补表格(`renderMarkdown`)。**`_renderTurnEvent` / `_workspaceTurnHtml` 内部逻辑 1a 不改**(只改它们外层的卡片视觉)。

---

## 重要前提:1a 是"重构 baf81ea"不是"从头写"

`baf81ea`(2026-06-01 PC sidebar 布局)已上线,现状已有:

- `renderDesktopSidebarLayout()`(app.js:1029)= 已经是"左 sidebar + 右 pane 网格",但**布局 chrome 跟 Workspaces 业务揉在一起**(`.pc-sidebar-layout` / `.pc-sidebar` / `.pc-main` 直接写在这个函数里)。
- `_pcSidebarHtml(tree)`(app.js:1126)= 已经按两级树渲染 sidebar,有 active 高亮(`.is-open` / `.is-active`)、塌缩三角、+新对话、hover ⇲。**但没有 rail 收起态、没有移动端 drawer**(spec 这次要补)。
- `_pcMainHtml(groups)`(app.js:1191)= pane 网格(1/2/3/4 布局阶梯靠 `.pc-main[data-pane-count]` CSS 切)。
- `paneStateReducer` / `MAX_PANES` / `_prunePanes`(ui_contract.mjs)= **纯函数已就绪**,有单测。
- `buildSidebarTree(groups)`(ui_contract.mjs:407)= 已存在,**但签名吃 `groups`(= `groupBySession` 输出),不是 spec §4.2 写的 `workspaces/sessions`;且没有 `running` 派生字段**。

→ 1a 的本质:把"布局 chrome"从 Workspaces 里**抽成通用 `renderShell`**(加 rail 收起 + drawer),把"sidebar 树渲染"按 **NavModel 契约**重构(`navModelFromTree` 适配 + nav 组件渲染 full/rail 两态),Workspaces 改成"喂 nav + main 给 shell",再叠去卡片 CSS + composer。**pane reducer / 路由 / `workspaceColHtml` / `groupBySession` 等保留复用。**

---

## 绝不能动清单(改动越线 = 返工 / 串台 / 数据丢失)

> code-dev 动手前先读这张表。下列是"重构时被包起来 / 被调用,但内部逻辑不许改"的东西。

| 资产 | 位置 | 为什么不能动 |
|---|---|---|
| `paneStateReducer` / `MAX_PANES` | ui_contract.mjs:310,325 | 已有单测、是 pane 主区状态真相源;shell 状态是**另一个正交状态**,别混进去 |
| `_prunePanes` | ui_contract.mjs:441 | pane 失效清洗,有单测 |
| pane 布局阶梯(1/2/3/4) | `.pc-main[data-pane-count]` CSS + `_pcMainHtml` 的 grid | spec §5 明列"保持不变";只是被 shell 的 main 区包起来 |
| `dispatchPane` / `loadPcLayout` / `savePcLayout` / `cc.pcLayout` | app.js:868,831,860 | pane 持久化链路;shell 的 `cc.shell.<tab>` 是**新的独立 key**,不复用这个 |
| 深链路由 `#workspaces/<name>` / `_focusWorkspaceDeepLink` | app.js:3094,3116 | spec §5 明列"深链保持不变" |
| `groupBySession` / `tileKeyFor` / `sessionTileId` / `parseSessionTileId` | app.js:2610 / ui_contract.mjs | 归桶真相源,有单测,五分支边界踩过坑(2026-05-31) |
| `workspaceColHtml` 的 turn 渲染主体 + `_workspaceTurnHtml` / `_renderTurnEvent` | app.js:2674,3309 | **event 渲染逻辑是 1b**;1a 只动它外层卡片视觉(CSS),不动函数体逻辑 |
| `bindWorkspaceColHandlers` | app.js:1682 | pane 内 trigger/approve/attach/turn 交互全靠它;composer 重构后仍由它绑 |
| `_pendingUploads` 附件链路 | app.js:623 | composer 的 📎 复用它,不重写上传链 |
| slash 自动补全(`_SLASH_TRIGGER_RE` 等) | app.js:1417 | composer 的 `/` 复用现成 slash,功能已有 |
| run cancel(`POST /runs/{id}/cancel` + `.run-cancel-btn` 委托) | app.js:2182 | composer 的 Run↔Stop **复用这个**,不写新后端、不写新 handler |
| `.ws-col` 本体 + `.ws-col-detail` | style.css | detail + mobile + pane 三处共用;去卡片只去**视觉三件套**(border/shadow/radius/surface),不删元素 |
| `renderMarkdown` | app.js:55 | 补表格是 **1b**,1a 不碰 |

---

## Task 列表

> 三段 review checkpoint(spec 硬约束 6):**A=纯函数地基** / **B=shell+nav DOM** / **C=去卡片+composer+移动端**。

### ── 第一段:纯函数地基(进 ui_contract.mjs + TDD)──

### Task 1: `buildSidebarTree` 加 `running` 派生 — 写失败测试(RED)
- **做什么:** 在 `tests/pwa-ui-contract.test.mjs` 给 `buildSidebarTree` 现有测试块**补 case**:每个 tree node + 每个 session child 多一个 `running` 布尔字段 —— node 的 `running` = 该 ws 任一 session 有 active run(`groups[tileId].active.length > 0`);session child 的 `running` = 该 child 的 `groups[tileId].active.length > 0`。覆盖:① 全无 active → 全 `running:false`;② 某 session 有 active run → 该 session child `running:true` 且其 repo node `running:true`;③ 默认 tile 有 active、用户 session 无 → repo `running:true`、用户 child `running:false`。
- **测试(RED):** `node --test tests/pwa-ui-contract.test.mjs` → 新断言全红(现实现无 `running` 字段)。先确认真红。
- **依赖:** 无
- **预估:** ~4 min
- **可并行:** 跟 Task 3(shell 状态测试)无依赖,可并行

### Task 2: `buildSidebarTree` 加 `running` 派生 — 实现(GREEN)
- **做什么:** 在 `pwa/ui_contract.mjs:407 buildSidebarTree` 的输出每个 node + 每个 session 加 `running` 字段(从 `groups[tileId].active` 派生)。**纯函数,只读传入的 `groups`,不引 IO**。保持现有签名 `buildSidebarTree(groups)` 不变(spec §4.2 文字写的是 workspaces/sessions,但现状已经吃 groups 且有单测 — 拆解判断:保留现状签名,适配工作交给 Task 4 的 `navModelFromTree`;见文末"要你拍板"P1)。
- **测试(GREEN):** Task 1 全绿;`node --test` 通过(56 旧 + 新)。
- **依赖:** Task 1
- **预估:** ~4 min
- **可并行:** 否

### Task 3: shell 状态纯函数 — 写失败测试(RED)
- **做什么:** 在 `tests/pwa-ui-contract.test.mjs` import 加 `loadShellState` / `saveShellStateValue`(命名最终由 Task 4 定,这里先按契约写)。按 spec §4.2 shell 状态契约写单测:
  - `loadShellState(raw)`(纯函数,吃 localStorage 已读出的字符串/对象,**不碰 localStorage 本身**)→ `{collapsed:bool}`。case:① `null` / 坏 JSON / 非对象 → `{collapsed:false}`(默认);② `{collapsed:true}` → 原样;③ `{collapsed:"yes"}` 等非 bool → 归一成 `false`(坏数据回 false,spec 明示)。
  - 不变量:返回值永远是 `{collapsed:bool}`,`collapsed` 只可能是 `true`/`false`。
- **测试(RED):** `node --test` → 函数未导出,该块全红。确认真红。
- **依赖:** 无
- **可并行:** 跟 Task 1/2 无依赖,可并行
- **预估:** ~4 min

### Task 4: shell 状态纯函数 + `navModelFromTree` — 实现(GREEN)
- **做什么:** 在 `pwa/ui_contract.mjs` 加两组纯函数(0 IO):
  - **shell 状态校验:** `loadShellState(raw)` → `{collapsed:bool}`(坏数据回 `{collapsed:false}`)。localStorage 的实际读写(key `cc.shell.<tab>`)归 app.js,**不进纯函数**(跟 `cc.pcLayout` 同纪律)。
  - **`navModelFromTree(tree)`:** 把 `buildSidebarTree` 输出的 tree 适配成 spec §4.2 `NavModel`:
    - `newAction = { label:'+ 新建 workspace', data:{} }`
    - `sections = [{ items: tree.map(node → NavItem) }]`
    - 每个 repo node → `NavItem{ id:tileId, label:ws, running, active(由调用方填,这里先不填或留 undefined), data:{tileId}, children:expandable?node.sessions.map(s→NavItem):undefined }`
    - session child → `NavItem{ id:s.tileId, label:(s.sessionKey===pwa-ws?'默认':s.label), running:s.running, data:{tileId:s.tileId} }`
    - `badge`(rail 角标)= repo node 的 `sessionCount`(>1 时),`icon` 不填(让 nav 组件取 label 首字 1-2 char,spec §4.2)
  - **`navModelFromTree` 写对应单测(同一 task 内 RED→GREEN 一起做,因为它纯、且形状直接由 tree 决定):** ① 单 session repo → 平铺 item 无 children;② 多 session repo → item 带 children + badge=sessionCount;③ running 透传;④ newAction 形状。
- **测试(GREEN):** Task 3 的 shell 状态测试 + `navModelFromTree` 新测试全绿;`node --test` 通过。
- **依赖:** Task 3(shell 测试),Task 2(`navModelFromTree` 吃带 `running` 的 tree)
- **预估:** ~5 min
- **可并行:** 否

> **Review checkpoint A(Task 2+4 后):** dispatch `code-reviewer` 审纯函数地基 —— ① `buildSidebarTree.running` 派生跟 `groupBySession` 的 active 语义一致;② `NavModel` 形状严格对齐 spec §4.2 契约(id/label/icon/badge/active/running/data/children);③ shell 状态校验坏数据回 false。**这是 nav 组件 + 全 4 tab 的契约地基(spec §3.2 几乎不可逆,80% 心思),钉死收益最大。** 通过再进 DOM。

### ── 第二段:shell + nav 组件 DOM(app.js + CSS)──

### Task 5: `renderShell({tab, nav, main})` — 通用容器(PC 展开态)
- **做什么:** 在 `pwa/app.js` 新增 `renderShell({tab, navFull, navRail, mainHtml, collapsed})`,产出 spec §4.2 的布局 HTML:`shell` 容器 = `shell-nav`(左)+ `shell-main`(右)。PC 展开态:`shell-nav` 放 `navFull`、`shell-main` 放 `mainHtml`。顶部 chrome 占位:`«` 收起按钮(`data-shell-collapse`)+ 移动端 `☰`(`data-shell-drawer`,先放着,Task 8 接 drawer)。**先只渲染展开态**(rail/drawer 下两个 task)。class 名清单交接 CSS(Task 11):`.shell` / `.shell-nav` / `.shell-main` / `.shell-collapse-btn` / `.shell-drawer-btn`。
- **测试(GREEN):** `node --check pwa/app.js` 通过。(DOM 走手动 smoke。)
- **依赖:** Review checkpoint A 通过(纯函数定稿)
- **预估:** ~5 min
- **可并行:** 否

### Task 6: nav 组件 `renderNav(navModel, {activeId})` — full 态(取代 `_pcSidebarHtml`)
- **做什么:** 在 `pwa/app.js` 新增 `renderNavFull(navModel, activeIds, activeId)` —— 按 `NavModel` 渲染 **full 态** HTML,**承接现有 `_pcSidebarHtml` 的全部行为**(active `.is-active` / open `.is-open` / 塌缩三角 / +新对话 / hover ⇲ / running 点),只是数据源从 `tree` 换成 `NavModel`、`newAction` 渲染顶部"+新建 workspace"。**复用现有 class 名**(`.pc-sidebar-item` 等)或在 Task 11 统一改名 —— 拆解倾向:**先沿用现有 class 跑通,Task 11 再统一到 shell 命名**(降低单 task 改动面)。running 渲染成青色脉冲点(spec §4.2,CSS 在 Task 11)。
- **测试(GREEN):** `node --check pwa/app.js` 通过。
- **依赖:** Task 4(`navModelFromTree` + NavModel)、Task 5(shell 容器)
- **预估:** ~5 min
- **可并行:** 否

### Task 7: nav 组件 rail 态 + PC 收起切换(`«`→52px / `»`)
- **做什么:**
  - 在 `pwa/app.js` 新增 `renderNavRail(navModel, activeId)` —— 渲染 **rail 收起态**(52px 图标条,spec §2/§4.2):每个 repo 顶层 item 显示 `icon`(无则 label 首字 1-2 char)+ rail 角标(`badge`)+ running 点 + active 高亮;`»` 展开按钮。children **不在 rail 展开**(rail 只到顶层)。
  - shell 收起接线:`«` 点击 → 翻转 `cc.shell.workspaces` 的 `collapsed` → 重渲染 shell(collapsed 时 `renderShell` 用 navRail,否则 navFull)。新增 app.js 侧 `loadShellCollapsed(tab)` / `saveShellCollapsed(tab, bool)`(包 try/catch,读写 `cc.shell.<tab>`,内部调纯函数 `loadShellState` 校验)。
  - `renderShell` 增加 collapsed 分支:collapsed → `shell-nav` 加 `.is-rail` 放 navRail;展开 → navFull。
- **测试(GREEN):** `node --check pwa/app.js` 通过;若把"localStorage 读出后归一"那一步走纯函数 `loadShellState`,它已在 Task 3/4 测过。
- **依赖:** Task 6
- **预估:** ~5 min
- **可并行:** 否

### Task 8: 移动端 drawer(`☰` → 覆盖层 + backdrop)
- **做什么:** 在 `pwa/app.js` 给 shell 接移动端 drawer(spec §2/§4.2):
  - `drawerOpen` 运行时态(模块级 `let`,**不持久化**,spec §4.2)。
  - `☰`(`data-shell-drawer`)点击 → `drawerOpen=true` → shell-nav 以覆盖层滑出(navFull)+ `.shell-backdrop` 遮罩;点 backdrop / 选中一项 → `drawerOpen=false` 收起。
  - 移动端**无 collapsed 概念**(spec §4.2)→ 移动端只走 navFull(drawer 里)。
  - shell 渲染:`renderShell` 加 `drawerOpen` 参数,移动端时 main 全宽 + `☰` 可见;PC 时 `☰` 隐藏(CSS media query,Task 11)。
- **测试(GREEN):** `node --check pwa/app.js` 通过。(drawer 动画 / backdrop 走手动真机 smoke。)
- **依赖:** Task 7
- **预估:** ~5 min
- **可并行:** 否

### Task 9: Workspaces 接入 shell —`renderDesktopSidebarLayout` 重构成"喂 nav+main 给 shell"
- **做什么:** 重构 `pwa/app.js:1029 renderDesktopSidebarLayout`:
  - 不再自己写 `.pc-sidebar-layout` 布局 HTML,改成:`const navModel = navModelFromTree(_pcSidebarTree()); navModel.sections[..].items` 填 active(从 `paneState`);`const main = _pcMainHtml(groups)`;`renderShell({ tab:'workspaces', navFull:renderNavFull(navModel, ...), navRail:renderNavRail(navModel, ...), mainHtml:main, collapsed:loadShellCollapsed('workspaces'), drawerOpen })`。
  - active 计算:`activeId = paneState.panes[paneState.activePaneIdx]`(tileId),`activeIds = new Set(paneState.panes)`(供 `.is-open`)。
  - **退掉 baf81ea 时 Workspaces 自己规划的收起** —— 收起/drawer 现在由 shell 提供(spec §5)。删 `renderDesktopSidebarLayout` 里内联的旧布局 chrome,但**保留**:new-ws `<dialog>` 绑定、`bindOverviewHandlers()` 调用、`bindWorkspaceColHandlers(主区)` 调用。
  - `_pcMainHtml` / `_pcSidebarTree` / `dispatchPane` / 深链 **不动**(只是被 shell 包起来)。
  - `bindOverviewHandlers`(app.js:1935)的事件委托选择器若依赖被改的 class,同步对齐(focus/openBeside/close/toggle-repo/new-chat 的 data 钩子保持)。
- **测试(GREEN):** `node --check pwa/app.js` 通过(无未定义引用、无孤儿 `_pcSidebarHtml` 调用残留 —— 旧 `_pcSidebarHtml` 被 `renderNavFull` 取代,确认删干净或保留为内部 helper)。
- **依赖:** Task 8
- **预估:** ~5 min
- **可并行:** 否

> **Review checkpoint B(Task 9 后):** dispatch `code-reviewer` 审 shell+nav DOM —— ① `renderShell` 不碰业务数据(spec §4.2 职责边界);② nav full/rail/drawer 三态都对、active/running 正确;③ Workspaces 接入后 pane 阶梯/reducer/深链确实没动;④ 旧 `_pcSidebarHtml` 残留清干净。通过再进去卡片+composer+移动端。

### ── 第三段:去卡片 + composer + 移动端退役 ──

### Task 10: pane 去卡片 + turn 去卡片(纯 CSS)
- **做什么:** 在 `pwa/style.css`(spec §4.1 去卡片规则):
  - `.pc-pane .ws-col`(pane 内):去 border / box-shadow / border-radius / surface 底色三件套;层级靠间距 + 极弱 hairline。
  - `.turn`:去框;展开态留**极弱左色条**(单一 hairline,彩色仅状态用);收紧 turn 间距。
  - user prompt:弱气泡(轻 surface,**不叠阴影**,spec §4.1)。
  - **沿用现有 event 渲染** —— 不改 `_renderTurnEvent` / `_workspaceTurnHtml` 逻辑(那是 1b)。只动选择器的视觉属性。
  - **保留 `.ws-col` 本体 + `.ws-col-detail`**(detail+mobile+pane 共用,绝不能动清单)。
- **测试(GREEN):** 无自动化(CSS)→ 手动浏览器 smoke。触发 Task 13 SW bump。
- **依赖:** Task 9(class 名对齐后再写视觉)
- **预估:** ~5 min
- **可并行:** 跟 Task 11(composer)理论可并行(都改 CSS/不同区块),但同改 style.css,串行更稳

### Task 11: composer 重构(`.trigger-form` → composer)
- **做什么:** 重构 `workspaceColHtml` 里的 `.trigger-form`(app.js:2843)+ mobile 的 `.trigger-form.workspace-input`(app.js:3296)成 composer(spec §4.4):
  - 圆角容器 + 聚焦蓝光;`<textarea>` 自增高(JS:input 时按 scrollHeight 调,或 CSS `field-sizing` 兜底 — 拆解倾向 JS 自增,兼容性稳)。
  - 底部工具栏:📎(复用现有 `.attach-btn` + `_pendingUploads`)/ `/` slash 触发(复用现有 slash)/ model chip(只读,从 `wsSettings[ws].provider` 取)/ ⌘↵ 提示 / **Run↔Stop**。
  - **Run↔Stop:** 跑动时(该 tile 有 active run)Run 按钮变 Stop,Stop 复用 `.run-cancel-btn` 逻辑(`data-run-id` = 当前 active run id)→ 走现成 `POST /runs/{id}/cancel` 委托(app.js:2182,**不写新 handler/后端**)。非跑动 = Run 提交(现有 `onTriggerSubmit`)。
  - 附件 chips 在容器内顶部(沿用现有 `.attach-chips`)。
  - **复用 `bindWorkspaceColHandlers`** 绑事件,不另起 binder。
  - composer CSS(圆角/聚焦光/工具栏布局)写进 style.css。
- **测试(GREEN):** `node --check pwa/app.js` 通过;textarea 自增 / Run↔Stop 切换走手动 smoke。
- **依赖:** Task 9(在新 shell 布局里)。CSS 跟 Task 10 同文件,建议串行。
- **预估:** ~5 min
- **可并行:** 跟 Task 10 同 style.css,串行更稳

### Task 12: Workspaces 移动端 = shell drawer(退役 overview 卡片 + carousel 残留)
- **做什么:**
  - `renderWorkspacesView`(app.js:1014)移动端分支:从 `renderMobileOverview()`(卡片列表)改成走 **shell drawer**(spec §5/§7-7)—— 移动端进 `#workspaces` 直接进对话流(默认聚焦第一个 ws),导航走 `☰` drawer(Task 8 的 shell drawer)。
  - **退役谨慎(spec 硬约束 5):** 先核查 `renderMobileOverview` / `_mobileWsCardHtml` / `_mobileCardCache` 的依赖边界 —— 它们只被移动端 overview 用?carousel 在 2026-05-15 已退役改箭头(代码注释 app.js:803),`renderMobileWorkspaceDetail` 用的是 `[‹] name [›]` arrow bar(app.js:3090),**不是 swipe carousel**。确认:退役 overview 卡片不影响 `renderMobileWorkspaceDetail`(它走 `groupByWorkspace` + `_workspaceSessionDetailHtml`,独立)。
  - 移动端内部对话流**复用同一渲染**(`workspaceColHtml` / `_workspaceTurnHtml`,spec §7-7"内部对话流复用同一渲染")。
  - 退役范围:`renderMobileOverview` 卡片列表 + `_mobileWsCardHtml` + `_mobileCardCache` 若退役后无消费者 → 删(本次改动造成的孤儿,CLAUDE.md §4 外科手术);若 `renderMobileWorkspaceDetail` 还用到则**保留**。**删前在 review B/C 列出依赖核查结果。**
- **测试(GREEN):** `node --check pwa/app.js` 通过(无孤儿调用/未定义引用);移动端导航走 shell drawer **真机 smoke 列进 Task 13 手动清单**。
- **依赖:** Task 8(shell drawer)、Task 9(shell 接入)
- **预估:** ~5 min(主要是核查依赖 + 改分支)
- **可并行:** 否

> **Review checkpoint C(Task 12 后):** dispatch `code-reviewer` 审第三段 —— ① 去卡片没误删 `.ws-col` / detail 共用段、没叠阴影;② composer Run↔Stop 确实复用 cancel 委托没造新后端、📎/slash 复用现成;③ 移动端 overview/carousel 退役的依赖核查正确、孤儿删干净、`renderMobileWorkspaceDetail` 未被波及;④ `_renderTurnEvent` 逻辑确实没动(1a 边界)。通过再 smoke + commit。

### Task 13: 整体 smoke + SW bump + commit
- **做什么:** bump `pwa/sw.js` `VERSION` `cc-v109` → `cc-v110`(改了 app.js + style.css,SW 必须 bump,CLAUDE.md §5)。跑全套 smoke。
- **测试(整体 smoke):**
  - `node --check pwa/app.js` → OK
  - `node --check pwa/sw.js` → OK
  - `node --test tests/pwa-ui-contract.test.mjs` → 全绿(56 旧 + 新增:`buildSidebarTree.running` / `loadShellState` / `navModelFromTree`)
  - `python3 -m py_compile backend/*.py backend/roundtable/*.py` → OK(确认后端零改动)
  - `grep -n "cc-v110" pwa/sw.js` → 确认已 bump
- **手动 smoke 清单(给用户,浏览器 + 真机):**
  - **PC 展开:** 进 `#workspaces` 看到 shell(左 nav full + 右 pane)→ 点另一 repo/session 聚焦 → 拖/⇲ 开第二 pane → 关一个 → +新对话 → 刷新恢复。
  - **PC 收起:** 点 `«` → nav 收成 52px rail(图标+角标+running 点)→ 点 rail 项仍能聚焦 → `»` 展开 → 刷新后 collapsed 记忆(`cc.shell.workspaces`)。
  - **去卡片:** pane / turn 无框无阴影、展开 turn 有极弱左色条、user prompt 弱气泡。
  - **composer:** textarea 自增高、📎 加附件 chip、`/` 弹 slash、model chip 显示 provider、跑动时 Run→Stop 能取消、⌘↵ 发送。
  - **移动端(真机):** 进 `#workspaces` 直接进对话流 → `☰` 滑出 drawer 导航 → backdrop 点击收起 → 选 ws 切换 → 对话流渲染正常(退役 overview 卡片后无回归)。
- **依赖:** Review checkpoint C 通过
- **预估:** ~4 min
- **可并行:** 否

---

## 依赖图

```
Task 1 (tree.running RED) → Task 2 (tree.running GREEN) ┐
Task 3 (shell 状态 RED)   → Task 4 (shell状态+navModelFromTree GREEN) ┘→ [Review A]
                                                                          ↓
                                                            Task 5 (renderShell 展开态)
                                                                          ↓
                                                            Task 6 (nav full = 取代 _pcSidebarHtml)
                                                                          ↓
                                                            Task 7 (rail 态 + « 收起)
                                                                          ↓
                                                            Task 8 (移动端 drawer)
                                                                          ↓
                                                            Task 9 (Workspaces 接入 shell)
                                                                          ↓
                                                                     [Review B]
                                                                          ↓
                                                  ┌─ Task 10 (去卡片 CSS)
                                                  ├─ Task 11 (composer)        [10/11 同 style.css,串行]
                                                  └─ Task 12 (移动端退役 overview)  [挂 8+9]
                                                                          ↓
                                                                     [Review C]
                                                                          ↓
                                                            Task 13 (smoke + SW bump + commit)
```

**可并行:**
- (Task 1+2) 跟 (Task 3+4) 两条纯函数线互不依赖,可并行(注:Task 4 的 `navModelFromTree` 部分依赖 Task 2 的 `running`,所以 Task 4 要等 Task 2 完;但 Task 1+3 的 RED 可同时写)。
- Task 10/11/12 都挂 Review B 后,理论可并行,但 10/11 同改 style.css、12 改 app.js 同一渲染分发 → 单用户单机串行做更稳,并行收益有限。

## Review checkpoint 汇总

- **Review A**(Task 2+4 后):纯函数地基 —— NavModel 契约对齐 spec §4.2(几乎不可逆,80% 心思)、running 派生、shell 状态校验。
- **Review B**(Task 9 后):shell+nav DOM —— shell 职责边界、三态正确、Workspaces 接入未动 pane/路由、旧 `_pcSidebarHtml` 清干净。
- **Review C**(Task 12 后):去卡片没误删共用段、composer 复用 cancel/slash/upload、移动端退役依赖核查正确、1a 边界(`_renderTurnEvent` 没动)。

## 范围外(spec 已划走,本 plan 不含)

- coding 报文流:`formatToolUse` / `renderEditDiff` / `pairToolEvents` / tool block 配对 / `_renderTurnEvent` 重做 —— **阶段 1b**。
- `renderMarkdown` 补表格 —— **阶段 1b**。
- Settings / Roundtable / Tasks 接入 shell —— **阶段 2/3/4**。
- nav 的 `data?` 渲染成 `data-*` 给非 Workspaces tab 用 —— 真接时再验(spec §3 不预先为想象消费者抽象)。

---

## 拆解时浮现、要你拍板的点

**P1 — `buildSidebarTree` 签名:保留 `groups` 还是改成 spec §4.2 写的 `workspaces/sessions`?**
spec §4.2 文字写"buildSidebarTree 输出 → 映射成 NavModel",§7 测试列表写"`navModelFromTree`、`buildSidebarTree.running`"。现状 `buildSidebarTree(groups)` 已落地、有单测、吃 `groupBySession` 输出。
- **拆解倾向(已写进 plan):保留现状签名 `buildSidebarTree(groups)` + 只加 `running` 派生**,适配成 NavModel 的活交给新纯函数 `navModelFromTree(tree)`。理由:① 改签名要动 `_pcSidebarTree` / `loadPcLayout` / 深链多处调用点 + 重写单测,反悔成本高于收益;② spec §4.2 也明说"buildSidebarTree 本身保留,只是再加一层 navModelFromTree"。
- 若你要严格按 §4.2 字面改签名,告诉我,我把 Task 1/2 改成"重写签名 + 迁移调用点"(会多 1~2 个 task)。

**P2 — composer textarea 自增高:JS 算 scrollHeight 还是 CSS `field-sizing: content`?**
`field-sizing` 较新(2024+ Chromium),移动端 WebView / 国产 ROM 兼容性不稳(CLAUDE.md §7 提到国产 ROM 坑)。
- **拆解倾向(已写进 plan):JS 自增**(input 时 `el.style.height = el.scrollHeight`),兼容稳。若你接受"只在新浏览器自增、旧的退化成固定高",可用 CSS 一行省事 —— 你定。

**P3 — 移动端退役 `renderMobileOverview`:删函数还是留壳?**
核查显示 carousel 早在 2026-05-15 退役(现状是箭头 bar,不是 swipe),`renderMobileWorkspaceDetail` 独立不依赖 overview。`renderMobileOverview`/`_mobileWsCardHtml`/`_mobileCardCache` 退役后**预计无消费者**。
- **拆解倾向(已写进 plan):退役后无消费者 → 删(本次改动造成的孤儿)**,但**删除决定放到 Task 12 + Review C 核查后落实**,不在 plan 阶段拍死(CLAUDE.md §4:已有死代码不主动删,但本次改动让它变孤儿则可删)。若你想**先留壳保险、下个 PR 再删**,告诉我。

**P4 — nav 组件 class 命名:沿用 `.pc-sidebar-*` 还是改成 `.shell-nav-*`?**
现状 `_pcSidebarHtml` 用 `.pc-sidebar-item` 等。shell 是通用组件,理想是统一到 `.shell-nav-item`(4 tab 复用)。
- **拆解倾向(已写进 plan):Task 6 先沿用现有 class 跑通**(降低单 task 改动面 + 复用现成 CSS),**统一改名留到 Task 11 CSS / 或 1b**。理由:通用语言统一是几乎不可逆决策(CLAUDE.md §3.4),但 1a 只有 Workspaces 一个消费者,过早统一命名增加 1a 改动面;等阶段 2(Settings 接入)真要复用时一次性统一更稳。**若你认为命名应在 1a 就钉死(避免 4 tab 各带历史包袱),我把"nav class 统一到 shell 命名"提成独立 task。**
