# Test Plan — P0 验收

> ⚠ **历史文档警示**:
> 这是 v1.5 PRD 配套测试计划,但**实际实现已偏离**(Codex 下线、圆桌已 P0 完成、HMAC auth 替换 Basic、工具审批 / auto-compact / per-workspace 配置 等新增)。
>
> **多数 §3.1-3.4 单元测试仍可跑**(claude smoke、cron、FastAPI、Feishu webhook 这几块行为没大改)。但 §3.5-3.8 PWA / 安全 / 可靠性的具体命令**有些过期**,应以代码为准。
>
> 系统当前如何验证,以仓库根目录 [`README.md`](../../README.md) + 实际 `tests/` 目录为准。

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

### Phase 1 Gate (A0) — ✅ 全过 @ 2026-05-11
- [x] **A1.1** Claude 引擎 smoke + session resume — PASS(provider=deepseek)
- [x] **A1.2** 第 4 个并发立即 exit 65 — PASS
- [x] **A1.3** push main 阻断 exit 67 — PASS
- [ ] **A1.4** [best-effort] Codex smoke — SKIP(CLI 未装,降级 P1)
- [x] **A2.1** Cron job 状态文件更新 — PASS(tick-test 130s 跑 2 次)
- [x] **A3.1** POST /run < 100ms — PASS(13ms)
- [x] **A3.2** GET /sessions 显示活跃 worker — PASS
- [x] **A3.3** 重启后历史可查 — PASS
- [x] **A4.1** 飞书 → reply — PASS(私聊 `[test-repo] reply with only OK` → `[done · exit 0] OK`)
- [ ] **A4.2** 飞书多轮 session 连续 — 代码 ready,完整 multi-turn 实测待
- [x] **A0.1** Mac Chrome 看到简陋触发页 — PASS
- [x] **A0.2** 页面 Run 触发 → 看到完成 — PASS(`419f6bf18aef` elapsed 4s exit 0)
- [x] **A0.3** 飞书 → 看回复 — PASS(等于 A4.1)
- [x] **A0.4** cron loop 触发 + 状态文件更新 — PASS(等于 A2.1)

→ **Phase 2 解锁** ✅

### Phase 2 Gate (A0')
- [ ] **A5.1** `backend/ui_cards.py` 抽象 Card 模型存在,不含 Feishu 字符串
- [ ] **A5.2** 飞书 `/sessions` 卡片可用,刷新按钮工作
- [ ] **A5.3** 飞书 `/loops` 卡片可用,暂停按钮工作
- [ ] **A5.4** 飞书 `[workspace] prompt` 文本触发继续工作
- [ ] **A5.5** Card 抽象渲染出的 Feishu JSON 通过卡片调试器
- [ ] **A6.1** PWA-lite 在 iPhone 装到桌面,启动是独立 app
- [ ] **A6.2** Workspaces 视图 4 列同屏并排,各列独立触发
- [ ] **A6.3** Tasks 视图能添加 / 编辑 / 暂停 / 删除 cron
- [ ] **A6.4** Tasks 视图能看每条 cron 最近 5 次运行历史
- [ ] **A6.5** 长输出 > 4000 字符 → 飞书发截断 + PWA `/runs/<id>/view` 链接
- [ ] **A6.6** **不存在** `backend/push.py` / VAPID / Web Push handler 代码
- [ ] **A0'.1-A0'.8** Phase 2 总 Gate(PRD §6.0)

→ **A0' 全过才能进 Phase 3**(IM Card 抽象 + PWA shell 都是结构性,无降级路径)

### Phase 3 Gate
- [ ] **A2.2** 连败 3 → 状态 enabled=false
- [ ] **A7.1-A7.5** 5 项安全(见 §3.7)
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

**前置**: P0-5 / P0-6 单独测试都已过 (§3.5-3.6)

```bash
# A0'.1 — Card 抽象层
ls backend/ui_cards.py    # 存在
grep -i "feishu\|lark\|larksuite" backend/ui_cards.py   # 应无任何 Feishu-specific 字符串

# A0'.2 — 飞书 /sessions 卡片 + 刷新
#   飞书发: /sessions
#   收到卡片,列出活跃 / 队列 / 最近,有"刷新"按钮
#   点刷新,卡片更新

# A0'.3 — 飞书 /loops 卡片 + 操作
#   飞书发: /loops
#   收到卡片,列出 cron jobs,每条有"暂停 / 恢复 / 触发"按钮
#   点"暂停"某条,看 ~/.cc-state/jobs/<name>.json 的 enabled 变 false

# A0'.3 — 飞书 [workspace] prompt 文本触发(Phase 1 约定继续工作)
#   飞书发: [test-repo] reply with only OK
#   等 1-3 分钟,飞书 reply 含 OK

# A0'.4 — PWA-lite 装桌面
#   iPhone Safari 开 https://<server>/pwa/ → 添加到主屏幕
#   启动是独立 app(无 Safari chrome)
#   Mac Chrome 也可 ⊕ 装独立窗口

# A0'.5 — Workspaces 视图
#   PWA 进 Workspaces tab,看 4 个 repo 同屏并排
#   任一列点 Run 触发任务,该列实时显示

# A0'.6 — Tasks 视图
#   PWA 进 Tasks tab,点 "新建" 填 workspace + cron + prompt 提交
#   状态文件 ~/.cc-state/jobs/<name>.json 生成
#   编辑 / 暂停 / 删除按钮各工作

# A0'.7 — Card 抽象层
ls backend/ui_cards.py    # 存在
grep -i "feishu\|lark" backend/ui_cards.py   # 应无任何 Feishu-specific 字符串

# A0'.8 — 长输出降级
agent-run --engine=claude test-repo "print 5000 random words" longout
#   飞书消息含前 ~1500 + 链接 https://<server>/pwa/runs/<id>/view
```

**A0' 通过判定**: 8 项全过

#### 3.0.3 A0' 没有降级路径

Card 抽象在不在,是**结构性问题**——不能"先不抽象后面再说",后面 90% 概率不会再去抽。要么 Phase 2 一开工就把 `ui_cards.py` 做对,要么这事永远做不对。**没有 graceful degradation**。

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

### 3.5 P0-5: IM Card 抽象 + Feishu 卡片扩展

#### 3.5.1 Card 抽象层存在性

```bash
test -f backend/ui_cards.py && echo "OK"
# 不允许包含 Feishu-specific 字符串
grep -i "feishu\|lark\|larksuite\|im_card_v2" backend/ui_cards.py
```

**期望**: `ui_cards.py` 存在,无 Feishu 关键词

#### 3.5.2 /sessions 卡片 + 刷新

飞书私聊机器人发 `/sessions`,**期望**: 卡片含活跃 / 队列 / 最近,有"刷新"按钮。点刷新,卡片内容立即更新。

#### 3.5.3 /loops 卡片 + 暂停/触发

飞书发 `/loops`,**期望**: 卡片每条 loop 含"暂停 / 恢复 / 触发"按钮。点"暂停"某条 → `~/.cc-state/jobs/<name>.json` 的 `enabled` 变 false。

#### 3.5.4 新建任务表单

飞书发 `/run`,**期望**: 收到表单卡片含 workspace dropdown + prompt textarea + Run 按钮。选 test-repo + 输入 prompt + 提交 → 1-3 分钟后飞书 reply 含 PR URL。

#### 3.5.5 Card → Feishu JSON 渲染合法

把 `render_card()` 输出的 JSON 喂飞书 Open Platform 后台的"卡片调试器"(card builder),**期望**: 解析无错,预览效果对。

---

### 3.6 P0-6: PWA-lite App(Workspaces + Tasks)

#### 3.6.1 PWA shell + 装桌面

iPhone Safari 开 `https://<server>/pwa/` → 分享 → 添加到主屏幕

**期望**: 启动是独立 app(无 Safari chrome / 无地址栏)。Mac 上 Chrome 也能 ⊕ 装独立窗口。

```bash
# 服务器侧文件
ls -la pwa/manifest.json pwa/sw.js
# Push handler 必须无
grep -i "push\|notification\|vapid" pwa/sw.js
```

**期望**: manifest 和 sw 存在;sw.js 里 grep **无 push 相关代码**(cache-only 限制)

#### 3.6.2 Workspaces 视图

PWA 进 Workspaces tab,**期望**:
- 4 个 repo 同屏并排显示(响应式:1 / 2 / 4 列)
- 每列含活跃 session 数 + 最近完成 + 触发表单
- 在任一列点 "Run" 触发任务,该列实时反映
- 任务不影响其他列

#### 3.6.3 Tasks 视图

PWA 进 Tasks tab,**期望**:
- cron 列表显示,每条带 workspace / cron 表达式 / 上次运行 / consecutive_errors
- "新建" 按钮 → 表单:workspace dropdown + cron 表达式输入 + prompt textarea
- 提交后 → 状态文件 `~/.cc-state/jobs/<name>.json` 生成 + cron 注册到 `/etc/cron.d/`
- 编辑 / 暂停 / 触发 / 删除按钮各工作
- 点某条 cron 展开 → 看最近 5 次运行结果

#### 3.6.4 长输出降级

```bash
agent-run --engine=claude test-repo "echo $(python3 -c 'print(\"X\"*5000)')" longout-test
```

**期望**: 飞书消息含前 ~1500 字符 + 链接 `https://<server>/pwa/runs/<id>/view`;点链接看到完整 stream-json 渲染。

#### 3.6.5 Web Push 路径已砍干净

```bash
test -f backend/push.py && echo FAIL                # 不存在
grep -ri "vapid\|pywebpush\|push_subscriptions" backend/    # 应无引用
grep -i "self\\.registration\\.pushManager\|onpush" pwa/sw.js   # 不允许
```

**期望**: 全部"无引用"

---

### 3.7 P0-7: 安全(5 子项)

#### 3.7.1 [7a] push main 阻断

(已在 §3.1.4 验证)

#### 3.7.2 [7b] Daily cost 告警

```bash
sqlite3 ~/.cc-state/runs.db "UPDATE runs SET tokens_used=20000 WHERE date(started_at,'unixepoch')=date('now')"
# 触发 cost 检查
```

**期望**: 飞书收到告警卡片 "今日 token 用量接近上限"

#### 3.7.3 [7c] CORS 拒绝跨 origin

```bash
curl -s -X POST http://localhost:8765/run \
    -H "Origin: https://evil.com" -H "Content-Type: application/json" \
    -d '{}' -o /dev/null -w "%{http_code}\n"
```

**期望**: 403(或 CORS 预检 fail)

#### 3.7.4 [7d] 权限位

```bash
ls -la ~/.cc-workflow/secrets.toml ~/.cc-workflow/providers.json
ls -ld ~/.cc-state/logs
```

**期望**: 两文件均 `-rw-------` (0600),logs 目录 `drwx------` (0700)

#### 3.7.5 [7e] 连败 disable + 告警

(P0-2 A2.2 联动 — 在 §3.2.2 已模拟连败)

**期望**: 连败 3 次后,
- `~/.cc-state/jobs/<name>.json` 的 `enabled` = false
- 飞书收到告警卡片: "Loop X 连败 3 次,已自动禁用"

> 不在本方案的测试(整体退到 P1):
> - [7d] CSRF — 走 CORS + same-origin / 飞书签名校验
> - [7f] Push subscribe 鉴权 — Web Push 整体不做

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

#### 场景 A2: 飞书卡片 → PR

1. 手机飞书发 `/run` → 收到表单卡片
2. 表单选 repo1 / claude / "在 README 加 Hello-Card"
3. 点 Run 按钮
4. 1-3 分钟内飞书收到 reply,含 PR URL
5. 飞书发 `/sessions` 看活跃 → 确认任务在列表
6. GitHub 看到 PR,branch=claude/repo1-..., diff 含 "Hello-Card"

#### 场景 D: 长输出 → dashboard 兜底

1. 飞书或 Mac 触发一个会产出 5000+ 字符的任务
2. 完成后飞书消息显示前 1500 字符 + 链接 `https://<server>/runs/<id>/view`
3. 点链接 Mac 浏览器打开,看到完整 stream-json 渲染

(Phase 1 场景 A1 / B / C 不变)

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

### "Workspaces 视图渲染空"

- 浏览器 F12 → Network 看 `/sessions` 请求是否 200,响应 JSON 是否含数据
- backend `journalctl -u cc-workflow` 看是否报错
- CORS:开 F12 → Console 看 CORS error,可能是 origin 不在白名单

### "Tasks 视图添加 cron 失败"

- 检查 cron 表达式格式(crontab man 5 标准 5 字段)
- `ls /etc/cron.d/cc-loops` 看新条目是否写入
- backend 有没有 sudo 权限写 `/etc/cron.d/`(systemd unit 需要)

### 通知(飞书 push)没到

- **本方案不用 Web Push**,通知全走飞书原生
- 检查 backend 是否真调了 Feishu reply API(看日志)
- 飞书 App Secret / Verification Token 对吗

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
