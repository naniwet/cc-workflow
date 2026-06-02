# PWA PC 视觉重构 — 去卡片化 + coding 工具报文流 + 侧边栏收起 — Design

**Date:** 2026-06-02
**Status:** ⚠️ SUPERSEDED — 已升级为程序级 `2026-06-02-pwa-unified-shell-program-design.md`(本文档内容并入其阶段 1 = Workspaces 接入)。保留作历史草稿,以程序级 spec 为准。
**Scope:** PC Workspaces tab 的视觉 / 交互重构。**只动 PC 前端,后端零改动,移动端 carousel 不碰。** 分两阶段:
- **Phase 1(CSS + 小 JS,快速上)**:pane 去卡片(flat)、turn 去卡片、composer 重做、侧边栏完整样式 + **收起成 52px 图标条**。
- **Phase 2(JS 渲染,较大)**:coding 工具报文流 —— 工具调用按类型出结构化块(Edit→diff / Bash→命令+输出 / Read→单行)、`tool_use`+`tool_result` 配对、默认显示但紧凑、回复渲染 markdown。

承接已合并的侧边栏布局(commit `baf81ea`,MAX_PANES=4)。这次只换"皮"和报文渲染,不动 pane 布局阶梯 / reducer / 路由。

---

## 1. Motivation

用户实测后反馈两点:
1. **卡里套卡**:pane 是卡(`.ws-col`:border+shadow+radius+surface+padding),每个 turn 又是卡(`.turn`:border+radius+surface),输入又是卡(`.trigger-form` 带框盒子)。三层卡叠着 → 松、重、空。
2. **不像 coding 工具**:报文是"通用聊天"味 —— 工具调用 dump 原始 JSON(`Edit {"file_path":…}` 截 220 字)、`tool_result` 裸 `<pre>`、默认全藏;回复不渲染 markdown(表格显示成原始 `| 管道 |`)。参考 Claude Code / Codex / happier:工具调用应是结构化动作块 + diff,默认能看见 agent 在干嘛。
3. 侧边栏没法收起,4 pane 时主区被挤。

**目标:** PC 工作区看起来像个**专业 coding 工具**,而非聊天框;布局更紧凑(去多余卡片 chrome),侧边栏可收起腾空间。

---

## 2. 通用语言

沿用 + 新增(代码 / UI / 文档一致):

| 术语 | 含义 |
|---|---|
| `pane` | 主区一个聚焦的 session 视图(已有) |
| `sidebar` | 左侧导航栏(已有);新增**收起态 = rail(图标条)** |
| **`composer`**(新) | pane 底部的指令输入区(取代"trigger-form 盒子"叫法) |
| `turn` | 一次 run 在时间线里的一个单元(已有) |
| `event` | turn 内的流式事件:`user/reply/result/thinking/tool_use/tool_result`(已有) |
| **`tool block`**(新) | Phase 2 里一个 `tool_use`+配对 `tool_result` 渲染成的结构化动作块 |

不引入 chat/message/bubble 等新主术语(UI 文案口语可用"对话/报文",代码统一 turn/event)。

---

## 3. Phase 1 — 去卡片化 + composer + 侧边栏收起(CSS + 小 JS)

**本阶段只换皮 + 加收起,不改 event 渲染逻辑**(工具调用仍走现有 `_renderTurnEvent`,Phase 2 才重做)。

### 3.1 pane 去卡片(flat)

| 决策 | 选项 | 理由 |
|---|---|---|
| pane 容器 | `.pc-pane .ws-col` **去 chrome**:无 border / shadow / radius,背景透明(= canvas) | pane 不是卡,是内容区;消"卡里套卡"第一层 |
| 多 pane 分隔 | pane 之间靠 grid gap + **1px `--border-subtle` 细线**分隔,pane 本身无框 | 多开时分得清,但不靠卡片框 |
| 作用域 | 只 `.pc-pane` 内;`.ws-col-detail`(PC detail 已废)/ mobile `.ws-col` **不变** | 外科手术,不波及 mobile |
| 去整条状态左边框 | 去掉 pane 级整条彩色左 border | 状态色交给 turn 标签 / 顶部状态点 |

### 3.2 turn 去卡片(视觉,沿用现有 event 类型)

| 决策 | 选项 |
|---|---|
| `.turn` 容器 | 去 border / surface / radius;turn = 轻量块,靠间距 + 标签分隔 |
| 展开态焦点 | 保留**极弱左色条**(inset 2px,done=绿/error=红/running=青),不再整块框 |
| 收起态 | 单行截断(label + summary),点展开 |
| user prompt | 弱底气泡(右对齐 / 弱 `--bg-elevated`),跟 assistant 区分 |
| 间距 | 收紧 turn 间 gap、head padding、timeline 行距 |

### 3.3 composer(取代 trigger-form 盒子)

| 决策 | 选项 | 理由 |
|---|---|---|
| 容器 | 一个圆角容器(`--bg-surface` + `--border-strong`),聚焦时蓝光描边(`box-shadow` accent-faint) | 一体感,不是裸 textarea |
| textarea | **自增高**(min ~38px,按内容长到上限再内滚) | 现在固定 min 60 占地大 |
| 工具栏(底部一行) | `📎 附件` · `/`(slash 提示,功能已有)· **model chip**(只读显示当前 provider/engine)· `⌘↵ 发送` 提示 · `Run` | 信息收在一条,不散 |
| 跑动时 | `Run` → `Stop`(**已查:后端 `POST /runs/{id}/cancel`(SIGTERM 进程组)+ 前端 `.run-cancel-btn` 已存在,直接复用**,不写新后端) | happier 的 steer 感,复用现成 cancel |
| 附件 chips | 在 composer 容器内顶部一行(沿用现有 `_pendingUploads` 渲染) | 不动上传逻辑 |

### 3.4 侧边栏完整样式 + 收起

**样式(restyle 现有树,不改渲染数据结构):**
- 顶栏:当前根 repo 名 + **`«` 收起按钮**;下面 `＋ 新建 workspace`(现有 dialog)。
- section 标签 `Workspaces`(微小 uppercase tertiary)。
- repo ▸ session 两级树(已有):repo 行带 ▸/▾ 三角(≥2 session 才有)、session 行缩进;**运行中的挂青色脉冲点**(新增,见下);active 行蓝底 + 左 accent 条(已有);hover 出 `⇲`(已有);`＋ 新对话`(已有)。
- 底部:在线状态 + `⚙` 设置入口。

**运行中状态点(需要纯函数支持):** `buildSidebarTree` 的 entry / session 增加 `running: bool`(从 groups 的 active runs 派生)。纯函数,补单测。

**收起(新功能,需 JS + CSS + 持久化):**

| 决策 | 选项 | 理由 |
|---|---|---|
| 收起形态 | **52px 图标条(rail)**:repo 首字母方块 + 运行点;顶 `»` 展开、`＋` 新建、底 `⚙` | 还能看到有哪些 repo + 谁在跑,点一下就切;比"完全隐藏"信息量大 |
| 多 session repo 在 rail | 方块右下角**数字角标**(几条对话) | 提示有多条对话,点进去展开看 |
| 点 rail 里 repo 方块 | **聚焦该 repo 默认 session**(`dispatchPane focus`) | 一键切,不强制展开整个 sidebar |
| 持久化 | `cc.pcLayout.sidebarCollapsed: bool`,刷新保持 | 跟现有 paneState 持久化同一份 |
| 作用域 | PC-only(`@media min-width:769px`);mobile 无侧边栏不受影响 | |

### 3.5 Phase 1 纯函数 & 测试

- `buildSidebarTree` 加 `running` 派生字段 → 补单测(repo/session 有 active run → running:true;无 → false)。
- 收起 toggle 的状态读写:`sidebarCollapsed` 并进 `loadPcLayout`/`savePcLayout`,默认 false;坏数据回 false。可加一个纯小函数校验(可选)。
- composer 自增高 / 折叠 / DOM 渲染 → `node --check` + 手动 smoke(§5.3 既有口径)。

---

## 4. Phase 2 — coding 工具报文流(JS 渲染,较大)

**重做 `_renderTurnEvent` 及配套,把工具调用从"裸 JSON"变成结构化块。核心是一组纯函数 formatter + 渲染器,可 TDD。**

### 4.1 per-tool formatter(纯函数)

新 `formatToolUse(name, input)` → `{ verb, target, glyph, kind }`(纯函数,进 `ui_contract.mjs`):

| 工具 | verb | target | 额外渲染 |
|---|---|---|---|
| `Bash` | `Bash` | `command`(截断) | 配对 result = 命令输出块 |
| `Edit`/`MultiEdit` | `Edit` | `file_path` | **diff 块**(`old_string`→`new_string` 行级 diff) |
| `Write` | `Write` | `file_path` | 新内容预览(折叠) |
| `Read` | `Read` | `file_path`(+行范围) | 单行,无展开 |
| `Grep`/`Glob` | `Search` | `pattern` | 配对 result = 命中列表 |
| 其它 | tool name | input 里第一个 string 值 | 配对 result 折叠 |

### 4.2 diff 渲染(纯函数)

`renderEditDiff(oldStr, newStr)` → 行级 diff(`-`/`+`/上下文),红删绿增。最小实现:按行 split + 朴素 LCS 或直接全删全增(MVP 可先全删全增,见 §7 Q2)。纯函数,补单测。

### 4.3 markdown 渲染

回复(`text`/`result`)内容渲染 markdown(表格 / 代码块 / 标题 / 列表 / 行内 code)。**需要 markdown 渲染器**:

| 选项 | trade-off |
|---|---|
| **A 引入 `marked.min.js`(vendor 静态文件)** | 健壮、省事;+1 个静态资源,无 build step 可直接 `<script>` 引(推荐,见 §7 Q3) |
| B 手写极简(只表格/代码/标题) | 不加依赖;但 markdown 边界多,易出 bug,维护负担 |

渲染输出**必须转义防 XSS**(marked 配 sanitize 或仅在可信内容上用 —— run 输出来自本机 claude,但仍按不可信处理)。

### 4.4 tool_use + tool_result 配对 & 默认显示

| 决策 | 选项 |
|---|---|
| 配对 | 把紧跟 `tool_use` 的 `tool_result` 合成一个 tool block(call 行 + 折叠的 result/diff) |
| 默认显示 | 工具块**默认显示但紧凑**(单行 call,result/diff 折叠);改现有"默认隐藏 tool 事件"为"默认紧凑显示" |
| 失败 | `tool_result.isError` → 红色高亮,默认展开 |
| 展开程度 | tool 行默认折叠(只 call 行);assistant text / result 展开;用户点单个 tool 展开它的 diff/output |
| 左侧 rail | 一连串工具动作用一条左侧细 rail 串起来(视觉:agent 在连续操作) |

### 4.5 Phase 2 纯函数 & 测试
- `formatToolUse(name, input)` → 各工具 verb/target 提取,补单测(Bash/Edit/Write/Read/Grep/未知)。
- `renderEditDiff(old, new)` → diff 行,补单测。
- `pairToolEvents(events)` → 把 tool_use 跟其 tool_result 配对成 block 列表,补单测。
- markdown 渲染走 vendor lib(若选 A)→ 集成/手动 smoke,不为第三方库写单测。

---

## 5. 数据流 & 测试金字塔

```
现有:events(含 tool_use{name,input} / tool_result{text,isError} / text / result{tokens})
  Phase 1:同数据,换 CSS + 侧边栏 running 字段 + 收起状态
  Phase 2:同数据,_renderTurnEvent 重做 → formatToolUse / renderEditDiff / pairToolEvents(纯函数)
           + markdown 渲染器(vendor)
```

- **纯函数(进 `ui_contract.mjs` + `pwa-ui-contract.test.mjs`)**:`buildSidebarTree.running`、`formatToolUse`、`renderEditDiff`、`pairToolEvents`(+ 可选 `sidebarCollapsed` 校验)。
- **DOM/CSS/拖拽/收起动画**:`node --check` + 手动浏览器 smoke(spec §5.3 既有口径)。
- 后端零改动 → `py_compile` 兜底确认无连带。

---

## 6. Trade-off / 反悔成本

| 决策 | 反悔成本 | 何时翻案 |
|---|---|---|
| pane/turn/composer 去卡片(CSS) | 轻易可逆 | 觉得太素再加弱底 |
| 侧边栏收起成图标条 | 痛但可行(新交互 + 持久化字段) | 不用就删 toggle;字段向前兼容 |
| 工具块默认显示(改默认过滤) | 轻易可逆(留"全部隐藏"开关) | 太吵改回默认折叠 |
| markdown 用 vendor marked | 痛但可行(+1 依赖) | 想去依赖改手写(§7 Q3) |
| diff MVP 全删全增 | 轻易可逆 | 需要精确 diff 再上 LCS |

**几乎不可逆**:无(术语沿用,无 schema/接口改动)。

---

## 7. Open Questions(给倾向,plan 阶段定)

1. ~~composer 的 Stop~~ **已定**:后端 `runner.cancel()`(`POST /runs/{id}/cancel`,SIGTERM 进程组)+ 前端 `.run-cancel-btn` 已存在 → composer 跑动时 `Run`→`Stop` 直接复用现成 cancel,不写新后端。
2. **diff 精度**:MVP **全删旧 + 全增新**(Edit 的 old_string/new_string 直接红/绿两块)够不够?还是要行级 LCS 精确 diff?倾向:MVP 全删全增,够看;精确 diff 留迭代。
3. **markdown 渲染器**:vendor `marked.min.js`(推荐,健壮)vs 手写极简。倾向:**vendor marked**(无 build step 直接引,XSS 按不可信处理)。
4. **Phase 1 / Phase 2 是否同一个 PR**:倾向**分开** —— P1(去卡片+收起,CSS+小JS)先上、立竿见影、风险低;P2(报文流,较大 JS)单独 plan + review。本 spec 一份覆盖,plan 拆成两批。

---

## 8. Self-review

- ✅ 无 TBD:4 个 open question 都给了倾向 + 不阻塞主结构。
- ✅ 内部一致:§3/§4 决策 ↔ §5 纯函数清单 ↔ §6 trade-off 对得上。
- ✅ 范围:明确两阶段,P1 可独立交付,P2 依赖 P1 的去卡片底子但逻辑独立。
- ✅ 歧义:composer/tool block/rail 等新词已在 §2 钉死;"turn 去卡片(P1 视觉)" vs "报文流重做(P2 逻辑)"边界清楚。
- ✅ 与已合并布局(baf81ea)不冲突:只换皮 + event 渲染,不动 reducer/布局阶梯/路由。

---

## 9. 不做(YAGNI)

- 移动端任何改动(carousel 不碰)。
- 后端改动(取消 run / 新数据)——除非 §7 Q1 查到现成能力。
- 精确语法高亮(代码块先等宽块,不上 highlighter)。
- 侧边栏拖拽调宽、pane 拖拽换位。
- 把 markdown 渲染用到 roundtable / 别处(本次只 PC pane 报文)。
