# Test Plan — P0 验收

> **配套**: [01-prd.md](01-prd.md) §6.1、[02-dev-plan.md](02-dev-plan.md) §4
> **用法**: 每完成一个 P0,跑对应 §3.X 全过,**通过才进下一个**
> **不通过**: 看 §5 诊断,**修问题不绕开,不 mock**

---

## 1. 测试分级

| 级别 | 范围 | 跑频 |
|---|---|---|
| Smoke | 单一命令跑通 | 每写完一个文件 |
| Integration | 模块接口对接 | 每完成一个 P0 |
| E2E | 用户场景 | P0 全完成后 |
| Soak | 长时间稳定 | P0 上线第 1 周 |

---

## 2. 总验收(按 Phase 分组,对照 PRD §6)

### Phase 1 Gate (A0) — 实测 2026-05-11
- [x] **A1.1** Claude 引擎 smoke + session resume — PASS(provider=deepseek)
- [x] **A1.2** 第 4 个并发立即 exit 65 — PASS
- [x] **A1.3** push main 阻断 exit 67 — PASS
- [ ] **A1.4** [best-effort] Codex smoke — SKIP(CLI 未装,降级 P1)
- [x] **A2.1** Cron job 状态文件更新 — PASS(tick-test 130s 跑 2 次)
- [x] **A3.1** POST /run < 100ms — PASS(13ms)
- [x] **A3.2** GET /sessions 显示活跃 worker — PASS
- [x] **A3.3** 重启后历史可查 — PASS
- [ ] **A4.1** 飞书 → PR — 代码 ready(ccf0220),e2e 待
- [ ] **A4.2** 飞书多轮 session 连续 — 代码 ready,e2e 待
- [x] **A0.1** Mac Chrome 看到简陋触发页 — PASS
- [x] **A0.2** 页面 Run 触发 → 看到完成 — PASS(`419f6bf18aef` elapsed 4s exit 0)
- [ ] **A0.3** 飞书 → 看回复 + PR — 代码 ready,e2e 待
- [x] **A0.4** cron loop 触发 + 状态文件更新 — PASS(等于 A2.1)

→ **A0 全过才能进 Phase 2**(当前 A0.3 待 Feishu e2e)

### Phase 2 Gate (A0')
- [ ] **A5.1** iOS PWA 可安装
- [ ] **A5.2** PWA 触发 30s 内开始
- [ ] **A6.1** Push 订阅成功
- [ ] **A6.2** 任务完成 15s 内 push 到达
- [ ] **A0'.1** iPhone PWA 启动是 PWA(非浏览器 chrome)
- [ ] **A0'.2** PWA 触发 → 锁屏弹 push,含 PR 链接
- [ ] **A0'.3** 点 push 跳进 PWA 看完整输出

→ **A0' 全过(或显式降级)才能进 Phase 3**

### Phase 3 Gate
- [ ] **A2.2** 连败 3 → 状态 enabled=false
- [ ] **A7.1-A7.7** 7 项安全(见 §3.7)
- [ ] **A8.1-A8.4** 4 项可靠性(见 §3.8)
- [ ] **E2E 场景 A / B / C** 三个全过(见 §4)

→ Phase 3 Gate 全过 = **P0 验收完成**

---

## 3. 各 P0 + Gate 测试

### 3.0 Phase Gates(Integration 验证)

#### 3.0.1 A0 (Phase 1 Gate)

**前置**: P0-1 / P0-2 / P0-3 / P0-4 单独测试都已过 (§3.1-3.4)

```bash
# A0.1 — Mac Chrome 打开简陋触发页
open http://<server>:8765/    # 或 https://<server>/

# A0.2 — 点 Run 触发,看到 PR
#   表单填: workspace=test-repo, prompt="在 README 加一行 Hello A0"
#   提交后等 1-3 分钟,页面显示完成 + PR URL
#   GitHub 上验证 PR 存在

# A0.3 — 飞书触发
#   飞书发: "在 test-repo 加 hello-a0.txt"
#   等 1-3 分钟,飞书收到回复 + PR URL

# A0.4 — cron loop
#   配 1 个每分钟跑的测试 job (test-plan §3.2.1)
#   等 2 分钟
cat ~/.cc-state/jobs/<test-job>.json | jq '.last_exit, .total_runs'
# 期望: last_exit=0, total_runs ≥ 1
```

**A0 通过判定**: 4 项全过

#### 3.0.2 A0' (Phase 2 Gate)

**前置**: P0-5 / P0-6 单独测试都已过 (§3.5-3.6),HTTPS 已起来

```bash
# A0'.1 — iPhone PWA 装桌面
#   iPhone Safari 开 https://<server>/pwa/
#   → 分享 → 添加到主屏幕
#   桌面点图标启动,看到 PWA(无 Safari chrome / 无地址栏)

# A0'.2 — PWA 触发 + Push 到达
#   PWA 上选 test-repo / claude / "在 README 加一行 Hello A0prime"
#   关闭 PWA,锁屏
#   1-3 分钟内 phone 锁屏弹通知,含 PR URL

# A0'.3 — 点 Push 跳 PWA
#   点 push 通知 → PWA 自动打开 → 看到完整输出 + PR 链接
```

**A0' 通过判定**: 3 项全过

#### 3.0.3 A0' 降级处理

A0' 不过(常见原因:iOS Push 配置问题、HTTPS cert、Safari 版本),可选择:

- **修到通过**(推荐)
- **显式降级**:Phase 2 只保留浏览器版(Mac 用),phone push 走飞书通道。继续 Phase 3,在 PRD §6.0 加 "Phase 2 降级" 备注

无论选哪个,都**不要静默跳过**继续 Phase 3。

---

### 3.1 P0-1: agent-run

> **provider 影响**:本节所有 `--engine=claude` 的测试,LLM 后端由 `~/.cc-workflow/config.toml` 的 `provider` 决定;profile 配置在 `~/.cc-workflow/providers.json`(`claude` / `deepseek` / `kimi` / 或自定义)。
>
> - 3.1.1 / 3.1.2 / 3.1.4 / 3.1.5:**与 provider 无关**,任一 provider 都应严格过(因为测的是 agent-run.sh 本身的行为,不是 LLM 推理质量)
> - **3.1.3 session resume 是唯一对 provider 敏感的**:见该节"期望"

#### 3.1.1 Claude smoke

```bash
# 准备
mkdir -p ~/workspaces/test-repo
cd ~/workspaces/test-repo && git init && touch README.md && git add . && git commit -m init

# 配 provider(install-deps.sh 已生成模板)
$EDITOR ~/.cc-workflow/config.toml      # 选 provider
$EDITOR ~/.cc-workflow/providers.json   # 填 <api-key> 占位

# 跑
agent-run --engine=claude test-repo "reply with only OK" smoke
```

**期望**: stdout 含 "OK",exit 0,耗时 < 60s

#### 3.1.2 并发上限

```bash
for i in 1 2 3 4; do
    (agent-run --engine=claude test-repo "sleep 20 then say OK" "c$i"; echo "$i exit=$?") &
done; wait
```

**期望**: 3 个 exit=0,1 个 exit=65

#### 3.1.3 Session resume

```bash
agent-run --engine=claude test-repo "Remember secret 'penguin'. Say OK." r-test
agent-run --engine=claude test-repo "What's the secret?" r-test
```

**期望**:
- `provider=claude` / `anthropic`:**严格** — 第二次回复含 "penguin"
- `provider=deepseek` / `kimi`:**best-effort** — anthropic-compatible 服务端是否实现 `session_id` 上下文恢复由各家决定。本测试失败**不阻塞 P0**,记录到 PRD §6.1 A1.1 备注

> 实测 fallback:测试时把 `config.toml` 切到 `provider = "claude"` 跑一遍验证 agent-run 本身的 resume 逻辑正确,再切回主力 provider 跑一遍记录实际行为。

#### 3.1.4 Push main 阻断

```bash
agent-run --engine=claude test-repo "Run: git push origin main" attack
```

**期望**: exit 67(阻断)

#### 3.1.5 Codex smoke(best-effort,P1 才严格)

```bash
agent-run --engine=codex test-repo "reply with only OK" codex-smoke
```

**期望(尽力)**: 返回 OK / exit 0;不通过不阻塞 P0 整体,记录到 PRD §6.1 P0-1 备注、降级 P1

---

### 3.2 P0-2: Cron + State

#### 3.2.1 Cron 触发 + 状态更新

```bash
# 一分钟一跑的测试 job
cat << 'EOF' | sudo tee /etc/cron.d/cc-loops-test
PATH=/usr/local/bin:/usr/bin:/bin
* * * * * <user> /usr/local/bin/agent-run --engine=claude test-repo "say tick" tick-test --source cron --job-name tick-test
EOF

sleep 130
jq '.last_exit, .total_runs, .last_run_at' ~/.cc-state/jobs/tick-test.json
```

**期望**: total_runs ≥ 1,last_exit=0

#### 3.2.2 连败计数

```bash
# 故意 fail 的 job
cat << 'EOF' | sudo tee /etc/cron.d/cc-loops-fail
PATH=/usr/local/bin:/usr/bin:/bin
* * * * * <user> /usr/local/bin/agent-run --engine=claude nonexistent "x" fail-test --source cron --job-name fail-test
EOF

sleep 240
jq '.consecutive_errors, .enabled' ~/.cc-state/jobs/fail-test.json
```

**期望**: consecutive_errors ≥ 3, enabled=false(P0-7g 联动)

#### 清理

```bash
sudo rm /etc/cron.d/cc-loops-{test,fail}
rm ~/.cc-state/jobs/{tick,fail}-test.json
```

---

### 3.3 P0-3: FastAPI Gateway

#### 3.3.1 健康检查 + 触发

```bash
curl -s http://localhost:8765/healthz
# {"ok":true}

# 拿 CSRF token
TOKEN=$(curl -sc /tmp/c.jar http://localhost:8765/csrf -u user:pass | jq -r .token)

TASK=$(curl -s -X POST http://localhost:8765/run \
  -u user:pass -b /tmp/c.jar \
  -H "X-CSRF-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"workspace":"test-repo","prompt":"say OK","engine":"claude","session_key":"api-1"}')
echo "$TASK"
```

**期望**: `/healthz` 返回 ok,`/run` 返回 task_id,**响应 < 100ms**

#### 3.3.2 任务状态轮询

```bash
TASK_ID=$(echo "$TASK" | jq -r .task_id)
for i in $(seq 1 20); do
    STATUS=$(curl -s -u user:pass http://localhost:8765/runs/$TASK_ID | jq -r .status)
    [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ] && break
    sleep 3
done
curl -s -u user:pass http://localhost:8765/runs/$TASK_ID | jq
```

**期望**: 最终 status=done, exit_code=0

#### 3.3.3 sessions + loops + 持久化

```bash
curl -s -u user:pass http://localhost:8765/sessions | jq
curl -s -u user:pass http://localhost:8765/loops | jq

sudo systemctl restart cc-workflow
sleep 3
curl -s -u user:pass http://localhost:8765/runs/$TASK_ID | jq    # 还能查到
```

**期望**: sessions 显示活跃 / queued / recent,loops 显示 cron jobs,**重启后历史仍在**

---

### 3.4 P0-4: Feishu

#### 3.4.1 签名校验

```bash
curl -s -X POST http://localhost:8765/im/feishu/webhook \
    -H "X-Lark-Signature: wrong" -d '{}' -o /dev/null -w "%{http_code}\n"
# 401
```

用飞书后台"事件订阅 → 验证消息推送"按钮测试 challenge:**应返回 200 + 期望响应**

#### 3.4.2 消息路由 + Reply

飞书发: "在 test-repo 加一个 hello.txt 文件"

**期望**:
- backend 日志看到 event
- db 有新 run(source=feishu)
- 1-3 分钟后飞书收到 reply

#### 3.4.3 多轮 session

```
你 → "记住秘密单词 elephant"
等 30s
你 → "我刚说的秘密单词是?"
```

**期望**: 第二次回复含 elephant

---

### 3.5 P0-5: PWA

#### 3.5.1 装到桌面

iPhone Safari 开 `https://<server>/pwa/` → 分享 → 添加到主屏幕

**期望**: 桌面图标,点击启动看 PWA(不是浏览器 chrome)

#### 3.5.2 触发 + 状态可见

PWA 选 test-repo / claude / "say PWA-test" / Run

**期望**:
- 立即看到 task queued + task_id
- 30s 内任务开始(activity 显示 running)
- 完成后看到结果 "PWA-test"

---

### 3.6 P0-6: Web Push

#### 3.6.1 VAPID + 订阅

```bash
ls -la ~/.cc-workflow/vapid_public.pem    # 存在
grep vapid_private ~/.cc-workflow/secrets.toml   # 存在,文件权限 0600
```

PWA 点 "启用通知" → 浏览器弹权限 → 允许

```bash
sqlite3 ~/.cc-state/runs.db "SELECT count(*) FROM push_subscriptions"
```

**期望**: count ≥ 1

#### 3.6.2 完成时 push

PWA 触发一个任务,**完成时 phone 锁屏弹通知,15s 内到达**,内容含任务摘要

---

### 3.7 P0-7: 安全(7 子项)

#### 3.7.1 [7a] push main 阻断

(已在 §3.1.4 验证)

#### 3.7.2 [7b] Daily cost 告警

```bash
# 插入模拟数据
sqlite3 ~/.cc-state/runs.db "UPDATE runs SET tokens_used=20000 WHERE date(started_at,'unixepoch')=date('now')"
# 触发 cost 检查(如有手动接口)或等 daily cost 检查 cron
```

**期望**: 飞书或 push 收到 "今日 token 用量接近上限"

#### 3.7.3 [7c] CORS 拒绝跨 origin

```bash
curl -s -X POST http://localhost:8765/run \
    -H "Origin: https://evil.com" -H "Content-Type: application/json" \
    -d '{}' -o /dev/null -w "%{http_code}\n"
```

**期望**: 403(或 CORS 预检 fail)

#### 3.7.4 [7d] CSRF 缺 token

```bash
curl -s -X POST http://localhost:8765/run -u user:pass \
    -H "Content-Type: application/json" -d '{}' \
    -o /dev/null -w "%{http_code}\n"
# 没带 X-CSRF-Token 也没 cookie
```

**期望**: 403

#### 3.7.5 [7e] 权限位

```bash
ls -la ~/.cc-workflow/secrets.toml ~/.cc-workflow/providers.json
ls -ld ~/.cc-state/logs
```

**期望**: 两文件均 `-rw-------` (0600),logs 目录 `drwx------` (0700)

#### 3.7.6 [7f] Push subscribe 鉴权

```bash
# 不带 session token
curl -s -X POST http://localhost:8765/push/subscribe \
    -H "Content-Type: application/json" -d '{...}' \
    -o /dev/null -w "%{http_code}\n"
```

**期望**: 401

#### 3.7.7 [7g] 连败 disable

(已在 §3.2.2 验证 + 此处验证 push 告警到达)

**期望**: 连败触发后,**phone 收到 push: "Loop X 已自动禁用"**

---

### 3.8 P0-8: 可靠性(4 子项)

#### 3.8.1 [8a] SQLite backup

```bash
# 手动触发一次
python3 -m backend.reliability daily_backup
ls -la ~/.cc-state/backup/
```

**期望**: 看到 `runs-YYYYMMDD.db` 文件,> 0 bytes,能 `sqlite3 .read` 打开

#### 3.8.2 [8b] Log 轮转

```bash
# 准备一个老 log
touch -d "40 days ago" ~/.cc-state/logs/old.jsonl

python3 -m backend.reliability weekly_log_cleanup
ls ~/.cc-state/logs/
```

**期望**: 40 天前的文件被删

#### 3.8.3 [8c] Worktree 清理

```bash
# 准备一个 stale worktree
WS=~/workspaces/.wt/test-repo-stale
mkdir -p $WS && touch -d "10 days ago" $WS/.lastactive

python3 -m backend.reliability weekly_worktree_prune
ls ~/workspaces/.wt/
```

**期望**: stale worktree 被清

#### 3.8.4 [8d] Service 自启

```bash
sudo systemctl status cc-workflow
sudo reboot
# 等机器起来后
ssh server "systemctl is-active cc-workflow"
curl https://<server>/healthz
```

**期望**: reboot 后 backend 自动起来

---

## 4. 端到端(E2E)场景

按 Phase 分组。**Phase 3 验收时所有场景都要重跑一遍**。

### Phase 1 场景(A0 验证用)

#### 场景 A1: Mac 浏览器 → PR

1. Mac Chrome 打开 `http://<server>/`(或 HTTPS)看简陋触发页
2. 选 repo1 / claude / "在 README 顶部加 Hello-Mac"
3. 点 Run
4. 页面 3 秒轮询 status,1-3 分钟内显示完成 + PR URL
5. GitHub 看到 PR,branch=claude/repo1-..., diff 含 "Hello-Mac"

#### 场景 B: 飞书 → PR

1. 手机飞书发"在 repo2 加 hello.md"
2. 1-3 分钟内飞书 reply,含 PR URL
3. GitHub 看到 PR

#### 场景 C: Cron → 飞书

1. 配置 daily-digest 每分钟跑(测试)
2. 等 2 分钟
3. 飞书收到 digest

### Phase 2 场景(A0' 验证用)

#### 场景 A2: PWA → PR + Push

1. iPhone Safari 开 `https://<server>/pwa/` → 装到主屏幕
2. PWA 上选 repo1 / claude / "在 README 加 Hello-PWA"
3. 点 Run,**锁屏关 phone**
4. 1-3 分钟内锁屏弹 push 通知,含 PR URL
5. 点 push,PWA 自动打开,看到完整输出 + PR 链接
6. GitHub 看到 PR

(Phase 1 场景 B 和 C 不变)

### Phase 3 全场景回归

Phase 1 + Phase 2 所有场景重跑一次,验证安全护栏和可靠性没破坏现有功能。

特别加测:
- 跑场景 A2,然后立刻再发 1 个任务从浏览器 → 验证 CSRF 不互相干扰
- 跑场景 B,故意让 Feishu 签名错 → 验证 401
- 跑场景 C 失败 3 次 → 验证 enabled 自动 false + push 告警

---

## 5. 失败诊断 Playbook

### "claude command not found in cron"

cron 子进程 PATH 不含 claude。修:
- `/etc/cron.d/cc-loops` 头部加 `PATH=/usr/local/bin:/usr/bin:/bin`
- 或用绝对路径 `$(which claude)`

### "FastAPI 启动 500"

```bash
sudo journalctl -u cc-workflow -n 100
```

常见: SQLite 权限、`~/.cc-state` 不存在、config 缺字段

### "PWA 装不到桌面"

- manifest 必须含 name / start_url / icons (192 + 512)
- start_url 必须是 https
- service worker 必须注册成功

### "Web Push 不到达"

- VAPID 公私钥 server / PWA 一致
- 订阅后 db 有记录
- pywebpush 日志: 410/404 = 订阅失效,401 = VAPID 错
- **iOS Safari 16.4+ 才支持**

### "飞书 webhook 签名 invalid"

- App Secret 是否对(secrets.toml)
- timestamp + nonce + Encrypt Key 顺序(看飞书 docs)
- 用飞书后台 "事件订阅 → 验证按钮" 测

### "Codex 报 unknown subcommand"

Codex CLI 版本不对或命令名变化。

**降级方案**: 标记 codex 为 P1,P0-1 退到仅 Claude

### "并发限制不触发"

flock 调用 / lock 路径 / mmin 判定

### "CORS preflight 失败"

- 浏览器开 F12 → Network 看 OPTIONS 请求
- 后端 allow_origins 是不是包含 https://<server>

### "CSRF 总是 403"

- 先 GET /csrf 拿 token + cookie
- POST 时 header `X-CSRF-Token` 必须 = cookie 里同名值

### "Backup 文件 0 bytes"

SQLite `.backup` 在写入中可能失败。检查源 db 权限,检查目标目录可写。

---

## 6. Soak Test(P0 验收后第 1 周)

每天看一次:

- [ ] `curl /loops` 看连败计数
- [ ] `journalctl -u cc-workflow -n 200` 看 ERROR 数
- [ ] `SELECT count(*) FROM runs WHERE status='failed' AND started_at > strftime('%s','now','-1 day')`
- [ ] 今日 cost 估算
- [ ] `ls ~/.cc-state/backup/` — 每天该多 1 份
- [ ] `du -sh ~/.cc-state/logs/` — 不超过 1G

**7 天稳定 + P0 全验收 = 进 P1**
