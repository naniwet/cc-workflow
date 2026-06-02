# 阶段 3:Roundtable(评议)接入统一 desktop 侧栏 shell — Implementation Plan

**基于 spec:** docs/superpowers/specs/2026-06-02-pwa-unified-shell-program-design.md(重点 §160 + §4.2 / §107-108)

**前置(code-dev 动手前必读):**
- spec §160(Roundtable 接 shell 定义:不套 conversation renderer,保留网格)
- Settings 接 shell 的参考实现:`renderSettingsSidebarNav`(app.js ~5786)+ render() 接线块(app.js 1016-1024)+ style.css 的 `.settings-sidebar-nav` / `.settings-back-link` 规则
- 现状代码地图:`renderRoundtablesView`(4771)/ `_roundtableListRow`(4943)/ `renderRoundtableDetailView`(5098)/ `paintRoundtableDetail`(5149)/ `navModelFromTree`(ui_contract.mjs 512)

**范围约束(已拍板,不要越界):**
- 纯前端,**零后端改动**,不引第三方,if-else 够用不抽象
- 通用语言:UI 显示用「评议」,代码 identifier(`roundtable` / `/roundtables/*` / `renderRoundtable*`)**故意保留不改**
- Mobile(≤768px)行为**完全不变** —— 只动 desktop 分支,断点统一用 `window.matchMedia('(max-width: 768px)')`
- 不动 `renderMarkdown`(§133 markdown 扩展是另一独立项,不在本阶段)
- 不动 `paintRoundtableDetail` 的网格渲染逻辑(网格保留,继续渲进 #view)

---

## Task 列表

### Task 1: 纯函数 `navModelFromRoundtables` 失败测试(RED)
- **做什么:** 在 `tests/pwa-ui-contract.test.mjs` 加一组失败测试,import 还不存在的 `navModelFromRoundtables`(顶部 import 块加一行)。覆盖:
  1. 空列表 `[]` → `{ sections:[{ items:[] }] }`(items 为空数组)
  2. 多条 → 每条产出 `{ id, label, running }`,数量 / 顺序跟输入一致
  3. running 标记:`status` 为 `done` / `error` → `running:false`;其它(`queued` / 进行中如 `running` 或缺字段)→ `running:true`
  4. label 来源:从 `question` 取;过长截断(定一个上限,如 40 char + 省略号);`question` 缺失 → 回落 `(无标题)`
  5. `id` 直接取 `r.id`
- **测试(RED→GREEN):** 本 task 只写测试 + 跑一次确认**真失败**(import 报错 / 函数未定义)。`node --test tests/pwa-ui-contract.test.mjs` 应红。
- **依赖:** 无(地基 task)
- **预估:** ~4 min
- **可并行:** 否(Task 2 依赖它)

> 注:截断上限、`(无标题)` 文案、running 判定的 status 取值集合,先在测试里钉死成具体值(可逆,实现细节级),实现照测试来。

### Task 2: 实现 `navModelFromRoundtables`(GREEN + 重构)
- **做什么:** 在 `pwa/ui_contract.mjs` 紧挨 `navModelFromTree`(512)后面新增 `export function navModelFromRoundtables(roundtables)`。输入 `lastData.roundtables` 数组,输出 `NavModel = { sections:[{ items:[NavItem] }] }`,每个 item 至少 `{ id, label, running }`(可带 `data:{ rtId }` 供事件 / active 比对,但**不要带 `data.tileId`** —— 那会被 workspace handler 误绑)。label 截断 + `(无标题)` 回落 + running 判定按 Task 1 测试。NavItem.active 留给调用方填(纯函数不知道谁 active,同 `navModelFromTree` 纪律)。
- **测试(RED→GREEN):** `node --test tests/pwa-ui-contract.test.mjs` 全绿(原 82 个 + 新增用例)。绿后做最小重构(命名 / 复用 `navModelFromTree` 的截断思路如果有),重构后再跑一次确认仍绿。
- **依赖:** Task 1
- **预估:** ~4 min
- **可并行:** 否

---

> **review checkpoint A:** Task 2 后 dispatch code-review 审一次纯函数契约(NavItem 形状是否跟 spec §4.2 一致、running 语义、是否误带 tileId)。通过再进 Task 3。

---

### Task 3: `renderRoundtableSidebarNav(activeId)` —— sidebar 列表渲染函数
- **做什么:** 仿 `renderSettingsSidebarNav`(app.js 5786),新增 `renderRoundtableSidebarNav(activeId)`:
  - 顶部一个 toolbar:`+ 新建` 钮(`id="rt-sidebar-new-btn"`,触发现有 dialog,见 Task 5)+ `⚙ 角色配置` 链(`href="#settings/roles"`,沿用现有那条),摆位仿 Workspaces ctx 顶部 / Settings。
  - 列表:调 `navModelFromRoundtables(lastData.roundtables)`,对每个 item 渲一个 `<a class="shell-nav-item shell-nav-repo" href="#roundtables/<id>">`(**不带 data-tile-id**,纯 `<a href>` 靠 hashchange 跳转),`item.id === activeId` 加 `.is-active`,`item.running` 渲 running 点(复用 `_navRunningDot` 或 `.shell-nav-dot`),label 进 `.shell-nav-label`。
  - 整块填进 `#sidebar-ctx`(`ctx.innerHTML = ...`),仿 Settings 用一个容器 class(如 `.rt-sidebar-nav`,Task 7 加样式)。
  - 空列表:列表区显一句弱提示(如「还没有评议」),`+新建` 仍在。
  - 绑 `+ 新建` 钮的 click → 打开 dialog(dialog 由 Task 5 保证在 DOM 里;这里只 `dlg?.showModal()`)。
- **测试(RED→GREEN):** 无纯函数可测(DOM 渲染)→ `node --check pwa/app.js` 语法过。真实渲染走查留到 Task 8。
- **依赖:** Task 2(用 `navModelFromRoundtables`)
- **预估:** ~5 min
- **可并行:** 跟 Task 4 部分重叠(都改 app.js),建议串行避免冲突;逻辑上 Task 4 依赖本 task 的函数名

### Task 4: render() 接线 —— desktop 下两个 roundtable 路由填 sidebar
- **做什么:** 在 `render()`(app.js 1016-1024 Settings 块**后面**)加一个**并列的 if 块**,仿 Settings 模板:
  ```
  if (isDesktop && (route.name === 'roundtables' || route.name === 'roundtable-detail')) {
    const activeId = route.name === 'roundtable-detail' ? route.id : null;
    renderRoundtableSidebarNav(activeId);
  }
  ```
  （`isDesktop` 变量 1020 已算好,复用。）这样裸 `#roundtables` 和 `#roundtables/<id>` desktop 下都把评议列表填进 `#sidebar-ctx`,active = 当前 detail id（裸列表时无 active）。
- **测试(RED→GREEN):** `node --check pwa/app.js` 语法过。
- **依赖:** Task 3(调它的函数)
- **预估:** ~3 min
- **可并行:** 否(改 render() 同区域,跟 Task 3 串行)

### Task 5: desktop main 区 —— `renderRoundtablesView` 拆 desktop 空态 + 复用 dialog
- **做什么:** 改 `renderRoundtablesView`(4771)的开头,加 desktop 分支(`!window.matchMedia('(max-width: 768px)').matches`):
  - **desktop 分支:** #view 渲**空态提示**(复用现有 blurb 文案,提示「左侧选个评议 / + 新建」)+ **保留 `<dialog id="rt-new-dialog">` 整块**(连同表单 + `onCreateRoundtable` / `_onRtModeChange` / model config 的绑定逻辑全部保留),**不渲** #view 里的 `.ws-toolbar`(`+新建`/`⚙` 已搬去 sidebar,Task 3)和 `.rt-list`(列表已搬去 sidebar)。dialog 由 sidebar 的 `+新建` 钮触发(Task 3 已绑 `showModal`)。
  - **mobile 分支:** 完全走现有老逻辑(toolbar + `.rt-list` diff-patch + dialog 全进 #view + bottom-nav),**一字不改**。
  - **关键纪律(本阶段最 tricky 点):dialog 表单逻辑只实现一次。** desktop / mobile 共用同一段 dialog HTML + 同一套 submit / mode-picker / model-config 绑定代码,只是 desktop 不渲 list/toolbar、mobile 渲全套。**不要复制一份 dialog 表单到 sidebar。**
- **测试(RED→GREEN):** `node --check pwa/app.js` 语法过。
- **依赖:** Task 3(sidebar 的 `+新建` 钮要能找到 `#rt-new-dialog` 并 `showModal` —— 所以 dialog 必须在 desktop 下也进了 DOM,这是本 task 保证的)
- **预估:** ~5 min（接近上限,若发现要动 5+ 处再拆)
- **可并行:** 否

> **dialog 摆放决策(plan 锁死,code-dev 照此做):** desktop 下 `+新建` 钮在 sidebar,但 `<dialog id="rt-new-dialog">` 仍渲在 desktop 空态的 #view 里(原生 dialog 是 top-layer 浮层,位置无所谓)。sidebar 的钮 `getElementById('rt-new-dialog')?.showModal()` 即可打开。**禁止**在 sidebar 重新实现表单。

### Task 6: detail 页内返回链 desktop 隐藏 + active 联动 sigskip 确认
- **做什么:** 两小步:
  1. `paintRoundtableDetail` / `renderRoundtableDetailView` 顶部的 `<a href="#roundtables" class="back-link">← Roundtable</a>`(5109 等处)加一个 class（如 `rt-back-link`,仿 `settings-back-link`),desktop 下由 CSS 隐藏(Task 7),mobile 仍显。**不删** back-link(mobile 要用)。
  2. 确认 detail 渲染的 sigskip(`_lastRtPainted`)与新 sidebar 不冲突:detail 重绘走 #view 的 `paintRoundtableDetail`,sidebar 重渲走 render() → `renderRoundtableSidebarNav`(每次 refreshAll 整块重渲)。本 task 只确认/微调,不移植 `_rtRowCache` diff-patch 到 sidebar（spec 决策 5:sidebar 列表小,整块重渲即可）。
- **测试(RED→GREEN):** `node --check pwa/app.js` 语法过。
- **依赖:** Task 4(active 接线已就绪才好对照)
- **预估:** ~3 min
- **可并行:** 跟 Task 7 可并行(一个改 JS class hook,一个写 CSS),但 Task 7 依赖本 task 定下的 class 名 → 建议先 Task 6 定名再 Task 7

### Task 7: CSS —— sidebar 列表容器 + 收起态隐藏 + back-link desktop 隐
- **做什么:** 在 `pwa/style.css` 仿 `.settings-sidebar-nav` 区块加:
  - `.rt-sidebar-nav`(flex column,gap 2px,复用 `.shell-nav-item` 视觉;含顶部 toolbar 的间距)
  - `.sidebar.is-rail .rt-sidebar-nav { display:none }`（收起 rail 态隐列表,仿 settings）
  - `@media (min-width:769px){ .rt-back-link{ display:none } }`（desktop 隐页内返回链,仿 `.settings-back-link`)
  - running 点若复用现有 `.shell-nav-dot` 则无需新样式;sidebar `+新建`/`⚙` toolbar 复用现有 `.ws-toolbar` / `.ws-new-btn` 视觉或加最小补丁
- **测试(RED→GREEN):** CSS 无语法检查工具 → 靠 Task 8 真实渲染走查。改动只追加,不动现有 `.settings-*` / `.shell-nav-*` 规则。
- **依赖:** Task 3(`.rt-sidebar-nav` 容器名)+ Task 6(`.rt-back-link` class 名)
- **预估:** ~3 min
- **可并行:** 跟 Task 6 弱并行(见 Task 6 备注)

---

> **review checkpoint B:** Task 7 后 dispatch code-review 审接线(render() 块是否漏路由 / mobile 分支是否真没动 / dialog 是否只实现一次 / 误绑 tileId 排查 / 收起态与 ctx 清空时序)。通过再进 Task 8。

---

### Task 8: 整体 smoke + 交接主会话真实渲染验收
- **做什么:**
  1. `node --check pwa/app.js`(语法)
  2. `node --test tests/pwa-ui-contract.test.mjs`(全绿,含新增 `navModelFromRoundtables` 用例)
  3. `python3 -m py_compile backend/*.py backend/roundtable/*.py`(兜底确认零后端误改)
  4. 自检 diff:每一行改动可追溯到本阶段需求;无遗留 `console.log` / 孤儿 import
  5. 列出交接给主会话的 render harness 走查清单(desktop 900px + mobile 390px):
     - 裸 `#roundtables` desktop:#view 显空态 + sidebar 显评议列表 + `+新建`/`⚙`
     - 点 sidebar 列表项 → 进 detail,#view 是 round×role 网格,sidebar 该项 `.is-active`
     - sidebar `+新建` → 弹 `#rt-new-dialog`,表单可提交(submit / mode 切换 / model config 都在)
     - running 评议在 sidebar 有 running 点;一次 refreshAll(轮询)后 sidebar 整块重渲不闪、点击不失效
     - `#roundtables` ↔ `#workspaces` 来回切:ctx 无残留(repo 树 / 评议列表互不串)、不卡在 workspaces 收起态
     - 收起态(`.sidebar.is-rail`):评议列表消失
     - mobile 390px:`#roundtables` 还是老样子(list + dialog 进 #view + bottom-nav),detail 页内 `← Roundtable` 返回链仍在
- **测试(RED→GREEN):** 上述 1-3 全过即「绿」;4-5 是交接清单,真实渲染由主会话执行。
- **依赖:** Task 1-7 全部
- **预估:** ~4 min
- **可并行:** 否(最后一个)

---

## 依赖图

```
Task 1 (RED 测试) → Task 2 (实现纯函数) → [review A]
                                            ↓
                    Task 3 (sidebar 渲染函数)
                                            ↓
                    Task 4 (render() 接线)
                                            ↓
                    Task 5 (main 空态 + dialog 复用)
                                            ↓
                    Task 6 (back-link class + sigskip 确认)
                                            ↓
                    Task 7 (CSS)  ←(Task 6/7 弱并行)
                                            ↓
                                        [review B]
                                            ↓
                    Task 8 (整体 smoke + 交接)
```

基本是一条线(单文件 app.js 改动多,并行收益低、冲突风险高 → 建议串行)。唯一弱并行:Task 6(JS class hook)与 Task 7(CSS),但 Task 7 依赖 Task 6 定下的 class 名,实操仍建议先 6 后 7。

## 整体 smoke(Task 8 即此)
- `node --check pwa/app.js`
- `node --test tests/pwa-ui-contract.test.mjs`(全绿)
- `python3 -m py_compile backend/*.py backend/roundtable/*.py`(零后端改动兜底)
- 主会话 render harness 走查(清单见 Task 8)
