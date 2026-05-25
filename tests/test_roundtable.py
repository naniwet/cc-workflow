import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.roundtable.data import Role
from backend.roundtable.debate import run_session
from backend.roundtable.io import session_path_for
from backend.roundtable.synth import build_r3_user_prompt, parse_synthesis
from backend.main import _roundtable_session_summary


class RoundtableTests(unittest.TestCase):
    def test_synth_prompt_asks_for_conditional_decision_sections(self):
        prompt = build_r3_user_prompt(
            "要不要先上严格 TDD?",
            [
                # Keep this deliberately tiny; the test is about the
                # synthesizer contract, not transcript rendering.
            ],
        )

        self.assertIn("## 关键判断", prompt)
        self.assertIn("## 条件性结论", prompt)
        self.assertIn("## 下一步行动", prompt)
        self.assertIn("不允许直接替用户拍板", prompt)

    def test_parse_synthesis_returns_five_canonical_sections(self):
        parsed = parse_synthesis(
            """## 共识点
- 先做小

## 分歧轴
- 速度 vs 鲁棒

## 关键判断
- 你是否接受后续返工?

## 条件性结论
- 如果你重视速度,倾向先 spike。

## 下一步行动
- 今天先实现一条可回滚路径。
"""
        )

        self.assertEqual(
            list(parsed),
            ["共识点", "分歧轴", "关键判断", "条件性结论", "下一步行动"],
        )
        self.assertEqual(parsed["关键判断"], ["你是否接受后续返工?"])
        self.assertEqual(parsed["条件性结论"], ["如果你重视速度,倾向先 spike。"])

    def test_session_path_for_avoids_overwriting_existing_file(self):
        with tempfile.TemporaryDirectory() as d:
            sessions_dir = Path(d)
            first = session_path_for("同一个问题", 1_700_000_000, sessions_dir)
            first.write_text('{"_meta": true}\n', encoding="utf-8")

            second = session_path_for("同一个问题", 1_700_000_000, sessions_dir)

            self.assertNotEqual(first, second)
            self.assertFalse(second.exists())

    def test_summary_reports_error_marker_as_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "20260516-010203-test.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "_meta": True,
                                "question": "Q",
                                "started_at": 1,
                                "critique_rounds": 1,
                                "version": "v0",
                            }
                        ),
                        json.dumps(
                            {
                                "round": 0,
                                "role": "__error__",
                                "type": "answer",
                                "content": "boom",
                                "ts": 2,
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            row = _roundtable_session_summary(path)

            self.assertEqual(row["status"], "error")
            self.assertEqual(row["turns_done"], 0)

    def test_run_session_executes_each_round_in_parallel(self):
        roles = [
            Role(name=f"角色{i}", system_prompt=f"system {i}", preferred_model="m")
            for i in range(4)
        ]
        synth = Role(name="整理员", system_prompt="synth", preferred_model="m")

        def model_fn(model, system, user, temp):
            time.sleep(0.05)
            if system == "synth":
                return (
                    "## 共识点\n- a\n\n## 分歧轴\n- b\n\n"
                    "## 关键判断\n- 你是否接受 b?\n\n"
                    "## 条件性结论\n- 如果接受 b,倾向 c。\n\n"
                    "## 下一步行动\n- 做 c。"
                )
            return f"{system} answer"

        with tempfile.TemporaryDirectory() as d:
            started = time.perf_counter()
            run_session(
                "Q",
                roles,
                synth,
                model_fn,
                Path(d) / "session.jsonl",
                clock=time.time,
            )
            elapsed = time.perf_counter() - started

        self.assertLess(elapsed, 0.25)

    def test_invalid_pessimist_turn_is_retried_once(self):
        pessimistic = Role(
            name="悲观派",
            system_prompt="你是悲观派",
            preferred_model="m",
        )
        other_roles = [
            Role(name="极简派", system_prompt="min", preferred_model="m"),
            Role(name="场景派", system_prompt="scenario", preferred_model="m"),
            Role(name="借鉴派", system_prompt="precedent", preferred_model="m"),
        ]
        roles = other_roles + [pessimistic]
        synth = Role(name="整理员", system_prompt="synth", preferred_model="m")
        attempts = {"悲观派": 0}

        def model_fn(model, system, user, temp):
            if system == "synth":
                return (
                    "## 共识点\n- a\n\n## 分歧轴\n- b\n\n"
                    "## 关键判断\n- 你是否接受 b?\n\n"
                    "## 条件性结论\n- 如果接受 b,倾向 c。\n\n"
                    "## 下一步行动\n- 做 c。"
                )
            if system == "你是悲观派":
                attempts["悲观派"] += 1
                if attempts["悲观派"] == 1:
                    return "这个方案有风险,需要小心。"
                return (
                    "- **存储因磁盘满而崩**(中概率 + 影响所有会话)\n"
                    "- **回调因进程重启而崩**(低概率 + 影响飞书推送)"
                )
            return "方案: 做。理由: 简单。"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q",
                roles,
                synth,
                model_fn,
                Path(d) / "session.jsonl",
                clock=time.time,
            )

        self.assertGreaterEqual(attempts["悲观派"], 2)
        pessimistic_r1 = [
            t for t in session.turns
            if t.round == 1 and t.role == "悲观派"
        ][0]
        self.assertIn("因磁盘满而崩", pessimistic_r1.content)


class _FakeHttpResp:
    """假 urlopen 返回值 — 实现 context manager + read 即可。"""
    def __init__(self, payload: dict):
        self._payload = payload
    def read(self):
        return json.dumps(self._payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return False


class HttpChatReasoningContentFallback(unittest.TestCase):
    """`_http_chat` 解析 reasoning model 响应 — 答案在 reasoning_content
    而非 content 字段(kimi-k2.6 / DeepSeek reasoner / o1 等)。"""

    def _call(self, message_dict: dict) -> str:
        from unittest.mock import patch
        from backend.roundtable import model
        payload = {"choices": [{"message": message_dict}]}
        with patch.object(model.urlreq, "urlopen", return_value=_FakeHttpResp(payload)):
            return model._http_chat(
                base_url="https://x.example",
                api_key="k",
                model="m",
                system="s",
                user="u",
                temperature=0.5,
                max_tokens=16,
                timeout=5,
            )

    def test_content_present_takes_precedence(self):
        out = self._call({"content": "正答案", "reasoning_content": "想了一会儿"})
        self.assertEqual(out, "正答案")

    def test_falls_back_to_reasoning_content_when_content_empty(self):
        out = self._call({"content": "", "reasoning_content": "用 reasoning 兜底"})
        self.assertEqual(out, "用 reasoning 兜底")

    def test_returns_empty_when_both_missing(self):
        # 两个都空 → 返回 "",call_model 那层会抛 EmptyModelOutputError。
        out = self._call({"content": "", "reasoning_content": ""})
        self.assertEqual(out, "")


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


if __name__ == "__main__":
    unittest.main()
