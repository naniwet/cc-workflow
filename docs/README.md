# cc-workflow

> 个人 AI 工作流系统 — 项目设计文档目录。

## 阅读顺序

| # | 文件 | 内容 | 受众 |
|---|---|---|---|
| 01 | `01-prd.md` | PRD: 问题、目标、需求(P0-1 到 P0-8)、成功指标 | 设计 review / 决策回溯 |
| 02 | `02-dev-plan.md` | 实施计划: 文件清单 / 接口契约 / T+ 顺序 | 服务器 Claude Code 实现跟着干 |
| 03 | `03-test-plan.md` | 测试计划: 每个 P0 acceptance → 具体命令 | 验证每阶段 |
| 04 | `04-handoff.md` | 给服务器 Claude Code 的初始 brief | 复制到 Claude Code 启动 |
| -- | `future/multi-agent-design.md` | **P1 才看,P0 期间不要读** | P0 验收后讨论入口 |

## 项目身份

- 单人使用
- 4C8G 云服务器,Linux
- 4 个目标 repo,GitHub
- API keys 已有: Anthropic / OpenAI / DeepSeek / Moonshot(Kimi)
- 飞书已有 webhook 集成
- 目标: phone 当信号器,server 当执行引擎

## 工作流约定

**Cowork 这边(写文档)** vs **服务器 Claude Code(写代码)** 的分工:

| 在哪做 | 适合 |
|---|---|
| Cowork | PRD / 实施计划 / 测试计划 / 架构 review / 设计 brainstorm |
| Server Claude Code | 实际代码 / 测试 / 调试 / 部署 |

平时分开跑,**遇到架构问题 / PRD 不清楚 / 想加新需求**时回 Cowork。

## 已确认的关键决策

- 单用户、4 repo、不设 API 硬上限(软告警)、禁止 push main、不启用 Cloud Routines
- 不依赖 OpenClaw,用 Linux cron + 自建 FastAPI gateway
- 飞书 + 钉钉(将来)用适配器形态,可加 Slack/Telegram
- 5 引擎: Claude / Codex / GPT / DeepSeek / Kimi,通过 agent-run 抽象
- 多 agent 模式默认 devils-advocate(3 agent),P1 实施
- 守护进程数 ≤ 2,总代码量 ≤ 1500 行

完整决策演进见 `01-prd.md` 附录 A。
