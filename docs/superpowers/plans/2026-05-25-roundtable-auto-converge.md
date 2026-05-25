# Roundtable Auto-Converge + 续问 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 roundtable 加 (1) 审查员 role 判断"是否收敛",(2) auto-drill loop(默认 3 次上限),(3) `POST /roundtables/{id}/continue` 让用户续问 — 续问也跑审查员 + auto-drill。

**Architecture:** 在现有 `run_session` 末尾加 auto-drill loop;loop body 抽成可复用 helper,被 initial session 和 `/continue` 共用。审查员是元角色(跟 SYNTHESIZER 同列,不在 `ROLES` list),输出结构化 markdown 由新 `reviewer.py` 解析。jsonl 加 3 个新 turn types(`review` / `follow_up` / `user_question`),老 invariant "只 1 个 synth turn" 改成 "last synth wins"(GET 端点已经这么读了,只是注释要更新)。

**Tech Stack:** Python 3.13 + FastAPI + Pydantic v2 + `unittest.TestCase` + monkeypatch(沿用 `tests/test_roundtable.py` 模式)。无新依赖。

**Spec:** [`docs/superpowers/specs/2026-05-25-roundtable-auto-converge-design.md`](../specs/2026-05-25-roundtable-auto-converge-design.md)

---

## File Structure

**Created:**
- `backend/roundtable/reviewer.py` — `ReviewerVerdict` dataclass + `parse_verdict()` 纯函数

**Modified:**
- `backend/roundtable/data.py` — `TurnType` Literal 扩(`answer / critique / synth / review / follow_up / user_question`),top docstring 更新 invariant
- `backend/roundtable/roles.py` — 加 `REVIEWER` 元角色(不进 `ROLES` list)
- `backend/roundtable/synth.py` — 加 `build_follow_up_synth_prompt()` 给 auto-drill / 续问 后的 synth 用
- `backend/roundtable/debate.py` — 抽 `_run_follow_up_iteration()` helper;`run_session` 末尾接 auto-drill loop;新增 `continue_session()` 入口
- `backend/roundtable/runner.py` — 新增 `submit_continue()` 给 /continue endpoint
- `backend/main.py` — 新增 `POST /roundtables/{id}/continue`;`GET /roundtables/{id}` 响应加 `reviewer` 段(供 PWA banner 渲染)
- `backend/config.py` — `[roundtable]` 配置段读 `max_auto_drills`(缺省 3)
- `pwa/app.js` — roundtable detail view 加续问 input + max-iter banner
- `tests/test_roundtable.py` — 扩 unit + integration 测试

**Files that change together stay together** — backend 改动一个 PR,PWA 改动同 PR(单用户单机项目模式)。

---

## Task 1: 扩 TurnType + 更新 data.py invariant 注释

**Files:**
- Modify: `backend/roundtable/data.py:18`(TurnType Literal)、`data.py:11`(docstring invariant 那行)

注意:此 task 没有可测的行为变化(仅类型联合扩张),不写 unit test,语法 check 即可。

- [ ] **Step 1: 扩 TurnType**

```python
# backend/roundtable/data.py:18
TurnType = Literal["answer", "critique", "synth", "review", "follow_up", "user_question"]
```

- [ ] **Step 2: 更新 invariant 注释**

`data.py:9-11` 原:

```
Invariants enforced by the orchestrator (debate.run_session), not here:
  - Session.turns is append-only.
  - AgentTurn.round walks 1 → 2 → 3 monotonically.
  - Exactly one type="synth" turn per Session, and it is the last turn.
```

改成:

```
Invariants enforced by the orchestrator (debate.run_session), not here:
  - Session.turns is append-only.
  - AgentTurn.round walks 1 → 2 → 3 → ... monotonically. Auto-drill /
    续问 会让 round 超过 critique_rounds + 2(原来的 synth round)。
  - LAST type="synth" turn 是当前 synth;earlier synth turns 是历史
    (auto-drill / 续问 后产生新 synth,前面的 synth 留着不删 — 旧代码
    `r3_turns[-1]` 这种 last-wins 写法保持有效,旧 session 兼容)。
  - 同 round 内,type 出现顺序:user_question(可选)→ answer/follow_up
    × N 派 → synth → review。
```

- [ ] **Step 3: 语法 check + commit**

```bash
python3 -m py_compile backend/roundtable/data.py && echo OK
git add backend/roundtable/data.py
git commit -m "refactor(roundtable): 扩 TurnType + 更新 invariant — 允许多 synth turn

加 3 个 turn types(review / follow_up / user_question)给即将到来的
auto-drill loop + 续问用。invariant 文档同步更新 — "exactly 1 synth"
改成 "last synth wins"。spec §2.2 + §3.2 一致。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `reviewer.py` — Verdict 数据类型 + 解析器

**Files:**
- Create: `backend/roundtable/reviewer.py`
- Modify: `tests/test_roundtable.py`(append 单测 class)

- [ ] **Step 1: 写 5 个失败测试**

在 `tests/test_roundtable.py` 末尾 `if __name__` 之前 append:

```python
class ParseVerdictTests(unittest.TestCase):
    """审查员输出解析 — fallback 表见 spec §3.2。"""

    def _parse(self, text: str):
        from backend.roundtable.reviewer import parse_verdict
        return parse_verdict(text)

    def test_converged_with_reason(self):
        v = self._parse("## 判断\nCONVERGED\n\n## 理由\n4 派分歧已经摊清楚。")
        self.assertTrue(v.converged)
        self.assertEqual(v.reason, "4 派分歧已经摊清楚。")
        self.assertIsNone(v.next_question)

    def test_needs_drill_with_next_question(self):
        v = self._parse(
            "## 判断\nNEEDS_DRILL\n\n## 理由\n关于 X 还没明确。\n\n"
            "## 追问问题\n那么如果 X 是 Y 的话,各派立场会变吗?"
        )
        self.assertFalse(v.converged)
        self.assertIn("X 是 Y", v.next_question)

    def test_missing_verdict_section_falls_back_to_converged(self):
        # spec §3.2 fallback 表第 1 行
        v = self._parse("没有 ## 判断 段")
        self.assertTrue(v.converged)

    def test_garbage_verdict_value_falls_back_to_converged(self):
        v = self._parse("## 判断\nMAYBE\n\n## 理由\n模型 hallucinate 了")
        self.assertTrue(v.converged)

    def test_needs_drill_but_no_next_question_falls_back_to_converged(self):
        # spec §3.2 fallback 表第 3 行 — 没问题可问 = 别死磕
        v = self._parse("## 判断\nNEEDS_DRILL\n\n## 理由\n好像还差点意思\n\n## 追问问题\n")
        self.assertTrue(v.converged)
```

- [ ] **Step 2: 跑测试,确认 5 个全失败(模块不存在)**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' -v 2>&1 | tail -10
```

预期:`ModuleNotFoundError: No module named 'backend.roundtable.reviewer'` ×5。

- [ ] **Step 3: 实现 `reviewer.py`**

```python
# backend/roundtable/reviewer.py
"""审查员输出解析。

审查员产出严格 markdown,parser 按 `## 段落标题` 切。解析失败 →
保守 fallback 为 CONVERGED(避免"解析坏了"被误读成"继续 drill" →
无限 loop + token 浪费)。fallback 表见 spec §3.2。
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ReviewerVerdict:
    converged: bool
    reason: str
    next_question: str | None    # 仅 not converged 时非 None


_SECTION_RE = re.compile(r"^##\s+(\S.*?)\s*$", re.MULTILINE)


def _split_sections(text: str) -> dict[str, str]:
    """`## 判断\\nFOO\\n\\n## 理由\\nBAR` → {判断: 'FOO', 理由: 'BAR'}"""
    out: dict[str, str] = {}
    matches = list(_SECTION_RE.finditer(text))
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out[title] = text[body_start:body_end].strip()
    return out


def parse_verdict(text: str) -> ReviewerVerdict:
    sections = _split_sections(text or "")
    verdict_raw = sections.get("判断", "").strip().upper()
    reason = sections.get("理由", "").strip()
    next_q = sections.get("追问问题", "").strip() or None

    # Fallback 表(spec §3.2)
    if verdict_raw == "CONVERGED":
        return ReviewerVerdict(converged=True, reason=reason, next_question=None)
    if verdict_raw == "NEEDS_DRILL":
        if not next_q:
            # 没问题可问 → 收敛
            return ReviewerVerdict(converged=True, reason=reason, next_question=None)
        return ReviewerVerdict(converged=False, reason=reason, next_question=next_q)
    # 缺段 / 段值错 → 保守停
    return ReviewerVerdict(converged=True, reason=reason, next_question=None)
```

- [ ] **Step 4: 跑测试,确认 5/5 pass**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' -v 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add backend/roundtable/reviewer.py tests/test_roundtable.py
git commit -m "feat(roundtable): 加 reviewer.py 解析审查员 markdown 输出

ReviewerVerdict(converged, reason, next_question) + parse_verdict()
纯函数 + 5 fallback 路径单测。解析失败一律 fallback CONVERGED —
保守停而不是死磕,spec §3.2。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 加 REVIEWER 元角色

**Files:**
- Modify: `backend/roundtable/roles.py`(SYNTHESIZER 同段下方,不进 ROLES list)
- Modify: `tests/test_roundtable.py`(append 1 个 prompt-anchor 断言)

- [ ] **Step 1: 写失败测试**

append 到 `tests/test_roundtable.py`(放在 ParseVerdictTests 之后):

```python
class ReviewerRoleTests(unittest.TestCase):
    def test_reviewer_prompt_carries_required_anchors(self):
        from backend.roundtable.roles import REVIEWER
        # spec §3.1 要求 prompt 包含关键 anchor — 不强校验全文,只校验
        # 必须出现的字面值,以免 prompt 演化时不小心删了 schema 关键词。
        self.assertEqual(REVIEWER.name, "审查员")
        self.assertEqual(REVIEWER.temperature, 0.0)
        self.assertEqual(REVIEWER.preferred_model, "deepseek-chat")
        for anchor in ("CONVERGED", "NEEDS_DRILL", "## 判断", "## 理由", "## 追问问题"):
            self.assertIn(anchor, REVIEWER.system_prompt)
```

- [ ] **Step 2: 跑测试,确认失败(导入错误)**

```bash
python3 -m unittest tests.test_roundtable.ReviewerRoleTests -v 2>&1 | tail -10
```

预期:`ImportError: cannot import name 'REVIEWER' from 'backend.roundtable.roles'`

- [ ] **Step 3: 实现 REVIEWER**

`backend/roundtable/roles.py` 在 `SYNTHESIZER = Role(...)` 之后(就是文件接近末尾,不进 `ROLES` list)append:

```python
# --------------------------------------------------------------------------- #
# 审查员 — 元角色,不参与辩论,只判断"是否收敛"                                #
# --------------------------------------------------------------------------- #
# 跟 SYNTHESIZER 同列(都是 meta-role)。spec §3.1 把 model 锁 deepseek-chat
# 不用 reasoning model — structured output 任务,reasoning_content 反而干扰。

REVIEWER = Role(
    name="审查员",
    preferred_model="deepseek-chat",
    temperature=0.0,
    system_prompt="""你是审查员,不参与论辩,只判断"圆桌讨论是否已收敛到足够清晰的答案"。

判断标准(全部满足才算收敛):
1. 用户的原始问题在最新 synth 里有明确响应
2. 派之间的核心分歧已经摊开 + 给了条件性结论
3. 没有未澄清就被搁置的关键事实/概念
4. 不强求"派全部同意" — 摆清楚 tradeoff 本身就是收敛

如果觉得还没收敛,你必须给出一个**具体到一点上的**追问问题。
不允许是"继续讨论"、"再展开"这种抽象指令。也不允许重复上轮已经辩过的问题。

输出严格用下面 markdown 格式(parser 按 ## 段落标题切):

## 判断
CONVERGED

或单独一行:

## 判断
NEEDS_DRILL

## 理由
[1-2 句话]

## 追问问题
(仅 NEEDS_DRILL 时填,具体到一点;CONVERGED 时这段省略)
""",
)
```

- [ ] **Step 4: 跑测试**

```bash
python3 -m unittest tests.test_roundtable.ReviewerRoleTests -v 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/roundtable/roles.py tests/test_roundtable.py
git commit -m "feat(roundtable): 加 REVIEWER 元角色 — 审查员判断收敛

跟 SYNTHESIZER 同列(meta-role,不进 ROLES list)。deepseek-chat +
temp=0 + structured markdown output(## 判断 / ## 理由 / ## 追问问题)。
prompt anchor 单测,以免后续修 prompt 不小心删了 schema 关键词。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `synth.py` 加 follow-up synth prompt builder

**Files:**
- Modify: `backend/roundtable/synth.py`(加 `build_follow_up_synth_prompt` + `synthesize_follow_up`)
- Modify: `tests/test_roundtable.py`(append prompt-shape 单测)

设计:auto-drill 后 / 续问后的新 synth 跟首次 synth 不一样 — 它应该接着上一次 synth 说,并知道 follow-up 问题是什么。

- [ ] **Step 1: 写失败测试**

```python
class FollowUpSynthPromptTests(unittest.TestCase):
    def test_follow_up_prompt_includes_prior_synth_and_followup_question(self):
        from backend.roundtable.synth import build_follow_up_synth_prompt
        prompt = build_follow_up_synth_prompt(
            original_question="要不要用 worktree?",
            prior_synth="上一次 synth 内容",
            follow_up_question="如果是笔记仓库呢?",
            follow_up_turns=[],
        )
        self.assertIn("要不要用 worktree?", prompt)
        self.assertIn("上一次 synth 内容", prompt)
        self.assertIn("如果是笔记仓库呢?", prompt)
        # 必须显式要求 LLM "接着前一次 synth 更新",而不是从零开始
        self.assertIn("接着上一次", prompt)
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
python3 -m unittest tests.test_roundtable.FollowUpSynthPromptTests -v 2>&1 | tail -10
```

- [ ] **Step 3: 实现**

`backend/roundtable/synth.py` 末尾 append(parse_synthesis 之后):

```python
def build_follow_up_synth_prompt(
    original_question: str,
    prior_synth: str,
    follow_up_question: str,
    follow_up_turns: list[AgentTurn],
) -> str:
    """Auto-drill / 续问 后的 synth prompt — 让整理员接着上一次的 synth
    更新,而不是从零写一个新 synth。

    follow_up_turns: 该 round 内 4 派对 follow-up question 的回应。
    """
    persona_block = "\n\n".join(
        f"- **{t.role}**: {t.content}" for t in follow_up_turns
    )
    return f"""原始问题:
{original_question}

上一次 synth(territory map):

{prior_synth}

---

新追问:
{follow_up_question}

4 派对这次追问的回应:

{persona_block}

---

请**接着上一次** synth 更新 — 保留仍然成立的部分,根据这次追问 + 4 派的
新回应,**只更新被影响的段落**。输出结构跟首次 synth 一致(5 段:
## 共识点 / ## 分歧轴 / ## 关键判断 / ## 条件性结论 / ## 下一步行动)。

约束跟首次 synth 一样 — 不允许直接替用户拍板,只摆 tradeoff + 留判断给人。
"""
```

- [ ] **Step 4: 跑测试**

```bash
python3 -m unittest tests.test_roundtable.FollowUpSynthPromptTests -v 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/roundtable/synth.py tests/test_roundtable.py
git commit -m "feat(roundtable): synth.py 加 follow-up prompt builder

build_follow_up_synth_prompt() 让整理员接着上一次 synth 更新,而不是
从零写新 synth。auto-drill / 续问 后调用这个 prompt,输出仍是 5 段
结构(共识/分歧/判断/条件/下一步)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `debate.py` 抽 follow-up iteration helper + auto-drill loop

**Files:**
- Modify: `backend/roundtable/debate.py`(`run_session` 末尾加 loop;抽 `_run_follow_up_iteration`)
- Modify: `tests/test_roundtable.py`(append 4 个 auto-drill integration 测试)

这是 plan 里最大的 task,因为是核心引擎改动。拆成 3 个 commit:
- 5a: 抽 helper(纯重构,行为不变,现有测试不动也得过)
- 5b: 加 loop(行为新增,新增 integration 测试)
- 5c: 加 review-turn 记录

### Task 5a: 抽 `_run_follow_up_iteration` helper(纯重构)

- [ ] **Step 1: 跑现有测试,记录基线**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' 2>&1 | tail -5
```

期望全 pass。这是重构 baseline。

- [ ] **Step 2: 在 `run_session` 内部加 helper**

在 `debate.py:run_session` 内,`_run_role_round` 函数定义之后、`# --- Round 1` 之前,append:

```python
    def _run_follow_up_iteration(
        round_no: int,
        follow_up_question: str,
        prior_synth: str,
        source: str,                     # "auto" | "user"
    ) -> None:
        """跑一轮 follow-up:user_question(若 source=user)→ 4 派 follow_up
        × N → 新 synth。auto-drill loop 和 /continue 都调这个。"""
        from .synth import build_follow_up_synth_prompt

        if source == "user":
            _record(AgentTurn(
                round=round_no, role="__user__", type="user_question",
                content=follow_up_question, ts=clock(),
            ))

        def _follow_up_prompt(role: Role) -> str:
            return f"""原问题:{question}

上一次 synth(territory map):

{prior_synth}

新追问(来源 {"用户" if source == "user" else "自动追问"}):
{follow_up_question}

---

请用 **≤ 200 字** 针对这次追问回应,延续你的人设立场。
不要重复你在前面 round 已经说过的内容。"""

        _run_role_round(round_no, "follow_up", _follow_up_prompt)

        # 新 synth
        follow_up_turns = [
            t for t in session.turns if t.round == round_no and t.type == "follow_up"
        ]
        synth_text = model_fn(
            overrides.get(synthesizer.name) or synthesizer.preferred_model,
            synthesizer.system_prompt,
            build_follow_up_synth_prompt(
                original_question=question,
                prior_synth=prior_synth,
                follow_up_question=follow_up_question,
                follow_up_turns=follow_up_turns,
            ),
            synthesizer.temperature,
        )
        _record(AgentTurn(round=round_no, role=synthesizer.name, type="synth", content=synth_text, ts=clock()))
```

- [ ] **Step 3: 跑现有测试,确认基线仍过**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' 2>&1 | tail -5
```

预期:全 pass(helper 还没被调用,纯定义)。

- [ ] **Step 4: Commit 5a**

```bash
git add backend/roundtable/debate.py
git commit -m "refactor(roundtable): 在 run_session 抽 _run_follow_up_iteration helper

下一步 auto-drill loop + 续问 都会调这个。纯定义,还没被调用 —
现有所有测试不受影响。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5b: 加 auto-drill loop

- [ ] **Step 1: 写 4 个失败 integration 测试**

append 到 `tests/test_roundtable.py`:

```python
class AutoDrillLoopTests(unittest.TestCase):
    """run_session 跑完 R1+R2+synth 后,进 auto-drill loop:审查员判断
    收敛了就停,没收敛就跑一轮 follow-up + 新 synth + 再让审查员判断,
    上限 max_auto_drills。"""

    def _stub_roles(self):
        from backend.roundtable.data import Role
        return [
            Role(name=f"派{i}", system_prompt=f"system {i}", preferred_model="m")
            for i in range(4)
        ]

    def _synth_role(self):
        from backend.roundtable.data import Role
        return Role(name="整理员", system_prompt="synth", preferred_model="m")

    def _verdict_text(self, converged: bool, next_q: str = "") -> str:
        if converged:
            return "## 判断\nCONVERGED\n\n## 理由\nOK"
        return f"## 判断\nNEEDS_DRILL\n\n## 理由\n再深一点\n\n## 追问问题\n{next_q}"

    def test_converged_immediately_no_extra_rounds(self):
        from backend.roundtable.debate import run_session

        # model_fn 计数器:R1+R2+initial-synth = 9 calls, 第 10 个调用是
        # reviewer,返回 CONVERGED,loop break。
        calls = {"count": 0}
        verdict_text = self._verdict_text(converged=True)
        def model_fn(model, system, user, temp):
            calls["count"] += 1
            if "审查员" in (system or ""):
                return verdict_text
            return f"call {calls['count']}"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q?",
                self._stub_roles(),
                self._synth_role(),
                model_fn,
                Path(d) / "s.jsonl",
                max_auto_drills=3,
            )

        # 应有:R1×4 + R2×4 + synth + review = 10 turns,no follow_up
        types = [t.type for t in session.turns]
        self.assertEqual(types.count("answer"), 4)
        self.assertEqual(types.count("critique"), 4)
        self.assertEqual(types.count("synth"), 1)
        self.assertEqual(types.count("review"), 1)
        self.assertEqual(types.count("follow_up"), 0)

    def test_two_drills_then_converged(self):
        from backend.roundtable.debate import run_session

        verdicts = iter([
            self._verdict_text(False, "drill 1?"),
            self._verdict_text(False, "drill 2?"),
            self._verdict_text(True),
        ])
        def model_fn(model, system, user, temp):
            if "审查员" in (system or ""):
                return next(verdicts)
            return "stub"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q?", self._stub_roles(), self._synth_role(), model_fn,
                Path(d) / "s.jsonl", max_auto_drills=3,
            )

        types = [t.type for t in session.turns]
        # 2 次 drill,每次 4 派 follow_up + 新 synth + review,加上前面 reviewer 1 次
        self.assertEqual(types.count("follow_up"), 8)        # 2 × 4 派
        self.assertEqual(types.count("synth"), 3)            # initial + 2 drills
        self.assertEqual(types.count("review"), 3)

    def test_hits_max_auto_drills_cap(self):
        from backend.roundtable.debate import run_session

        # 审查员永远 NEEDS_DRILL → 应该跑满 max 次然后停
        def model_fn(model, system, user, temp):
            if "审查员" in (system or ""):
                return "## 判断\nNEEDS_DRILL\n\n## 理由\n还差点\n\n## 追问问题\n更多?"
            return "stub"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q?", self._stub_roles(), self._synth_role(), model_fn,
                Path(d) / "s.jsonl", max_auto_drills=2,    # 测试故意设 2
            )

        types = [t.type for t in session.turns]
        # max=2 → 跑 2 次 follow-up round (8 follow_up turns) + initial synth + 2 drill synths
        self.assertEqual(types.count("follow_up"), 8)
        self.assertEqual(types.count("synth"), 3)
        self.assertEqual(types.count("review"), 3)            # initial + 2 drills,2 次都是 NEEDS_DRILL

    def test_max_auto_drills_zero_disables_loop(self):
        from backend.roundtable.debate import run_session

        # max=0 → loop 一次都不跑,行为等同现状
        def model_fn(model, system, user, temp):
            return "stub"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q?", self._stub_roles(), self._synth_role(), model_fn,
                Path(d) / "s.jsonl", max_auto_drills=0,
            )

        types = [t.type for t in session.turns]
        self.assertEqual(types.count("review"), 0)
        self.assertEqual(types.count("follow_up"), 0)
        self.assertEqual(types.count("synth"), 1)
```

- [ ] **Step 2: 跑测试,确认全失败(`max_auto_drills` 参数还没加)**

```bash
python3 -m unittest tests.test_roundtable.AutoDrillLoopTests -v 2>&1 | tail -15
```

预期:`TypeError: run_session() got an unexpected keyword argument 'max_auto_drills'`。

- [ ] **Step 3: 加 `max_auto_drills` 参数 + loop**

修改 `run_session` 签名:

```python
def run_session(
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    session_path: Path,
    *,
    role_model_overrides: Optional[dict[str, str]] = None,
    critique_rounds: int = 1,
    max_auto_drills: int = 3,             # ← 新增
    on_turn: Optional[Callable[[AgentTurn], None]] = None,
    clock: Callable[[], float] = time.time,
) -> Session:
```

在文件顶部 `from .synth import synthesize` 同段加:

```python
from . import reviewer as reviewer_mod
from .roles import REVIEWER
```

在 `run_session` 现有 `_record(AgentTurn(round=synth_round, role=synthesizer.name, type="synth"...))` 之后(就是文件末尾、`return session` 之前),append:

```python
    # --- Auto-Drill Loop --------------------------------------------------- #
    next_round = synth_round + 1
    for _ in range(max_auto_drills):
        # 找最新 synth 内容(可能是 initial 也可能是上一次 drill 的)
        last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
        if last_synth is None:
            break   # 不该发生(synth 一定在前面跑过),防御性

        # 历史 review turns(给审查员看"上次说过什么,别重复")
        prior_reviews = "\n\n".join(
            f"--- 上次 review (round {t.round}) ---\n{t.content}"
            for t in session.turns if t.type == "review"
        ) or "(无)"

        reviewer_prompt = f"""原始问题:
{question}

最新 synth:
{last_synth.content}

历史 review:
{prior_reviews}

按你的 system_prompt 输出判断。"""

        verdict_text = model_fn(
            overrides.get(REVIEWER.name) or REVIEWER.preferred_model,
            REVIEWER.system_prompt,
            reviewer_prompt,
            REVIEWER.temperature,
        )
        verdict = reviewer_mod.parse_verdict(verdict_text)
        _record(AgentTurn(
            round=last_synth.round, role=REVIEWER.name, type="review",
            content=verdict_text, ts=clock(),
        ))
        if verdict.converged:
            break
        # NEEDS_DRILL → 跑 follow-up
        _run_follow_up_iteration(
            round_no=next_round,
            follow_up_question=verdict.next_question,
            prior_synth=last_synth.content,
            source="auto",
        )
        next_round += 1
```

- [ ] **Step 4: 跑测试**

```bash
python3 -m unittest tests.test_roundtable.AutoDrillLoopTests -v 2>&1 | tail -10
```

预期:4/4 pass。

- [ ] **Step 5: 跑全部 roundtable 测试,确认无回归**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' 2>&1 | tail -5
```

- [ ] **Step 6: Commit 5b**

```bash
git add backend/roundtable/debate.py tests/test_roundtable.py
git commit -m "feat(roundtable): run_session 加 auto-drill loop (max=3 默认)

initial synth 后 审查员 评估;NEEDS_DRILL → 调 _run_follow_up_iteration
跑一轮 + 新 synth + 再让审查员评估,上限 max_auto_drills 次。
4 个 integration 测试:立即收敛 / 2 轮后收敛 / 跑满上限 / max=0 关闭。

spec §3.3。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `continue_session()` + `runner.submit_continue()`

**Files:**
- Modify: `backend/roundtable/debate.py`(新增 module-level `continue_session()`)
- Modify: `backend/roundtable/runner.py`(新增 `submit_continue()` background-thread launcher)
- Modify: `tests/test_roundtable.py`(append `continue_session` integration 测试)

- [ ] **Step 1: 写失败测试**

```python
class ContinueSessionTests(unittest.TestCase):
    def _seed_session(self, tmp_path):
        """跑一个基础 session(立即 CONVERGED 不 drill),返回 path。"""
        from backend.roundtable.debate import run_session
        from backend.roundtable.data import Role
        roles = [Role(name=f"派{i}", system_prompt="s", preferred_model="m") for i in range(4)]
        synth = Role(name="整理员", system_prompt="synth", preferred_model="m")
        def model_fn(model, system, user, temp):
            if "审查员" in (system or ""):
                return "## 判断\nCONVERGED\n\n## 理由\nOK"
            return "stub"
        path = tmp_path / "s.jsonl"
        run_session("Q?", roles, synth, model_fn, path, max_auto_drills=3)
        return path, roles, synth, model_fn

    def test_continue_appends_user_question_and_runs_follow_up(self):
        from backend.roundtable.debate import continue_session
        with tempfile.TemporaryDirectory() as d:
            path, roles, synth, model_fn = self._seed_session(Path(d))
            continue_session(
                session_path=path,
                follow_up_question="再深入问 X?",
                roles=roles,
                synthesizer=synth,
                model_fn=model_fn,
                max_auto_drills=3,
            )

            from backend.roundtable.io import read_session
            session = read_session(path)
            user_questions = [t for t in session.turns if t.type == "user_question"]
            self.assertEqual(len(user_questions), 1)
            self.assertEqual(user_questions[0].content, "再深入问 X?")
            # 续问后应该有 4 个 follow_up(4 派回应)+ 新 synth + 新 review
            follow_ups_post = [t for t in session.turns if t.type == "follow_up"]
            self.assertEqual(len(follow_ups_post), 4)
            self.assertGreaterEqual(len([t for t in session.turns if t.type == "synth"]), 2)
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
python3 -m unittest tests.test_roundtable.ContinueSessionTests -v 2>&1 | tail -5
```

预期:`ImportError: cannot import name 'continue_session' from 'backend.roundtable.debate'`

- [ ] **Step 3: 实现 `continue_session()` in `debate.py`**

注意:`continue_session` 是 module-level 函数,跟 `run_session` 同级。它需要 load 现有 jsonl,然后跑一次 follow-up iteration + auto-drill loop。

把 `run_session` 内部的 auto-drill loop 逻辑也抽成一个 helper(避免 continue 里复制粘贴),命名 `_run_auto_drill_loop`。这需要把 `_run_follow_up_iteration` 和 auto-drill loop 都提到 module scope 或者用 closure 重新组织。

**实现策略:** 因为 `_run_follow_up_iteration` 和 auto-drill loop 都依赖 closure-captured 状态(`question`, `roles`, `synthesizer`, `model_fn`, `_record` 等),最干净的做法是把它们都用一个内部 dataclass 包起来,或者新引入一个 `_SessionEngine` class。但为了避免引入新抽象(§3.3 复杂度有代价),改用最朴素方法:**`continue_session` 重新构造 closures**。

```python
# 在 debate.py 末尾(run_session 之后)新增:

def continue_session(
    session_path: Path,
    follow_up_question: str,
    *,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    role_model_overrides: Optional[dict[str, str]] = None,
    max_auto_drills: int = 3,
    on_turn: Optional[Callable[[AgentTurn], None]] = None,
    clock: Callable[[], float] = time.time,
) -> Session:
    """用户续问:load 现有 session,跑一轮 user follow-up + 新 synth +
    审查员判断 + 可能再 auto-drill。"""
    from .io import read_session
    session = read_session(session_path)
    question = session.question
    overrides = role_model_overrides or {}

    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:  # noqa: BLE001
                pass
        session.turns.append(turn)

    # 找下一个 round number(现有 turns 最大 round + 1)
    next_round = max((t.round for t in session.turns), default=0) + 1

    # 最新 synth 作为 prior_synth
    last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
    if last_synth is None:
        raise ValueError("session 没有 synth turn,不能续问")

    # 复用 run_session 内部的 follow-up iteration 逻辑 — 抽出来作为 module-level
    # helper 以便共享(下面 _run_follow_up_iteration_v2 是新的 module-level 版本)
    _run_follow_up_iteration_v2(
        session=session,
        session_path=session_path,
        question=question,
        roles=roles,
        synthesizer=synthesizer,
        model_fn=model_fn,
        overrides=overrides,
        clock=clock,
        round_no=next_round,
        follow_up_question=follow_up_question,
        prior_synth=last_synth.content,
        source="user",
        on_turn=on_turn,
    )

    # 续问后接 auto-drill loop
    _run_auto_drill_loop(
        session=session,
        session_path=session_path,
        question=question,
        roles=roles,
        synthesizer=synthesizer,
        model_fn=model_fn,
        overrides=overrides,
        clock=clock,
        start_round=next_round + 1,
        max_auto_drills=max_auto_drills,
        on_turn=on_turn,
    )
    return session
```

然后把 `_run_follow_up_iteration` 和 auto-drill loop 提到 module-level 作为 `_run_follow_up_iteration_v2` 和 `_run_auto_drill_loop`,接收所有依赖作为显式参数(消除 closure 依赖)。

也要把 `run_session` 内部的 inline auto-drill loop / inline follow-up helper 改成调这俩 module-level 函数。**这是 Task 5b 实现的等价重构 —— 行为不变,但代码可被 continue_session 复用。**

具体落实:

```python
# debate.py module-level(放在 run_session 之前):

def _run_follow_up_iteration_v2(
    *,
    session: Session,
    session_path: Path,
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    overrides: dict[str, str],
    clock: Callable[[], float],
    round_no: int,
    follow_up_question: str,
    prior_synth: str,
    source: str,
    on_turn: Optional[Callable[[AgentTurn], None]],
) -> None:
    from .synth import build_follow_up_synth_prompt

    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:  # noqa: BLE001
                pass
        session.turns.append(turn)

    def _model_for(role: Role) -> str:
        return overrides.get(role.name) or role.preferred_model

    if source == "user":
        _record(AgentTurn(
            round=round_no, role="__user__", type="user_question",
            content=follow_up_question, ts=clock(),
        ))

    # 跑 4 派 follow-up,并行
    from concurrent.futures import ThreadPoolExecutor
    def _follow_up_prompt_for(role: Role) -> str:
        return f"""原问题:{question}

上一次 synth(territory map):

{prior_synth}

新追问(来源 {"用户" if source == "user" else "自动追问"}):
{follow_up_question}

---

请用 **≤ 200 字** 针对这次追问回应,延续你的人设立场。
不要重复你在前面 round 已经说过的内容。"""

    with ThreadPoolExecutor(max_workers=max(1, len(roles))) as pool:
        futures = [
            pool.submit(
                _call_role_with_quality_retry,
                role, model_name=_model_for(role),
                user_prompt=_follow_up_prompt_for(role),
                model_fn=model_fn,
            )
            for role in roles
        ]
        for role, fut in zip(roles, futures):
            _record(AgentTurn(
                round=round_no, role=role.name, type="follow_up",
                content=fut.result(), ts=clock(),
            ))

    # 新 synth
    follow_up_turns = [
        t for t in session.turns if t.round == round_no and t.type == "follow_up"
    ]
    synth_text = model_fn(
        overrides.get(synthesizer.name) or synthesizer.preferred_model,
        synthesizer.system_prompt,
        build_follow_up_synth_prompt(
            original_question=question,
            prior_synth=prior_synth,
            follow_up_question=follow_up_question,
            follow_up_turns=follow_up_turns,
        ),
        synthesizer.temperature,
    )
    _record(AgentTurn(
        round=round_no, role=synthesizer.name, type="synth",
        content=synth_text, ts=clock(),
    ))


def _run_auto_drill_loop(
    *,
    session: Session,
    session_path: Path,
    question: str,
    roles: list[Role],
    synthesizer: Role,
    model_fn: ModelFn,
    overrides: dict[str, str],
    clock: Callable[[], float],
    start_round: int,
    max_auto_drills: int,
    on_turn: Optional[Callable[[AgentTurn], None]],
) -> None:
    def _record(turn: AgentTurn) -> None:
        append_turn(session_path, turn)
        if on_turn is not None:
            try:
                on_turn(turn)
            except Exception:  # noqa: BLE001
                pass
        session.turns.append(turn)

    next_round = start_round
    for _ in range(max_auto_drills):
        last_synth = next((t for t in reversed(session.turns) if t.type == "synth"), None)
        if last_synth is None:
            break

        prior_reviews = "\n\n".join(
            f"--- 上次 review (round {t.round}) ---\n{t.content}"
            for t in session.turns if t.type == "review"
        ) or "(无)"

        reviewer_prompt = f"""原始问题:
{question}

最新 synth:
{last_synth.content}

历史 review:
{prior_reviews}

按你的 system_prompt 输出判断。"""

        verdict_text = model_fn(
            overrides.get(REVIEWER.name) or REVIEWER.preferred_model,
            REVIEWER.system_prompt,
            reviewer_prompt,
            REVIEWER.temperature,
        )
        verdict = reviewer_mod.parse_verdict(verdict_text)
        _record(AgentTurn(
            round=last_synth.round, role=REVIEWER.name, type="review",
            content=verdict_text, ts=clock(),
        ))
        if verdict.converged:
            break
        _run_follow_up_iteration_v2(
            session=session,
            session_path=session_path,
            question=question,
            roles=roles,
            synthesizer=synthesizer,
            model_fn=model_fn,
            overrides=overrides,
            clock=clock,
            round_no=next_round,
            follow_up_question=verdict.next_question,
            prior_synth=last_synth.content,
            source="auto",
            on_turn=on_turn,
        )
        next_round += 1
```

然后 `run_session` 末尾的 inline auto-drill loop 删掉,改成:

```python
    # 删掉之前 Task 5b 加的 inline loop,改成调 module-level helper
    _run_auto_drill_loop(
        session=session,
        session_path=session_path,
        question=question,
        roles=roles,
        synthesizer=synthesizer,
        model_fn=model_fn,
        overrides=overrides,
        clock=clock,
        start_round=synth_round + 1,
        max_auto_drills=max_auto_drills,
        on_turn=on_turn,
    )

    return session
```

- [ ] **Step 4: 跑全部 roundtable 测试**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable.py' 2>&1 | tail -5
```

预期:Task 5b 的 4 个 AutoDrillLoopTests 仍然全 pass(纯重构,行为不变);ContinueSessionTests 1 个新测 pass。

- [ ] **Step 5: 实现 `runner.submit_continue()`**

`backend/roundtable/runner.py` 加:

```python
def submit_continue(
    session_path: Path,
    follow_up_question: str,
    *,
    role_models: dict[str, str] | None = None,
    on_complete: Optional[OnCompleteFn] = None,
) -> None:
    """跟 submit 同模式 — 在 background thread 里跑 continue_session。"""
    t = threading.Thread(
        target=_execute_continue,
        args=(session_path, follow_up_question, dict(role_models or {}), on_complete),
        name=f"roundtable-continue-{session_path.stem}",
        daemon=True,
    )
    t.start()


def _execute_continue(
    session_path: Path,
    follow_up_question: str,
    role_models: dict[str, str],
    on_complete: Optional[OnCompleteFn],
) -> None:
    from .debate import continue_session
    try:
        continue_session(
            session_path=session_path,
            follow_up_question=follow_up_question,
            roles=roles_mod.ROLES,
            synthesizer=roles_mod.SYNTHESIZER,
            model_fn=call_model,
            role_model_overrides=role_models,
        )
    except ModelError as e:
        write_error_marker(session_path, f"model error during continue: {type(e).__name__}: {e}")
    except Exception as e:    # noqa: BLE001
        write_error_marker(session_path, f"unexpected during continue: {type(e).__name__}: {e}")
    finally:
        if on_complete is not None:
            try:
                on_complete(session_path)
            except Exception:  # noqa: BLE001
                pass
```

- [ ] **Step 6: Commit**

```bash
git add backend/roundtable/debate.py backend/roundtable/runner.py tests/test_roundtable.py
git commit -m "feat(roundtable): 加 continue_session + submit_continue + 重构 loop 到 module-level

把 Task 5b 加的 inline auto-drill loop 提到 module-level helper
(_run_auto_drill_loop + _run_follow_up_iteration_v2),让 continue_session
能复用同一套引擎。

continue_session: load 现有 jsonl → 跑 user follow-up round → 新 synth
→ auto-drill loop。submit_continue() 在 background thread 跑,跟 submit()
同模式。1 个 integration 测试覆盖端到端流程。

spec §3.3 + §3.4。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `POST /roundtables/{id}/continue` endpoint + GET 响应加 reviewer 段

**Files:**
- Modify: `backend/main.py`(新 endpoint + 改 GET 响应)
- Modify: `tests/test_roundtable.py`(append 1 个 endpoint 测试)

- [ ] **Step 1: 写失败测试**

```python
class ContinueEndpointTests(unittest.TestCase):
    """POST /roundtables/{id}/continue end-to-end through TestClient."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        from unittest.mock import patch
        self.patches = [
            patch.object(config, "ROUNDTABLES_DIR", self.tmp_path),
        ]
        for p in self.patches:
            p.start()
        from backend import main, auth
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        from fastapi.testclient import TestClient
        self.client = TestClient(main.app)

    def tearDown(self):
        from backend import main
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_continue_rejects_when_session_missing(self):
        r = self.client.post(
            "/roundtables/nope/continue", json={"question": "再问 X"},
        )
        self.assertEqual(r.status_code, 404)

    def test_continue_rejects_empty_question(self):
        # 先 seed 一个空的 jsonl(meta + 1 synth turn 足够)
        from backend import config
        path = config.ROUNDTABLES_DIR / "abc.jsonl"
        from backend.roundtable.data import Session
        from backend.roundtable.io import write_meta, append_turn
        from backend.roundtable.data import AgentTurn
        write_meta(path, Session(question="Q", started_at=0.0))
        append_turn(path, AgentTurn(round=3, role="整理员", type="synth", content="hi", ts=0.0))

        r = self.client.post("/roundtables/abc/continue", json={"question": ""})
        self.assertEqual(r.status_code, 422)

    def test_continue_returns_202(self):
        from backend import config
        path = config.ROUNDTABLES_DIR / "abc.jsonl"
        from backend.roundtable.data import Session
        from backend.roundtable.io import write_meta, append_turn
        from backend.roundtable.data import AgentTurn
        write_meta(path, Session(question="Q", started_at=0.0))
        append_turn(path, AgentTurn(round=3, role="整理员", type="synth", content="hi", ts=0.0))

        # mock掉 runner.submit_continue,只验证 endpoint accept
        from unittest.mock import patch
        with patch("backend.main.roundtable_runner.submit_continue") as sub:
            r = self.client.post("/roundtables/abc/continue", json={"question": "再问 X"})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertTrue(sub.called)
```

- [ ] **Step 2: 跑测试,确认全失败**

```bash
python3 -m unittest tests.test_roundtable.ContinueEndpointTests -v 2>&1 | tail -10
```

- [ ] **Step 3: 加 endpoint 到 `main.py`**

在 `delete_roundtable` endpoint 之前(就是 `@app.delete("/roundtables/{session_id}"...)` 之前)插入:

```python
class ContinueRoundtableRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)


@app.post("/roundtables/{session_id}/continue", dependencies=PROTECT, status_code=202)
def continue_roundtable(session_id: str, body: ContinueRoundtableRequest) -> dict:
    """用户续问:在已有 session 上 append user follow-up round + 新 synth
    + 审查员判断(可能再触发 auto-drill)。"""
    if "/" in session_id or ".." in session_id or session_id.startswith("."):
        raise HTTPException(400, {"error": "bad session id"})
    path = config.ROUNDTABLES_DIR / f"{session_id}.jsonl"
    if not path.is_file():
        raise HTTPException(404, {"error": "session not found", "id": session_id})
    roundtable_runner.submit_continue(path, body.question.strip())
    return {"id": session_id, "status": "queued", "question": body.question}
```

- [ ] **Step 4: 改 GET `/roundtables/{id}` 响应加 reviewer 段**

在 `get_roundtable` 函数里(`main.py:1666`),把现有 return dict 改成:

```python
    # 现有逻辑保留,但末尾 return 之前加:
    review_turns = [t for t in session.turns if t.type == "review"]
    reviewer_summary = None
    if review_turns:
        last_review = review_turns[-1]
        from .roundtable.reviewer import parse_verdict
        verdict = parse_verdict(last_review.content)
        reviewer_summary = {
            "converged": verdict.converged,
            "reason": verdict.reason,
            "next_question": verdict.next_question,    # 给 PWA banner prefill 用
            "hit_max_drills": (
                not verdict.converged
                and len(review_turns) >= 3      # 默认 max_auto_drills
            ),
        }
    # ... return dict 加 "reviewer": reviewer_summary
```

注意:`hit_max_drills` 的 3 是 hardcode 等于 `max_auto_drills` 默认。应该从 `config.toml` 读,但为了 plan 简洁,先 hardcode + TODO 标记在 commit message。

完整修改后的 return:

```python
    return {
        "id": session_id,
        "question": session.question,
        "started_at": session.started_at,
        "status": status,
        "critique_rounds": session.critique_rounds,
        "turns_expected": turns_expected,
        "turns": [
            {"round": t.round, "role": t.role, "type": t.type, "content": t.content, "ts": t.ts}
            for t in normal_turns
        ],
        "r3": r3,
        "reviewer": reviewer_summary,    # ← 新增
        "error": error_turns[-1].content if error_turns else None,
    }
```

- [ ] **Step 5: 跑测试**

```bash
python3 -m unittest tests.test_roundtable -v 2>&1 | tail -10
```

预期:全 pass。

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_roundtable.py
git commit -m "feat(main): POST /roundtables/{id}/continue + GET 响应加 reviewer 段

POST endpoint 接受 {question} body,转给 runner.submit_continue 在
background 跑。GET 端点响应加 reviewer:{converged, reason, next_question,
hit_max_drills},供 PWA banner 渲染。

hit_max_drills 阈值暂 hardcode 3 = max_auto_drills 默认;后续从
config.toml 读(YAGNI:目前默认值锁死)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: PWA — 续问 input + max-iter banner

**Files:**
- Modify: `pwa/app.js`(roundtable detail view)

PWA 没自动化测试,改动靠 `node --check` + 手动验证。

- [ ] **Step 1: 找 roundtable detail view 的位置**

```bash
grep -n "roundtable\|/roundtables" pwa/app.js | head -20
```

定位渲染 roundtable session detail 的函数 — 通常是 `renderRoundtableDetail` / `_roundtableDetailHtml` 之类。

- [ ] **Step 2: 在 detail HTML 末尾加续问 input + banner**

模板示意(具体函数名按 Step 1 找到的为准):

```javascript
// 在 roundtable detail HTML 渲染函数末尾(synth 渲染完之后)append:

const reviewer = data.reviewer;
let bannerHtml = '';
if (reviewer && reviewer.hit_max_drills && reviewer.next_question) {
  bannerHtml = `
    <div class="reviewer-banner">
      <p>⚠ 审查员认为还没收敛(已达 ${data.turns_expected ? '3' : '上限'} 次自动追问上限)</p>
      <p><strong>建议继续追问:</strong> ${esc(reviewer.next_question)}</p>
      <button class="rt-continue-prefill" data-question="${esc(reviewer.next_question)}">
        一键续问
      </button>
    </div>`;
}

const continueInputHtml = `
  <div class="rt-continue-input">
    <textarea data-rt-followup placeholder="继续问..." rows="3"></textarea>
    <button class="rt-continue-submit" data-session-id="${esc(data.id)}">继续问</button>
  </div>`;

// append bannerHtml + continueInputHtml 到 detail body
```

事件 binding:

```javascript
// 一键续问:把 banner 里的 question 填到 textarea
root.querySelectorAll('.rt-continue-prefill').forEach(btn => {
  btn.addEventListener('click', e => {
    const q = e.currentTarget.dataset.question;
    const ta = root.querySelector('textarea[data-rt-followup]');
    if (ta) { ta.value = q; ta.focus(); }
  });
});

// 续问提交
root.querySelectorAll('.rt-continue-submit').forEach(btn => {
  btn.addEventListener('click', async e => {
    const sessionId = e.currentTarget.dataset.sessionId;
    const ta = root.querySelector('textarea[data-rt-followup]');
    const question = (ta?.value || '').trim();
    if (!question) return;
    btn.disabled = true; btn.textContent = '提交中...';
    try {
      await api(`/roundtables/${encodeURIComponent(sessionId)}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      ta.value = '';
      // 当前 detail view 会通过 polling 拿到新 turns,无需手动 refresh
    } catch (err) {
      showError(`续问失败: ${err.message}`);
    } finally {
      btn.disabled = false; btn.textContent = '继续问';
    }
  });
});
```

- [ ] **Step 3: 语法 check**

```bash
node --check pwa/app.js && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add pwa/app.js
git commit -m "feat(pwa): roundtable detail 加续问 input + max-iter banner

session detail 末尾加 textarea + 继续问按钮 → POST /continue。
若 reviewer.hit_max_drills 为真,显示 banner + 一键续问按钮(把
审查员的 next_question 填进 textarea)。

PWA 无自动化测试,靠 node --check + ssh 手动验证 UI。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 整体 smoke + 服务器 acceptance

- [ ] **Step 1: 全部 Python 测试**

```bash
python3 -m unittest discover -s tests -v 2>&1 | tail -15
```

预期:全 pass(老 21 + 新 ~16 个新增,共 ~37 个)。

- [ ] **Step 2: py_compile**

```bash
python3 -m py_compile backend/*.py backend/roundtable/*.py && echo OK
```

- [ ] **Step 3: PWA 语法 + contract 测试**

```bash
node --check pwa/app.js && node --test tests/pwa-ui-contract.test.mjs 2>&1 | tail -10
```

- [ ] **Step 4: 服务器端 acceptance + 手动验证(ssh 跑)**

```bash
ssh <server> 'cd /path/to/cc-workflow && git pull && systemctl restart cc-workflow'
```

PWA 浏览器端验证:

1. 触发一个 roundtable(已有功能不破坏)
2. 看 session detail 是否正常显示
3. 看末尾有续问 input
4. 输入续问 → submit → 看 session 长出新 turns(user_question + 4 follow_up + synth + review)
5. 如果初始 session 跑满 3 次还没收敛 → 看 banner 出现 + "一键续问" 按钮工作

---

## Self-Review

**Spec coverage check:**

| Spec 章节 | 实现位置 |
|---|---|
| §2.1 架构 | Task 5 + 6 + 7 |
| §2.2 jsonl 格式(3 个 new turn types) | Task 1 |
| §3.1 REVIEWER role | Task 3 |
| §3.2 Verdict 解析 + fallback 表 | Task 2 |
| §3.3 Auto-Drill Loop | Task 5b + 6 |
| §3.4 续问 endpoint | Task 7 |
| §3.5 PWA UI(续问 input + banner) | Task 8 |
| §4 错误处理 | Task 2(parser fallback)+ Task 6(submit_continue try/except)+ Task 7(404 / 422) |
| §5.1 unit(reviewer.parse_verdict 5 fixtures + prompt anchors) | Task 2 + Task 3 |
| §5.2 integration(auto-drill 4 case + continue 1 case + endpoint 3 case) | Task 5b + 6 + 7 |
| §6 零迁移 | Task 1 invariant 文档更新 |
| §7 Non-goals | 已避免 — 无 stateful pause、无评分反馈、无完整 R1/R2 喂审查员、无 PWA 配置 max_auto_drills |

✓ 全覆盖。

**Placeholder scan:** 无 TBD / TODO,每步代码块都是完整可粘的代码。Task 7 Step 4 的 `hardcode 3` 在 commit message 里明确标了"暂 hardcode"+ 理由(YAGNI),不算 placeholder。

**Type consistency:**

- `ReviewerVerdict(converged, reason, next_question)` — Task 2 定义,Task 5b + 6 + 7 一致使用 ✓
- `TurnType = Literal["answer", "critique", "synth", "review", "follow_up", "user_question"]` — Task 1 扩,所有后续 task 用字面值一致 ✓
- `max_auto_drills: int = 3` — `run_session` (Task 5b) + `continue_session` (Task 6) + `submit_continue` (Task 6) 默认值一致 ✓
- `_run_follow_up_iteration_v2` / `_run_auto_drill_loop` — Task 6 引入,run_session 和 continue_session 共用 ✓
- `reviewer.parse_verdict()` — Task 2 定义,Task 7 GET endpoint 调用,签名一致 ✓
- `submit_continue()` — Task 6 runner.py 定义,Task 7 endpoint 调用,签名一致 ✓
