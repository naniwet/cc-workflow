# Dev Plan — P0 实施

> ⚠ **历史文档警示**:
> 这是开工前的实施计划。Phase 1+2 已完成,**实际实现的文件清单 / 接口契约 / Phase 2 顺序 都与本文档偏离**:
> - **多了**: `backend/approvals.py` `backend/auth.py` `backend/llm.py` `backend/skills.py` `backend/ws_settings.py` `backend/roundtable/*` `pwa/login.html` `scripts/cc-approve-hook.sh`
> - **少了**: `backend/csrf.py`(改为 HMAC auth)、原 `backend/push.py`(从未实现)
> - **变了**: 鉴权 Basic → HMAC session cookie;workspaces 从硬编码 4 个改为 `workspaces.json` 动态;auto-compact / 圆桌 等新增功能
>
> **看代码当真,看本文档当历史**。仓库根目录 [`README.md`](../../README.md) 是当前架构 source of truth。

> ⚠ **历史文档 — 本文件是 Phase 1/2 开工前的实施计划**。
> Phase 1/2 实施过程中部分接口契约和模块边界已经演化(尤其鉴权、工具审批、
> per-workspace 配置)。**系统当前如何工作以仓库根目录的 [`/README.md`](../../README.md)
> 和代码为准**;本文件保留为决策演进的历史快照,代码注释里出现的
> `dev-plan §X` 引用应理解为"那一节是当时的设计起点",不一定还反映现状。

> **配套**: [01-prd.md](01-prd.md)(why & what)、[03-test-plan.md](03-test-plan.md)(怎么验证)、[04-handoff.md](04-handoff.md)(角色与约定)
> **范围**: 仅 PRD §6.1 的 8 个 P0,P1/P2 暂不做
> **总代码量预算**: ≤ 1500 行,任何模块超估算 1.3x 停下找 Cowork

---

## 1. 项目目录结构(目标形态)

代码 repo 在 server 上,推荐位置 `~/projects/cc-workflow/`,自己 git init 管版本:

```
cc-workflow/
├── README.md
├── pyproject.toml
├── .gitignore
│
├── agent-run.sh                # P0-1, 多引擎包装 + provider 切换
│
├── scripts/
│   └── install-deps.sh         # P0-1, 装 claude/codex CLI + jq + config.toml/providers.json 模板
│
├── backend/
│   ├── __init__.py
│   ├── main.py                 # FastAPI 入口
│   ├── config.py               # 配置加载
│   ├── db.py                   # SQLite schema + CRUD
│   ├── runner.py               # subprocess worker
│   ├── ui_cards.py             # IM 抽象 Card 模型 (P0-5a, Phase 2)
│   ├── im_feishu.py            # Feishu adapter,Phase 2 加卡片渲染
│   ├── cron_state.py           # cron 状态读取
│   ├── auth.py                 # HTTP Basic auth (§4.2 basic; Phase 1)
│   ├── static/                 # Phase 1 简陋触发页(沙袋,不是 PWA)
│   │   └── index.html
│   └── reliability.py          # 备份 / 轮转 / 清理 (P0-8)
│
├── pwa/                        # Phase 2 PWA-lite app(manifest + cache-only sw)
│   ├── index.html              # 路由入口(workspaces / tasks 两视图)
│   ├── app.js                  # SPA 路由 + fetch + 视图渲染
│   ├── style.css
│   ├── manifest.json           # name / icons 192+512 / start_url / display=standalone
│   ├── sw.js                   # cache-only,不上 push
│   └── run_view.html           # 长输出详情页
│
├── cron/
│   └── cc-loops.crontab        # /etc/cron.d/ 模板
│
├── deploy/
│   ├── cc-workflow.service     # systemd unit
│   └── nginx.conf              # 反代 + basic auth + HTTPS
│
└── tests/
    ├── test_agent_run.sh
    └── test_backend.py
```

**服务器侧配置文件**(不进 repo):

```
~/.cc-workflow/
├── config.toml                 # 非敏感,provider = "deepseek" 等(见 §4.1.1)
├── providers.json              # 权限 0600;LLM provider profiles(ccswitch 风格,见 §4.1.1)
└── secrets.toml                # 权限 0600;Feishu app secret 等
# 注:本方案不做 Web Push,故无 VAPID 密钥文件

~/.cc-state/
├── runs.db                     # SQLite
├── backup/                     # 每日备份 (P0-8a)
├── locks/                      # 活跃 agent-run lock
├── logs/                       # stream-json 日志,权限 0700 (P0-7e)
└── jobs/                       # 每 cron job 一份状态文件
```

---

## 2. 文件清单 + 估算(总目标 ≤ 1500)

按 Phase 分组(对应 PRD §6.0):

### Phase 1 — 核心闭环

| 文件 | 语言 | 行数 | 模块 |
|---|---|---|---|
| `agent-run.sh` | bash | 240 | P0-1(含 provider 切换 ~40 行,§4.1.2) |
| `scripts/install-deps.sh` | bash | 150 | P0-1 依赖装机(CLI / jq / config.toml + providers.json + secrets.toml 模板) |
| `backend/main.py` | python | 120 | P0-3 |
| `backend/config.py` | python | 40 | P0-3 |
| `backend/db.py` | python | 130 | P0-3 |
| `backend/runner.py` | python | 100 | P0-3 |
| `backend/im_feishu.py` | python | 140 | P0-4 |
| `backend/cron_state.py` | python | 60 | P0-2 |
| `backend/auth.py` | python | 50 | P0-3 Phase 1(§4.2 basic 提前) |
| `cron/cc-loops.crontab` | cron | 30 | P0-2 |
| `backend/static/index.html` | html | 60 | **Phase 1 简陋触发页** |
| **Phase 1 小计** | | **~1000** | |

### Phase 2 — 富交互(飞书卡片 + PWA-lite 2 视图)

| 文件 | 语言 | 行数 | 模块 |
|---|---|---|---|
| `backend/ui_cards.py` | python | 100 | P0-5a(抽象 Card 模型) |
| `backend/im_feishu.py` 扩展 | python | +150 | P0-5b/5c/5d(Feishu adapter 卡片渲染 + 回调) |
| `pwa/index.html` | html | 60 | P0-6a(SPA shell + nav) |
| `pwa/app.js` | js | 280 | P0-6b/6c(Workspaces + Tasks 视图 + fetch + 轮询) |
| `pwa/style.css` | css | 100 | P0-6(响应式 + 4 列 grid) |
| `pwa/manifest.json` | json | 20 | P0-6a |
| `pwa/sw.js` | js | 40 | P0-6a(cache-only,**无 push handler**) |
| `pwa/run_view.html` | html | 60 | P0-6d(长输出详情页) |
| **Phase 2 小计** | | **~810** | |

### Phase 3 — 稳定化

| 文件 | 语言 | 行数 | 模块 |
|---|---|---|---|
| `backend/reliability.py` | python | 80 | P0-8 |
| `deploy/cc-workflow.service` | systemd | 20 | P0-8d |
| `deploy/nginx.conf` | nginx | 60 | P0-3 Phase 1(反代提前)+ P0-7c HTTPS Phase 3 |
| **Phase 3 小计** | | **~160** | |

**全部小计**: ~1970 行,**超 1500 预算约 30%**。**接受**——PWA-lite 2 视图是产品要的真功能,不是镀金。但任何单文件超估算 1.3x 仍要停下复议。

**砍掉 / 保留判断**:
- 保留: `pwa/*`(PWA-lite shell,但**仅 cache-only sw,无 push handler**)
- 砍: `backend/push.py`、VAPID、Web Push handler、`backend/csrf.py`
- 留 P1: 圆桌会议视图(P1-3)+ Web Push(P1-0)+ Codex 深度集成(P1-1)

> Phase 1 的 `backend/static/index.html` 仍是简陋触发页(60 行,做 fallback)。Phase 2 的 `pwa/` 是主 UX,定位不同。
> 不写 `deploy/setup.sh`(部署仍手册化,见 §10);`scripts/install-deps.sh` 是依赖装机脚本,不是部署脚本。

---

## 3. 依赖图(build 顺序)

```
agent-run.sh           (零依赖,纯 bash)
       ↓
backend/db.py + config.py
       ↓
backend/runner.py      (subprocess agent-run, 写 db)
       ↓
backend/main.py + csrf.py   (HTTP routes,带 CSRF 中间件)
   ↓                          ↓
backend/im_feishu.py   backend/ui_cards.py
   ↓
backend/cron_state.py + cron/cc-loops.crontab
   ↓
backend/reliability.py
   ↓
pwa/*  (HTTP 客户端)
   ↓
deploy/*  (部署 + nginx + systemd)
```

---

## 4. 接口契约(钉死,不许偏)

### 4.1 `agent-run.sh` CLI

```
agent-run --engine=<claude|codex> <workspace> "<prompt>" [session_key]
        [--source <pwa|feishu|cron|manual>] [--job-name <name>]
```

| Exit | 含义 |
|---|---|
| 0 | success |
| 64 | invalid usage(参数错) |
| 65 | concurrency limit (3) |
| 66 | engine call failed |
| 67 | push main 阻断 |
| 68 | timeout(超过 10 分钟) |

> exit codes 用 64-78 sysexits.h 标准段,避开 bash 内置 1/2/126/127/130 等。

**stdout**: 最终结果文本
**stderr**: 错误诊断

**副作用**:
- `~/.cc-state/locks/$$.lock` 执行期间存在
- `~/.cc-state/jobs/<job-name>.json` 如有 `--job-name`
- `~/workspaces/.wt/<workspace>-<session_safe>/` 多会话隔离
- `~/.cc-state/logs/<date>.jsonl` 完整 stream-json

**核心行为要点**:
- flock 实现并发上限,试 3 个 slot 文件
- workspace 校验:`~/workspaces/<name>/.git` 必须存在
- engine 调度:
  - `claude` (严格 P0): `claude -p "..." --output-format stream-json --verbose --permission-mode acceptEdits [--resume <id>]`
  - `codex` (best-effort): `codex exec "..."`(Day 0 实测验证语法)
- **provider 切换**: 调 claude 前读 `~/.cc-workflow/config.toml` 的 `provider` 字段,从 `~/.cc-workflow/providers.json` 取对应 profile 的 `env` dict,全部 `export`。空 env profile(`claude` / `anthropic`)= 不 export,走 claude CLI 自身 OAuth。codex 不做 provider 切换。
- push main 检测:prompt 静态扫描 `\bgit\s+push.*\b(main|master)\b`,命中 → exit 67。**运行时 tool-call 扫描留 P1**(MINIMAL_CHOICE)
- session_id 抽取:从 stream-json 第一条 `{type:"system",subtype:"init"}` 取 `session_id`,存 `~/.cc-state/sessions.json`

#### 4.1.1 provider 配置(两文件)

**`~/.cc-workflow/config.toml`(非敏感,可 commit)**:

```toml
# Which profile in providers.json to use.
provider = "deepseek"
```

**`~/.cc-workflow/providers.json`(权限 `0600`,含 API key)**:schema 借鉴 [ccswitch](https://github.com/foreveryh/claude-code-switch),`profiles.<name>.env` 是任意 env 字典(写什么就 export 什么):

```json
{
  "profiles": {
    "claude": { "env": {} },
    "deepseek": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "<api-key>",
        "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
        "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
        "CLAUDE_CODE_EFFORT_LEVEL": "max"
      }
    },
    "kimi": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.kimi.com/coding/",
        "ANTHROPIC_API_KEY": "<api-key>"
      }
    }
  }
}
```

`<api-key>` 是 placeholder — agent-run 检测到 placeholder 立即 exit 64,防止用占位符跑挂。

#### 4.1.2 加新 provider(零代码改动)

格式跟 DeepSeek/Kimi 一样,加一个 profile 到 `providers.json`:

```json
"glm": {
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "glm-4.6"
  }
}
```

然后改 `config.toml` 的 `provider = "glm"`。**agent-run.sh 完全不动**,因为它不硬编码任何 provider 名 / env 变量名 — 来自 ccswitch 的 flat env 哲学。

⚠️ DeepSeek 用 `ANTHROPIC_AUTH_TOKEN`,Kimi 用 `ANTHROPIC_API_KEY` — 两家不同。来源:[DeepSeek 接入 Claude Code 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code) + [Kimi 接入 Claude Code 官方文档](https://www.kimi.com/code/docs/third-party-tools/other-coding-agents.html)

**JSON 解析**: agent-run.sh 用 `jq`(已是必需依赖,§8);**不再依赖 python tomllib/tomli**。`config.toml` 那一行用 awk 解析(只支持 `provider = "value"`)。

#### 4.1.3 acceptance 在不同 provider 下的预期

| 测试 | claude / anthropic | deepseek | kimi | 其他(glm 等) |
|---|---|---|---|---|
| A1.1 smoke + resume | **严格** | best-effort → **实测 PASS @ 2026-05-11**(DeepSeek 服务端保留了 session_id) | best-effort(未实测) | best-effort |
| A1.2 并发上限 | 严格 | 严格 ✓ 实测 | 严格 | 严格 |
| A1.3 push main 阻断 | 严格 | 严格 ✓ 实测(prompt 静态检查与 LLM 后端无关) | 严格 | 严格 |
| A1.4 codex smoke | best-effort(provider 切换不影响 codex) | (同) — SKIP 实测(CLI 未装,降级 P1) | (同) | (同) |

### 4.2 `backend/main.py` HTTP 路由

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/run` | basic + CSRF | `{workspace, prompt, engine, session_key?}` | `{task_id, status}` |
| GET | `/runs/{task_id}` | basic | - | `{task_id, status, exit_code, output, pr_url, ...}` |
| GET | `/sessions` | basic | - | `{active, queued, recent}` |
| GET | `/loops` | basic | - | `[{name, schedule, last_run_at, ...}]` |
| POST | `/loops/{name}/pause` | basic + CSRF | - | `{status}` |
| POST | `/loops/{name}/resume` | basic + CSRF | - | `{status}` |
| POST | `/loops/{name}/trigger` | basic + CSRF | - | `{task_id}` |
| POST | `/push/subscribe` | basic + session token | WebPushSubscription | `{status}` |
| POST | `/im/feishu/webhook` | Feishu sig | Feishu event | Feishu-expected |
| GET | `/csrf` | basic | - | `{token}` |
| GET | `/healthz` | (open) | - | `{ok: true}` |

**响应统一**: `application/json`,错误 `{error, code}` + HTTP 4xx/5xx

> **basic 已在 Phase 1 提前实现**(backend/auth.py,credentials 从 `~/.cc-workflow/secrets.toml` `[ui]` 段读)。
> **CSRF 仍 Phase 3**(P0-7d),`/csrf` endpoint 同步 Phase 3 才出现。
> `/healthz` 故意 **public**(监控用,不泄露任何敏感信息)。

### 4.3 CORS 策略 (P0-7c)

```python
allow_origins = [
    "https://<server_host>",   # PWA 同源
    # 不允许其他来源
]
allow_credentials = True
allow_methods = ["GET", "POST"]
```

飞书 webhook 直接走 `/im/feishu/webhook`,这个 endpoint 走自己的签名校验,**不走 CORS**(因为飞书服务器请求时不带 origin)。

### 4.4 CSRF 双重提交 (P0-7d)

- 用户首次访问 PWA → GET `/csrf` 拿到 token + 同名 cookie
- 后续 POST 必须 header `X-CSRF-Token: <token>`,服务器对比 header 和 cookie 是否相等
- 不等 → 403

### 4.5 SQLite Schema

```sql
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    engine TEXT NOT NULL,
    session_key TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,                   -- queued|running|done|failed
    exit_code INTEGER,
    output TEXT,
    pr_url TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    elapsed_s INTEGER,
    tokens_used INTEGER,
    cost_usd REAL,
    source TEXT                             -- pwa|feishu|cron|manual
);

CREATE TABLE sessions (
    session_key TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    claude_session_id TEXT,
    codex_session_id TEXT,
    last_active_at INTEGER NOT NULL
);

CREATE INDEX idx_runs_status ON runs(status, started_at);
CREATE INDEX idx_runs_workspace ON runs(workspace, started_at);
```

### 4.6 Cron 状态文件格式

`~/.cc-state/jobs/<job_name>.json`:

```json
{
  "name": "daily-digest",
  "last_run_at": 1778500000,
  "last_finished_at": 1778500120,
  "last_exit": 0,
  "last_output_summary": "...",
  "consecutive_errors": 0,
  "last_error_at": null,
  "last_error_msg": null,
  "total_runs": 47,
  "enabled": true
}
```

**写入约定**: agent-run 完成后写入(`--job-name <name>` 标记)
**读取约定**: `backend/cron_state.py` 读取暴露给 `/loops`

---

## 5. 实施顺序(按 Phase,依赖序)

> 估算时间参考,**实测可能 ±50%,任何段超 1.5x 停下找 Cowork**
> **每个 Phase 末尾的 Gate(对应 PRD §6.0)必须全过,才进下一 Phase**

---

### Phase 1 — 核心闭环验证

目标:Mac 浏览器 + 飞书都能端到端触发任务、看到 PR(PRD A0 Gate)。**不动 PWA 不动 Push**。

#### T+0: agent-run.sh (P0-1)

任务:
1. agent-run.sh 实现 §4.1 全部 exit code / 副作用 — **Claude 路径必须严格通过**
2. Codex 路径:best-effort smoke;实测语法不对或不存在,**降级到 P1**,在 PRD §6.1 P0-1 备注
3. 跑 [test-plan §3.1](03-test-plan.md#31-p0-1-agent-run) Claude 全过 + Codex smoke(尽力)

**通过判定**: A1.1, A1.2, A1.3 全过 + A1.4 尽力

#### T+0.5d: backend 核心 (P0-3 一半)

任务:
4. backend/config.py
5. backend/db.py(schema + CRUD)
6. backend/runner.py(simple subprocess pool)
7. backend/main.py 加 `/run` + `/runs/{id}` + `/healthz` + `/sessions`
8. systemd unit 跑起来(为 Phase 1 提供长驻 backend)

**通过判定**: A3.1, A3.2 过(curl 能跑通)

#### T+1d: cron + 状态 (P0-2 + P0-3 后半)

任务:
9. cron/cc-loops.crontab 模板(初版含 1 个测试 job)
10. backend/cron_state.py
11. backend/main.py 加 `/loops/*` 路由
12. 部到 `/etc/cron.d/cc-loops`
13. agent-run.sh 加 `--source cron --job-name X` 支持

**通过判定**: A2.1, A3.3 过

#### T+1.5d: Feishu adapter (P0-4)

任务:
14. backend/im_feishu.py(签名校验、消息解析、reply API)
15. backend/main.py 加 `/im/feishu/webhook`
16. 接到现有 Feishu app(更新 webhook URL)

**通过判定**: A4.1, A4.2 过

#### T+2d: Phase 1 简陋触发页

任务:
17. backend/static/index.html — **只有触发表单 + 活跃 session 列表 + 最近完成列表**
18. backend/main.py 挂载静态目录(`/` → static/index.html)
19. 用普通 fetch + 3 秒轮询,**不上 service worker / 不上 manifest / 不上 push**

**通过判定**: Mac Chrome 打开看见页面,点 Run 触发任务,看到 PR

#### ═══ Phase 1 Gate (A0) ═══

完成 **PRD §6.0 A0.1-A0.4** 全部:
- A0.1 Mac Chrome 看到简陋触发页
- A0.2 页面 Run → 看 PR
- A0.3 飞书 → 看回复 + PR
- A0.4 cron loop 触发,状态文件正确

**A0 不过,不许进 Phase 2**。修 Phase 1 直到通过。

---

### Phase 2 — 富交互(飞书卡片 + PWA-lite 2 视图)

目标:Phase 1 文本-only 飞书升级为富卡片;加 PWA-lite 2 视图 app(Workspaces + Tasks)(PRD A0' Gate)。

> **明确范围**:
> - ✅ 做 PWA shell(manifest + cache-only sw),装桌面可用
> - ❌ 不做 Web Push handler / VAPID(留 P1)
> - ❌ 不做圆桌会议视图(整体留 P1-3,P0 不留空壳)

> **顺序约定(P0-6 先,P0-5 后)**: PWA-lite 是用户价值最显著的部分(4 repo 同屏 + cron CRUD,飞书做不了),先做;Feishu 卡片是基础体验 polish(飞书文本触发已经 Phase 1 工作),后做。
> **Card 抽象层 JIT 提取**: PWA-lite 直接走 backend REST API + HTML 渲染,**不引入 Card 抽象**;等到 T+4.5d 真正开始 Feishu 卡片(第 2 个消费者)时,**那时**才提取 `ui_cards.py`——避免单消费者的过度抽象。

#### T+2.5d: PWA-lite shell (P0-6a)

任务:
20. `pwa/manifest.json`: name / icons 192+512 / start_url=`/pwa/` / display=standalone
21. `pwa/sw.js`: cache-only(precache index/app.js/style.css/manifest;运行时 cache-first)— **不监听 push 事件**
22. `pwa/index.html`: SPA shell + nav(顶部 2 个 tab:Workspaces / Tasks)
23. backend/main.py 加静态路由 `/pwa/*`
24. nginx 配置 `/pwa/` 路径(确保 HTTPS,装桌面要求)

**通过判定**: A6.1 过(iPhone 装桌面 + 启动是独立 app + 无浏览器 chrome)

#### T+3d: Workspaces 视图 (P0-6b)

任务:
25. `pwa/app.js` 加 `WorkspacesView`:从 `/sessions` API 拉数据,按 workspace 分组
26. 响应式 grid(4 列 ≥ desktop / 2 列 tablet / 1 列 mobile)
27. 每列内嵌触发表单(workspace 固定 + prompt textarea + Run 按钮)
28. 3 秒轮询刷新

**通过判定**: A6.2 过(4 repo 同屏 + 各列独立触发)

#### T+3.5d: Tasks 视图 (P0-6c)

任务:
29. `pwa/app.js` 加 `TasksView`:从 `/loops` API 拉 cron 列表
30. 添加表单:workspace dropdown + cron 表达式输入(带常用预设 + 表达式校验)+ prompt textarea
31. 编辑 / 暂停 / 触发 / 删除按钮(走 backend `/loops/{name}/*` 路由)
32. 每条 cron 展开看最近 5 次运行历史

**通过判定**: A6.3, A6.4 过

#### T+4d: 长输出详情页 + 飞书消息截断降级 (P0-6d/e)

任务:
33. `pwa/run_view.html`:`/runs/{id}/view` 路由,完整 stream-json → 渲染 markdown / pre
34. backend/im_feishu.py 加"长输出降级":output > 4000 字符 → 飞书消息发前 1500 + PWA 详情链接(`/pwa/runs/<id>/view`)

**通过判定**: A6.5 过

**中间 Gate(P0-6 完工)**: PWA-lite 真好用,Workspaces + Tasks 都能用,长输出有兜底链接。**到此为止 PWA 是单消费者,不需要 Card 抽象**。

---

#### T+4.5d: IM Card 抽象层 (P0-5a) — 此时提取

> 为什么现在才做: 接下来要做 Feishu 卡片,**这是第 2 个消费者**(第 1 个是 PWA-lite 但 PWA 不走抽象)。Feishu 卡片不能直接拼 JSON——后续加钉钉就要重复一次。所以**在引入 Feishu 卡片的同一阶段提取抽象**,避免事后改造成本。

任务:
35. `backend/ui_cards.py` 定义:
    - `@dataclass Card(title, sections, buttons, refresh_token, footer)`
    - `@dataclass Section(kind, content)` — kind ∈ {text, kv, table, divider}
    - `@dataclass Button(label, action, params)` — action 走 backend 回调
    - `@dataclass FormField(name, label, kind, options)` — kind ∈ {text, dropdown, textarea}
36. backend 路径产出 Card:`/sessions` 卡片路由生成"活跃 sessions Card"、`/loops` 生成"loops Card" 等(**仅给 Feishu 用,PWA 仍走原 REST**)

**通过判定**: `backend/ui_cards.py` 存在 + `Card` 抽象**不含任何 Feishu 字符串**

#### T+5d: Feishu adapter 卡片扩展 (P0-5b/c/d)

任务:
37. `backend/im_feishu.py` 加 `render_card(card: Card) -> dict` — Card → Feishu Open Platform 互动卡片 JSON
38. `backend/im_feishu.py` 加 `parse_card_action(payload: dict) -> CardAction` — Feishu 卡片按钮回调 → 抽象 Action
39. 加 slash 命令路由:`/sessions` `/loops` `/run` `/templates`
40. 加新建任务表单卡片(workspace dropdown + prompt textarea + Run 按钮)
41. 飞书 Open Platform 后台配置:加"消息卡片回调 URL" → `/im/feishu/card_callback`

**通过判定**: A5.1, A5.2, A5.3, A5.4, A5.5 全过

#### ═══ Phase 2 Gate (A0') ═══

完成 **PRD §6.0 A0'.1-A0'.8** 全部:
- A0'.1 飞书 `/sessions` 卡片 + 刷新
- A0'.2 飞书 `/loops` 卡片 + 暂停按钮
- A0'.3 飞书 `[workspace] prompt` 文本触发(已存在的约定)
- A0'.4 PWA-lite 装桌面 + Mac 独立窗口启动
- A0'.5 Workspaces 视图 4 列并排
- A0'.6 Tasks 视图 CRUD 工作
- A0'.7 Card 抽象在 `ui_cards.py`,Feishu adapter 不直接拼 JSON
- A0'.8 长输出 > 4000 字符飞书发摘要 + PWA 详情链接

**A0' 不过,修到通过**(IM Card 抽象 / PWA shell 都是结构性,无降级)。

**圆桌会议视图(P1-3)Phase 2 不做,UI + backend 一起留 P1**。

---

### Phase 3 — 稳定化

目标:加安全和可靠性护栏,准备长期稳定运行。

#### T+4d: 安全护栏 (P0-7 五子项)

任务:
31. agent-run.sh push main 检测(已在 T+0 做,这里加 e2e 验证)
32. backend/main.py 加 CORS 配置(只允许 PWA-lite 同源 + 飞书 webhook)
33. backend/runner.py 加日成本估算 + 飞书告警卡片
34. backend/cron_state.py 加连败 ≥ 3 自动 disable + 飞书告警
35. 部署后 `chmod 0600 ~/.cc-workflow/{secrets.toml,providers.json}` + `chmod 0700 ~/.cc-state/logs/`

**通过判定**: A7.1-A7.5 全过

> 不做的任务(整体退到 P1):
> - CSRF 中间件 — PWA-lite + 飞书 webhook 走 CORS + same-origin / 签名校验
> - Push subscribe 鉴权 — Web Push 整体不做

#### T+4d: 可靠性 (P0-8 四子项)

任务:
38. backend/reliability.py 实现:
    - daily backup function(SQLite `.backup`)
    - weekly log cleanup
    - weekly worktree prune
39. 注册到 Linux cron(daily/weekly 触发 reliability.py 的对应函数)
40. deploy/cc-workflow.service + 启用 enable
41. deploy/nginx.conf + 反代 + basic auth

**通过判定**: A8.1-A8.4 过

#### T+4.5d: E2E 三场景 + buffer

跑 [test-plan §4](03-test-plan.md#4-端到端e2e场景) 三个场景。

**通过判定**: 三个场景全过,P0 验收完成。

---

## 6. 代码风格约定

### Bash
- `set -euo pipefail` 顶部
- 单文件 ≤ 200 行
- 错误 → stderr,数据 → stdout
- 锁用 `flock`

### Python
- 全部 type hints
- FastAPI + Pydantic
- 同步 IO,`sqlite3` 直接用
- 单模块 ≤ 200 行
- **不用 ORM、不用 async(除非 push 多目标真要并发)**

### 配置
- `~/.cc-workflow/config.toml`(非敏感):provider 选择等
- `~/.cc-workflow/providers.json` 权限 `0600`(敏感):LLM provider profiles + API key
- `~/.cc-workflow/secrets.toml` 权限 `0600`(敏感):
  - `[ui]` HTTP Basic 用户名 + 密码(Phase 1 已生效,install-deps.sh 自动生成随机密码)
  - `[feishu]`(P0-4 / T+1.5d)
- 不放进**长期** shell 环境变量(`~/.bashrc` 等会被 `ps -E` 看到)
- **例外**:agent-run.sh 调 claude 前**短期** export `ANTHROPIC_AUTH_TOKEN` 等给子进程(§4.1)— 这是 claude code 官方接入路径,无法绕开;进程生命周期短,只有 root / 同 uid 能读 `/proc/<pid>/environ`,接受这个 trade-off

### 错误处理
- exit code + stderr / HTTP 4xx/5xx + JSON
- **不吞错、不静默重试、不 `except: pass`**

---

## 7. 不许做的事(防 drift)

| 禁止 | 理由 |
|---|---|
| Redis / Celery / RabbitMQ | SQLite + subprocess 在你 scale 够用 |
| ORM(SQLAlchemy 等) | sqlite3 module 够 |
| React / Vue / Svelte / build step | PWA 原生 JS |
| OAuth / 多用户 | nginx basic auth 够 |
| 实现 P1 引擎(GPT 等纯 chat-mode 模型) | 不做。**DeepSeek / Kimi 作为 claude code 的 LLM 后端在 P0-1 已支持(§4.1.1-2);它们不是顶层 `--engine=` 值** |
| 实现 P1 multi-agent discuss | 不做 |
| **Codex 深度集成(--resume 等价物等)** | **best-effort smoke 即可,深度放 P1** |
| Docker / k8s | 直接 systemd |
| 改 git config / `--no-verify` / force push | 禁止 |

**破例规则**: 觉得某条该破,**停下,在 commit message 写 `BREAK_RULE: <原因>`,推到独立分支**,让用户回 Cowork 讨论。

---

## 8. 外部依赖契约

### Claude Code CLI
```bash
npm install -g @anthropic-ai/claude-code
# 版本 >= 2.1.72
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --permission-mode acceptEdits \
  [--resume <session_id>]
```

### Codex CLI (best-effort)
```bash
# Day 0 实测,语法可能与下面不同:
codex exec "<prompt>" [--full-access]
# 如不存在或差异大 → 降级 P1,P0-1 仅 Claude
```

### DeepSeek / Kimi 后端(claude code 切后端,§4.1)
两家都官方提供 anthropic-compatible endpoint,不需要装新 CLI。**只需注册账号 → 拿 API key → 写到 `~/.cc-workflow/providers.json`**(install-deps.sh 自动生成模板)。

- DeepSeek: https://platform.deepseek.com/api_keys
- Kimi: https://www.kimi.com/code/console
- 接入文档(env 变量):见 §4.1.2 后面的两个引用

### gh CLI
- 已装、已 `gh auth login`

### Feishu
- App ID / App Secret / Verification Token / Encrypt Key 全部在 `~/.cc-workflow/secrets.toml`
- Webhook URL 配在 `https://<server>/im/feishu/webhook`
- 当前 OpenClaw 不动,**在 Feishu App 加一个新的 event subscription 指到本系统 webhook**;P0 验收 + Soak 通过后再退 OpenClaw

---

## 9. P0-8 可靠性细节

### 9.1 SQLite backup (8a)

```python
# backend/reliability.py
def daily_backup():
    src = Path("~/.cc-state/runs.db").expanduser()
    backup_dir = Path("~/.cc-state/backup").expanduser()
    backup_dir.mkdir(exist_ok=True, parents=True)
    dst = backup_dir / f"runs-{date.today():%Y%m%d}.db"
    conn = sqlite3.connect(src)
    bkp = sqlite3.connect(dst)
    conn.backup(bkp)
    bkp.close(); conn.close()
    # 清理 7 天前
    cutoff = datetime.now() - timedelta(days=7)
    for f in backup_dir.glob("runs-*.db"):
        if f.stat().st_mtime < cutoff.timestamp():
            f.unlink()
```

cron: `13 3 * * *  user  /usr/bin/python3 -m backend.reliability daily_backup`

### 9.2 Log rotate (8b)

```python
def weekly_log_cleanup():
    log_dir = Path("~/.cc-state/logs").expanduser()
    cutoff = datetime.now() - timedelta(days=30)
    for f in log_dir.glob("*.jsonl"):
        if f.stat().st_mtime < cutoff.timestamp():
            f.unlink()
```

cron: `17 4 * * 0  user  /usr/bin/python3 -m backend.reliability weekly_log_cleanup`

### 9.3 Worktree cleanup (8c)

```python
def weekly_worktree_prune():
    wt_base = Path("~/workspaces/.wt").expanduser()
    cutoff = time.time() - 7*86400
    for wt in wt_base.iterdir():
        if not wt.is_dir():
            continue
        latest = max((f.stat().st_mtime for f in wt.rglob("*")), default=0)
        if latest < cutoff:
            shutil.rmtree(wt)
    # 然后 git worktree prune
    subprocess.run(["git", "-C", "~/workspaces/<repo>", "worktree", "prune"])
```

cron: `23 4 * * 0  user  /usr/bin/python3 -m backend.reliability weekly_worktree_prune`

### 9.4 Service 自启 (8d)

```ini
# /etc/systemd/system/cc-workflow.service
[Unit]
Description=CC Workflow Backend
After=network.target

[Service]
Type=simple
User=<your_user>
WorkingDirectory=/home/<your_user>/projects/cc-workflow
# Project-local venv (PEP 668 — Ubuntu 24.04+ blocks system pip).
# Setup once: python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn pydantic tomli
#
# Backend binds 127.0.0.1; public traffic comes through nginx on :80
# (deploy/nginx.conf reverse-proxies to here). HTTP basic auth enforced
# at FastAPI layer (backend/auth.py). Phase 3 adds HTTPS via certbot.
ExecStart=/home/<your_user>/projects/cc-workflow/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now cc-workflow`

---

## 10. 部署步骤(手册化,部署不写 setup.sh)

> **设计意图**:部署涉及 systemd / nginx / cron / HTTPS,这些是几乎不可逆的系统级改动(PRD 3 级反悔成本表 1 级),**部署透明度优先于一键化**。
>
> 唯一例外:`scripts/install-deps.sh` 是**依赖装机**(装 CLI、jq、config.toml + providers.json 模板),不动 systemd/nginx/cron,且脚本本身是透明 bash。这条**不破 §10 的设计意图**。命名上严格区分 `install-deps.sh`(依赖)vs `setup.sh`(部署,不写)。

### 一次性 setup

```bash
# 1. clone repo
cd ~/projects/cc-workflow

# 2. 一键装依赖(CLI + jq + 写 config.toml/providers.json 模板)
bash scripts/install-deps.sh
# 这步等价于:
#   - npm i -g @anthropic-ai/claude-code
#   - 装 codex(各平台不同,脚本里实测)
#   - apt-get install -y jq
#   - 写 ~/.cc-workflow/config.toml(默认 provider = "deepseek")
#   - 写 ~/.cc-workflow/providers.json 模板(API key 占位由你填),chmod 0600
# 跑完手动编辑:
#   ~/.cc-workflow/config.toml      ← provider = "deepseek" | "kimi" | "claude"
#   ~/.cc-workflow/providers.json   ← 填 <api-key> placeholder
# 鉴权(按 provider 选其一):
#   claude / anthropic → claude login(OAuth,一次性)
#   deepseek / kimi    → 不需要 claude login,env vars 由 agent-run 注入

# 3. Python deps (venv — Ubuntu 24.04+ blocks system pip per PEP 668)
sudo apt install -y python3-venv
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install fastapi uvicorn pydantic python-multipart tomli
# tomli is only needed on Python < 3.11 (3.11+ has stdlib tomllib).
# Listing it unconditionally keeps the command idempotent across server Python versions.

# 4. 状态目录
mkdir -p ~/.cc-state/{backup,locks,logs,jobs}
chmod 0700 ~/.cc-state/logs

# 5. agent-run 装到 PATH
sudo install -m 0755 agent-run.sh /usr/local/bin/agent-run

# 6. 数据库初始化
python3 -m backend.db init

# 7. systemd
sudo cp deploy/cc-workflow.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cc-workflow

# 9. nginx reverse proxy
#    Phase 1: bare HTTP on :80, no cert.
#    Phase 3: add HTTPS (certbot).
sudo apt install -y nginx                                        # if absent
sudo cp deploy/nginx.conf /etc/nginx/sites-available/cc-workflow
sudo ln -sf /etc/nginx/sites-available/cc-workflow /etc/nginx/sites-enabled/cc-workflow
sudo rm -f /etc/nginx/sites-enabled/default                      # stock welcome page would shadow ours
sudo nginx -t && sudo systemctl reload nginx
# Phase 3 only:
# sudo certbot --nginx -d <your_domain>                           # HTTPS

# 10. cron
sudo cp cron/cc-loops.crontab /etc/cron.d/cc-loops
```

### 验证

`curl https://<server>/healthz` → `{"ok":true}`

---

## 11. 验收清单(按 Phase)

### Phase 1 Gate ✅ 全过 @ 2026-05-11
- [x] P0-1 [agent-run]: test §3.1 全过 — PASS(commit 7b88107;3.1.1-4 strict pass on `provider=deepseek`,3.1.5 codex SKIP)
- [x] P0-2 [cron + state]: A2.1 PASS(commit 7467001);A2.2 留 Phase 3 P0-7g
- [x] P0-3 [FastAPI]: A3.1/A3.2/A3.3 全过(commit f8ee553 + 7467001 + be37214 + ff78f86 + fad7119 + 35a0423)
- [x] P0-4 [Feishu]: A4.1 PASS(commit ccf0220,飞书 webhook → backend → reply 全链路通)
- [x] **A0 全过**:A0.1 / A0.2 / A0.3 / A0.4 全部实测 PASS

→ **Phase 2 解锁**

### Phase 2 Gate
- [ ] P0-5 [PWA]: test §3.5 全过
- [ ] P0-6 [PWA-lite app]: test §3.6 全过
- [ ] **A0' 全过**:iPhone PWA + Push 端到端

→ A0' 全过(或显式降级)才进 Phase 3

### Phase 3 Gate
- [ ] P0-7 [安全 7 子项]: test §3.7 全过
- [ ] P0-8 [可靠性 4 子项]: test §3.8 全过
- [ ] E2E 三场景(A / B / C)全过

**Phase 3 全勾 = P0 验收 = 可以考虑进 P1。**
