# 个人 AI 工作流系统 — 方案文档

## 0. TL;DR

把手机变成 Claude Code(以及未来 Codex / GPT / DeepSeek / Kimi)的远程信号器。**phone 触发,server 干活,push 通知**。3 层:

1. **信号层**: PWA(主)+ Feishu/钉钉(辅) — 都是入口
2. **网关层**: 自建 FastAPI gateway(无 OpenClaw)
3. **执行层**: agent-run 多引擎包装 + Linux cron(定时)

**P0 严格保证 Claude Code 引擎**;Codex 引擎在 P0 留接口跑 smoke,深度集成放 P1。其他引擎(GPT/DS/Kimi)以及多 agent 协同讨论也是 P1。

代码量约 1500 行,自建。

---

## 1. 背景与问题

### 1.1 问题陈述

个人开发者(单人,4 个 repo,4C8G 云服务器)希望搭一套**"phone 当信号器,server 当执行引擎"**的工作流——参考 Boris Cherny 的工作模式(但**不复刻**:他在 Anthropic 内部不付 token 钱,你不一样)。当前已经把 OpenClaw 接上飞书并部分跑通,但发现:

- OpenClaw 的 cron payload schema 在 v2026.4.1 有已知不一致(Issue #1982),调试成本高
- OpenClaw 的 agent + skill + tools 抽象对个人 scale 过度封装,反而成了路由不可见的黑盒
- 多引擎支持要绕开 OpenClaw 自己实现
- 多 agent 协同讨论在 OpenClaw 里不自然

### 1.2 不解决的代价

- 维持现状(OpenClaw):**只能跑 Claude,跑通后 schema 翻车难修**,加引擎要打补丁
- 完全放弃自动化:**丢掉本来已经看到的杠杆**(让 Loop 在后台干活)
- 等 OpenClaw / Codex / Claude Code 三家都把 cron 做完美:**等 6-12 个月,且都是面向 GUI / 云端用户**

### 1.3 决定自建的关键事实

- **Claude Code CLI 没有面向 headless server 的原生 cron**(`/loop` 是 session 内、Desktop 调度要 GUI、Cloud Routines 在 Anthropic 端)
- **Codex CLI 没有原生调度**(Issue #8317 仍 open;`codex exec` 设计为被外部 cron 调用)
- **结论**: 外部调度器必然要有,Linux cron 是最简形态

---

## 2. Goals(目标)

### 用户目标

1. **G1 — 触发延迟**: 手机发出指令到服务器开始执行 ≤ 10 秒(P95)
2. **G2 — 无人值守**: 关手机/笔记本后任务继续,完成时 push 到达 ≤ 15 秒
3. **G3 — 引擎切换**: 一键选 Claude (P0) 引擎执行;Codex 接口预留,P1 完整支持其他引擎
4. **G4 — 7 天稳定**: 至少 5 个 Loop 持续运行 7 天,daily-digest 每日按时送达

### 系统目标

5. **G5 — 守护进程 ≤ 2**: FastAPI + Linux cron(系统自带),不引入第三个 daemon
6. **G6 — 故障可见**: 任何 Loop / 任务失败,push 通知 + dashboard 红色标记,30 秒内可知
7. **G7 — 总代码量 ≤ 1500 行**: 控制复杂度,任何文件 24 小时内能完整 review
8. **G8 — 可靠性**: 关键数据(runs.db)有备份;日志不爆磁盘;worktree 不无限增长

---

## 3. Non-Goals

| 非目标 | 为何不做 |
|---|---|
| **N1**. 手机上写复杂代码(IDE 替代) | 手机不是 coding device;phone = 信号器是核心心智模型 |
| **N2**. 团队多租户 / 多用户 | 个人使用,不引入用户系统 |
| **N3**. PC 桌面原生 app | 飞书桌面客户端 + Mac 浏览器 dashboard 已经覆盖 |
| **N4**. 自建 LLM 路由 / 自动选 agent | 显式选择更好,自动路由是后期可选 |
| **N5**. 替代 Claude iOS App | 官方 app 已成熟;这个项目解决官方不覆盖的:飞书集成、多引擎、自建 Loop |
| **N6**. 重新发明 cron / IM 协议 | Linux cron + Feishu/钉钉 webhook 已稳定 |

---

## 4. User Stories

> **⚠ Disclaimer**: 下列场景是 PRD owner 推测,**不是用户真实表述**。开工前应由用户确认或修正。如场景不准,P0 优先级可能错。

### 通勤场景(推测高频)
- 作为开发者,在地铁上 5 秒内触发"修复 repo1 bug",继续看视频,5 分钟后 push 通知

### 监控场景(推测每日)
- 作为开发者,每天 9:03 飞书收到 4 个 repo 昨日活动综合简报
- 任意 Loop 连败 ≥ 3 次立即收到告警

### 决策场景(推测低频高价值,P1 才实现)
- 架构选型时触发 3 个 agent 的"魔鬼代言人"讨论

### 多线并行(推测中频)
- 同时开 3 个 session 在 dashboard 看进度

---

## 5. 系统架构

```
┌─────────────── 信号层(Signal) ───────────────┐
│  PWA(装到桌面) │ Feishu Bot(已集成)│ 钉钉(P1) │
└────────┬────────────────┬─────────────────┬───┘
         │ HTTPS          │ webhook         │ webhook
         ▼                ▼                 ▼
┌──────────── IM Adapter 层 ─────────────────────┐
│  pwa_adapter / feishu_adapter / dt_adapter(P1) │
│  统一形态化 → 调 gateway                       │
└────────────────────┬───────────────────────────┘
                     ▼
┌──────────── 网关层(FastAPI) ──────────────────┐
│  /run /runs /sessions /loops /push /im/feishu  │
└────────────────────┬───────────────────────────┘
                     ▼
┌──── 执行层(agent-run + 未来 discuss) ────────┐
│  agent-run --engine=claude (P0) | codex (P0bp) │
│  + worktree 隔离 + session_key 持续           │
└────────────────────┬───────────────────────────┘
                     ▼
┌─────────── Engine 适配器 ───────────────────────┐
│  claude:   claude code CLI                      │
│  codex:    codex exec(P0 best-effort, P1 完整) │
│  gpt/ds/kimi: OpenAI-compatible SDK(P1)        │
└─────────────────────────────────────────────────┘

平行通道:
   /etc/cron.d/cc-loops ──> agent-run(同一执行层)
   结果通过 Push / Feishu / 钉钉回报
```

---

## 6. Requirements

### 6.0 实施阶段(Phasing)

P0 8 项分 **3 个 phase** 实施。**前一 phase 通过 Gate 才进下一 phase**:

| Phase | 范围 | Gate(必须全过才进下一阶段) |
|---|---|---|
| **Phase 1: 核心闭环验证** | P0-1 / P0-2 / P0-3 / P0-4(基础) + 简陋 HTML 触发页 | Mac 浏览器 + 飞书文本消息都能端到端触发任务、看到 PR(**A0** 验证) |
| **Phase 2: 富交互(飞书卡片 + PWA-lite 2 视图)** | P0-5(IM Card 抽象 + Feishu 卡片) / P0-6(PWA-lite app:Workspaces + Tasks 两个视图) | 飞书卡片能用 + PWA-lite 装桌面可用 + 两视图工作(**A0'** 验证) |
| **Phase 3: 稳定化** | P0-7(安全 5 项) / P0-8(可靠性 4 项) | 全部 sub-item acceptance 过 |

#### 为什么 PWA-lite 而不是完整 PWA

**Web Push 仍然不做**(留 P1)——飞书原生 push 在 iOS 上比 Web Push 可靠 10 倍,VAPID / service worker / Safari 16.4+ 这些坑能避免就避免。

**但 PWA shell(manifest + cache-only sw)做**——因为有 3 个真需求 飞书 卡片不擅长:
- **4 个 workspace 并行同屏**: 卡片一次显示一个,多视图同屏需要原生 grid 布局
- **添加 / 编辑 cron**: 选 cron 表达式、看每条 cron 的历史曲线 — 卡片不够
- **(P1)圆桌会议**: 多 agent 发言流 + 综合面板 — 必须有自己的 UI

所以 Phase 2 = **飞书卡片(短交互)+ PWA-lite(2 视图深度交互),互补**。

**P0-6 = 2 视图**(Workspaces + Tasks)。圆桌会议视图整体留 P1(UI + backend 一起做,**不在 P0 留空壳**)。

#### 为什么不直接写死 Feishu schema(IM Card 抽象层)

未来可能换钉钉/Slack/Telegram。所以 **P0-5 引入抽象 Card 模型**:
- backend 产出抽象 `Card` 对象(title / fields / buttons / refresh hook)
- `FeishuAdapter` 把 Card 渲染成 Feishu Open Platform 卡片 JSON
- 将来加 `DingTalkAdapter`,backend 不动,只加 ~120 行渲染代码

这是约 50 行多写的"抽象税",换未来 5x 易维护性。

#### 分 3 阶段的根本逻辑(不变)

1. Phase 1: **验证产品假设**(核心闭环 work 不 work)
2. Phase 2: **加富 UX**(卡片 + Mac 全局视图)
3. Phase 3: **加护栏**(安全 + 可靠性)

每个 phase 验证一件事,**不要并行调试两件未知**。

#### Phase 1 简陋 HTML 的设计约束

**故意不做 PWA-grade UX**:
- 单个 HTML 页面 + 内嵌 JS,无 manifest 无 service worker 无 push
- 只有:触发表单(workspace 选择、prompt 输入、Run 按钮)+ 活跃 session 列表 + 最近完成列表
- 视觉丑到你不想长期用 — **这是设计意图**,让你有动力进 Phase 2

放在 backend 自己的静态目录里(`backend/static/index.html`),Mac 直接浏览器打开。

#### Phase 1 Gate (A0)

Phase 1 完成判定:

- [x] **A0.1** Mac Chrome 打开 `http://<server>/` 看到简陋触发页 — PASS @ 2026-05-11(commit be37214 → ccf0220,经 nginx :80 反代到 backend 127.0.0.1:8765)
- [x] **A0.2** 页面点 Run 触发任务,几分钟内看到完成 — PASS @ 2026-05-11(`419f6bf18aef` test-repo · claude · sk=web-1 · elapsed 4s · exit 0,output "OK")
- [x] **A0.3** 飞书发消息 → 飞书收到回复 — PASS @ 2026-05-11(commit ccf0220,飞书私聊机器人 `[test-repo] reply with only OK` → reply `[done · exit 0] OK`,1-3 分钟)
- [x] **A0.4** 配 1 个 cron loop(每分钟),状态文件正确更新 — PASS @ 2026-05-11(等于 A2.1,见 §6.1 P0-2)

**A0 全过 ✅(2026-05-11)→ Phase 2 解锁**。

#### Phase 2 Gate (A0')

Phase 2 完成判定:

- [ ] **A0'.1** 飞书 `/sessions` 命令 → 收到卡片,列出当前活跃 + 最近完成,卡片有"刷新"按钮工作
- [ ] **A0'.2** 飞书 `/loops` 命令 → 收到卡片,列出 cron jobs + 状态,卡片"暂停 / 恢复 / 触发"按钮工作
- [ ] **A0'.3** 飞书 `[workspace] <prompt>` 文本格式触发(Phase 1 已存在的约定继续工作),session 连续
- [ ] **A0'.4** PWA-lite 在 iPhone 装到桌面 + 在 Mac 浏览器独立窗口启动 都看到 app(无浏览器 chrome)
- [ ] **A0'.5** **Workspaces 视图**: 4 个 repo 同屏并排,每列含活跃 session + 最近 + 触发表单
- [ ] **A0'.6** **Tasks 视图**: cron 列表 + 添加表单(workspace + cron 表达式 + prompt)+ 编辑 / 暂停 / 删除按钮工作
- [ ] **A0'.7** Card 抽象在 backend(`backend/ui_cards.py`),Feishu adapter 渲染该模型,**不直接拼 Feishu JSON**
- [ ] **A0'.8** 长输出 > 4000 字符 → 飞书发摘要 + 链接到 PWA 详情页 `/runs/<id>/view`

**A0' 全过才能进 Phase 3**。
**圆桌视图(多 agent)Phase 2 不做,留 P1-3 实施(UI + backend 一起做,不在 P0 留空壳)**。

---

### 6.1 Must Have(P0)

#### P0-1: agent-run 多引擎包装 **[Phase 1]**

**严格 P0**: Claude 引擎完整支持(`--resume`、错误处理、stream-json 解析)

**P0-best-effort**: Codex 引擎 smoke 跑通即可。深度集成(`--resume` 等价物、错误处理细节)放 P1。**如果 Codex CLI 在实测时和假设差异大,Codex 直接退到 P1,不影响 P0 整体**。

CLI: `agent-run --engine=<claude|codex> <workspace> "<prompt>" [session_key]`

- session_key 非 default 时,git worktree 隔离
- 全局并发上限 3
- push main 阻断(exit 67)
- 超时阻断(exit 68)

> Exit code 完整定义见 dev-plan §4.1(0/64/65/66/67/68 — sysexits.h 标准段,避开 bash 内置)

**Engine 与 LLM 后端解耦(关键设计)**:

`--engine=<claude|codex>` 表示 **agent 工具**(claude code CLI / codex CLI),底层 **LLM 后端**由 `~/.cc-workflow/config.toml` 的 `provider` 字段决定,profile 配置在 `~/.cc-workflow/providers.json`:

| provider | 后端 LLM | 触发机制 |
|---|---|---|
| `claude`(默认 profile,空 env) | Claude(Anthropic 官方) | 不 export 任何 `ANTHROPIC_*` 变量,claude CLI 走自身 OAuth |
| `deepseek` | DeepSeek(`deepseek-v4-pro[1m]` / `-flash`) | profile 里的 env dict 全部 export(8 个变量) |
| `kimi` | Kimi(`kimi-for-coding`) | profile 里的 env dict 全部 export(2 个变量) |

DeepSeek / Kimi 都官方提供 **anthropic-compatible endpoint** — claude code CLI 的 agent loop / 文件工具 / `--resume` 全部不动,**仅 LLM 后端切换;不引入任何代理 daemon**,G5(守护进程 ≤ 2)不变。

Profile schema(`providers.json`)= **ccswitch 风格的 flat env dict**:加新 provider 只需新增一个 profile,agent-run.sh 零改动。完整 schema 见 dev-plan §4.1。

**acceptance**:
- [x] **A1.1** `agent-run --engine=claude` 返回正确;session resume 在 `provider=claude / anthropic` 时**严格工作**;在 `deepseek` / `kimi` 时 **best-effort**(anthropic-compatible 不保证 `session_id` 行为完全一致,实测决定)
  - **实测数据点 (2026-05-11, server, commit 7b88107)**: `provider=deepseek` 下 3.1.3 session resume **严格 PASS**(超出 best-effort 基线)— DeepSeek 的 anthropic-compatible endpoint 实际实现了 `session_id` 上下文恢复。Kimi 暂未实测。
- [x] **A1.2** 第 4 个并发立即 exit 65 — PASS @ 2026-05-11(3 个 exit=0 + 1 个 exit=65,test-plan §3.1.2)
- [x] **A1.3** push main attempt → exit 67 — PASS @ 2026-05-11(test-plan §3.1.4,prompt 静态扫描,与 LLM 后端无关)
- [ ] **A1.4 [best-effort]** `agent-run --engine=codex` smoke 跑通 — SKIP @ 2026-05-11(codex CLI 未装,P0-1 best-effort 允许,降级 P1)

#### P0-2: Linux cron + 状态文件 **[Phase 1]**

每个 cron job 写状态到 `~/.cc-state/jobs/<name>.json`:lastRun, lastExit, consecutiveErrors, lastError, enabled。

**acceptance**:
- [x] **A2.1** cron job 触发后状态文件正确更新 — PASS @ 2026-05-11(commit 7467001,`tick-test` 130 秒里跑 2 次,`total_runs=2 / last_exit=0 / last_output_summary="OK"`)
- [ ] **A2.2** 连败 ≥ 3 自动写 enabled=false(与 P0-7g 联动)— **Phase 3 P0-7g 才实现**;Phase 1 pause/resume 只写 state(commit 7467001 MINIMAL_CHOICE)

#### P0-3: FastAPI Gateway **[Phase 1]**

端点:`/run` `/runs/{id}` `/sessions` `/loops/*` `/push/subscribe` `/im/feishu/webhook` `/healthz`

SQLite 持久化 (`~/.cc-state/runs.db`)

**acceptance**:
- [x] **A3.1** `POST /run` 返回 < 100ms — PASS @ 2026-05-11(`time curl` 实测 13ms,远低于 100ms;commit f8ee553)
- [x] **A3.2** `GET /sessions` 显示活跃 worker — PASS @ 2026-05-11(返回 `{active, queued, recent}` 结构,recent 含 `1cbdb7720763`)
- [x] **A3.3** 重启后历史 task 仍可查 — PASS @ 2026-05-11(`systemctl restart cc-workflow` 后 `/runs/1cbdb7720763` 仍返回 `done` + exit 0;SQLite 持久化)

#### P0-4: Feishu IM Adapter **[Phase 1]**

webhook 接收 + 签名校验 + 反向 reply

**消息格式约定**(已在 Phase 1 实现并实测通过):
- 文本触发: `[workspace] <prompt>` —— 例:`[test-repo] reply with only OK`
- 不匹配该格式 → bot 提示"请用 `[workspace] prompt` 格式" / 或当作默认 workspace
- 多轮对话: `session_key = feishu-<chat_id>`,**[workspace] 前缀可省略时复用上次的 workspace**(待 P1 改进)

**acceptance**:
- [x] **A4.1** 飞书发消息 → 收到回复 — PASS @ 2026-05-11(commit ccf0220;`[test-repo] reply with only OK` → `[done · exit 0] OK`)
- [ ] **A4.2** 多轮对话 session 连续(`--resume` 工作)— 代码 ready,`session_key = feishu-<chat_id>` 保证同一 chat 复用 session;A4.1 PASS 已隐含路径通,完整 multi-turn 实测待

#### P0-5: IM Card 抽象 + Feishu 卡片扩展 **[Phase 2]**

> **架构原则**: backend 产出抽象 `Card`,各 IM adapter 各自渲染。未来加钉钉/Slack/Telegram 只写一个新 adapter,backend 不动。

| # | 子项 | 内容 |
|---|---|---|
| 5a | **抽象 Card 模型** | `backend/ui_cards.py`: `Card(title, sections, buttons, refresh_token)` dataclass + `Section` / `Button` / `FormField` 基础类型 |
| 5b | **Feishu adapter 渲染** | `backend/im_feishu.py` 扩展:Card → Feishu Open Platform 互动卡片 JSON;回调 webhook 解析 → 抽象 `CardAction` 事件 |
| 5c | **Slash 命令** | `/sessions` `/loops` `/run` `/templates` 四个命令,backend 接收文本指令 → 生成 Card → adapter 渲染发送 |
| 5d | **会话/Loop 卡片** | 活跃 session 卡片(带刷新按钮)、cron loops 卡片(每行带"暂停 / 触发"按钮)、最近完成卡片 |
| 5e | **新建任务表单卡片** | 卡片含:workspace dropdown + prompt 文本框 + Run 按钮;按钮回调走 backend → 走 `/run` → 触发 |

**acceptance**:
- [ ] **A5.1** `backend/ui_cards.py` 含 `Card` / `Section` / `Button` / `FormField` 抽象,无任何 Feishu 字符串
- [ ] **A5.2** 飞书发 `/sessions` → 收到卡片;点"刷新"按钮 → 卡片内容更新
- [ ] **A5.3** 飞书发 `/loops` → 收到卡片;点某条 loop 的"暂停"按钮 → cron job 状态文件 `enabled` 变 false
- [ ] **A5.4** 飞书发"新建任务"卡片表单 → 选 workspace + prompt + 提交 → 任务被触发,后续完成 reply 回原 chat
- [ ] **A5.5** Card 抽象渲染的 Feishu JSON 通过 Feishu Open Platform 的"卡片调试器"验证合法

#### P0-6: PWA-lite App(Workspaces + Tasks 两视图) **[Phase 2]**

> **PWA-lite = manifest + cache-only service worker,但不上 Web Push**。装到桌面 / 全屏启动可用,通知仍走飞书。
>
> 两个视图 — 圆桌(多 agent)视图整体留 P1-3 实施。

| # | 子项 | 内容 |
|---|---|---|
| 6a | **PWA shell** | `pwa/manifest.json`(name / icons 192+512 / start_url / display=standalone)+ `pwa/sw.js`(纯缓存,不 push)|
| 6b | **Workspaces 视图** | 4 列(N 列可配置)横向布局,每列对应一个 repo:活跃 session / 最近完成 / 内嵌触发表单 |
| 6c | **Tasks 视图** | cron 列表 + 添加表单(workspace dropdown + cron 表达式输入 + prompt textarea)+ 编辑 / 暂停 / 删除按钮 + 每条 cron 的运行历史(最近 5 条) |
| 6d | **长输出详情页** | `/runs/{id}/view` 路由(可独立访问,飞书消息长输出兜底用) |
| 6e | **3 秒轮询刷新** | fetch + 轮询;无 WebSocket / SSE / push |

**acceptance**:
- [ ] **A6.1** PWA 在 iPhone Safari "添加到主屏幕" 后启动是独立 app(无浏览器 chrome)
- [ ] **A6.2** Workspaces 视图同屏并排显示 4 个 repo,各自独立可触发任务
- [ ] **A6.3** Tasks 视图能添加新 cron(选 workspace + 输入 cron 表达式 + prompt),状态文件正确生成
- [ ] **A6.4** Tasks 视图编辑 / 暂停 / 删除单条 cron,文件系统状态正确反映
- [ ] **A6.5** 长输出 > 4000 字符,飞书消息含截断 + 链接到 `/runs/<id>/view`,点链接看完整 stream-json
- [ ] **A6.6** **不存在** `backend/push.py` / VAPID 密钥 / 任何 Web Push 引用(确认这条路径砍干净)

#### P0-7: 安全护栏(5 子项)**[Phase 3]**

> 原本设计的 CSRF token / Push 订阅鉴权 已随 Web Push 整体退到 P1,本方案安全护栏 5 项。

| # | 子项 | 内容 |
|---|---|---|
| 7a | **禁止 push main** | agent-run 检查 + GitHub branch protection 双保险 |
| 7b | **API 用量软告警** | 日 token 估算超阈值(默认 $30/天)→ 飞书告警 |
| 7c | **CORS** | 后端只允许 PWA-lite 同源 + 飞书 webhook 来源 |
| 7d | **Log / Secret 权限** | `~/.cc-state/logs/` 权限 `0700`,`~/.cc-workflow/secrets.toml` + `providers.json` 权限 `0600` |
| 7e | **连败自动 disable** | cron job 连败 ≥ 3 自动 enabled=false + 飞书告警(与 P0-2 A2.2 联动) |

**acceptance**:
- [ ] **A7.1** push main 阻断(exit 67)
- [ ] **A7.2** 模拟超阈值 → 飞书告警卡片
- [ ] **A7.3** 跨 origin 调用 `/run` → 403
- [ ] **A7.4** `ls -la ~/.cc-workflow/{secrets.toml,providers.json}` 都显示 `-rw-------`
- [ ] **A7.5** 连败 3 次自动 disable + 告警

#### P0-8: 可靠性 **[Phase 3]**

| # | 子项 | 内容 |
|---|---|---|
| 8a | **SQLite 备份** | 每日 cron `sqlite3 .backup` 到 `~/.cc-state/backup/runs-YYYYMMDD.db`,保 7 天 |
| 8b | **日志轮转** | `~/.cc-state/logs/*.jsonl` 每周清理 > 30 天的 |
| 8c | **Worktree 清理** | 每周扫 `~/workspaces/.wt/`,> 7 天无活动的 `git worktree prune` + 删目录 |
| 8d | **服务自启** | systemd unit,server 重启后 backend 自动恢复 |

**acceptance**:
- [ ] **A8.1** 7 天后 backup 目录有 7 份备份
- [ ] **A8.2** 30 天前日志被清
- [ ] **A8.3** 旧 worktree 被清
- [ ] **A8.4** server reboot 后 backend 自动起来

---

### 6.2 Should Have(P1)

| # | 内容 |
|---|---|
| P1-0 | **Web Push 完整支持**(VAPID + iOS Safari 16.4+);只在飞书 push 失败率 > 5% 时才做 |
| P1-1 | **Codex 引擎深度集成**(--resume 等价、错误处理、stream 输出对齐) |
| P1-2 | agent-run 接入 GPT 等纯 chat-mode 模型(OpenAI-compatible SDK)。**DeepSeek / Kimi 在 P0-1 已经作为 claude code 的 LLM 后端覆盖**,P1 这里只剩没有 anthropic-compatible 桥的模型(GPT、Qwen 等) |
| P1-3 | **Multi-agent 协同讨论 + 圆桌视图**(PWA-lite 第 3 视图 + backend `/discuss` endpoint,**UI 与 backend 一起做**)— 详细设计见 [`future/multi-agent-design.md`](future/multi-agent-design.md) |
| P1-4 | DingTalk IM Adapter(沿用 Feishu 形态,~120 行) |
| P1-5 | Dashboard 模板库整合到 PWA-lite Tasks 视图 |
| P1-6 | API 用量 / Cost Tracker |
| P1-7 | GitHub Actions Loop 集成(PR babysit / Issue triage / Flaky test) |

### 6.3 Could Have(P2)

LLM 自动路由、Session 跨重启恢复、语音输入、Slack/Telegram、长任务自动拆解 — 远期。

---

## 7. Success Metrics

### Leading (1-2 周)

| 指标 | 目标 |
|---|---|
| 手机触发延迟 P95 | ≤ 10 秒 |
| 任务完成率(Claude 引擎) | ≥ 90% |
| Push 通知到达率 | ≥ 95% |
| 飞书机器人周交互次数 | ≥ 20 |
| daily-digest 准时率 | 7/7 |

### Lagging (1-3 月)

| 指标 | 目标 |
|---|---|
| 日均 SSH 次数 | < 1 |
| 月 merge PR 数(相对之前) | + 30% |
| API 月成本 | < $200 |

---

## 8. Open Questions(阻塞性)

- **Q1** [engineering] Feishu webhook 当前集成具体形态?接入 OpenClaw 还是已有独立服务?
- **Q2** [engineering] Codex CLI 在服务器装了没?哪个版本?(决定 P0-1 的 best-effort 走多远)
- **Q3** [data] 4 个 repo 真实名字
- **Q4** [security] 服务器能上 HTTPS(let's encrypt / cloudflare)吗?**PWA-lite 必需 HTTPS**(manifest + service worker 强制),飞书 webhook 可走 HTTP 但推荐 HTTPS

---

## 9. Timeline(分 phase,依赖序,非日历)

> ⚠ 这是**估算**,不是承诺。实测每段可能 ±50%。
> **每个 Phase Gate 必须过,才进下一个 Phase**。

### Phase 1: 核心闭环验证(Mac 浏览器可用)

```
T+0           agent-run.sh (Claude 严格 + Codex best-effort smoke)
T+0.5d        backend 核心 (db + runner + /run + /runs + /sessions + /healthz)
T+1d          cron + state + /loops + cron_state.py
T+1.5d        Feishu adapter
T+2d          简陋 HTML 触发页(backend/static/index.html)
─── A0 Gate: Mac 浏览器 + 飞书都能端到端触发 ───
```

**A0 不过,不许进 Phase 2**。

### Phase 2: 富交互(PWA-lite 先,Feishu 卡片 后)

**顺序**: PWA-lite 是用户价值最显著的部分(4 repo 同屏 + cron CRUD,飞书卡片做不了),先做。Feishu 卡片是基础体验 polish(Phase 1 文本触发已工作),后做。
**Card 抽象 JIT 提取**: PWA 直接走 backend REST,不引入抽象;等 Feishu 卡片(第 2 消费者)出现时**才**提取 `ui_cards.py`。

```
T+2.5d        PWA-lite shell (manifest + cache-only sw + nav)
T+3d          Workspaces 视图(4 repo 同屏)
T+3.5d        Tasks 视图(cron CRUD + 历史)
T+4d          长输出详情页 + 飞书消息截断降级
─── 中间 Gate: PWA-lite 真好用,Workspaces + Tasks 都能用 ───
T+4.5d        IM Card 抽象层 (backend/ui_cards.py)
T+5d          Feishu adapter 扩展:卡片渲染 + 回调 + slash 命令
─── A0' Gate: PWA-lite + 飞书卡片 都到位 ───
```

**A0' 不过,修到通过**(IM Card 抽象在不在是结构性,无降级路径)。

**Phase 2 明确不做**:
- ❌ Web Push / VAPID / 完整 PWA push handler — 通知走飞书
- ❌ 圆桌会议视图(multi-agent UI)— 整体留 P1-3
- ❌ 任何让 Phase 2 越过 ~2000 行总代码量的功能

### Phase 3: 稳定化

```
T+4d          安全护栏 (P0-7 七子项)
T+4.5d        可靠性 (P0-8 四子项) + systemd 部署
T+5d          E2E 测试 (场景 A/B/C) + buffer
```

≈ 一周认真做能跑起来。**任何段超 1.5x 估算停下找 Cowork。**

### Phase 间的反向流(失败应对)

- **A0 不过**: 修 Phase 1 直到通过,不增量加 Phase 2 代码
- **A0' 不过**: 可以选择
  - 修 Phase 2 直到通过(优先)
  - 或者降级 Phase 2 到"只用浏览器版,phone 不装",继续 Phase 3
- **Phase 3 acceptance 不过**: 单个 sub-item 修复;不影响整体上线(可以分批 Phase 3 sub-item 上线)

---

## 10. Risks & Mitigations

| 风险 | 严重 | 概率 | 对策 |
|---|---|---|---|
| Codex CLI 接口与假设不符 | 中 | 中 | **P0 降为 best-effort;Day 0 实测;差异大放 P1** |
| Web Push 在 iOS 不稳 | — | — | **本方案不做 Web Push,改用飞书原生 push;留 P1-0,风险与 P0 无关** |
| 失控 Loop 烧 token | 高 | 中 | 软告警 + 连败 3 disable + 日 cost 上限 |
| 自动改 main 灾难 | 极高 | 低 | 双重防护:GH branch protection + agent-run exit 67 |
| SQLite 文件损坏 | 中 | 低 | **P0-8 每日 backup 已覆盖** |
| OpenClaw / 自建 cron 字段冲突 | 低 | 低 | 本方案不依赖 OpenClaw,与之平行运行不冲突 |
| PWA-lite 在公司网络下连不上 server | 中 | 中 | 可选 cloudflare tunnel / VPN;飞书入口不受影响 |
| CSRF / CORS 漏洞导致外部触发 | 高 | 中 | **P0-7 已覆盖** |

---

## 11. 关键设计决策 (Trade-offs)

### D1: 自建 vs 留 OpenClaw → 自建
- 收益:完全可控,多引擎天然支持
- 代价:多写 ~600 行代码

### D2: Linux cron vs APScheduler → Linux cron
- 收益:50 年稳定、零 daemon、cron 表达式标准
- 代价:状态机要自己写

### D3: SQLite vs JSON 文件 → SQLite
- 收益:并发安全、查询能力
- 代价:多一个抽象;**反悔成本中**,跑通后嫌重还能改 JSON

### D4: 飞书主入口 + PWA-lite 2 视图辅助
- 收益:利用飞书已有 push / 卡片 / 多端,Web Push 完全不做(留 P1);PWA-lite 提供 4 repo 并行同屏 + cron CRUD 两个飞书卡片不擅长的场景
- 代价:与 Feishu 短期耦合(P0-5 用 IM Card 抽象层缓解,未来加钉钉/Slack 适配器即可);PWA-lite 必需 HTTPS

### D5: Codex P0-best-effort
- 收益:不让 codex 的不确定性阻塞 P0 整体
- 代价:Codex 用户体验在 P1 才完整

### D6: Multi-agent 推到 P1
- 收益:P0 专注核心闭环,避免提前优化
- 代价:复杂决策类场景在 P0 没有,P1 才有

### D7: Engine 与 LLM 后端解耦(P0-1)→ claude code + 可切换后端(claude / deepseek / kimi)
- 收益:用户能用便宜的 deepseek/kimi 作日常主力,保留 anthropic 作 fallback;**agent 工具(claude code)能力完整保留**(agent loop、文件工具、tool-use),只是 LLM 后端变;无新 daemon;**profile schema 借鉴 ccswitch**(`providers.json` flat env dict),加新 provider 零代码改动
- 代价:`session resume` 在非 anthropic 后端 best-effort(实测决定);多 2 个配置文件(`~/.cc-workflow/config.toml` 选 provider + `~/.cc-workflow/providers.json` 存 profiles);agent-run.sh 多 ~30 行 provider 切换逻辑(jq 读 JSON 后 export)
- 何时翻案:某家 anthropic-compatible endpoint 跟官方协议差异大到 `--resume` 完全不可用 → 把那家从 P0 撤回到"P1 纯 chat 模式";或者出现性能/质量回归严重 → 改 `config.toml` 的 `provider = "claude"` 回退到 anthropic

---

## 12. 已确认的设计决策

- 单用户、4 repo、不设 API 硬上限(软告警)、禁止 push main、不启用 Cloud Routines
- 不依赖 OpenClaw,改用 Linux cron + 自建 FastAPI
- 飞书 + 钉钉 用适配器形态
- P0 的 agent 工具:严格 `claude code` + best-effort `codex`;**LLM 后端 P0 支持 anthropic / deepseek / kimi 切换**(详见 D7、§6.1 P0-1)
- 其他纯 chat 模型(GPT 等)P1
- Multi-agent 推到 P1
- 飞书主入口 + PWA-lite 2 视图(Workspaces + Tasks)辅助;Web Push 整体留 P1

---

## 附录 A. 决策演进(供后续 review 参考)

本方案在敲定前迭代过 4 个形态。保留这一节是为了让未来的你/团队成员理解"为什么这样设计、为什么不那样":

| 形态 | 关键判断 | 弃用原因 |
|---|---|---|
| 自建 SQLite + APScheduler + Web Dashboard | 全自建,完全可控 | 重复造 cron 轮子 |
| 留 OpenClaw 当 cron 引擎 + 自建 PWA | 利用 OpenClaw 已有能力 | OpenClaw schema 不稳、agent 抽象黑盒,加引擎需要绕开 |
| 改用 Claude Code / Codex CLI 自带调度 | 用 CLI 原生能力 | 两边的 native cron 都要 GUI / 云端,server headless 不适用 |
| **Linux cron + 自建轻量 FastAPI + 多引擎** | 50 年稳定 + 完全控制 + 多引擎 | **最终选定** |

主要 review 修订点(从初稿到本稿):
- Codex 从严格 P0 降到 best-effort,避免 CLI 接口不确定阻塞 P0
- P0-7 安全章节从单一"禁止 push main"扩为 7 子项(加 CORS / CSRF / 权限位 / push 鉴权 / 连败 disable)
- 新增 P0-8 可靠性(备份 / 日志轮转 / worktree 清理 / 服务自启)
- 多 agent 详细设计移到 `future/multi-agent-design.md`,P0 不实施
- 时间估算改为依赖序(T+0、T+0.5d、T+1d ...),不用日历日
