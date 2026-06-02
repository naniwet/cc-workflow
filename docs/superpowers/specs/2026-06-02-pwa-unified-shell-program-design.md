# PWA 统一视觉系统 + App Shell — 程序级 Design

**Date:** 2026-06-02
**Status:** Drafted for user review
**Scope:** 把整个 PWA(4 个 tab:Workspaces / Settings / Roundtable / Tasks)统一到一套**视觉语言 + 可复用 app shell**。先做公共组件,再各页面接入。**只动前端;后端零改动(唯一复用现成 `runner.cancel`);移动端一并纳入(抽屉导航由 shell 统一提供)。**

> **本 spec supersede** `2026-06-02-pwa-visual-redesign-design.md`(那份 Workspaces-only 草稿的内容并入这里的阶段 1)。承接已上线的 `baf81ea`(Workspaces 侧边栏布局,MAX_PANES=4)——阶段 1 会把那部分**重构成公共组件**,不另起炉灶。

---

## 1. Motivation

1. **卡里套卡**:pane 卡 + turn 卡 + 输入卡三层叠加 → 松、重。
2. **不像 coding 工具**:工具调用 dump 原始 JSON、`tool_result` 裸 `<pre>`、默认全藏、回复不渲染 markdown。
3. **4 个 tab 各搞一套**:导航 / 列表 / 详情各自实现,视觉不统一,维护负担 4×。

**目标:** 一套设计语言 + 一个 `list-pane` shell(左 list/nav + 右 content,PC 可收起 / 移动端抽屉),4 个 tab 复用;对话流渲染成专业 coding 工具样。**4 个消费者已知** → 提前抽公共组件是有依据的(非"将来可能用")。

---

## 2. 通用语言(接口级,几乎不可逆——开局钉死)

| 术语 | 含义 |
|---|---|
| `shell` | 通用布局容器:`shell-nav`(左)+ `shell-main`(右)+ 收起/抽屉机制 |
| `nav-model` | 喂给 shell-nav 的数据结构(分组列表,见 §4.2) |
| `rail` | shell-nav 的**收起态**(PC 52px 图标条) |
| `drawer` | shell-nav 的**移动端态**(☰ 滑出的覆盖层) |
| `conversation` | 通用对话流渲染器(turn 流 + 报文 + composer) |
| `turn` / `event` | 对话单元 / 流式事件(沿用现有) |
| `tool block` | `tool_use`+配对 `tool_result` 渲染成的结构化动作块 |
| `composer` | 指令输入组件 |

不引入 chat/message/page/panel 等新主术语。

---

## 3. 程序结构

### 阶段 0 — 公共组件(先做,但**边做边被阶段 1 验证**,不空中楼阁)
| 组件 | 文件落点 | 纯逻辑(TDD)| DOM/CSS |
|---|---|---|---|
| 设计 token + 去卡片视觉 | `pwa/style.css :root` + 工具类 | — | CSS |
| `list-pane` shell | `app.js`(render+binder)+ `ui_contract.mjs`(状态纯函数) | shell 状态 reducer / 持久化校验 | 布局/收起/抽屉 CSS+JS |
| `conversation` renderer | `app.js` + `ui_contract.mjs` | `formatToolUse`/`renderEditDiff`/`pairToolEvents` | turn/event/composer CSS |
| `sidebar/list`(渲染 nav-model) | `app.js` + `ui_contract.mjs` | `navModelFrom*` 派生 | 树/rail CSS |

### 阶段 1-4 — 页面接入(每个独立 ship)
1. **Workspaces**(第一个真实消费者,边接边验证组件)— 重构现有 `baf81ea` 代码用公共组件 + P1 去卡片 + P2 coding 报文流。
2. **Settings** — shell + sections nav + 现有表单 pane。
3. **Roundtable** — shell + 评议列表 nav + transcript(复用 conversation 渲染角色发言 + markdown)。
4. **Tasks** — shell + loop 列表 nav + loop 详情。

### 排期原则
- 公共组件**先被 Workspaces(最复杂场景)用上验证,接口契约定稳**,再铺 Settings/Roundtable/Tasks。
- 接口边界 = §3.2 几乎不可逆 → 多花心思、多 review;实现细节大胆改。
- 纯逻辑进 `ui_contract.mjs` + TDD;DOM/CSS 手动 smoke。
- 每个页面接入是独立 phase,绿一个 ship 一个。
- **不预先加配置项 / 不为想象消费者抽象**;Roundtable/Tasks 真要用时若发现契约不够,再扩(并回写 spec)。

---

## 4. 公共组件接口契约(最关键,本 spec 核心)

### 4.1 设计 token / 去卡片视觉
- 沿用现有 `:root`(`--space-*`/`--radius-*`/`--bg-*`/`--border-*`/`--text-*`/`--accent-*`)。
- **去卡片规则**:content pane / turn / 列表项**不用 border+shadow+radius 三件套**;层级靠 ① 间距 ② 极弱 surface 底色(仅在需要分隔多块时)③ 单一 hairline。彩色仅用于状态(running/done/error)与 active。
- composer / 弱气泡等可保留轻 surface,但不叠阴影。

### 4.2 `list-pane` shell + `nav-model`
**shell 职责**:布局 + 收起/抽屉机制 + chrome(« / » / ☰ / backdrop)。**不碰业务数据**。

**渲染契约**:
```
renderShell({ tab, nav, main }) →
  PC 展开: [shell-nav(nav.full) | shell-main(main)]
  PC 收起: [rail(nav.rail) | shell-main(main)]   // 52px
  移动端:  [shell-main(main)] + ☰;点 ☰ → drawer(nav.full) 覆盖
```
- `nav` = 由 `sidebar/list` 组件按 **nav-model** 渲染出的 `{ full, rail }` 两份 HTML。
- `main` = 该 tab 的内容 HTML(Workspaces=panes / Settings=表单 / …)。

**shell 状态**(纯函数 + 持久化):
```
shellState[tab] = { collapsed: bool }          // PC 收起,持久化 cc.shell.<tab>
drawerOpen: bool                                // 移动端运行时态,不持久化
```
- `collapsed` 默认 false;坏数据回 false。每 tab 独立记忆。
- 移动端无 `collapsed` 概念(只有 drawer 开合)。

**nav-model 契约**(喂给 §4.4 的列表组件):
```
NavItem = {
  id: string,                 // 唯一,active 比对用
  label: string,
  icon?: string,              // rail 态显示(无则取 label 首字 1-2 char)
  badge?: number,             // rail 角标(如多 session 数)
  active?: bool,
  running?: bool,             // 青色脉冲点
  data?: { [k]: string },     // 渲染成 data-* 供事件委托(如 data-tile-id)
  children?: NavItem[],       // 两级(workspaces▸sessions);Settings/Tasks 用平铺(无 children)
}
NavModel = { newAction?: {label,data}, sections: [{ label?, items: NavItem[] }] }
```
- Workspaces:`buildSidebarTree` 输出 → 映射成 NavModel(repo=item,session=children,running 来自 active run)。
- Settings:固定 sections(providers/roles/agents/workspaces),平铺 items。
- Roundtable:评议列表 → items(running=进行中的评议)。
- Tasks:loop 列表 → items。

> 这把现有 `buildSidebarTree` 的角色变成"产出 NavModel 的适配器之一"。`buildSidebarTree` 本身保留(Workspaces 专用派生),只是再加一层 `navModelFromTree`。

### 4.3 `conversation` renderer
**输入**:归一化 turn 流。**输出**:去卡片 turn 流 + tool block + markdown,(可选)composer。

**归一化 Turn/Event 契约**(Workspaces 与 Roundtable 都映射进来):
```
Turn = {
  id, role,                   // role: 'user'|'assistant'|'system'|<评议角色名>
  status?: 'running'|'done'|'error',
  events: Event[],            // 流式:见下
  meta?: { inTokens, outTokens, subtype, elapsed }
}
Event = { kind: 'text'|'thinking'|'tool_use'|'tool_result'|'result', ... }  // 沿用现有
```
- Workspaces:现有 run/turn/event 直接是这个形状(`_renderTurnEvent` 重做)。
- Roundtable:角色发言 → Turn{role=角色名, events:[{kind:'text', text}]}(无 tool 事件)。所以 conversation renderer 对"无 tool 的纯文本 turn"要优雅退化。

**纯函数(进 `ui_contract.mjs` + TDD)**:
- `formatToolUse(name, input)` → `{verb,target,glyph,kind}`(Bash/Edit/Write/Read/Grep/未知)。
- `renderEditDiff(oldStr, newStr)` → diff 行模型(MVP:全删旧+全增新两块,见 §9 Q)。
- `pairToolEvents(events)` → 把 `tool_use` 与紧跟的 `tool_result` 配成 block 列表。
- markdown:**vendor `marked.min.js`**(无 build step,`<script>` 引);渲染输出按不可信处理转义防 XSS。

**渲染规则**(§见 mockup):工具块默认紧凑(单行 call,diff/output 折叠)、`isError` 红且默认展开、assistant text 渲染 markdown、user prompt 弱气泡、一连串动作左侧 rail 串联。

### 4.4 `composer`
```
renderComposer({ placeholder, model, running, hasDraft }) + binder
```
- 圆角容器 + 聚焦蓝光;textarea 自增高;底部工具栏:📎 / `/`(slash,功能已有)/ model chip(只读)/ ⌘↵ 提示 / **Run↔Stop**。
- 跑动时 Run→Stop = 复用现成 `POST /runs/{id}/cancel` + `.run-cancel-btn` 逻辑(**不写新后端**)。
- 附件 chips 在容器内顶部(沿用 `_pendingUploads`)。

---

## 5. 阶段 1 — Workspaces 接入(第一个消费者 + 验证组件)

把已上线的 Workspaces 重构成"用公共组件实现",同时落 P1 去卡片 + P2 报文流:
- **shell**:`renderDesktopSidebarLayout` 拆成 `renderShell` + Workspaces 填 main(panes)。pane 布局阶梯(1/2/3/4,MAX_PANES)、reducer、深链**保持不变**(只是 main 区内容)。
- **nav**:`buildSidebarTree` → `navModelFromTree` → §4.4 列表组件。收起态 rail + 移动端抽屉**来自 shell**(Workspaces 不再自己写收起;之前 spec 的"侧边栏收起"由 shell 提供)。
- **conversation**:pane 内容用 conversation renderer;P1 先去卡片视觉,P2 上 tool block/diff/markdown。
- **composer**:pane 底部用 composer 组件。
- **移动端**:Workspaces 移动端导航 = shell 的 drawer(退役 overview 卡片 + carousel 箭头)。内部对话流 = 同一个 conversation renderer。

阶段 1 内部再分批:**1a 去卡片+composer+shell(收起/抽屉)** → **1b coding 报文流(tool block/diff/markdown)**。两批各自 review + ship。

## 6. 阶段 2-4(各自独立 plan,这里只勾勒映射)
- **Settings**(已核现状,确认契合,**Workspaces 之后第一个接**):现状是 `renderSettingsView` hub 卡片 + `renderSettingsSectionView` 子页 +"← Settings"返回链(钻入/返回)。改造 = `navModelFromSettings` 产出 3 个平铺 nav 项(Providers / Roles / Agents,无 children / running)→ shell-nav 常驻;各子页内容(`renderSettingsProvidersView`/`RolesView`/`AgentsView` 复用,**去掉 back-link 包壳**)填 shell-main;移动端走 shell 抽屉。是 UX 升级(标准"左 section 列表 + 右内容",切换不用退回 hub),且**没有 conversation / 多 pane / 拖拽** → 验证 shell 最纯粹布局 + 收起 + 抽屉 + 平铺 nav-model 的最低风险消费者。
- **Roundtable**:`navModelFromRoundtables`(评议列表)→ shell;transcript 用 conversation renderer(角色发言映射成 Turn)。验证 conversation 对"无 tool 纯文本 turn"退化。
- **Tasks**:`navModelFromLoops` → shell;loop 详情/历史填 main。

> 阶段 2-4 各自写 plan 前,先确认阶段 0 组件接口在该 tab 站得住;站不住就回头扩接口(并回写本 spec §4)。

---

## 7. 测试
- **纯函数 TDD**(`ui_contract.mjs` + `pwa-ui-contract.test.mjs`):shell 状态校验、`navModelFromTree`、`buildSidebarTree.running`、`formatToolUse`、`renderEditDiff`、`pairToolEvents`、`_prunePanes`(已有)。
- **DOM/CSS/收起动画/抽屉/拖拽**:`node --check` + 手动浏览器 smoke(PC + 真机移动端)。
- 后端 `py_compile` 兜底(零改动)。markdown vendor 库不写单测。

---

## 8. Trade-off / 反悔成本
| 决策 | 反悔成本 | 何时翻案 |
|---|---|---|
| 抽公共 shell/nav-model/conversation 接口 | **几乎不可逆**(组件契约)→ 80% 心思在这 | 接口设计前多 review;定后尽量不动 |
| 一次性程序级(4 tab)而非样板先行 | 痛但可行 | 用户已决策;靠"边做边验证 + 分阶段 ship"控风险 |
| nav-model 统一抽象 | 痛但可行 | 某 tab 套不进 → 扩 NavItem 字段(向前兼容) |
| markdown vendor marked | 痛但可行 | 想去依赖改手写 |
| diff MVP 全删全增 | 轻易可逆 | 需要精确再上行级 LCS |
| 移动端导航统一抽屉(退役 carousel) | 痛但可行 | git 留旧码可回滚 |

## 9. Open Questions(给倾向)
1. **diff 精度**:MVP 全删旧+全增新够看?倾向是,精确 diff 迭代。
2. **markdown**:vendor `marked.min.js`?倾向是。
3. **nav-model 抽象 vs 各 tab 各写 nav HTML**:抽 nav-model(shell 统一渲染 full+rail)是更大复用但更强抽象;退路是 shell 只给布局+收起机制、各 tab 自己给 navHtml/railHtml。倾向**抽 nav-model**(rail/角标/active 逻辑只写一遍),但这是最该 review 的接口——若觉得太重可降级成"各 tab 给 HTML"。
4. **阶段 0 与阶段 1 边界**:倾向**合并推进**(组件跟着 Workspaces 一起长出来),不先憋一个抽象的阶段 0 再用——避免空中楼阁。

## 10. Self-review
- ✅ 无 TBD;4 个 OQ 有倾向。
- ✅ 一致:§4 契约 ↔ §5/6 各 tab 映射 ↔ §7 测试对得上。
- ✅ 分解:程序拆 5 个可独立 plan 的 phase(组件随阶段 1 长出);符合"大项目分解"。
- ✅ 不可逆点(§2 术语、§4 接口)单列,标了"多 review"。
- ✅ 与 baf81ea 关系说清(重构非重写,布局阶梯/reducer/路由不动)。

## 11. 不做(YAGNI)
- 不预先造抽象阶段 0(组件随 Workspaces 长出)。
- 不做精确语法高亮、可调侧栏宽、pane 拖拽换位。
- 不把 conversation 用到 Workspaces/Roundtable 以外。
- 不为 Tasks/Settings 想象需求提前加 nav-model 字段。
- 后端不动(除复用 cancel)。
