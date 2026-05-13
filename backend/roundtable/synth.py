"""整理员 (R3) — prompt construction, call wrapper, output parsing.

Ported from AgentRoundtable's synth.py. Logic unchanged; only the
import paths were rewritten to relative imports.

parse_synthesis NEVER raises on malformed input — returns the canonical
three-key dict with empty lists for missing sections. The caller decides
whether to warn. Source of truth is the raw .jsonl line.
"""
from __future__ import annotations

import re

from .data import AgentTurn, Role
from .model import ModelFn

SECTION_HEADERS: tuple[str, str, str] = ("共识点", "分歧轴", "判断题")


# --------------------------------------------------------------------------- #
# R3 user prompt                                                              #
# --------------------------------------------------------------------------- #


def build_r3_user_prompt(question: str, turns: list[AgentTurn]) -> str:
    """Compose the user message handed to the 整理员 in R3.

    Turns are grouped by round (R1 then R2), and within a round shown in the order
    they appear in `turns`.
    """
    r1 = [t for t in turns if t.round == 1]
    r2 = [t for t in turns if t.round == 2]

    def _format_block(round_label: str, ts: list[AgentTurn]) -> str:
        body = "\n\n".join(f"**{t.role}**:\n{t.content}" for t in ts)
        return f"### {round_label}\n\n{body}"

    blocks = []
    if r1:
        blocks.append(_format_block("Round 1 — 初次回答", r1))
    if r2:
        blocks.append(_format_block("Round 2 — Steel-man + Attack", r2))
    transcript = "\n\n".join(blocks)

    return f"""问题:
{question}

---

四个角色的 R1 + R2 轨迹:

{transcript}

---

你是组织员,不参与判断、不偏向任何人。请用以下**三个段落**的固定 Markdown 结构整理:

## 共识点
[大家都同意的事实/原则,bullet,每条独立一行,以 `- ` 开头]

## 分歧轴
[核心分歧本质是哪个维度的取舍,1-3 条,每条说清楚两端代表什么,bullet]

## 判断题
[把分歧转化为给用户的 yes/no 问题,≤ 3 个,bullet]

约束:
- **不允许**出现你自己的结论或推荐方案
- **不允许**评价哪个角色更对
- **不允许**添加任何一个角色都没提到的新论点
- 用具体引用("极简派主张 X,悲观派反驳 Y"),不要泛指
- 三个段落标题必须按上面的字面写法出现(`## 共识点` / `## 分歧轴` / `## 判断题`),不要换措辞
"""


# --------------------------------------------------------------------------- #
# Synthesize wrapper                                                          #
# --------------------------------------------------------------------------- #


def synthesize(
    question: str,
    turns: list[AgentTurn],
    synthesizer: Role,
    model_fn: ModelFn,
) -> str:
    """Build the R3 prompt and call the model. Returns raw text — caller persists."""
    prompt = build_r3_user_prompt(question, turns)
    return model_fn(
        synthesizer.preferred_model,
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
    """Split text into the three named bullet lists. Missing section → empty list.

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
