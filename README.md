# cc-workflow

> 个人 AI 工作流系统:**手机当信号器,服务器当执行引擎**。
>
> 在 PWA 或飞书里发指令 → 服务器跑 Claude Code / Codex → 结果回推。
> Linux cron 可定时触发同样的执行路径(无人值守 loop)。

单用户、单机、4C8G 云服务器够用。代码量约 2000 行(Python + 原生 JS,无 build step)。

---

## 它能干什么

- **PWA**(手机/PC 浏览器都能装):4 列 Workspaces 视图 + Tasks(cron)视图,实时看每个 workspace 的 agent 运行状态
- **飞书集成**:在群里 `@bot daily-digest 总结一下昨天的 commit` 就能触发,执行完结果以飞书卡片回到群里
- **Linux cron Loop**:每天 9 点拉代码、每小时巡检 PR、隔半小时跑测试都行
- **多引擎**:Claude Code(主)+ Codex(辅);通过 ccswitch-style providers.json 可切到 DeepSeek / Kimi 等 Anthropic 兼容端点
- **每 workspace 独立配置**:engine(创建后不可改)+ provider(可改)+ trust(可改;开启后跳过工具审批)
- **工具审批**(可选):Claude 想跑 Bash / WebFetch 时 PWA 弹 `[Approve] [Deny]`,审批通过才执行(走 Claude Code PreToolUse hook)

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
        │  - /run /loops /workspaces /approvals /im/feishu/*    │
        └─────────────────────────┬────────────────────────────┘
                                  │ subprocess
                                  ▼
        ┌──────────────────────────────────────────────────────┐
        │  agent-run.sh  (Claude / Codex 多引擎包装 + 并发锁)  │
        │  - PreToolUse hook → /approvals/internal/* 长轮询      │
        │  - 写状态到 ~/.cc-state/{runs,jobs,locks,logs}        │
        └──────────────────────────────────────────────────────┘
                                  ▲
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
- **engine**:`claude` 或 `codex`(**创建后不可改**;想换 engine 就新建一个)
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

`~/.cc-workflow/providers.json` 是 ccswitch 风格:

```json
{
  "active": "deepseek",
  "profiles": {
    "claude":   { "env": {} },
    "deepseek": { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "sk-..." } },
    "kimi":     { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "sk-..." } }
  }
}
```

每 workspace 可以在列头的下拉里独立选 provider。`claude` profile 因为不带 token(用 Anthropic 原生 OAuth),只能本地 `claude login` 后被 agent-run 使用,不能从后端被驱动——所以不出现在 PWA dropdown 里。

---

## 目录结构

```
cc-workflow/
├── agent-run.sh                  # 多引擎包装(claude / codex)+ 并发锁
├── backend/                      # FastAPI gateway
│   ├── main.py                   #   全部 HTTP 路由
│   ├── auth.py                   #   HMAC session cookie 鉴权
│   ├── runner.py                 #   submit() — 把请求落到 subprocess
│   ├── db.py                     #   SQLite (~/.cc-state/runs.db)
│   ├── cron_state.py             #   cron file 读写 + jobs/*.json
│   ├── ws_settings.py            #   per-workspace provider/engine/trust
│   ├── approvals.py              #   工具审批 in-memory 队列 + 长轮询
│   ├── im_feishu.py              #   飞书 webhook + 卡片回复
│   ├── ui_cards.py               #   Card 抽象(渲染中间层)
│   └── llm.py                    #   后端直调 LLM(parse-nl 用)
├── pwa/                          # 单页前端(原生 JS,无 build)
│   ├── index.html  app.js  style.css
│   ├── login.html                #   /auth/login 登录页
│   ├── manifest.json  sw.js      #   PWA 可装桌面
│   └── icon.svg
├── scripts/
│   ├── install-deps.sh           #   T+0 装依赖(claude / codex / jq ...)
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

## 当前架构关键决策

按反悔成本从高到低:

| 决策 | 选了什么 | 代价 / 何时翻案 |
|---|---|---|
| **鉴权模型** | HMAC 签名 session cookie(30 天) | Phase 1 时是 HTTP Basic,后来发现在 Quark / 微信内置浏览器对 `WWW-Authenticate` 处理不一致,Phase 2 后期换。HMAC key 自动生成于 `~/.cc-workflow/.session-secret`。 |
| **工具审批模型** | PreToolUse hook → backend 长轮询 → PWA 弹按钮(路 2) | 路 1(`.claude/settings.json` 预批准)和路 3(`bypassPermissions` 全跳过)都保留。trust toggle 让用户在路 2 和路 3 之间一键切。 |
| **per-workspace 配置 vs 全局** | 选 per-workspace,落到 `~/.cc-workflow/workspaces.json` | 全局 fallback 在 `config.toml`(`provider`、`default_trust`)。engine 一旦创建不可改——避免历史 run 的语义漂移。 |
| **cron loop 触发** | cron 写 `/etc/cron.d/cc-loops`,POST `/loops/{name}/run` 可手动重发一次 | session_key 用 loop 名 → cron-fired 和手动 fired 共享同一个 Claude 会话(对模型来说是连续对话) |
| **PWA 缓存策略** | service worker 网络优先,失败回落缓存 | 频繁发布的开发工具,用户拉新代码就该看到新 UI;缓存只在离线时兜底 |

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
