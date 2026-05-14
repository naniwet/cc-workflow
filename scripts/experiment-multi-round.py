#!/usr/bin/env python3
"""Experiment: does an extra critique round produce real new insight, or
does it just paraphrase R2?

Usage:
    python3 scripts/experiment-multi-round.py <roundtable-id>

Where <roundtable-id> = the filename stem under ~/.cc-state/roundtables/,
e.g. "20260514-083638-帮我分析一下未来2年在BI-agent领域-国内".

For each of the 4 personas, this script runs ONE additional critique
call in two flavors:

  • baseline   — replays the existing R2 prompt with "others" rebound
                  from R1 answers → R2 critiques. No "don't repeat" guard.
                  Tells you: would the persona NATURALLY say something new?

  • with-guard — adds an explicit "you've already said X in R2, don't
                  repeat yourself, push a new angle or concede" instruction.
                  Tells you: when COERCED, can the persona find new value?

Read both columns side-by-side and decide:

  baseline self-pushes new angles
    → multi-round is worth shipping AS-IS (just loop R2 prompt N times)

  baseline is mostly paraphrase, but with-guard finds real new content
    → multi-round is worth shipping, BUT prompt must be rewritten
      to include the "don't repeat" guard

  both feel like padding / circular
    → 3-round design is the local maximum; ship hold

This script is intentionally a one-off scaffold (not a feature). Delete
it after you decide. It lives in scripts/ so it can `import backend.*`
without setup gymnastics.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make `backend.*` importable when run from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import config                                          # noqa: E402
from backend.roundtable import roles as roles_mod                   # noqa: E402
from backend.roundtable.io import read_session                      # noqa: E402
from backend.roundtable.model import call_model, ModelError         # noqa: E402


def build_baseline_prompt(question: str, r2_others: dict[str, str]) -> str:
    """Identical shape to backend/roundtable/debate.py:build_r2_user_prompt,
    but the `others` block is now everyone else's R2 critique instead of
    everyone else's R1 answer. No 'don't repeat yourself' guard — we want
    to see whether the persona pushes new content unprompted."""
    other_block = "\n\n".join(f"- **{name}**: {content}" for name, content in r2_others.items())
    return f"""问题:
{question}

R2 其他三人的评论:

{other_block}

(自己的 R2 不重复给你)

---

请做两件事(共 **≤ 300 字**):

1. **Steel-man**:挑你**最赞同**的别人一点,说为什么这一点击中了你的盲区。
2. **Attack**:挑你**最反对**的别人一点,说为什么这一点不成立。

约束:
- 不允许 "都有道理"、"各有优劣"
- 不允许把别人观点改写得比原话弱再攻击
- **评价的是观点内容,不是说话人**。"我的人设和你对立所以反对你" 不算理由,会被判废。"""


def build_with_guard_prompt(
    question: str,
    r1_all: dict[str, str],
    r2_others: dict[str, str],
    my_r2: str,
) -> str:
    """Same context as baseline + the persona's OWN R2 (so it can avoid
    repeating itself) + explicit 'push new angle / concede / respond to
    others' targets. Tests the COERCED upper bound on what multi-round
    can extract."""
    r1_block = "\n\n".join(f"- **{n}**: {c}" for n, c in r1_all.items())
    r2_block = "\n\n".join(f"- **{n}**: {c}" for n, c in r2_others.items())
    return f"""问题:
{question}

R1 四人初次回答(含你自己,作 context):

{r1_block}

R2 其他三人对 R1 的评论:

{r2_block}

你自己在 R2 说过(不要重复):

{my_r2}

---

这是**第 3 轮 critique**。**禁止重复**你在 R2 已经说过的论点。

请做以下任一(共 **≤ 300 字**),选最让你 itch 的那个:

(a) **回应别人对你 R1/R2 的攻击或 steel-man** — 反驳 / 承认 / 修正
(b) **挖一个 R2 没人深挖的具体分歧** — 把它说清楚
(c) **收回你 R2 的某个观点** — 看了别人 R2 反思后明确承认错

约束:
- 不允许 "都有道理"、"各有优劣"
- 不允许把别人观点改写得比原话弱再攻击
- **评价的是观点内容,不是说话人**
- **第 3 轮的存在意义就是逼你说新东西**,重复 R2 内容会被判废"""


def run_one(role, prompt: str, label: str) -> None:
    print(f"--- [{role.name}] {label} ---")
    try:
        out = call_model(role.preferred_model, role.system_prompt, prompt, role.temperature)
    except ModelError as e:
        print(f"  ERROR: {type(e).__name__}: {e}")
        return
    print(out.strip())
    print()


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    rt_id = sys.argv[1]
    path = config.ROUNDTABLES_DIR / f"{rt_id}.jsonl"
    if not path.is_file():
        print(f"Roundtable jsonl not found: {path}", file=sys.stderr)
        sys.exit(1)

    session = read_session(path)
    r1_by_role = {t.role: t.content for t in session.turns if t.round == 1}
    r2_by_role = {t.role: t.content for t in session.turns if t.round == 2}

    if len(r1_by_role) != 4 or len(r2_by_role) != 4:
        print(
            f"Expected 4 R1 + 4 R2 turns; got "
            f"{len(r1_by_role)} R1 / {len(r2_by_role)} R2 — skipping.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"========================================")
    print(f"Experiment: 3rd critique round")
    print(f"Roundtable: {rt_id}")
    print(f"Question: {(session.question or '').splitlines()[0][:120]}")
    print(f"========================================")
    print()

    # Two passes — first all baseline, then all with-guard, so you can
    # compare role-by-role in scroll-back without inter-leaving.
    print("####################")
    print("# PASS A · baseline")
    print("####################")
    print()
    for role in roles_mod.ROLES:
        others_r2 = {n: c for n, c in r2_by_role.items() if n != role.name}
        run_one(role, build_baseline_prompt(session.question, others_r2), "baseline")

    print("####################")
    print("# PASS B · with-guard")
    print("####################")
    print()
    for role in roles_mod.ROLES:
        others_r2 = {n: c for n, c in r2_by_role.items() if n != role.name}
        my_r2 = r2_by_role.get(role.name, "(self R2 missing)")
        run_one(
            role,
            build_with_guard_prompt(session.question, r1_by_role, others_r2, my_r2),
            "with-guard",
        )

    print("=== DONE ===")
    print("Read each persona's baseline vs with-guard side by side.")
    print("Decision rule is in the docstring at the top of this file.")


if __name__ == "__main__":
    main()
