# Handoff Brief — 给服务器 Claude Code 的开工说明

> 你好,Claude Code。我是 Cowork 这一侧的 Claude,负责把项目设计沉淀成 PRD / dev-plan / test-plan。**实现部分交给你**,因为你在用户的服务器上,能跑实际命令、读真实文件、做真实迭代——比我在 Cowork 沙箱里写代码再让用户复制过去快 10-20 倍。

---

## 1. 这是什么项目(30 秒版)

用户(单人)有一台云服务器(Ubuntu, 4C8G),4 个 GitHub repo,飞书已集成,有 Anthropic / OpenAI / DeepSeek / Moonshot 4 套 API key。

要建一个 **"手机当信号器,服务器当执行引擎"** 的 AI 工作流系统:

- 手机发指令 → 你在 server 上的 backend 接到 → 启动 Claude / Codex 等 agent → 执行编码任务 → push 通知回手机
- Linux cron 定时触发同样的执行路径(无人值守 Loop)

替代之前的临时方案(OpenClaw + Feishu 桥接)。

---

## 2. 你的角色(三件事)

1. **实现** PRD §6.1 列的 8 个 P0 需求 P0-1 到 P0-8(P1/P2 暂不做)
2. **遵循** [02-dev-plan.md](02-dev-plan.md) 的目录结构、接口契约、T+ 顺序——**不要重新设计**
3. **验证** 每完成一个 P0 模块,跑 [03-test-plan.md](03-test-plan.md) 对应章节的全部测试,**全过才进下一个**

---

## 3. 你不该做的事(严格)

| 禁止 | 理由 |
|---|---|
| 重新设计架构 | 已在 PRD 里钉死,你不知道当时的决策上下文 |
| 实现 P1 / P2 | 即使顺手也不做,scope creep 是项目第一杀手 |
| 引入未列依赖 | Redis / Celery / ORM / React / Vue 等都禁止(见 dev-plan §7) |
| 静默改接口契约 | 如果觉得 dev-plan §4 哪里不对,**停下,标记问题** |
| 跳过测试 | 测不过 = 没完成。不要用 mock / 跳过 / TODO 后补 |
| `git push origin main` | 这台机器上的 4 个目标 repo 都开了 branch protection,**永远 PR 不 push** |
| force push 任何分支 | 同上 |
| 修改 git config | 系统配置不动 |
| 用 `--no-verify` 跳 hook | hook 失败要修根因 |

---

## 4. 怎么读这一套文档(阅读顺序)

按顺序读 1-2 小时:

1. **本文件(04-handoff.md)** — 你正在读
2. **[01-prd.md](01-prd.md)** — 项目的 why 和 what(20 分钟)
3. **[02-dev-plan.md](02-dev-plan.md)** — 文件结构 / 接口契约 / Day-by-Day(15 分钟)
4. **[03-test-plan.md](03-test-plan.md)** — 怎么知道你干完了(10 分钟,做参考用)

读完后,**先不要写代码**。先 echo 一下:

> "I read the 4 docs. My understanding of the next task is: <复述>. Plan to do: <你要怎么做>. Anything I should double-check before starting?"

让用户(或 Cowork)回应。这一步避免你跑偏 80%。

---

## 5. 实施分 3 阶段,T+0 起 Phase 1

整个 P0 分 **Phase 1 → Phase 2 → Phase 3** 三个阶段(详见 [PRD §6.0](01-prd.md#60-实施阶段phasing) 和 [dev-plan §5](02-dev-plan.md#5-实施顺序按-phase依赖序)):

| Phase | 范围 | Gate |
|---|---|---|
| **Phase 1** | P0-1 / P0-2 / P0-3 / P0-4 + 简陋 HTML | A0:Mac 浏览器 + 飞书都能端到端 |
| **Phase 2** | P0-5(PWA) / P0-6(Push) | A0':iPhone PWA + Push 端到端 |
| **Phase 3** | P0-7 / P0-8 | 安全 + 可靠性全过 |

**强制规则**: A0 不过不许碰 Phase 2 任何文件。A0' 不过不许进 Phase 3。

### T+0 任务:Phase 1 第一步

实现 **P0-1:`agent-run.sh`**:

- **Claude 引擎严格 P0**(必须全过 [03-test-plan §3.1.1-3.1.4](03-test-plan.md#31-p0-1-agent-run))
- **Codex 引擎 best-effort**(尽力 §3.1.5,**不通过不阻塞 P0**;真不行写到 commit message 里降级到 P1)
- **不要碰 Phase 2 / Phase 3 的任何文件**(pwa/、backend/push.py、backend/csrf.py、backend/reliability.py)

### 步骤

1. 在 server 上创建项目目录 `~/projects/cc-workflow/`,`git init`
2. 把这 4 份文档 sync / 复制过来,放在 `~/projects/cc-workflow/docs/`
3. 准备测试 workspace:
   ```bash
   mkdir -p ~/workspaces/test-repo
   cd ~/workspaces/test-repo
   git init && touch README.md && git add . && git commit -m "initial"
   # 添加 GitHub remote(任选你的一个 repo 做测试)
   ```
4. 装依赖 + 配 provider:
   ```bash
   bash scripts/install-deps.sh
   # 跑完它会:
   #   - npm i -g @anthropic-ai/claude-code
   #   - 装 codex CLI(各平台不同)
   #   - apt-get install -y jq
   #   - 写 ~/.cc-workflow/config.toml(默认 provider = "deepseek")
   #   - 写 ~/.cc-workflow/providers.json 模板(0600)
   $EDITOR ~/.cc-workflow/config.toml      # 选 provider
   $EDITOR ~/.cc-workflow/providers.json   # 填 <api-key> 占位
   # 鉴权(按 provider 选其一):
   #   claude / anthropic → claude login(OAuth)
   #   deepseek           → 不需要 claude login,env vars 从 providers.json 注入
   #   kimi               → 同上
   ```
   手动 sanity check:
   ```bash
   claude --version       # 需 >= 2.1.72
   codex --version 或 codex --help
   gh auth status         # 已登录
   jq --version
   flock --help           # bash 自带,Linux flock(macOS 没有)
   ```
5. 写 `agent-run.sh`,严格按 [02-dev-plan §4.1](02-dev-plan.md#41-agent-runsh-cli) 的接口契约
6. 跑 03-test-plan §3.1 全套(5 组测试,3.1.5 best-effort)
7. 全过后,git commit
8. **停下**,把状态贴出来,等用户/Cowork 检查后再进 Day 2

### T+0 通过判定(对照 test-plan §3.1)

- [ ] §3.1.1 Claude smoke 过
- [ ] §3.1.2 并发上限(3 成功 1 exit 65)
- [ ] §3.1.3 Session resume 工作
- [ ] §3.1.4 push main 阻断(exit 67)
- [ ] §3.1.5 Codex smoke(best-effort:不通过不阻塞 P0,记录到 PRD §6.1 P0-1 备注、降级 P1)

---

## 6. 什么时候找 Cowork(我)

发现下面情况之一,**停下来,把问题描述清楚交给用户,让用户决定要不要回 Cowork 讨论**:

| 触发 | 例子 |
|---|---|
| dev-plan 或 PRD 在某处不一致 / 没说清 | 比如 §4 接口契约说一回事,§5 day-by-day 说另一回事 |
| 实际环境跟 PRD 假设不符 | 比如 codex CLI 不存在 / 接口完全不同 |
| 想加任何不在 dev-plan 里的功能 | 即使"很合理",也先停下 |
| 想换技术栈或框架 | 比如想从 sqlite 换 postgres |
| 某个 P0 实现完了,要做阶段 review | 自然停顿点 |
| 测试不过,且 §5 诊断 playbook 没覆盖 | 真正卡住时 |

**不要默默偏离 dev-plan**——偏离是错误的,但说出来是对的。

---

## 7. 工作方式

### 颗粒度
- 一次一个文件,**写完 + 测过,再写下一个**
- 不并行起多个 P0
- 一个 commit 解决一件事

### 不确定时
- 默认走"最简方案"
- 在 commit message 标 `TODO: confirm <疑点>`
- 在 PR description 列出所有未解决问题

### 错误处理
- 测试不过 → **修问题**,不要 mock 不要绕开
- 卡住 30 分钟 → 写一份"已尝试 X,猜测 Y,需要决定 Z"的简报,交给用户
- 不要重试相同操作期待不同结果

### 用户的 CLAUDE.md(在 `~/.claude/CLAUDE.md`)
读一下,有 Unix / TDD / DDD / Trade-off 4 条原则。遵循它,特别是:
- **Unix**: 一个 module 一件事,不堆功能
- **TDD**: 接口能否在 5 分钟内写出单测?能否 mock 副作用?不能就改设计
- **DDD**: 用通用语言,session_key / workspace / engine 这些术语保持一致
- **Trade-off 显式**: 任何设计选择写清楚收益 + 代价 + 何时翻案

### Communication
完成一个 P0 → 简短 status:
```
✓ P0-1 (agent-run.sh) 完成
- 03-test-plan §3.1 全部 7 测过 (附测试输出)
- 代码 ~180 行(dev-plan 估算一致)
- 偏离 PRD 的点(如有):
  - 例:codex exec 实际语法是 codex run,已在 agent-run.sh 调整,PR description 标记
- 准备进 P0-2,等 review
```

卡住 → 简报:
```
卡在 P0-X 子任务 Y。
- 现象:[完整 error / 不期望的行为]
- 我已尝试:[A, B, C]
- 我猜原因:[hypothesis]
- 需要:[决定 / 信息 / Cowork 复审]
```

---

## 8. 起手 commit message 模板

```
feat(P0-1): agent-run.sh multi-engine wrapper

Per dev-plan §4.1 contract:
- exit codes per sysexits.h (0/64/65/66/67/68)
- flock-based concurrency limit (3)
- worktree isolation when session_key != default
- claude + codex engine routing
- push main detection (exit 67)
- state writes to ~/.cc-state/{locks,jobs,logs}/

Tests passed (test-plan §3.1):
- 3.1.1 claude smoke: OK
- 3.1.2 concurrency: 3 success + 1 exit-65
- 3.1.3 session --resume
- 3.1.4 push main blocked (exit 67)
- 3.1.5 codex smoke: <OK or N/A best-effort>


Co-authored-by: cc-workflow PRD <noreply>
```

---

## 9. 沟通通道

| 谁 | 何时 | 怎么联系 |
|---|---|---|
| 用户 | 任何决策、跑测试反馈、卡壳 | 直接对话 |
| Cowork(我) | 架构问题、PRD 不清楚、设计 review | 用户回 Cowork 这边问 |
| 你自己 | 实现、迭代、debug | 你自己内部循环 |

**你和我不需要直接对话**——你跟用户对话,用户来 Cowork 找我。

---

## 10. 退役计划(看远一点)

P0 全过 + Soak 1 周稳定后:

- OpenClaw 服务退役:`sudo systemctl disable openclaw-gateway`
- 数据备份保留(jobs.json 拷一份)
- ai-news-daily-top10 这种 cron 迁移到 Linux cron 形态

但**这不是你要做的**,这是 P0 验收后的运维动作。你只管把 P0 干完。

---

## 11. 结构性约束(代替"信任契约")

不靠话术,靠这 5 条约束防 drift。**每个 commit 前自检**:

1. **测不过 = 没干完**。03-test-plan 对应章节全过才能提交,不允许"TODO: add tests" / "测试先跳过" / mock 关键路径
2. **新依赖要在 commit message 标注理由**。任何 `pip install` / `npm install` / `apt install` 之外 dev-plan §8 没列的依赖,commit message 必须含 `NEW_DEP: <package> — <为什么必需>`,且新增依赖不能引入 dev-plan §7 禁止的(Redis / ORM / build step 等)
3. **dev-plan §4 接口契约不许改**。改契约必须在 commit message 加 `CONTRACT_CHANGE: <文件>:<改动>`,**推到独立分支**,等用户复议
4. **代码量按估算计算**。任何文件超 dev-plan §2 估算 1.3x 立即停下,看是否真需要那么多;1.5x 直接 commit message 标 `OVER_BUDGET` 找复议
5. **遇到不在 dev-plan 里的设计选择 → 默认走"最简方案"**,commit message 标 `MINIMAL_CHOICE: <选了什么 / 还可以选什么>`,供后续 review

> 这 5 条是 **commit-time 检查项**,不是修辞。违反任何一条,commit 不该被推出去。

---

## 12. 最后

读完 12 节后,**先 echo 你的理解**(见 §4 结尾),等用户/Cowork 回应,然后从 §5 第 1 步开始。

**复杂度有代价,默认是"不加",等真有需求再加** —— 这是这个项目最重要的设计原则。

— Cowork PRD owner
