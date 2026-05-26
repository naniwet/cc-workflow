"""决断员 — opt-in 元角色,在 synth 之后跑一次,给出 AI 拍板的推荐方案。

定位:不破坏 synth"不替用户拍板"IP — 用户**显式**勾选 enable_decider 时
才触发。失败不影响 synth(graceful degradation:verdict 段缺,session 仍完整)。

输入:question + R1/R2 turns + synth 文本 + mode("roundtable" / "oneonone")
输出:markdown,4 段(推荐方案 / 理由 / 代价 / 备选);1v1 mode 额外含
     胜方判定 段。

Spec: docs/superpowers/specs/2026-05-26-decider-meta-role-design.md
"""
from __future__ import annotations

import re

from .data import AgentTurn, Role
from .model import ModelFn

# --------------------------------------------------------------------------- #
# DECIDER Role — temperature=0.3(跟 synth 一样要稳定结构化输出,不要 R1/R2
# 的发散度)。preferred_model 默认 v4-pro:决断员是最终拍板,质量比 latency
# 重要,跟整理员同 model 选型。
# --------------------------------------------------------------------------- #

DECIDER_SYSTEM_PROMPT = """你是决断员。所有其他角色已经发言,整理员已经给出分歧轴 / 条件性结论。
现在用户**明确要求你拍板** — 你的职责不是再重新讨论,而是基于已有讨论给出一个**具体推荐**,并说清楚 trade-off。

# 你必须遵守

1. **推荐必须具体**:不允许"看情况选 A 或 B",必须选一个
2. **理由必须基于讨论**:引用 R1/R2/synth 里的具体论点,不允许凭空发挥
3. **代价必须显式**:选了 X 你必须接受什么 Y(用户会不会后悔)
4. **备选必须存在**:如果 X 实现不了,fallback Z 是什么
5. **拒绝中立语**:出现"两边都有道理"、"可以折中"、"trade-off 视情况"判废

# 输出格式严格按下面 markdown(parser 按 ## 段切)

## 推荐方案
[一句话陈述,不超过 50 字。eg. "做 X,先 spike 2 周验证假设 A,再决定 scale"]

## 理由
- 基于哪些 R1/R2/synth 论点(具体引用,不泛指)
- 为什么这个方案胜出而不是另一个
- (至少 2 条 bullet)

## 代价
- 选了这个方案,你必须接受的事:1-3 条具体的(不是"难度大"这种泛指)

## 备选
- 如果推荐方案行不通,fallback 是 Y 因为 ...
- (至少 1 条)

# 如果用户给你的 user 消息里**显式提示了"1v1 mode + 给出胜方判定"**,额外加最后一段:

## 胜方判定
正方 / 反方 / 平手
- 关键击穿点:对方 R2 反驳里 [具体某句] 没站住,因为 [具体理由]
"""

DECIDER = Role(
    name="决断员",
    preferred_model="deepseek-v4-pro",  # 跟整理员同源,质量优先
    temperature=0.3,
    system_prompt=DECIDER_SYSTEM_PROMPT,
)


# --------------------------------------------------------------------------- #
# Prompt builder                                                              #
# --------------------------------------------------------------------------- #


def build_decider_user_prompt(
    *,
    question: str,
    mode: str,
    turns: list[AgentTurn],
    synth_text: str,
) -> str:
    """构造 decider 的 user message。

    mode="oneonone" 时显式提示"额外给胜方判定";"roundtable" 不提(避免
    给 4 派 mode 强加二值判定)。
    """
    transcript = "\n\n".join(
        f"[{t.role} R{t.round} {t.type}]\n{t.content}"
        for t in turns
        if t.type in ("answer", "critique")    # synth 单独贴,不进 transcript
    )

    mode_hint = ""
    if mode == "oneonone":
        mode_hint = (
            "\n\n**注意**:这是 1v1 对抗 session。除了 推荐方案/理由/代价/备选 4 段外,"
            "你必须额外给出 `## 胜方判定` 段(正方 / 反方 / 平手 + 关键击穿点)。"
        )

    return (
        f"# 用户原问题\n{question}\n\n"
        f"# 各角色发言 transcript\n{transcript or '(无)'}\n\n"
        f"# 整理员综合\n{synth_text or '(无)'}"
        f"{mode_hint}\n\n"
        f"请基于以上,按你 system prompt 里的格式输出推荐。"
    )


# --------------------------------------------------------------------------- #
# decide — 调 LLM                                                             #
# --------------------------------------------------------------------------- #


def decide(
    *,
    question: str,
    mode: str,
    turns: list[AgentTurn],
    synth_text: str,
    decider: Role,
    model_fn: ModelFn,
    model_override: str | None = None,
) -> str:
    """跑一次 decider LLM call,返回 raw markdown。Caller 负责持久化(append
    type="verdict" turn)。失败抛 ModelError — caller 兜底成 inline error。

    model_override: per-session model 覆盖(eg. user 在 #settings/roles
    给决断员指定了别的 model)。
    """
    user_prompt = build_decider_user_prompt(
        question=question, mode=mode, turns=turns, synth_text=synth_text,
    )
    return model_fn(
        model_override or decider.preferred_model,
        decider.system_prompt,
        user_prompt,
        decider.temperature,
    )


# --------------------------------------------------------------------------- #
# parse_recommendation — 复用 synth 风格的 ## 段切                            #
# --------------------------------------------------------------------------- #
# NB: 不叫 parse_verdict — 跟 reviewer.parse_verdict 同名会 shadow,且语义不
# 同(reviewer 的 verdict 是"判收敛 / 追问",decider 的 verdict 是"推荐方案")。
# 通用语言 §3.4:同一个名字不允许两个语义。本 module 内部 / 对外用
# parse_recommendation。

_HEADER_RE = re.compile(r"^##\s+(.+?)\s*$")
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$")

# 4 派 mode 必有这 4 段;1v1 加 胜方判定 第 5 段。parser lenient:多 / 少
# 段都不 raise,UI 按存在的段渲染。
_KNOWN_SECTIONS = ("推荐方案", "理由", "代价", "备选", "胜方判定")


def parse_recommendation(text: str) -> dict[str, object]:
    """按 ## 段切。推荐方案 / 胜方判定 是 free-text(取 section 内所有非空非
    bullet 行 join);理由 / 代价 / 备选 是 bullet list(只取 bullet,扔无关行)。

    Lenient — 缺段 = 不在 dict;不抛。caller(PWA)按 key in dict 判断展示。

    返回 dict 的 value 类型:
      - 推荐方案 / 胜方判定: str(单行陈述)
      - 理由 / 代价 / 备选: list[str](bullets)
    """
    sections: dict[str, list[str]] = {}    # raw lines per section
    current: str | None = None
    for line in text.splitlines():
        m = _HEADER_RE.match(line)
        if m:
            section_name = m.group(1).strip()
            if section_name in _KNOWN_SECTIONS:
                current = section_name
                sections.setdefault(current, [])
            else:
                current = None      # unknown header → 不收
            continue
        if current is None:
            continue
        sections[current].append(line)

    out: dict[str, object] = {}
    for section, lines in sections.items():
        if section in ("推荐方案", "胜方判定"):
            # free-text:join 非空非 bullet 行
            content = "\n".join(
                line.strip() for line in lines
                if line.strip() and not _BULLET_RE.match(line)
            ).strip()
            if content:
                out[section] = content
        else:
            # bullet list:只取 bullet
            bullets = [m.group(1) for line in lines if (m := _BULLET_RE.match(line))]
            if bullets:
                out[section] = bullets
    return out
