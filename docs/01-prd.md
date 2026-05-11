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
| **N3**. PC 桌面原生 app | PWA 在桌面浏览器同样工作 |
| **N4**. 自建 LLM 路由 / 自动选 agent | 显式选择更好,自动路由是后期可选 |
| **N5**. 替代 Claude iOS App | 官方 app 已成熟;这个项目解决官方不覆盖的:飞书集成、多引擎、自建 Loop |
| **N6**. 重新发明 cron / IM 协议 | Linux cron + Feishu/钉钉 webhook 已稳定 |

---

## 4. User Stories

> **⚠ Disclaimer**: 下列场景是 PRD owner 推测,**不是用户真实表述**。开工前应由用户确认或修正。如场景不准,P0 优先级可能错。

### 通勤场景(推测高频)
- 作为开发者,在地铁上 5 秒内触发"修复 repo1 bug",继续看视频,5 分钟后 push 通知

### 监控场景(推测每日)
- 作为开发者,每天 9:03 飞书/PWA 收到 4 个 repo 昨日活动综合简报
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
| **Phase 1: 核心闭环验证** | P0-1 / P0-2 / P0-3 / P0-4 + 简陋 HTML 触发页 | Mac 浏览器 + 飞书都能端到端触发任务、看到 PR(**A0** 验证) |
| **Phase 2: 移动端化** | P0-5(PWA) / P0-6(Web Push) | PWA 装到 iPhone 桌面 + 触发任务 + 收到 Push(**A0'** 验证) |
| **Phase 3: 稳定化** | P0-7(安全 7 项) / P0-8(可靠性 4 项) | 全部 sub-item acceptance 过 |

#### 为什么分 3 阶段

PWA + Web Push 是 P0 里最 fragile 的层(iOS Safari 16.4+、VAPID、service worker、HTTPS、manifest 各种坑)。**叠在没经过端到端验证的 backend 上同时调试,bug 定位时间至少 2x**。

正确顺序:
1. 先用 Mac 浏览器 + 简陋 HTML 页面验证 backend / agent-run / cron / Feishu 全通 → 这是产品假设验证(核心闭环 work 不 work)
2. 闭环通过后再上 PWA / Push → 这时候是把验证过的能力做移动端化,不是同时验证两件事
3. 最后做安全 / 可靠性 → 在功能 stable 之后做硬化最合适

#### Phase 1 简陋 HTML 的设计约束

**故意不做 PWA-grade UX**:
- 单个 HTML 页面 + 内嵌 JS,无 manifest 无 service worker 无 push
- 只有:触发表单(workspace 选择、prompt 输入、Run 按钮)+ 活跃 session 列表 + 最近完成列表
- 视觉丑到你不想长期用 — **这是设计意图**,让你有动力进 Phase 2

放在 backend 自己的静态目录里(`backend/static/index.html`),Mac 直接浏览器打开。

#### Phase 1 Gate (A0)

Phase 1 完成判定:

- [ ] **A0.1** Mac Chrome 打开 `http://<server>/`(或 HTTPS 同源)看到简陋触发页
- [ ] **A0.2** 页面点 Run 触发任务,几分钟内看到完成 + PR URL
- [ ] **A0.3** 飞书发"在 repo1 加 README" → 飞书收到回复 + PR
- [ ] **A0.4** 配 1 个 cron loop(每分钟),状态文件正确更新

**A0 全过才能进 Phase 2**。否则修 backend / agent-run / cron / Feishu 直到 A0 通过。

#### Phase 2 Gate (A0')

Phase 2 完成判定:

- [ ] **A0'.1** iPhone Safari 装到桌面,启动看 PWA(不是浏览器 chrome)
- [ ] **A0'.2** PWA 触发任务,1-3 分钟内 phone 锁屏弹 Web Push,含 PR 链接
- [ ] **A0'.3** 点 Push 跳进 PWA 看完整输出

**A0' 全过才能进 Phase 3**。

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
  - **实测数据点 (2026-05-11, server)**: `provider=deepseek` 下 3.1.3 session resume **严格 PASS**(超出 best-effort 基线)— DeepSeek 的 anthropic-compatible endpoint 实际实现了 `session_id` 上下文恢复。Kimi 暂未实测。
- [ ] **A1.2** 第 4 个并发立即 exit 65
- [ ] **A1.3** push main attempt → exit 67
- [ ] **A1.4 [best-effort]** `agent-run --engine=codex` smoke 跑通(命令存在 + 能返回结果);不通过不阻塞 P0

#### P0-2: Linux cron + 状态文件 **[Phase 1]**

每个 cron job 写状态到 `~/.cc-state/jobs/<name>.json`:lastRun, lastExit, consecutiveErrors, lastError, enabled。

**acceptance**:
- [ ] **A2.1** cron job 触发后状态文件正确更新
- [ ] **A2.2** 连败 ≥ 3 自动写 enabled=false(与 P0-7 联动)

#### P0-3: FastAPI Gateway **[Phase 1]**

端点:`/run` `/runs/{id}` `/sessions` `/loops/*` `/push/subscribe` `/im/feishu/webhook` `/healthz`

SQLite 持久化 (`~/.cc-state/runs.db`)

**acceptance**:
- [ ] **A3.1** `POST /run` 返回 < 100ms
- [ ] **A3.2** `GET /sessions` 显示活跃 worker
- [ ] **A3.3** 重启后历史 task 仍可查

#### P0-4: Feishu IM Adapter **[Phase 1]**

webhook 接收 + 签名校验 + 反向 reply

**acceptance**:
- [ ] **A4.1** 飞书发"在 repo1 加 README" → 收到回复 + PR 链接
- [ ] **A4.2** 多轮对话 session 连续(`--resume` 工作)

#### P0-5: PWA 信号器 **[Phase 2]**

> Phase 2 是把 Phase 1 的简陋 HTML 升级成完整 PWA — 加 manifest、service worker、移动端布局、模板库。

manifest + service worker;移动端友好布局;触发任务 + 查看状态 + 模板库。

**acceptance**:
- [ ] **A5.1** iOS Safari "添加到主屏幕" 后,启动是 PWA 不是浏览器
- [ ] **A5.2** PWA 触发任务,30 秒内任务开始执行

#### P0-6: Web Push 通知 **[Phase 2]**

VAPID + 订阅 + 完成时推送

**acceptance**:
- [ ] **A6.1** PWA 订阅成功,db 有记录
- [ ] **A6.2** 任务完成 15 秒内 push 到达 phone

#### P0-7: 安全护栏(7 子项)**[Phase 3]**

| # | 子项 | 内容 |
|---|---|---|
| 7a | **禁止 push main** | agent-run 检查 + GitHub branch protection 双保险 |
| 7b | **API 用量软告警** | 日 token 估算超阈值(默认 $30/天)→ push 告警 |
| 7c | **CORS** | 后端只允许 PWA 同源 + 飞书 webhook 来源 |
| 7d | **CSRF token** | PWA POST 请求必须带 CSRF token,与 cookie 双重校验(double-submit) |
| 7e | **Log / Secret 权限** | `~/.cc-state/logs/` 权限 `0700`,`~/.cc-workflow/secrets.toml` + `~/.cc-workflow/providers.json` 权限 `0600` |
| 7f | **Push 订阅 auth** | `/push/subscribe` 必须带 PWA 会话 token,防止外部劫持订阅 |
| 7g | **连败自动 disable** | cron job 连败 ≥ 3 自动 enabled=false + push 告警 |

**acceptance**:
- [ ] **A7.1** push main 阻断(exit 67)
- [ ] **A7.2** 模拟超阈值 → 告警 push
- [ ] **A7.3** 跨 origin 调用 `/run` → 403
- [ ] **A7.4** 不带 CSRF token → 403
- [ ] **A7.5** `ls -la ~/.cc-workflow/{secrets.toml,providers.json}` 都显示 `-rw-------`
- [ ] **A7.6** 未授权 `/push/subscribe` → 401
- [ ] **A7.7** 连败 3 次自动 disable + 告警

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
| P1-1 | **Codex 引擎深度集成**(--resume 等价、错误处理、stream 输出对齐) |
| P1-2 | agent-run 接入 GPT 等纯 chat-mode 模型(OpenAI-compatible SDK)。**DeepSeek / Kimi 在 P0-1 已经作为 claude code 的 LLM 后端覆盖**,P1 这里只剩没有 anthropic-compatible 桥的模型(GPT、Qwen 等) |
| P1-3 | **Multi-agent 协同讨论** — 详细设计见 [`future/multi-agent-design.md`](future/multi-agent-design.md),**P0 不实现** |
| P1-4 | DingTalk IM Adapter(沿用 Feishu 形态,~120 行) |
| P1-5 | Dashboard 模板库整合到 PWA |
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
| PWA 周启动次数 | ≥ 10 |
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
- **Q4** [security] 服务器能上 HTTPS(let's encrypt / cloudflare)吗?PWA / Web Push 都要

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

### Phase 2: 移动端化

```
T+2.5d        PWA manifest + service worker + 移动布局
T+3d          Web Push (VAPID + 订阅 + 推送)
T+3.5d        iPhone 装桌面 + Push 端到端验证
─── A0' Gate: phone 上完整体验 work ───
```

**A0' 不过,不许进 Phase 3**(或者降级 Phase 2 部分功能再继续)。

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
| Web Push 在 iOS 不稳 | 高 | 中 | **iOS Safari 16.4+ 才支持**;不行 fallback 飞书 push |
| 失控 Loop 烧 token | 高 | 中 | 软告警 + 连败 3 disable + 日 cost 上限 |
| 自动改 main 灾难 | 极高 | 低 | 双重防护:GH branch protection + agent-run exit 67 |
| SQLite 文件损坏 | 中 | 低 | **P0-8 每日 backup 已覆盖** |
| OpenClaw / 自建 cron 字段冲突 | 低 | 低 | 本方案不依赖 OpenClaw,与之平行运行不冲突 |
| PWA 在公司网络下连不上 server | 中 | 中 | 可选 cloudflare tunnel / VPN |
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

### D4: PWA 主入口 + IM 辅助
- 收益:UX 自控 + 复用 IM
- 代价:维护两套入口(边际成本低)

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
- PWA 主入口

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
