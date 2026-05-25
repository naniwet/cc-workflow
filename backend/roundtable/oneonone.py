"""1v1 对抗 mode — 2 个立场死磕同一分歧轴。

跟 4 派 round-table 共用 `debate.run_session` 状态机,只是 ROLES 换成 2 个
PROPONENT 实例,critique_rounds=2(R2 反驳),max_auto_drills=0(不接 reviewer)。

输入:用户写一个**二值决策问题** → `frame_stances` 用一次 LLM 调用拆成
"立场 A / 立场 B" → `make_proponent_roles` 把立场注入同一 prompt 模板。

适用场景:用/不用 X 框架、走 A 还是 B、立项 vs 不立项 等用户已知"分歧轴
在哪只是不知道哪端胜"的问题。不适用开放探索类(那种走 4 派评议)。

Spec: docs/superpowers/specs/2026-05-26-roundtable-1v1-mode-design.md
"""
from __future__ import annotations

import json
import re
from typing import Tuple

from .data import Role
from .model import ModelFn

# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


class NonBinaryQuestionError(ValueError):
    """Framing LLM 判定:用户的问题不是二值决策 → 1v1 mode 拒绝建会话,
    caller(main.py)转 400 + hint 让用户改写或切回 4 派评议。"""

    def __init__(self, hint: str = ""):
        super().__init__(hint or "question is not a binary decision")
        self.hint = hint


# --------------------------------------------------------------------------- #
# PROPONENT 通用辩士 prompt(立场作为变量注入)                                #
# --------------------------------------------------------------------------- #
# Spec §3.1 — 4 条核心约束的 anchor 必须保留,test_proponent_prompt_template_
# carries_four_core_anchors 锁死:立场不可摇摆 / steel-man / 中立语 / 反例边界

PROPONENT_PROMPT_TEMPLATE = """你是{stance_label}(辩士),你的立场是:**{stance}**

对立方({opponent_label})的立场是:**{opponent_stance}**

你的职责:为你的立场进行结构化辩护,把分歧轴逼到最深。

# 立场约束(违反 = 失职)

1. **立场不可摇摆** — 整个对话坚持 "{stance}",哪怕被对方 attack 也不能临时
   变中立 / 折中 / 改投。

2. **强 steel-man + 强 attack**(R2 反驳硬约束):
   - 先 1 段 **steel-man** 对方:**承认对方最强的那个论点**,完整复述它的内核
   - 再 1 段 **attack** 对方最弱的那个论点:具体到原话哪一句
   - 不允许:对方所有论点一起糊弄过去 / 只 attack 不 steel-man / 只 steel-man
     不 attack

3. **拒绝中立语**(LLM 默认味儿,出现就算回答失败):
   - "看情况"、"两边都有道理"、"trade-off 视情况"
   - "综合考虑"、"可以折中"、"具体场景具体分析"
   - 任何看似平衡、实际没立场的圆滑表达

4. **具体到可证伪 — 反例边界**:每个核心论点必须给出**反例边界**:
   > "我的立场在 [具体场景] 下会失效"

   不允许"如果情况变了我就错"这种泛指。反例必须具体到一个可观察事件
   /数据点 /用户行为。

# 输出节奏

- **R1(陈述)**:200-400 字。正面给出至少 **3 个**支持立场的具体论点。
  每个论点附反例边界(约束 4)。
- **R2(反驳)**:200-400 字。结构:steel-man 对方最强 → attack 对方最弱 →
  强化自己立场(用对方刚说过的具体内容,不要重新铺垫)。
"""


# --------------------------------------------------------------------------- #
# Role 构造                                                                   #
# --------------------------------------------------------------------------- #


def proponent_role_placeholders() -> list[Role]:
    """供 `GET /roundtables/models` 列出 1v1 角色用 — system_prompt 是带
    {stance} / {opponent_stance} / {stance_label} / {opponent_label} 占位符
    的 raw template。用户在 #settings/roles 看到的就是这个 template,override
    时要保留这 4 个占位符(否则立场字符串就注入不进去 — 不强校验,UI 上给
    hint 即可)。preferred_model / temperature 走 Role default。"""
    return [
        Role(name="正方", system_prompt=PROPONENT_PROMPT_TEMPLATE),
        Role(name="反方", system_prompt=PROPONENT_PROMPT_TEMPLATE),
    ]


def make_proponent_roles(stance_a: str, stance_b: str) -> list[Role]:
    """Build the two PROPONENT Role instances for a 1v1 session.

    name 固定 "正方" / "反方" — 这是用户感知层术语(spec §4.1),
    code identifier 仍是 PROPONENT_A / PROPONENT_B 概念,但 dataclass
    name 字段直接用中文跟 4 派(极简派 / 场景派 等)的命名风格一致,
    PWA / synth 渲染时就是这两个字符串。

    preferred_model / temperature 走 Role default(v4-flash / 0.7),
    用户可通过 #settings/roles 给"正方"/"反方"单独 override。
    """
    prompt_a = PROPONENT_PROMPT_TEMPLATE.format(
        stance_label="正方",
        stance=stance_a,
        opponent_label="反方",
        opponent_stance=stance_b,
    )
    prompt_b = PROPONENT_PROMPT_TEMPLATE.format(
        stance_label="反方",
        stance=stance_b,
        opponent_label="正方",
        opponent_stance=stance_a,
    )
    return [
        Role(name="正方", system_prompt=prompt_a),
        Role(name="反方", system_prompt=prompt_b),
    ]


# --------------------------------------------------------------------------- #
# Framing — 一次 LLM 调用把 question 拆成立场 A/B                              #
# --------------------------------------------------------------------------- #

_FRAMING_SYSTEM_PROMPT = """你的任务:把用户的决策问题框成两个**互斥**的具体立场。

输出严格 JSON(无 markdown / 无其它文字):

合法二值决策 → {"a": "<立场 A 一句话陈述>", "b": "<立场 B 一句话陈述>"}

非二值决策(开放性"如何 X" / 多选 / 不可对立)→ {"error": "non_binary_question", "hint": "<给用户一句改写建议>"}

约束:
- A / B 必须**互斥**:不能都对也不能都错,选 A 必定不选 B
- 用陈述句不是疑问句
- 每个立场 < 30 字
- 如果用户问的本来就是"X vs Y"明确两端,直接照搬不要重新发明
"""

# Framing 用更强的 model — 这是 1v1 整轮的 gate,框错了后面全错。
# 跟整理员同款 v4-pro,可被用户 override(future:加个 settings 项)。
_FRAMING_MODEL = "deepseek-v4-pro"

# 匹配 ```json ... ``` / ``` ... ``` 包裹的 JSON(LLM 常自己包一层)
_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```\s*$", re.MULTILINE)


def frame_stances(question: str, model_fn: ModelFn) -> Tuple[str, str]:
    """用一次 LLM 调用把决策问题拆成立场 A/B。

    Returns: (stance_a, stance_b) — 两个互斥立场字符串
    Raises:
      - NonBinaryQuestionError: LLM 判定非二值决策(带 hint)
      - ValueError: LLM 输出无法解析(JSON 坏 / 缺 key)— caller 应转
        500(framing failed)而非 400(用户没错,LLM 抽风)
    """
    reply = model_fn(
        _FRAMING_MODEL,
        _FRAMING_SYSTEM_PROMPT,
        f"问题:{question}",
        0.0,
    )
    cleaned = _CODE_FENCE_RE.sub("", reply).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"framing LLM returned non-JSON: {reply!r}") from e

    if not isinstance(data, dict):
        raise ValueError(f"framing LLM returned non-object: {data!r}")

    if "error" in data:
        if data["error"] == "non_binary_question":
            raise NonBinaryQuestionError(data.get("hint", ""))
        raise ValueError(f"framing LLM returned unknown error: {data['error']!r}")

    a = data.get("a")
    b = data.get("b")
    if not isinstance(a, str) or not isinstance(b, str) or not a or not b:
        raise ValueError(f"framing LLM missing or empty a/b keys: {data!r}")
    return a, b
