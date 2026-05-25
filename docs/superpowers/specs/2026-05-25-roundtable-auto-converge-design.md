# Roundtable Auto-Converge + 续问 — Design

**Date:** 2026-05-25
**Status:** Approved for implementation (pending user review of this doc)
**Scope:** 给 roundtable 加 3 件事 — (1) 审查员角色判断"是否收敛",(2) 未收敛自动追问循环上限 3 次,(3) 续问能力让用户主动追。

---

## 1. Motivation

当前 roundtable 是 fire-and-forget:R1 answer + R2 critique + synth → 结束。产出是"决策辅助"式的 5 段 territory map(共识 / 分歧 / 关键判断 / 条件性结论 / 下一步)。

**用户痛点:** 拿到 map 后想 drill 进某一点继续追,系统没机制响应 —— session 到此为止。

**目标:**
- (a) **审查员判断收敛** — 看完 session 决定"够清晰了"还是"还有关键分歧没摊完"
- (b) **自动 drill** — 未收敛时审查员出 1 个具体追问问题,4 派再辩一轮 + 新 synth,直到收敛或 hit hard cap
- (c) **续问** — 用户主动追问,走同一套引擎(4 派 follow-up + synth + 审查员判断 + 可能再触发 auto-drill)

---

## 2. Approach: 审查员 + Auto-Drill Loop + 续问 共享一套底层

### 2.1 架构

```
[初始 session]
  R1 answer × 4 派
  R2 critique × 4 派        ← 现有逻辑
  synth(initial)
        ↓
  ┌─────────────────────────────────┐
  │ AUTO-DRILL LOOP                 │
  │   审查员判断                       │
  │     ├─ CONVERGED → break         │
  │     └─ NEEDS_DRILL + next_q      │
  │         → R[N+1] follow-up × 4 派 │
  │         → 新 synth                │
  │         → 审查员再判断              │
  │   (max_auto_drills=3 上限)        │
  └─────────────────────────────────┘
        ↓
  完结 — session.jsonl 落盘

[POST /roundtable/{id}/continue body={question}]
  R[M+1] follow-up × 4 派 (看到 user's question + 历史 synth)
  新 synth
        ↓
  AUTO-DRILL LOOP(同上,从这次 follow-up 后重新计数)
        ↓
  完结
```

**几乎不可逆的设计选择(§3.2 第 1 级,提前钉死):**

| 决策 | 选择 | 理由 |
|---|---|---|
| 审查员是否进 `ROLES` list | **不进** — 跟 ADJUDICATOR 同列,是元角色 | 不参与论辩,不该出现在派之间的相互引用 |
| 续问是否也跑审查员 | **跑**(用户选项 Q2=a) | 续问后再让审查员判断"这次追问是否解决了你的问题",必要时继续 auto-drill。代价:延迟翻倍;收益:产品一致性 |
| max_auto_drills 默认 | **3**(用户选项 Q1=b) | 大多数场景能收敛 + token 成本可控 |
| 续问 = append 同 session 还是新 session | **append 同 session.jsonl** | 心智模型是"继续这场对话" |
| max_iter 到顶 PWA 怎么呈现 | **banner + prefill 审查员最后的 next_q**(Q4=b) | 用户一键续问,无缝衔接 |

### 2.2 jsonl 格式(append-only,旧 session 兼容)

```
session.jsonl
├── meta line
├── R1 × 4 派      (type=answer,    round=1)
├── R2 × 4 派      (type=critique,  round=2)
├── synth          (type=synth,     round=3)
├── reviewer turn  (type=review,    round=3)            ← 新
├── (NEEDS_DRILL 时)
│   ├── R4 × 4 派  (type=follow_up, round=4, source=auto)  ← 新 type
│   ├── synth      (type=synth,     round=4)               ← 多个 synth turn(打破"最多 1 个"老 invariant)
│   └── reviewer   (type=review,    round=4)
├── (用户 POST /continue 时)
│   ├── user q     (type=user_question, round=5)        ← 新 type
│   ├── R5 × 4 派  (type=follow_up, round=5, source=user)
│   ├── synth      (type=synth,     round=5)
│   └── reviewer   (type=review,    round=5)
└── ...
```

**新增 turn types:** `review`, `follow_up`, `user_question`(共 3 个)。

**老 invariant 改写:** `data.py:11` 原文 "Exactly one type='synth' turn per Session, and it is the last turn" → 改成 **"LAST type='synth' turn 是当前的 synth;earlier synth 是历史"**。读 jsonl 时按 last-synth-wins,旧 session 自然兼容(它只有一个 synth)。

---

## 3. Components

### 3.1 审查员 Role(`backend/roundtable/roles.py`)

```python
REVIEWER = Role(
    name="审查员",
    preferred_model="deepseek-chat",   # 稳定 structured output + 低 token
    temperature=0.0,                    # 判断任务要确定性
    system_prompt="""
你是审查员,不参与论辩,只判断"圆桌讨论是否已收敛到足够清晰的答案"。

判断标准(全部满足才算收敛):
1. 用户的原始问题在最新 synth 里有明确响应
2. 派之间的核心分歧已经摊开 + 给了条件性结论
3. 没有未澄清就被搁置的关键事实/概念
4. 不强求"派全部同意" — 摆清楚 tradeoff 本身就是收敛

如果觉得还没收敛,你必须给出一个**具体到一点上的**追问问题,
不允许是"继续讨论"、"再展开"这种抽象指令。也不允许重复上轮已经辩过的问题。

输出严格用下面 markdown 格式(parser 按 ## 段落标题切):

## 判断
CONVERGED
(或单独一行:NEEDS_DRILL)

## 理由
[1-2 句话]

## 追问问题
(仅 NEEDS_DRILL 时填,具体到一点;CONVERGED 时这段省略)
""",
)
```

**deepseek-chat 不 reasoning model** —— 避免 `reasoning_content` 字段绕路(虽然 model.py 已经修了 fallback,但 structured output 任务 reasoning 反而干扰)。

### 3.2 Verdict 解析(`backend/roundtable/reviewer.py` — 新文件)

```python
@dataclass(frozen=True)
class ReviewerVerdict:
    converged: bool
    reason: str
    next_question: str | None    # 仅 not converged 时非 None


def parse_verdict(text: str) -> ReviewerVerdict:
    """Parse 审查员 markdown 输出。解析失败 → 保守 fallback 为 CONVERGED
    (避免"解析坏了"被误读成"应该继续 drill" → 无限 loop / token 浪费)。
    """
```

**Fallback 表(parser 严格但宽容):**

| 输入异常 | 处理 |
|---|---|
| 没有 `## 判断` 段 | → `CONVERGED`(保守停) |
| `## 判断` 段值不是 `CONVERGED` / `NEEDS_DRILL` | → `CONVERGED` |
| `NEEDS_DRILL` 但 `## 追问问题` 段缺失或空 | → `CONVERGED`(没问题可问 = 别死磕) |
| `## 理由` 段缺失 | → `reason=""`,verdict 仍按 `## 判断` 取 |

**纯函数,5 个单测覆盖全部 case。**

### 3.3 Auto-Drill Loop(`backend/roundtable/debate.py`)

`run_session` 加 `max_auto_drills: int = 3` 参数。在现有 synth 之后加:

```python
def run_session(..., max_auto_drills: int = 3, ...):
    ... # 现有 R1 / R2 / initial synth 不动

    next_round = synth_round + 1
    for _ in range(max_auto_drills):
        verdict_text = model_fn(REVIEWER.preferred_model, REVIEWER.system_prompt,
                                _build_reviewer_prompt(session), REVIEWER.temperature)
        verdict = reviewer.parse_verdict(verdict_text)
        _record(_reviewer_turn(verdict, next_round - 1))   # type=review
        if verdict.converged:
            break
        # NEEDS_DRILL → 跑 1 轮 follow-up + 新 synth
        _run_follow_up_round(verdict.next_question, source="auto", round_no=next_round)
        _run_synth(round_no=next_round)
        next_round += 1
    return session
```

`_build_reviewer_prompt` 把 **最新 synth + 所有历史 reviewer turns** 喂给审查员(不喂完整 R1/R2 详情 — 省 token,且审查员的判断只需要看 synth 即可,§7 Non-goals 第 4 条)。

### 3.4 续问 Endpoint(`backend/main.py`)

```python
class ContinueRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)


@app.post("/roundtable/{session_id}/continue", dependencies=PROTECT)
def continue_roundtable(session_id: str, body: ContinueRequest) -> dict:
    """Append user follow-up. 跑 follow-up round + synth + auto-drill loop。"""
```

复用 `run_session` 内部的 follow-up + auto-drill 逻辑 — 拆出一个 `continue_session(session_path, question, source="user")` helper,initial path 和 continue path 共用。

### 3.5 PWA UI(`pwa/app.js` roundtable detail view)

- **续问 input** — session 末尾加 `<textarea>` + "继续问" button,POST `/continue`
- **Auto-drill 进度** — round N+1, N+2 出现时正常渲染(就是 follow-up turns),用户能看到自动追问的过程
- **Max-iter banner** — 如果最后一个 review turn 是 `NEEDS_DRILL`(说明跑满 3 次还没收敛):

  ```
  ⚠ 审查员认为还没收敛(已达 3 次自动追问上限)
  建议继续追问: [next_question 全文]
  [一键续问] [关闭]
  ```

  点 "一键续问" → 把 next_question 填进上面那个 textarea 提交。

---

## 4. Error Handling

| 场景 | 处理 |
|---|---|
| 审查员 LLM 调用失败 / 超时 | break out of loop;session 标 "auto-drill interrupted"。PWA 显示 warning + 仍可手动续问 |
| 审查员输出解析失败 | §3.2 fallback 表 |
| `POST /continue` 时 session 不存在 / 已删 | 404 |
| `POST /continue` body.question 为空 | 422(Pydantic min_length=1) |
| 续问触发的 follow-up round 跑挂 | jsonl 留半截结果 + session 标 "interrupted",下次续问无影响 |
| max_auto_drills 是 0(配置成关) | loop 一次都不跑 → 行为等同现状,零回归 |

---

## 5. Testing

### 5.1 Unit(`tests/test_roundtable.py` 扩)

- `reviewer.parse_verdict()` 5 个 fixture:CONVERGED / NEEDS_DRILL+next_q / 缺段 / 段值错 / NEEDS_DRILL 但缺 next_q
- 审查员 prompt 关键 anchor 断言:`assert "CONVERGED" in REVIEWER.system_prompt` 等

### 5.2 Integration

- `run_session` with fake `model_fn`:
  - 审查员上来就 CONVERGED → loop 0 次,jsonl 跟现有 + 1 个 review turn
  - 审查员前 2 次 NEEDS_DRILL 第 3 次 CONVERGED → 跑 2 次 auto-drill
  - 审查员永远 NEEDS_DRILL → max_auto_drills=3 后停,最后一个 review 是 NEEDS_DRILL
  - 审查员输出格式坏 → 按 fallback 走
- `POST /continue` 端到端:基本流程跑通,session.jsonl 长出 follow-up + 新 synth + 新 review

### 5.3 Non-goals(明确不测)

- 审查员判断质量好不好 — 那是 eval framework 的事,目前 YAGNI
- PWA UI 渲染 — 无 jsdom 设施,人工 ssh 验证

---

## 6. Migration & Rollout

- **零迁移:** 老 session.jsonl 没新 turn types → io.py 读 jsonl 时按 `type` field dispatch,未知 type 已经有兜底(verify in code)
- **回滚:** `max_auto_drills=0` 一键关掉 auto-drill;新 turn types 在老前端被忽略,数据不破坏
- **配置:** `config.toml` 加一个可选 `[roundtable] max_auto_drills = 3`(缺省 3),不强制写

---

## 7. Non-Goals (YAGNI)

- ❌ 用户中途打断 auto-drill —— drill 跑得快(~30s/轮 × 3 ≤ 2 min),看完再续问
- ❌ 审查员评分反馈循环(用户给"审查员判断对不对"打分调 prompt) —— 等 eval 数据
- ❌ 审查员看完整 R1/R2 详情 —— 只看 synth + reviewer history,token 省 + 判断聚焦
- ❌ PWA 配置 max_auto_drills —— config.toml 全局够,per-session 配置 YAGNI

---

## 8. 工程方法论自检(CLAUDE.md §4)

| 原则 | 检查 |
|---|---|
| §0 沟通 | 4 个关键决策(Q1-Q4)已 Q&A 钉死,副作用("续问也触发 auto-drill")显式 |
| §1 Unix | `reviewer.py` 单一职责(parse + verdict 类型);auto-drill loop 在 debate.py 单一函数;不引入 BaseX |
| §2 TDD | parse_verdict 纯函数;auto-drill loop 注入 fake model_fn 即可测;接口 5 分钟可写单测 |
| §3.1 trade-off | §2 已对比"审查员调用 vs 状态机 pause"(后者 = Option 3 被砍) |
| §3.2 反悔成本 | jsonl turn type 命名 / verdict schema / `max_auto_drills` 配置位置 —— 第 1 级,spec 钉死 |
| §3.3 复杂度 | 不加 stateful pause(YAGNI);只加 1 个新文件 + 1 个 endpoint + 1 段 loop;约 ~385 行 |
| §3.4 通用语言 | reviewer / 审查员 一一对应;verdict / next_question / max_auto_drills 全代码统一 |
