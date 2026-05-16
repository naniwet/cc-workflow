# 02 · workspace 详情(手机) — 设计规格

> 配套:`02-workspace-detail.html`(浏览器直接打开;或 nginx serve `/design/02-workspace-detail.html`)
>
> 跟 01 一样,这份文档讲**设计意图 + 与现状差异 + 砍掉什么**。具体改哪几行由实施判断。

---

## 1. 这张稿要解决什么

workspace 卡片点进来,看到的就是**当前 session** —— 不是单次 run,不是历史 audit。

核心要求:

- 一次对话里 events 再多,屏幕不被糊一片
- 同 session 多轮(turn × N)都保留,不会越用越乱
- 进行中 turn 永远可见,新事件自动跟随
- 想往上回看时不被新事件打断

---

## 2. 与上一稿(01)的衔接 + 与现状的差异

### 衔接

01 概览的 workspace 卡片点击 → 进入这张详情页(对应 `#workspaces/{name}` 路由)。
头部「← workspaces」返回 01 概览。

### 差异(对照当前 `pwa/app.js` / `pwa/style.css`)

| 概念 | 现状 | 设计要求 |
|---|---|---|
| Turn 折叠 | 不存在(所有 events 打平) | **新增**:每个 turn 一个折叠条 |
| Session 边界 | 隐式(用 reset 按钮清空) | **显式**:`新对话`动作,旧 session 直接消失 |
| 历史 runs 入口 | 有 `#runs/<id>` 路由 + `renderRunDetailView` | **砍掉** |
| Run-detail 详情页 | 整个 `renderRunDetailView` + 相关 CSS | **砍掉** |
| Cancel | 散在 `.run-cancel-btn` 上 | **保留**,挪到进行中 turn 的头部右侧 |
| Sticky 输入框 | 现状未确认是 sticky | **必须 sticky**;auto-scroll 跟随底部 |
| 新事件浮按钮 | 不存在 | **新增**:用户向上 scroll 偏离底部时显示 |
| 齿轮菜单 | 配置散在卡片头各小图标 | **聚合**到一个齿轮 dropdown |

---

## 3. 关键交互决策(可争议项,展开 trade-off)

### 3.1 Session = 当前对话(同 session 内所有 turn 全保留)

**决策:** session 的所有 turn 都在这一页,**不论 5 个还是 50 个**。按齿轮菜单的 `新对话` 才归档,旧 turn 立刻从 UI 消失,不留痕迹。

**收益:** 用户心智简单 —— "这一屏 = 当前在跟它聊的话"。

**代价:** 长 session(50+ turn)需要靠 turn 折叠机制控制密度,DOM 节点也会变多。

**何时翻案:** 单 session 超过 100 turn 时再考虑虚拟滚动 / 只保留最近 N 个 turn 在 DOM。

### 3.2 Turn 折叠默认规则

```
进行中的 turn       → 永远展开 + auto-scroll 跟随
最近 1 个完成 turn  → 展开
更早的 turn         → 自动收起为一行 summary
用户可手动反转任何一行
```

**Summary 行内容**:用户输入第一句(单行截断) + 主要 tool 名 + 耗时 + ✓ / ✗

**为什么"最近 1 个完成 turn"也展开:** 用户刚跑完一轮想立刻看结果,不应该再点一下。

### 3.3 最新在底部 + Sticky 输入框

**决策:** 时间从上到下递增,**最新 turn 在视觉最底部**,输入框 sticky 在最底。新事件 append 到底,auto-scroll 跟随。

**为什么不顶部递增:** chat UI 的标准心智(iMessage / 微信 / Slack / ChatGPT)。颠倒会反直觉。

### 3.4 新事件浮按钮

用户向上 scroll 偏离底部 ≥ 1 个视口高度时,屏幕右下角(贴近输入框上方)显示一个浮按钮 `↓ N 新事件`(蓝色背景)。

行为:
- 用户继续向上滚 → 按钮保留,N 实时累加
- 用户点按钮 → scroll 回底部 + N 清零 + 恢复 auto-scroll
- 用户手动 scroll 回到底部 → 按钮自动消失 + 恢复 auto-scroll

### 3.5 没有"历史 runs"入口,没有 run-detail 页

**决策:** workspace 详情顶部只有 `← workspaces` + 名 + `⚙`。**没有任何**指向历史的链接。

**理由:**
- "旧 session 不保留"和"加历史入口"在逻辑上矛盾
- 单人项目,调试/审计需求都靠后端 jsonl,不是 PWA 的责任
- 砍掉一条整路由,代码量直接少一截

### 3.6 Cancel 按钮位置

进行中 turn 的头部右侧 (`.turn-cancel`)。turn 走到 result 事件后按钮消失。

**为什么不在 sticky 输入框:** sticky 输入框只有 Run 一个按钮,保持极简。Cancel 是 turn 级动作,放在 turn 头部更符合"我在取消这一轮"的心智。

### 3.7 齿轮菜单(workspace 级所有配置/操作)

聚合到顶部 ⚙,点开 dropdown。**所有 UI 文案用英文**(对齐项目现有 toast / tooltip 风格)。分 4 段:

```
ENGINE
  ◉ kimi        moonshot     ← current
  ○ claude      anthropic
  ○ gpt         openai
  ○ codex       openai
  ○ deepseek    deepseek

WORKSPACE
  Trust workspace            ON
  Pull latest                git pull --ff
  Sync skills

SESSION
  New chat

──
  Delete workspace           (danger)
```

**Engine 切换:** 不是单行带 dropdown,而是**直接展开** 5 个 radio(列出全部可用 provider,当前的高亮选中)。点击任意一行立刻切换,后端立即生效;不需要"保存"。

- 为什么 5 个 provider 直接平铺:选项只有 5 个固定值,sub-menu 反而多一步
- 5 个固定值属于**几乎不可逆决策**(改名会动后端 `engine` 字段 + jsonl 历史档),在 spec / `agent-run.sh` / `workspaces.json` 三处一致钉死

**Workspace 段三个动作:**

- **Trust workspace** — toggle,ON 时所有 tool(Bash / Edit / WebFetch …)自动批准,不弹 approval banner。对应现状 `.ws-trust-toggle` + 后端 `workspaces.json` 的 trust 字段
- **Pull latest** — 跑 `git pull --ff-only`,toast 显示结果。对应现状 `_onPullLatestClick`(`POST /workspaces/{ws}/pull`)。**这是漏掉的功能,补回来**
- **Sync skills** — 同步 `~/.claude/skills/*` 到 workspace。对应现状 `_onSyncSkillsClick`(`syncSkillsFor(ws)`)

**Session 段只有 New chat:** 原稿写了"New chat vs Reset session"两个动作,实际上**本质相同**(都是 reset `session_key=pwa-{ws}` + 前端清屏)。jsonl 由后端自动落,不存在"归档 vs 抛弃"的区别。砍掉一个,统一叫 **New chat**(心智跟 ChatGPT 的 New chat 一致)。

**当前 turn 在跑时:** New chat / Pull latest / 引擎切换都 disabled,先按 ✕ Cancel 才可点;Trust workspace 和 Sync skills 不影响。

---

## 4. tool_result 长输出处理

**决策:** 默认显示头 5 行,末尾一个 `↓ 展开 N 行` 链接。点击后整段全展。

**为什么这条单独提**: tool_result 是 stream 里**最容易爆字数**的(Read 一个 200 行文件就是 200 行)。这是性能 + UX 同时的痛点。

**Event 级折叠(thinking / tool_use)暂不做**,按"复杂度有代价":目前没有证据说 thinking 长到要折,先观察。

---

## 5. 状态色复用 01 的映射表

不重新定义,直接套 01-spec 的 3.3 节:

- running → cyan(turn-expanded border + auto-scroll active)
- done    → green(turn-status ✓)
- failed  → red(turn-cancel + 内部 tool_use 失败)
- 待审批  → amber(approval banner)
- thinking → purple(罕见用法,但 thinking 在 stream 里需要一个不抢主的色,purple 合适)

---

## 6. 砍掉的代码 / 路由清单

按"删完不影响构建"的标准列出:

**JS(`pwa/app.js`):**

- 路由 `#runs/<id>` 整段
- `renderRunDetailView` 函数
- 内部的 approval 详情 accordion、transcript accordion、live tail toggle helper
- `runs` 相关的 polling / fetch 路径(若仅供 run-detail 用)

**CSS(`pwa/style.css`):**

- `.run-approvals` / `.run-approvals-list` / `.a-row` / `.a-tool` 等审批列表样式
- `.run-transcript` / `.run-transcript-body` 等只读 transcript 样式
- `.run-live-tail` / `.run-live-hint`
- `.run-meta`
- 其他仅 `renderRunDetailView` 引用的 class

**保留(挪用):**

- `.run-cancel-btn` 样式 —— 改成 turn 头部用的 `.turn-cancel`,或直接复用
- `.tag-running` / `.tag-done` / `.tag-failed` —— 全 PWA 通用,保留
- `.approval-pending` / `.approval-approve` / `.approval-deny` —— 内联 approval banner 继续用

---

## 7. 不在本稿范围

- **空状态**(session 刚开还没说话):简单显示 placeholder 即可,P0 不重点画
- **错误/断网**:postbar 处理(01 已定),详情页不重复
- **桌面端布局**:留 04 画(同样是 session-stream 视图,但 sticky 输入框位置可能在右栏底部)
- **全局 pending sheet** 长啥样:留 03 画

---

## 8. 给实施方的提醒

按项目 `CLAUDE.md`:

- **沟通底线** —— 实施过程中如果发现 "Cancel 后 backend 状态不一致" / "新对话 vs reset 后端语义对不上" 这类问题,**回 Cowork 讨论**,不要自己挑一个做掉
- **Unix** —— turn 折叠状态是一个独立小模块,只负责"哪个 turn 该展开";auto-scroll 是另一个独立小模块,只负责"是否在底部"。不要揉一起
- **TDD** —— 至少两个测试用例必须有:(1) 收到 result 事件后,该 turn 自动从 expanded 切到 collapsed 摘要(除非是最近 1 个完成);(2) auto-scroll 在用户向上滚开后停止,新事件累加到浮按钮的 N 上
- **架构思维** —— Provider 列表(kimi / claude / gpt / codex / deepseek)的 5 个固定值属于**几乎不可逆决策**(改名会牵动后端 `engine` 字段 + jsonl 历史档),在 spec / `agent-run.sh` / `workspaces.json` 三处一致钉死

---

## 9. 验收

打开 PWA(手机)进任意 workspace,操作:

1. 发 3 条消息(产生 3 个 turn)→ 第 3 个 turn 跑完后,第 1 个 turn 应自动收起
2. 在第 4 个 turn 跑到一半时按 ✕ 取消 → backend 收到 abort,该 turn 标记为 cancelled,Run 按钮恢复可用
3. 按齿轮 → 新对话 → 整页清空,从 0 开始(后端 reset `session_key=pwa-{ws}`)
4. 按齿轮 → 引擎 → 点击 `claude` → 当前 provider 切到 anthropic,下一个 turn 用 claude 引擎跑(jsonl 里 engine 字段记录)
5. 向上滚动到第 1 个 turn → 屏幕右下角出现 `↓ N 新事件`,点击回到底
6. 拉一个超长 Read 的 tool_result → 默认只看到 5 行 + "展开 N 行",点击全展
