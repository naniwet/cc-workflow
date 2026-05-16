# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 仓库工作语言:**简体中文**(对话、注释、commit message 都用中文)。
> 上层 `/Users/wet/work/workspace/CLAUDE.md` 定义了工程方法论(Unix / TDD / 架构思维),本文件只补**本项目特有**的信息,不重复方法论。

---

## 项目本质

单用户、单机的个人 AI workflow gateway。FastAPI 后端 + 原生 JS PWA + 飞书 webhook + Linux cron,4 条触发链共用一条 `backend/runner.py:submit()` 执行路径,后端通过 subprocess 调 `claude` CLI(经 `agent-run.sh` 包装)。

**无 build step**(Python + 原生 JS),**无 ORM / Redis / Celery**。守护进程只有 2 个:`cc-workflow.service` (uvicorn) + 系统 `cron`。

---

## 常用命令

### 语法检查(本地 mac dev box 唯一能跑的"验证")

```bash
# Python 后端:全部模块编译检查
python3 -m py_compile backend/*.py backend/roundtable/*.py

# 单文件 AST 检查(更安静)
python3 -c "import ast; ast.parse(open('backend/main.py').read()); print('OK')"

# Bash 脚本语法
bash -n agent-run.sh
bash -n scripts/cc-approve-hook.sh

# 前端 JS 语法(不执行,只 parse)
node --check pwa/app.js
```

### Acceptance 测试(只在服务器上能跑)

```bash
# P0-1 验收套件 — 需要真实 claude CLI + Linux flock + ~/workspaces/test-repo
bash tests/test_agent_run.sh
```

Mac 上跑不了(缺 `flock` + `claude` 二进制)。改动 `agent-run.sh` 后必须 ssh 到服务器跑一遍。

### 服务器部署 / 重启

```bash
# 拉新代码后重启后端(只动 backend/* 或 deploy/*.service 时)
systemctl restart cc-workflow

# 改了 agent-run.sh 后重新安装到 /usr/local/bin
install -m 755 agent-run.sh /usr/local/bin/agent-run

# 改了 pwa/* 不需要重启,SW 网络优先策略下浏览器刷新即拿到新版

# 改了 .service / nginx.conf 后
systemctl daemon-reload && systemctl restart cc-workflow
nginx -t && systemctl reload nginx

# 看后端日志
journalctl -t cc-workflow -f
```

### 启动单机后端(开发用)

```bash
# 不通过 systemd,直接跑 uvicorn(便于看 traceback)
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765 --reload
```

---

## 架构关键事实(读完这几条再动代码)

### 1. 4 个触发源 → 1 条统一执行路径

| 来源 | 入口 | 落点 |
|---|---|---|
| PWA `Run` 按钮 | `POST /run` | `runner.submit()` |
| 飞书 `@bot ...` | `POST /im/feishu/webhook` | `runner.submit()` |
| Linux cron | `POST /loops/{name}/run/internal`(localhost-only,nginx deny 外部) | `runner.submit()` |
| 飞书 `/run` slash | `_handle_slash` → `runner.submit()` | 同上 |

**所有 run 必须走 `runner.submit()`**,这样才会:落 `runs.db`、注册到 PWA run-detail、挂 `on_finish` 回调(飞书推送 / cron 通知群)。

绝对不要让某个新触发器 bypass runner 直接 spawn `agent-run`。早期 cron 就这么干过,2026-05-15 才重构。

### 2. 状态分散在两个目录

| 路径 | 内容 | 谁写 |
|---|---|---|
| `~/.cc-workflow/` | 配置:`config.toml` / `secrets.toml` / `providers.json` / `workspaces.json` / `.session-secret` | 人工编辑 + backend 增删 workspace |
| `~/.cc-state/` | 运行时:`runs.db` (SQLite) / `jobs/*.json`(cron 计数器)/ `locks/*.lock` (flock) / `logs/*.jsonl`(每 run stream) | backend + agent-run.sh |

`config.py` 读 `~/.cc-workflow/`,`db.py` 读 `~/.cc-state/runs.db`,`runner.py` 写 `~/.cc-state/{logs,locks}`。**不要把这两个目录混用**。

### 3. 权限模式只有 4 个

Claude Code CLI 的 `--permission-mode` 合法值**只有** `default / acceptEdits / plan / bypassPermissions`。

历史教训:`dontAsk` 和 `auto` 是 LLM 幻觉,曾被错误地 hardcode 进 `agent-run.sh` 和 `ws_settings.py:permission_mode_for()`。已在 2026-05-15 修复并加注释警告。**不要再加回来**。

### 4. trust 是两层串联,不是单点开关

- **L1**:`~/.claude/settings.json#permissions.allow` 全局 allow 14 个内置 tool(Bash / Read / Write / Edit / Glob / Grep / WebFetch / ...)。由 `ws_settings.sync_global_allow_rules` 在 backend 启动时写入,**不要手编**。
- **L2**:PreToolUse hook(`scripts/cc-approve-hook.sh`)按 workspace 的 `trust=on/off` 决定:
  - trust=off → PWA 弹 `[Approve] [Deny]`,长轮询 `backend/approvals.py`
  - trust=on → 自动 approve,**但仍写 audit ring buffer**(read-only,run-detail Approvals 面板显示)

trust=on 的 audit trail 是有意保留的——用户能事后看到 claude 实际跑了哪些工具。**不要为了"加速"删掉 audit 写入**。

### 5. PWA SW 是网络优先 + 强制绕过浏览器 cache

`pwa/sw.js` 用 `fetch(request, { cache: 'no-store' })` 强制绕过浏览器 HTTP cache。这是经验教训:nginx `expires 1h` + cache-first SW 会让用户拿到坏的旧 `app.js`。改 SW 策略前先读 `pwa/sw.js` 的注释,**特别是 HTTPS 迁移后那段"newWsProviderPicker fix"故事**。

发布新 SW 必须 bump `VERSION` 常量。

### 6. 长对话:DIY auto-compact

`agent-run.sh` 检测 `input_tokens > 阈值`(默认 150k,可在 `config.toml#compact_threshold_tokens` 改)时,自动跑 9 段式 summary prompt 清旧 session,新 session 以 summary 续。

**Prompt 模板是 Piebald-AI 社区反向工程版本,不是 Anthropic 官方**——升级 claude CLI 后建议在 staging 验证一次。改这个 prompt 时,先读 `agent-run.sh` 里 `_auto_compact` 那段注释。

### 7. 通用语言(术语统一,几乎不可逆)

| 术语 | 含义 |
|---|---|
| `workspace` | `~/workspaces/<name>/` 的一个 git repo。**不是** "session" / "project"。 |
| `run` | 一次 `agent-run` 调用。有 `run_id`,落 `runs.db`。 |
| `session` | Claude CLI 的内部 session id(`sid`)。一个 workspace 可以连续若干 runs 复用同一个 session(`--resume`)。**run ≠ session**。 |
| `loop` | 一个 cron 行 + 关联 prompt。`/etc/cron.d/cc-loops` 一行一个。 |
| `provider` | `providers.json` 里一个 entry。**不是** "engine"——engine 当前只有 `claude` 一种。 |

新代码不要引入 `task` / `job` / `chat` 等同义词。改名要全代码库 + telemetry + 文档一起改。

---

## 代码导航(只列"读多个文件才搞得清"的部分)

- **HTTP 路由全在 `backend/main.py`**——~1300 行单文件,**不要拆**(单用户单机项目刻意避免过度分层)。改路由先 `grep -nE "^def " backend/main.py` 找位置。
- **`backend/runner.py:submit()`** 是所有 run 的唯一入口。第一次读代码先从这里追,会看到它怎么:加 flock → 启 subprocess → tail stdout → 写 `runs.db` → 触发 `on_finish` 回调。
- **`backend/im_feishu.py:_handle_slash()`** 是飞书 slash 命令的 dispatch。新增命令必须同时改 `_HELP_TEXT`(在同一文件里)。
- **`backend/ws_settings.py:permission_mode_for()`** 是 trust 模型的真相源——给定 workspace + 当前 uid,返回 4 个合法 mode 之一。改逻辑前读 docstring(包含 dontAsk 幻觉的教训)。
- **`backend/roundtable/`** 是 in-process 移植的圆桌会议子系统,与主链路完全独立(不走 agent-run.sh,不进 runs.db,自己持久化到 `~/.cc-state/roundtables/*.jsonl`)。改这部分不影响主链路。

---

## 复杂度边界(不要越线)

按 CLAUDE.md 方法论 §3.3,本项目**刻意拒绝**以下"将来可能有用"的复杂度:

- ❌ ORM(直接 `sqlite3` + `db.py` 写 SQL)
- ❌ 任务队列 / Celery / Redis(`runner.submit()` 直接 fork subprocess + flock)
- ❌ 前端 build(原生 JS + `<script>` 标签直接引)
- ❌ 配置自动发现(workspace / loop / provider 都显式注册)
- ❌ 抽象基类 `BaseRunner` / `BaseTrigger`(`if-else` 够用)
- ❌ 多租户 / SSO / k8s 化(单用户单机,见 README §状态 & 范围)

加新能力前,先看是不是和这些边界冲突——是的话需要明确写出 trade-off。

---

## 文档地图

| 文件 | 什么时候读 |
|---|---|
| `README.md` | 想理解整体怎么用 / 给外部人讲项目 |
| `deploy/INSTALL.md` | 第一次部署,或换机器 |
| `deploy/MIGRATE-TO-NONROOT.md` | 想切非 root 跑(claude-code#20449 兜底) |
| `docs/feishu-usage.md` | 飞书端 slash 命令清单 / 触发 / 排错 |
| `docs/archive/` | 想理解某个决策**为什么**当时那样定。注意:**历史快照,实施期间有偏离**,当前架构以 README 为准 |
