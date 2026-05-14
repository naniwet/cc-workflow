# Multi-Agent 协同讨论设计(P1 规划,不在 P0)

> ⚠ **本文档不在 P0 实施范围内**。Claude Code 在做 P0 时**不要读不要实现**。
> 这是 P1-3 的提前设计,作为 P0 验收后讨论入口。

---

## 1. 为什么不在 P0

review 中发现:多 agent 讨论虽然有真实价值,但:
- API 成本翻 3-5 倍(同一问题多个 agent 跑)
- 延迟翻倍(顺序调用)
- 大多数 prompt 不需要(回音壁问题)
- 增加 ~300 行代码,挤占 P0 预算

**先把 P0 单 agent 跑稳,有了真使用数据(哪类问题真需要 brainstorm),再上 P1**。

---

## 2. 设计草案(P1 实施时参考)

### 2.1 3 种讨论模式

| 模式 | 形态 | 适用场景 | Agent 数 |
|---|---|---|---|
| **devils-advocate** | A 提议 → B 唱反调 → C 仲裁 | 架构选型 / 不可逆决策 | 3 |
| **roles** | 架构师 / 实现者 / 审查者 / 总结 各司其职 | 复杂设计任务 | 3-4 |
| **parallel-judge** | N 个独立答 → 1 个 judge 选 / 合 | 开放性问题 | N+1 |

**默认模式**: devils-advocate(3 agent 平衡成本/价值)

### 2.2 Agent 角色搭配建议

| Agent | 适合角色 |
|---|---|
| Claude | 架构师 / 主实现者(长 context、规划强) |
| GPT | 第二意见 / 仲裁者(中立、稳) |
| DeepSeek | 批判审查 / cost-sensitive 路径(便宜、找 bug 不留情) |
| Kimi | 长文档审查(200k context) |

### 2.3 API 抽象

```python
# backend/discuss.py(P1 才实现)
from openai import OpenAI
from anthropic import Anthropic

# OpenAI-compatible 共享 SDK
clients = {
    "gpt":      OpenAI(api_key=GPT_KEY,      base_url="https://api.openai.com/v1"),
    "deepseek": OpenAI(api_key=DS_KEY,       base_url="https://api.deepseek.com/v1"),
    "kimi":     OpenAI(api_key=KIMI_KEY,     base_url="https://api.moonshot.cn/v1"),
}
clients["claude"] = Anthropic(api_key=CL_KEY)
```

### 2.4 端点设计

```
POST /discuss
  body: {
    question: str,
    mode: "devils-advocate" | "roles" | "parallel-judge",
    agents: [{name, role, model, system_prompt}],   # 可选,有默认
    max_tokens_per_agent: 2000,                      # 成本上限
  }
  returns: {
    task_id, transcript: [...], synthesis: str
  }
```

### 2.5 一个高价值组合: discuss → code

```
你: "在 repo1 加 rate limiter,讨论方案"
   ↓ /discuss devils-advocate
   ├─ Claude:  提议 redis token bucket
   ├─ DeepSeek: 反驳 "QPS < 100,内存 dict 够"
   └─ GPT:     仲裁 "内存 dict + sqlite 持久化,折中"
   ↓ 你看后选 B
你: "按方案 B 实现"
   ↓ /run claude
   └─ Claude Code 在 worktree 实现 + PR
```

这种"讨论 → 实现"的衔接是 multi-agent 真正甜点。

---

## 3. 风险

| 风险 | 对策 |
|---|---|
| 回音壁(agent 互相点头) | 强制不同 system prompt + 显式角色 |
| 成本失控 | max_tokens_per_agent + 全局 cost 上限 |
| Synthesis 失真(判断 agent 自带偏见) | 让 synthesis 必须引用其他 agent 的原文 |
| 滥用(每个问题都 discuss) | UI 设默认 single-agent,discuss 是显式选 |

---

## 4. 何时升级到 P1 实施

P0 上线后 1 个月,看实际数据:
- 单 agent 模式跑稳没?(任务成功率 > 90%)
- 是否真有"复杂决策类"任务在单 agent 模式下吃力?
- API 月 cost 是否还有空间(< $200)?

3 个都 yes,P1-3 可以启动。否则继续单 agent 模式打磨。

---

## 5. 不在 P0 范围 — 严格要求

如果 Claude Code 在 P0 实施期读到本文档**并开始实现**,这是违反 04-handoff.md §3 的禁止条款。**正确做法 = 略过本文档**。
