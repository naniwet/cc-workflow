# cc-workflow

> 个人 AI 工作流系统:**手机当信号器,服务器当执行引擎**。
>
> 在 PWA 或飞书里发指令 → 服务器跑 Claude Code / Codex → 结果回推。
> Linux cron 可定时触发同样的执行路径(无人值守 loop)。

单用户、单机、4C8G 云服务器够用。代码量约 2000 行(Python + 原生 JS,无 build step)。

---

## 它能干什么

- **PWA**(手机/PC 浏览器都能装):3 个 tab — **Workspaces**(每个 workspace 一条时间线 + 输入框)/ **Tasks**(cron loop 列表)/ **圆桌**(多 agent 辩论)
- **飞书集成**:在群里 `@bot daily-digest 总结一下昨天的 commit` 就能触发,执行完结果以飞书卡片回到群里;`/use` `/where` `/ws` `/sessions` `/loops` `/run` 6 个 slash 命令
- **Linux cron Loop**:每天 9 点拉代码、每小时巡检 PR、隔半小时跑测试都行;PWA 上每个 loop 也能手动点 **Run now**
- **多 provider**:通过 ccswitch-style providers.json 可切到 DeepSeek / Kimi 等 Anthropic 兼容端点
- **每 workspace 独立配置**:provider(可改)+ trust(可改;开启后跳过工具审批)
- **工具审批**(可选):Claude 想跑 Bash / WebFetch 时 PWA 弹 `[Approve] [Deny]`,审批通过才执行(走 Claude Code PreToolUse hook)
- **Slash 命令自动补全**(PWA):在输入框打 `/` 弹出当前 workspace 所有 skill(project + user + plugin 三层来源),Tab 补全
- **DIY 自动 compact**:长对话接近 context 上限时,agent-run 自动调用 9 段式 summary prompt(基于 Claude Code `/compact` 反向工程),清旧 session,新 session 以 summary 续——transparent,你不会感知。撞坏了也有手动 **Reset session** 按钮兜底
- **圆桌会议**(从 [AgentRoundtable](https://github.com/wet-/AgentRoundtable) 移植):4 角色(极简派 / 场景派 / 借鉴派 / 悲观派)+ 1 个整理员,对一个决策级问题辩论 3 轮,输出 **共识点 / 分歧轴 / 判断题**。让你做决定,不替你做决定。

---

## 30 秒看架构

```
            ┌─────────────────┐                ┌──────────────────┐
            │   PWA (手机/PC) │                │   飞书 (群机器人)│
            └────────┬────────┘                └─────────┬────────┘
                     │ HTTPS                              │ webhook
                     ▼                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  FastAPI gateway  (backend/main.py + 8765 端口)       │
        │  - 鉴权: HMAC 签名 session cookie                     │
        │  - /run /loops /workspaces /roundtables /skills        │
        │    /approvals /im/feishu/*                            │
        └────────┬───────────────────────────┬─────────────────┘
                 │ subprocess                │ in-process HTTP
                 ▼                           ▼
   ┌─────────────────────────────┐  ┌────────────────────────┐
   │  agent-run.sh (claude 包装) │  │  roundtable runner     │
   │  + flock 并发锁 + 工具审批  │  │  4 角色 × 3 轮 LLM 调用 │
   │  + DIY auto-compact         │  │  → ~/.cc-state/         │
   │  + session resume           │  │     roundtables/*.jsonl │
   │  → ~/.cc-state/{runs,jobs,  │  │  (DeepSeek + Kimi 直 v1) │
   │     locks,logs}             │  └────────────────────────┘
   └──────────────▲──────────────┘
                  │ 同样的执行路径
                  │
        ┌──────────────────────────────────────────────────────┐
        │  Linux cron  (/etc/cron.d/cc-loops)                  │
        │  每个 cron loop 都是一个 agent-run.sh 调用            │
        └──────────────────────────────────────────────────────┘
```

守护进程只有 2 个:`cc-workflow.service`(FastAPI)+ 系统自带的 `cron`。不上 Redis / Celery / ORM / build step。

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

### 4. 工具审批(可选)

如果某个 ws 没开 trust(默认),Claude 在跑到 Bash / WebFetch 时会暂停,PWA 那条 timeline 上出现 `[Approve] [Deny]` 按钮。点 Approve → Claude 继续;点 Deny → Claude 收到拒绝信号,自己换路或停下。

想全局跳过审批?在 ws 列头点 🔒 → 切到 🔓(琥珀色锁形 = "auto-approve, treat with care")。

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

每 workspace 可以在列头下拉里独立选 provider —— PWA 显示 `profiles` 的 keys。Roundtable 的 4 个角色硬编码在 `roles.py` 里(借鉴派用 Kimi,其他三个 + 整理员用 DeepSeek),不通过 PWA 切。

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
│   └── roundtable/               #   圆桌会议(第三 tab)— 移植自 AgentRoundtable
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
└── docs/                         # 设计文档(历史 + 架构)
    ├── 01-prd.md                 #   PRD(why)
    ├── 02-dev-plan.md            #   开发计划(原始 P0-1 → P0-8)
    ├── 03-test-plan.md           #   测试 playbook
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
| **工具审批模型** | PreToolUse hook → backend 长轮询 → PWA 弹按钮(路 2) | 路 1(`.claude/settings.json` 预批准)和路 3(`bypassPermissions` 全跳过)都保留。trust toggle 让用户在路 2 和路 3 之间一键切。 |
| **per-workspace 配置 vs 全局** | 选 per-workspace,落到 `~/.cc-workflow/workspaces.json` | 全局 fallback 在 `config.toml`(`provider`、`default_trust`)。 |
| **cron loop 触发** | cron 写 `/etc/cron.d/cc-loops`,POST `/loops/{name}/run` 可手动重发一次 | session_key 用 loop 名 → cron-fired 和手动 fired 共享同一个 Claude 会话(对模型来说是连续对话) |
| **PWA 缓存策略** | service worker 网络优先,失败回落缓存 | 频繁发布的开发工具,用户拉新代码就该看到新 UI;缓存只在离线时兜底 |
| **长对话 context 管理** | DIY auto-compact(agent-run 检测 input_tokens > 阈值时,跑 9 段式 summary prompt,清旧 session,新 session 以 summary 开场)+ PWA 手动 reset 按钮 | Claude Code 的 `/compact` 是 TUI-only,headless 不可用。Prompt 模板基于 Piebald-AI 社区反向工程版本(非 Anthropic 官方)。阈值默认 150k,可在 `config.toml` 改 `compact_threshold_tokens`。 |

完整决策演进:[docs/01-prd.md 附录 A](docs/01-prd.md)。

---

## 文档地图

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| **README.md(本文)** | 当前架构 + 怎么用 | 首次接触 / 日常 reference |
| [deploy/INSTALL.md](deploy/INSTALL.md) | 完整部署 step-by-step | 第一次装,或装新机器 |
| [docs/01-prd.md](docs/01-prd.md) | PRD:why、goals、非目标、决策史 | 想加新需求前 / 想理解为什么是这样 |
| [docs/02-dev-plan.md](docs/02-dev-plan.md) | 原始开发计划(Phase 1/2/3) | 想看模块切分 / 接口契约的历史定义 |
| [docs/03-test-plan.md](docs/03-test-plan.md) | 测试 playbook | 改了某模块、想知道该跑什么 |
| [docs/04-handoff.md](docs/04-handoff.md) | T+0 给实现方的 brief | 历史文档,新人不需读 |
| [docs/future/](docs/future/) | P1+ 未实现的设计 | 准备做 multi-agent 等 P1 功能时 |

注:01-04 都是**历史设计文档**。系统当前如何工作以本 README 为准。

---

## 状态

- **Phase 1 + Phase 2 完成**:agent-run + FastAPI gateway + PWA + 飞书 + cron loop + 工具审批 + 多 workspace 配置 + 移动端 UI 全部上线
- **Phase 3 部分**:HTTPS / 自动备份 / 日志轮转 — 见 INSTALL.md §7 选做
- **未做(P1)**:Web Push / 圆桌会议(多 agent 协同)/ Slack 适配 / 钉钉适配

—

## License

私用项目,未声明许可证。如果你要 fork 自用,**先和我聊一下**——我希望避免它被装到不适合的多用户场景上。
