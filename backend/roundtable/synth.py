"""整理员 (R3) — prompt construction, call wrapper, output parsing.

Ported from AgentRoundtable's synth.py. Logic unchanged; only the
import paths were rewritten to relative imports.

parse_synthesis NEVER raises on malformed input — returns the canonical
section dict with empty lists for missing sections. The caller decides
whether to warn. Source of truth is the raw .jsonl line.
"""
from __future__ import annotations

import re

from .data import AgentTurn, Role
from .model import ModelFn

SECTION_HEADERS: tuple[str, ...] = (
    "共识点",
    "分歧轴",
    "关键判断",
    "条件性结论",
    "下一步行动",
)

# Round labels for the transcript handed to 整理员. Unknown rounds get a
# generic fallback in build_r3_user_prompt — keeps the prompt extensible
# without needing to update this dict every time debate.py adds a round.
_ROUND_LABELS: dict[int, str] = {
    1: "Round 1 — 初次回答",
    2: "Round 2 — Steel-man + Attack",
    3: "Round 3 — 深挖 / 收回 / 回应",
}


# --------------------------------------------------------------------------- #
# R3 user prompt                                                              #
# --------------------------------------------------------------------------- #


def build_r3_user_prompt(question: str, turns: list[AgentTurn]) -> str:
    """Compose the user message handed to the 整理员.

    Round-agnostic: walks every non-synth turn grouped by round, in
    ascending round order. This lets the orchestrator add a 3rd critique
    round (or more in the future) without touching synth.

    Synth turns are filtered out — they're the output we're about to
    produce, not part of the debate transcript the integrator sees.
    """
    non_synth = [t for t in turns if t.type != "synth"]
    rounds_in_order = sorted({t.round for t in non_synth})

    def _label(r: int) -> str:
        return _ROUND_LABELS.get(r, f"Round {r}")

    def _format_block(r: int) -> str:
        ts = [t for t in non_synth if t.round == r]
        body = "\n\n".join(f"**{t.role}**:\n{t.content}" for t in ts)
        return f"### {_label(r)}\n\n{body}"

    blocks = [_format_block(r) for r in rounds_in_order]
    transcript = "\n\n".join(blocks)

    return f"""问题:
{question}

---

四个角色的辩论轨迹:

{transcript}

---

你是组织员,不参与辩论,不直接替用户拍板。你的职责是做"条件性决策教练":
把分歧整理成用户能据此行动的结构,并说明在不同价值取向下分别倾向什么。

请用以下**五个段落**的固定 Markdown 结构整理:

## 共识点
[大家都同意的事实/原则,bullet,每条独立一行,以 `- ` 开头]

## 分歧轴
[核心分歧本质是哪个维度的取舍,1-3 条,每条说清楚两端代表什么,bullet]

## 关键判断
[把分歧转化为用户必须回答的 yes/no 判断,≤ 3 个,bullet。每条以"你是否..."或等价 yes/no 问法开头]

## 条件性结论
[用 if/then 形式说明:如果用户更重视某一端,则倾向哪个角色/方案;必须说"倾向",不能说"最终应该",bullet]

## 下一步行动
[给出 1-3 个可以马上执行的小动作,必须能从上面的共识/分歧/条件性结论推出,bullet]

约束:
- **不允许直接替用户拍板**。不能写"最终建议你选 X"、"你应该选 X"
- 允许写"如果你更重视 A,倾向 X;如果你更重视 B,倾向 Y"
- **不允许**评价哪个角色更对
- **不允许**添加任何一个角色都没提到的新论点
- 用具体引用("极简派主张 X,悲观派反驳 Y"),不要泛指
- 五个段落标题必须按上面的字面写法出现(`## 共识点` / `## 分歧轴` / `## 关键判断` / `## 条件性结论` / `## 下一步行动`),不要换措辞
"""


# --------------------------------------------------------------------------- #
# Synthesize wrapper                                                          #
# --------------------------------------------------------------------------- #


def synthesize(
    question: str,
    turns: list[AgentTurn],
    synthesizer: Role,
    model_fn: ModelFn,
    *,
    model_override: str | None = None,
) -> str:
    """Build the R3 prompt and call the model. Returns raw text — caller persists.

    model_override: optional per-session model name (validated by caller against
    MODEL_ENDPOINTS). When omitted, falls back to synthesizer.preferred_model
    from roles.py.
    """
    prompt = build_r3_user_prompt(question, turns)
    return model_fn(
        model_override or synthesizer.preferred_model,
        synthesizer.system_prompt,
        prompt,
        synthesizer.temperature,
    )


# --------------------------------------------------------------------------- #
# parse_synthesis                                                             #
# --------------------------------------------------------------------------- #

_HEADER_RE = re.compile(r"^##\s+(.+?)\s*$")
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$")


def parse_synthesis(text: str) -> dict[str, list[str]]:
    """Split text into the named bullet lists. Missing section → empty list.

    Lenient by design: never raises. Ignores non-bullet lines inside a
    section (e.g. intro paragraphs the LLM occasionally inserts).
    """
    result: dict[str, list[str]] = {h: [] for h in SECTION_HEADERS}
    current: str | None = None

    for line in text.splitlines():
        header_match = _HEADER_RE.match(line)
        if header_match:
            heading = header_match.group(1).strip()
            current = heading if heading in result else None
            continue

        if current is None:
            continue

        bullet_match = _BULLET_RE.match(line)
        if bullet_match:
            result[current].append(bullet_match.group(1).strip())

    return result


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
