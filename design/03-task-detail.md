# 03 · task 详情(手机) — 设计规格

> 配套:`03-task-detail.html`
>
> Tasks tab 列表点某个 cron 进来。**stream 复用 02 的渲染逻辑**,不是另起一套。

---

## 1. 这张稿要解决什么

cron 跑出来的内容跟 workspace turn 是同一种东西(都是 agent-run.sh 的 stream)。所以详情页主区域 = **最近一次 run 的 stream**,UI 直接抄 02。

但 cron 跟 workspace 有 4 个本质差异,这张稿专门处理这 4 点:

1. **无人值守** — 没 input bar,Run now 在齿轮菜单里
2. **周期性** — Last 7 sparkline 替代历史列表,看健康度
3. **每次 run 独立** — 只展示最近一次,过去的不在 UI(后端 jsonl 有)
4. **Approval 处理不同** — cron 跑时如果遇到 pending tool,**等用户**;没有 trust=ON 兜底会卡住

---

## 2. 与其它稿的衔接

- **01 概览 Tasks tab** 的 task 行 → 点击进 03 详情(对应 `#tasks/<id>` 路由,新增)
- **02 workspace 详情** 的 stream 渲染代码 → 03 完全复用(`event-rail`、`tool-result-fold`、typing 等同一套 CSS class)

---

## 3. 关键交互决策

### 3.1 没有 input bar(cron 无交互输入)

**决策:** 详情页底部不放 sticky 输入框。Run now / Pause / Edit 全在齿轮菜单。

**收益:** 视觉简洁;cron 的"无人值守"心智清晰(不是"我跟它聊");stream 区域可以一直 scroll 到底。

**代价:** Run now 多一步(开齿轮),但这是低频动作,可接受。

### 3.2 Last 7 sparkline 替代历史列表

**决策:** task header 卡片下方一行 sparkline `Last 7: ✓ ✓ ✕ ✓ ✓ ✓ ● 86%`,**不画**完整的历史 runs 列表。

```
✓ = ok (绿方块)
✕ = failed (红方块)
● = 当前正在跑(cyan 空心圈)
```

**收益:** 健康度一眼可见,符合"周期任务"的判断需求。
**代价:** 看不到具体某次失败的详情。

**何时翻案:** 用户反馈"我需要点开某次失败看 transcript"——这个真有需求再加(可能 sparkline 方块变成可点)。当前不做。

### 3.3 不引入 task 级 trust 设置(复用 workspace 的)

**决策:** task 自身**不**有"无人值守 / 自动审批"开关。完全依赖 workspace 的 trust=ON。

**收益:** 复杂度有代价——少一个配置点,少一处需要同步的状态。
**代价:** workspace trust=OFF 时,cron 跑到工具调用会挂等审批,直到用户登录批准/拒绝。

**用户操作流:** 配 cron 之前,先去 workspace 详情把 trust 打开;否则 cron 等同手动确认。

**何时翻案:** 用户反馈"我想 cron 自动批但 workspace 还是要手动批"——再加 task 级开关。当前不预设。

### 3.4 Cancel 按钮位置

放在 **task header 卡片右下角**(running 时显示),不放底部。

**为什么:** 详情页没有 sticky 底部 bar,放头部跟"task 现状"信息聚在一起更自然。

### 3.5 齿轮菜单结构

```
SCHEDULE
  Cron                       0 9 * * *
  Prompt                     edit

RUN
  Run now                    (disabled if running)
  Pause / Resume

──
  Delete task                (danger)
```

**为什么这么分段:**
- "SCHEDULE" 段 = 改 cron 跑什么、什么时候跑(配置)
- "RUN" 段 = 控制当前运行状态(动作)
- 删除单独分,避免误点

**Cron 行右侧直接显示表达式**(`0 9 * * *`),不需要点开才看到——cron 表达式是 task 的 ID-like 信息,常驻可见。点击进入编辑。

**Pause / Resume 是同一个 item,文案根据状态切换**——不要做两个 item,避免视觉冗余。

### 3.6 Prompt 区域

放在 task header 下方,单独一块,**默认展开**(prompt 是 task 的灵魂内容,跟 cron 表达式同等重要)。

**支持多行**,白色文字 + pre-wrap。点击进入编辑(齿轮里的 Prompt edit 是同一个入口)。

---

## 4. 状态分类

### 4.1 running

- task-card 左侧亮条 + cyan 边框
- task-state `● running` + 计时
- 右下 `✕ Cancel` 按钮
- sparkline 最后一格 = cyan 空心圈
- stream 末尾 typing dots
- 齿轮 Run now disabled

### 4.2 done(最近完成)

- 默认 task-card 样式(无亮条)
- task-state `✓ done · 2m ago`(green)
- 无 Cancel 按钮
- sparkline 最后一格 = green ✓ 方块
- stream 静态,完整显示最后一次 run

### 4.3 failed

- task-card red 边框
- task-state `✗ failed · 3 retries` (red)
- 无 Cancel 按钮(已结束)
- sparkline 最后一格 = red ✕ 方块
- stream 静态显示失败 run,末尾有 result 事件标记失败原因

### 4.4 paused

- task-card opacity .6 + 灰边框
- task-state `paused` (gray)
- 无 sparkline 当前格(因为这次没跑)
- stream 区域显示上一次 run(只读),顶部加一个 banner: `⏸ Paused since ... · tap gear to Resume`
- 齿轮 Pause 变 Resume

### 4.5 first time(从没跑过)

- sparkline 不显示(或者全是 7 个空灰格 + 文字 "Never run")
- stream 区域占位: `Not yet run. Will trigger at 0 9 * * * (next: 明早 9:00). Or tap gear → Run now.`

---

## 5. 与现状的差异

| 概念 | 现状 | 设计要求 |
|---|---|---|
| `#tasks/<id>` 路由 | 现状未确认是否存在 | **必须有**(从 01 概览 task 行点进来) |
| sparkline 控件 | 不存在 | **新增** —— 接受后端给 `recent_runs` 数组(7 项,each {status, run_id}) |
| Pause / Resume API | 现状未确认 | 后端需暴露 `POST /tasks/<id>/pause` + `/resume` |
| Run now API | 现状未确认(`refreshAll` 不算) | 后端需暴露 `POST /tasks/<id>/run` 立即触发 |
| cron 编辑界面 | 现状未确认 | 齿轮 Cron item 点击 → 进 edit 界面(本稿不画;P0 用 prompt 弹框即可) |
| task 详情页 stream | 不存在 | **新增** —— 直接复用 02 的 event 渲染 |

---

## 6. 砍掉的代码 / 不引入的概念

- ❌ **task 级 trust/approval 设置** — 见 3.3
- ❌ **完整历史 runs 列表** — 用 sparkline 替代
- ❌ **task 级 input bar** — cron 是无人值守
- ❌ **多个 run 并排展示** — 每次 cron run 独立,详情只展示最近一次

---

## 7. 给实施方的提醒

按项目 `CLAUDE.md`:

- **沟通底线** —— sparkline 数据 schema(`recent_runs` 数组)如果后端还没暴露,**回 Cowork 讨论字段名 + 长度**,不要自己定;改名成本高
- **Unix** —— sparkline 是一个独立小组件,接受 `[{status}, ...]` 数组,只负责画 7 个格子。不要把它跟 task-card 揉一起
- **TDD** —— 至少两个测试:(1) sparkline 收到 `[{ok},{fail},{ok},...]` 渲染对应 cells;(2) running 状态时 Cancel 按钮可见,done/failed/paused 时不可见
- **架构思维** —— "task 没有自己的 trust 设置"这一点属于**轻易可逆决策**,但加之前必须有真实需求;不要预设性引入

---

## 8. 验收

1. Tasks tab 点任意 task → 进入详情页,顶部 `← Tasks`,task name 居中
2. running task → cyan 亮条 + Cancel 按钮可见 + sparkline 最后一格是 cyan 圈
3. 按齿轮 → menu 弹出,Run now 在 running 时 disabled(灰)
4. 进入 paused task → stream 区域 banner 提示,齿轮里 Pause 变 Resume
5. 进入从未跑过的 task → stream 区域占位文字 + 显示下次触发时间
6. 拉一个超长 Bash output → 同 02 折叠规则,head 5 行 + Expand N lines
