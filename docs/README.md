# cc-workflow — 设计文档目录

> ⚠ **这些是历史设计文档**。系统当前如何工作请看仓库根目录的 [`README.md`](../README.md)。
>
> 01-04 记录的是 Phase 1/2 开工前的规划 + T+0 brief,部分内容(尤其鉴权模型、
> 工具审批路径、per-workspace 配置)已经在实施过程中演化。保留它们是为了
> 让设计决策的演进可追溯——但**作为"现在系统怎么工作"的参考已过期**。

## 阅读顺序

| # | 文件 | 内容 | 还有用吗? |
|---|---|---|---|
| 01 | `01-prd.md` | PRD: 问题、目标、需求(P0-1 到 P0-8)、决策附录 | ✓ why & 决策回溯仍准确 |
| 02 | `02-dev-plan.md` | 实施计划: 文件清单 / 接口契约 / T+ 顺序 | ⚠ 接口契约部分已演化,看代码为准 |
| 03 | `03-test-plan.md` | 测试计划: 每个 P0 acceptance → 具体命令 | ✓ 多数测试仍可跑 |
| 04 | `04-handoff.md` | 给实现方(服务器 Claude Code)的 T+0 brief | 历史价值 — 新人不必读 |
| -- | `future/multi-agent-design.md` | **P1 设计稿,尚未实施** | 准备做多 agent 协同时再读 |

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
