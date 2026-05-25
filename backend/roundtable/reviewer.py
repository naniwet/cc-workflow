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
