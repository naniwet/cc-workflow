# cc-workflow

> **English TL;DR** *(中文版见下方)*
>
> A personal AI-workflow gateway. Your phone (PWA) or Feishu group sends a
> prompt; a single FastAPI service on a small VPS runs `claude` (Claude Code
> CLI) inside the right git workspace; results come back as a streaming
> timeline in the PWA and as a Feishu card in chat. Linux `cron` triggers the
> same execution path for hands-off recurring loops. A third tab runs an
> in-process "roundtable" — four prompted personas debate a decision-grade
> question across 3 rounds, then a synthesizer summarizes consensus and
> remaining splits.
>
> Single-user, single-machine. Daemons: just the FastAPI service + system
> `cron`. No Redis / Celery / ORM / build step. ~2k LOC of Python + vanilla
> JS. Tested on Ubuntu 22.04 / 24.04 (4C8G is plenty). MIT licensed —
> intended as a reference implementation for your own self-hosted setup, not
> as a multi-tenant SaaS.
>
> Start at [`deploy/INSTALL.md`](deploy/INSTALL.md).

---

> 个人 AI 工作流系统:**手机当信号器,服务器当执行引擎**。
>
> 在 PWA 或飞书里发指令 → 服务器跑 Claude Code → 结果回推。
> Linux cron 可定时触发同样的执行路径(无人值守 loop)。

单用户、单机、4C8G 云服务器够用。代码量约 2000 行(Python + 原生 JS,无 build step)。

---

## 它能干什么

- **PWA**(手机/PC 浏览器都能装):3 个 tab — **Workspaces** / **Tasks** / **Roundtable**;PC 上 manifest `display: fullscreen` + `display_override` 加桌面后无浏览器 UI
  - 每个 workspace:turn-streaming 流式对话(USER prompt + claude 的 thinking/tool_use/tool_result/reply/result 完整 event timeline,跟 workspace overview / cron 详情 / run-detail 共用同一套渲染)
  - 输入框:可在 claude 跑的过程中**继续按 Run 排队**(前端 queue,跑完一条自动 dispatch 下一条),队列卡片可点 × 删除
  - workspace ⚙ menu:Trust 切换 / Pull latest(同时 rebase PWA worktree)/ Sync skills / Show all events 切换 / **Merge session → main + push**(一键把 cc/* 分支 ff-merge 回 main + push origin) / New chat / Delete workspace
  - 创建 workspace / cron / roundtable:都走 `<dialog>` modal,不再占永久空间
- **飞书集成**:在群里 `@bot daily-digest 总结一下昨天的 commit` 就能触发,执行完结果以飞书卡片回到群里;`/use` `/where` `/ws` `/sessions` `/loops` `/history` `/run` `/help` 8 个 slash 命令;cron 跑完也能自动推回飞书(每 loop 独立目的地 + 全局兜底,见下)
- **Linux cron Loop**:每天 9 点拉代码、每小时巡检 PR、隔半小时跑测试都行;PWA 上每个 loop 也能手动点 **Run now**;cron 触发的 run 走 backend → 落 runs.db → PWA Tasks tab 点 task 进 `#tasks/<name>` 详情页看最新 run 的完整 event timeline + **Last 7 sparkline** 健康度可视化
- **多 provider**:通过 ccswitch-style providers.json 可切到 DeepSeek / Kimi 等 Anthropic 兼容端点
- **每 workspace 独立配置**:provider(可改)+ trust(可改;开启后工具调用走 hook auto-approve)
- **工具审批 + 审计**(可选):Claude 想跑 Bash / WebFetch 时 PWA 在对应 turn 末尾弹 `[Approve] [Deny]`(走 PreToolUse hook);trust=on 工作区自动通过,**但仍以 audit event 形式记在 turn 的 event timeline 里**,你能看到 claude 实际执行了哪些工具
- **完整对话 Transcript**:**不再有单独的 Transcript 面板** —— 直接是 turn 的 expanded event timeline(`💭 thinking / 🔧 tool_use / ↳ tool_result / 🤖 reply / ✓ done`),长 `tool_result` 自动折叠为前 5 行 + `↓ Expand N lines` 按钮。默认只显示 `reply + result`,在 ⚙ menu → Display 切 "Show all events" 看 thinking / tool 细节
- **Slash 命令自动补全**(PWA):在输入框打 `/` 弹出当前 workspace 所有 skill(project + user + plugin 三层来源),Tab 补全
- **DIY 自动 compact**:长对话接近 context 上限时,agent-run 自动调用 9 段式 summary prompt(基于 Claude Code `/compact` 反向工程),清旧 session,新 session 以 summary 续——transparent,你不会感知。撞坏了也有 ⚙ menu → **New chat** 按钮兜底(同时**真删** runs.db + log 文件,不再有"刷新一下旧 turn 又冒出来");`--resume` 撞到孤儿 sid 时自动 fallback 到新会话
- **评议**(从 [AgentRoundtable](https://github.com/wet-/AgentRoundtable) 移植):两种 mode 共享同一 jsonl / 整理员 / 续问基础设施。
  - **4 派评议**(广):4 角色(极简派 / 场景派 / 借鉴派 / 悲观派)+ 1 个整理员,对决策问题各抒己见辩论 1-2 轮,输出 **共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动**。审查员判收敛自动追问。
  - **1v1 对抗**(深):二值决策问题 → backend framing 自动拆成正反两个立场 → 2 派 R1 陈述 + R2 反驳 + 整理员综合。适合"做 / 不做"二值场景。
  - 不替你拍板,但把不同价值取向 / 分歧轴两端的行动路径说清楚。

---

## 30 秒看架构

```
            ┌─────────────────┐                ┌──────────────────┐
            │   PWA (手机/PC) │                │   飞书 (群机器人)│
            └────────┬────────┘                └─────────┬────────┘
                     │ HTTPS (Let's Encrypt)              │ webhook
                     ▼                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  FastAPI gateway  (backend/main.py + 127.0.0.1:8765)  │
        │  - 鉴权: HMAC 签名 session cookie                     │
        │  - /run /loops /workspaces /roundtables /skills        │
        │  - /approvals/{,internal/} /loops/.../run/internal     │
        │  - /im/feishu/*                                       │
        └────────┬─────────────────────────────┬───────────────┘
                 │ subprocess                  │ in-process HTTP
                 ▼                             ▼
   ┌─────────────────────────────┐  ┌────────────────────────┐
   │  agent-run.sh (claude 包装) │  │  roundtable runner     │
   │  + flock 并发锁              │  │  4 角色 × 1-2 轮辩论     │
   │  + DIY auto-compact         │  │  → ~/.cc-state/         │
   │  + session resume + 自愈     │  │     roundtables/*.jsonl │
   │  → ~/.cc-state/{runs,jobs,  │  │  (DeepSeek + Kimi 直 v1) │
   │     locks,logs}             │  └────────────────────────┘
   └──────────────▲──────────────┘
                  │ runner.submit (统一入口)
                  │
        ┌─────────┴────────────────────────────────────────────┐
        │  Linux cron  (/etc/cron.d/cc-loops)                  │
        │  每行 curl POST /loops/<name>/run/internal            │
        │  → 落 runs.db → on_finish 推回飞书(可选)             │
        └──────────────────────────────────────────────────────┘
```

守护进程只有 2 个:`cc-workflow.service`(FastAPI)+ 系统自带的 `cron`。不上 Redis / Celery / ORM / build step。

**4 个触发源(PWA / 飞书 / cron / 手动 /run)** 全走同一条 `runner.submit()` 路径,所以每个 run 都进 runs.db、都能在 PWA run-detail 看到、都能挂 on_finish 回调(飞书 push、cron 通知群)。

---

## 5 分钟部署速览

Ubuntu 22.04 / 24.04 云服务器,以 root 跑:

```bash
# 1. 装依赖
apt update && apt install -y python3-venv git nginx cron sqlite3

# 2. 克隆 + venv
mkdir -p /root/projects && cd /root/projects
git clone https://github.com/naniwet/cc-workflow.git
cd cc-workflow
python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn pydantic tomli cryptography

# 3. 配置(详见 deploy/INSTALL.md §2)
mkdir -p /root/.cc-workflow /root/.cc-state /root/workspaces
$EDITOR /root/.cc-workflow/config.toml      # provider 默认 / PWA url
$EDITOR /root/.cc-workflow/secrets.toml     # [ui] username + password
$EDITOR /root/.cc-workflow/providers.json   # 各 LLM 端点 + key

# 4. 装 agent-run + 审批 hook
install -m 755 agent-run.sh /usr/local/bin/agent-run
install -m 755 scripts/cc-approve-hook.sh /usr/local/bin/cc-approve-hook
# .claude/settings.json 写入 PreToolUse 配置——见 INSTALL.md §3.5

# 5. systemd + nginx
install -m 644 deploy/cc-workflow.service /etc/systemd/system/
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/cc-workflow
ln -sf /etc/nginx/sites-available/cc-workflow /etc/nginx/sites-enabled/cc-workflow
systemctl daemon-reload && systemctl enable --now cc-workflow
nginx -t && systemctl reload nginx

# 6. 验证
curl -s http://<server-ip>/healthz   # → {"ok":true}
# 浏览器打开 http://<server-ip>/pwa/  →  登录 → 看到 Workspaces 页
```

完整步骤(含 Feishu webhook、HTTPS、ccswitch-style providers.json 范例、troubleshooting):**[deploy/INSTALL.md](deploy/INSTALL.md)**

---

## 日常使用

### 1. 加 workspace

PWA → Workspaces → `+ New workspace`。填:
- **name**:repo 目录名(字母数字 `.` `_` `-`)
- **provider**:LLM 路由(留空 → 用 config.toml 的全局默认)
- **engine**:固定 `claude`。codex 引擎已于 2026-05-14 下线,见末尾"已知限制"。
- **trust**:勾上 → 自动批准 Bash / WebFetch 等工具(默认不勾,会弹审批)

后端会在 `~/workspaces/<name>/` 创建空目录 + `git init` + first commit。

### 2. 跑一次 agent

PWA → Workspaces → 某 ws 的输入框里写 prompt → Run。或者在飞书群里:

```
@bot daily-digest 总结一下昨天的 commit
```

`daily-digest` 是 workspace 名;不写时落到 secrets.toml 里的 `default_workspace`。

### 3. 加定时任务(cron loop)

PWA → Tasks → `New cron loop`。两种填法:

- **手填 cron 表达式**(标准 5 字段:`0 9 * * *` = 每天 9:00)
- **自然语言**:输入"每天早上 9 点 拉一下最新代码",点 Parse → LLM 同时填好 cron 和 prompt

注:Add 只**注册调度**,不会立即跑一次。要立即试一下点新增的 **Run now** 按钮。

cron 跑完后:
- **PWA**:Tasks tab 的 task 行 → 点进 `#tasks/<name>` 详情页 → 看最新 run 的完整 event timeline(USER prompt + thinking + tool_use + tool_result + reply + done 5 种 event)+ sparkline 健康度。齿轮菜单里有 Run now / Pause / Delete。
- **飞书自动推送**(可选):走以下两条任一通路触发
  - **per-loop 目的地**:用飞书 `/loops new <name> <描述>` + `/loops confirm` 在群里创建的 loop,自动记下当前 chat_id,以后每次 cron 跑完结果推回这个群
  - **全局兜底**:在 `~/.cc-workflow/secrets.toml` 加 `[feishu] cron_notify_chat = "<chat_id>"`,所有 cron loop(包括 PWA 创建的)跑完都推到这个群
  - 两个都没配 → 不推,run 仍正常进 runs.db 和 PWA

### 4. 工具审批(可选)

如果某个 ws 没开 trust(默认),Claude 在跑到 Bash / WebFetch 时会暂停,PWA 在那条 expanded turn 的最末尾出现 `[Approve] [Deny]` 按钮(贴近输入框,scroll-to-bottom 后自然落在视口)。点 Approve → Claude 继续;点 Deny → Claude 收到拒绝信号,自己换路或停下。

想全局跳过审批?进 workspace ⚙ menu → Trust workspace 切 ON(琥珀色锁形 = "auto-approve, treat with care")。

trust=on 也**不是完全没记录**——auto-approved 的每次工具调用会以 `tool_use` event 形式记在 turn 的 event timeline 里。默认 PWA 只显示 reply + result(避免噪音),要看就在 ⚙ menu → Display 切 "Show all events"。所以你能事后看到 claude 实际跑了 `Bash(npx vitest)` / `Write(notes.md)` 等等。

### 5. 多 provider

`~/.cc-workflow/providers.json` 两段:

```json
{
  "profiles": {
    "deepseek": { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "sk-..." } },
    "kimi":     { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_API_KEY":  "sk-..." } }
  },
  "openai_endpoints": {
    "deepseek": { "base_url": "https://api.deepseek.com/v1", "api_key": "sk-..." },
    "moonshot": { "base_url": "https://api.moonshot.cn/v1", "api_key": "sk-..." }
  }
}
```

| 段 | 协议 | 消费方 |
|---|---|---|
| **`profiles`** | Anthropic-compat | `claude` CLI(通过 agent-run.sh)、`backend/llm.py` |
| **`openai_endpoints`** | OpenAI-compat | Roundtable(`backend/roundtable/model.py` 直接 HTTP) |

每 workspace 可以在列头下拉里独立选 provider —— PWA 显示 `profiles` 的 keys。Roundtable 的 4 个角色 + 整理员的 model 名硬编码在 `roles.py` 里(当前 4 角色 + 整理员都用 DeepSeek),不通过 PWA 切。原始设计中借鉴派可切到 Kimi 做跨模型实验,`roles.py` 注释里写了恢复方法。

**想用 Anthropic 原生 OAuth**(本地 `claude login`):在 `profiles` 加一条 `"claude": { "env": {} }`(空 env),再在 `config.toml` 设 `provider = "claude"`。agent-run 看到名字是 claude/anthropic 就跳过 env 注入。默认模板不预置——大部分用户用 DeepSeek/Kimi 兼容端点。

---

## 目录结构

```
cc-workflow/
├── agent-run.sh                  # claude CLI 包装 + 并发锁 + 沙盒 + DIY compact
├── backend/                      # FastAPI gateway
│   ├── main.py                   #   全部 HTTP 路由
│   ├── auth.py                   #   HMAC session cookie 鉴权
│   ├── runner.py                 #   submit() — 把请求落到 subprocess
│   ├── db.py                     #   SQLite (~/.cc-state/runs.db)
│   ├── cron_state.py             #   cron file 读写 + jobs/*.json
│   ├── ws_settings.py            #   per-workspace provider/engine/trust
│   ├── approvals.py              #   工具审批 in-memory 队列 + 长轮询
│   ├── im_feishu.py              #   飞书 webhook + 卡片回复 + slash 命令
│   ├── ui_cards.py               #   Card 抽象(渲染中间层)
│   ├── skills.py                 #   slash command 扫描 (.claude/commands)
│   ├── llm.py                    #   后端直调 LLM(parse-nl 用)
│   └── roundtable/               #   评议(第三 tab)— 移植自 AgentRoundtable;dir 名保留 roundtable
│       ├── roles.py              #     4 个 persona prompt + 整理员(产品 IP)
│       ├── debate.py             #     R1/R2/R3 三轮 orchestrator
│       ├── synth.py              #     R3 整理员 prompt + 解析
│       ├── model.py              #     stdlib urllib OpenAI-compat client
│       ├── runner.py             #     in-process thread launcher
│       └── data.py / io.py       #     dataclasses + jsonl 持久化
├── pwa/                          # 单页前端(原生 JS,无 build)
│   ├── index.html  app.js  style.css
│   ├── login.html                #   /auth/login 登录页
│   ├── manifest.json  sw.js      #   PWA 可装桌面
│   └── icon.svg
├── scripts/
│   ├── install-deps.sh           #   T+0 装依赖(claude / jq ...)
│   └── cc-approve-hook.sh        #   Claude PreToolUse hook(工具审批)
├── deploy/
│   ├── INSTALL.md                #   ← 完整部署文档
│   ├── cc-workflow.service       #   systemd unit
│   └── nginx.conf                #   反向代理 + 静态 /pwa/ 服务
└── docs/archive/                 # 历史设计文档(why & 决策回溯,非当前架构)
    ├── 01-prd.md                 #   原始 PRD
    ├── 02-dev-plan.md            #   原始开发计划(P0-1 → P0-8)
    ├── 03-test-plan.md           #   原始测试 playbook
    ├── 04-handoff.md             #   T+0 给实现方的 brief
    └── future/                   #   P1 未实现的设计(multi-agent 等)
```

外部状态在 `~/.cc-state/`:`runs.db` + `jobs/*.json`(cron loop 计数器)+ `locks/`(flock 并发锁)+ `logs/`(每 run 的 jsonl)。
外部配置在 `~/.cc-workflow/`:`config.toml` + `secrets.toml` + `providers.json` + `workspaces.json` + `.session-secret`(自动生成)。

---

## 已知限制

**codex 引擎已下线(2026-05-14)**。只支持 Claude Code (`claude` CLI)。

原因:codex-cli 0.130+ 上游[废弃了 `wire_api = "chat"`](https://github.com/openai/codex/discussions/7782),DeepSeek / Kimi 等非 OpenAI 端点没有 `/v1/responses`,导致 codex + 非 OpenAI 在 0.80.0 之后结构性不可用。

如果未来想恢复 codex(任一条件满足):
- DeepSeek/Kimi 实现了 `/v1/responses` 端点
- 或通过 [VibeAround](https://github.com/jazzenchen) 这种 Responses↔Chat 代理转接
- 或 pin `@openai/codex@0.80.0`(陈旧,不推荐)

恢复操作:参考 git 历史 commit `f15d830`(完整 codex 实现)+ `8d5f648`(PWA 隐藏);代码已删除,从 git revert 找回即可。

—

## 当前架构关键决策

按反悔成本从高到低:

| 决策 | 选了什么 | 代价 / 何时翻案 |
|---|---|---|
| **鉴权模型** | HMAC 签名 session cookie(30 天) | Phase 1 时是 HTTP Basic,后来发现在 Quark / 微信内置浏览器对 `WWW-Authenticate` 处理不一致,Phase 2 后期换。HMAC key 自动生成于 `~/.cc-workflow/.session-secret`。 |
| **工具审批 + trust 模型** | 两层串联:L1 `~/.claude/settings.json#permissions.allow` 全局 allow 14 个内置 tool(Bash / Read / Write / ...); L2 PreToolUse hook 按 trust=on/off 决定 auto-approve 还是弹 PWA `[Approve][Deny]`。**trust=on 也会经过 backend,自动审批后写进 Approvals 面板 audit ring buffer**(read-only)。 | 早期 per-workspace `.claude/settings.local.json` 不被 git worktree 看到,2026-05-15 改成 user-global。GH claude-code#20449 的 file-modifying Bash 偶尔仍会弹审批,**这是 claude 上游 bug,不归我们管**;真受不了就走 [`deploy/MIGRATE-TO-NONROOT.md`](deploy/MIGRATE-TO-NONROOT.md) 切非 root + bypassPermissions。 |
| **cron 触发路径** | cron 行用 `curl POST /loops/{name}/run/internal`(localhost-only,nginx deny 外部),backend 走 `runner.submit()` 跟 PWA / 飞书统一路径 | 早期是 cron 直接调 agent-run,bypass 整个 backend,cron-fired run 既不进 runs.db 也不能挂 on_finish。2026-05-15 重构;启动时 `cron_state.rewrite_legacy_cron_lines()` idempotent 迁移老格式。 |
| **per-workspace 配置 vs 全局** | 选 per-workspace,落到 `~/.cc-workflow/workspaces.json` | 全局 fallback 在 `config.toml`(`provider`、`default_trust`)+ `secrets.toml`(`[feishu] cron_notify_chat` 兜底 cron 通知群)。 |
| **PWA 缓存策略** | service worker 网络优先 + 强制 `cache: 'no-store'` 绕过浏览器 HTTP cache | 频繁发布的开发工具,nginx `expires 1h` 会让浏览器服坏掉的旧 app.js 给新 SW(turning network-first into cache-first under the hood);SW 自己的 cache.open(VERSION) 是唯一的离线兜底。 |
| **长对话 context 管理** | DIY auto-compact(agent-run 检测 input_tokens > 阈值时,跑 9 段式 summary prompt,清旧 session,新 session 以 summary 开场)+ PWA 手动 reset 按钮;`--resume <stale-sid>` 撞到 claude 内部 session 不存在时自动重试 | Claude Code 的 `/compact` 是 TUI-only,headless 不可用。Prompt 模板基于 Piebald-AI 社区反向工程版本(非 Anthropic 官方)。阈值默认 150k,可在 `config.toml` 改 `compact_threshold_tokens`。 |
| **Turn-streaming UI 模式统一**(2026-05 重构) | 所有"对话视图"(workspace overview 卡片 / workspace detail / `#runs/<id>` / cron `#tasks/<name>`)都复用同一套 `_workspaceTurnHtml` + `_loadTurnEvents`,从 `/runs/{id}/tail` 拉 stream-jsonl 解析成 thinking/tool_use/tool_result/text/result 5 种结构化 event 卡片。 | 之前 run-detail 是独立 5 段堆叠 UI(Prompt / Output / Approvals 折叠 / Transcript 折叠 / Live output),维护双份。统一后净删 ~840 行死代码,事件渲染规则只改一处。代价:`_patchWorkspaceCard` 老 diff-patch 算法弃用,各视图改全量重画 —— refreshAll 的 hash 去重让性能开销可控。 |
| **Prompt 队列**(纯前端) | workspace 已有 run 在跑时,用户继续按 Run → 前端 `_promptQueue[ws]` 入队 + 弹"已排队"toast;当前 run 完成 → `_dispatchAllQueues` 自动 pop 队头发出去。每条可点 × 删。 | 后端 `POST /run` 在 workspace busy 时会 409(`active_in_workspace` 检查),不肯排队 —— 前端攻略性地避免触发。状态 in-memory(刷新即丢,可接受);PWA "I want to type 5 messages while it's running" 的体验从"5 个 409 报错"变"5 个排队 + 串行 dispatch"。 |
| **PWA session worktree 双向同步** | PWA session 跑在 `~/workspaces/.wt/<ws>-pwa-<ws>/` 独立 worktree(分支 `cc/<ws>-pwa-<ws>`,见 PRD §A8 worktree 隔离),跟主 worktree 的 main 分支不会自动同步。⚙ menu 加两个对称按钮:**Pull latest** = `git pull --ff-only` 主 worktree 然后 `git rebase main` PWA worktree;**Merge session → main + push** = rebase cc/* 到 main 然后 ff-merge + push origin。 | 之前 Pull latest 只 pull 主 worktree,PWA session 的 worktree 还停在老 commit,claude 下次跑看不到上游更新。现在两个对称 endpoint 把"我在 PWA 里说的话怎么进到 main / 怎么从 main 拿新代码"两个方向都覆盖了。 |

完整决策演进:[docs/archive/01-prd.md 附录 A/B](docs/archive/01-prd.md)。

---

## 文档地图

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| **README.md(本文)** | 当前架构 + 怎么用 | 首次接触 / 日常 reference |
| [deploy/INSTALL.md](deploy/INSTALL.md) | 完整部署 step-by-step | 第一次装,或装新机器 |
| [deploy/MIGRATE-TO-NONROOT.md](deploy/MIGRATE-TO-NONROOT.md) | Plan B:切非 root 跑(为 claude-code#20449 兜底) | trust=on 频繁被 file-modifying Bash 命令挡住时 |
| [docs/feishu-usage.md](docs/feishu-usage.md) | 飞书端完整使用说明(slash 命令清单 / 触发 / 评议推送 / 排错) | 配好飞书集成后,日常使用查询 |
| [docs/archive/](docs/archive/) | 历史设计文档(PRD / dev-plan / test-plan / handoff / future) | 想理解某个决策**为什么**当时那样定 / 想看 P1 未实现的设计 |

注:`docs/archive/` 是**历史快照**,实施期间有偏离(见 archive 内每个文件顶部的"历史文档警示")。系统当前如何工作以本 README 为准。

---

## 状态 & 范围

- 当前**单用户、单机**已稳定运行;接口、PWA、cron loop、工具审批、评议(4 派 / 1v1)、auto-compact 都在用
- Ubuntu 22.04 / 24.04 上验证过;4C8G VPS 跑得轻松
- **不打算做的事**:多租户、SSO、kubernetes 化、SaaS 化、Cloud Routines 集成。这是一份给"想自己 host 一套类似工作流"的人的参考实现,不是 SaaS 产品

—

## License

MIT — 见 [LICENSE](LICENSE)。

注:这是个**单人自用工具**。代码本身按 MIT 开放,但作者**不主动接 PR / issue / 多用户支持请求**。鼓励你 fork 自己改、不用问;有 bug 就在自己 fork 修。本项目对你最有用的姿势是当"参考实现"读,不是当"上游依赖"用。
