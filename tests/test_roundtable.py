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
                max_auto_drills=0,   # 关闭 auto-drill,只测 R1/R2/synth 的并行性
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


class HttpChatTemperatureLockTests(unittest.TestCase):
    """`_http_chat` 对 _TEMP_LOCKED_MODELS 里的 model 强制 temperature=1.0
    (reasoning model API quirk;kimi-k2.6 传别的温度直接 400)。"""

    def _captured_body(self, model_name: str, requested_temp: float) -> dict:
        from unittest.mock import patch
        from backend.roundtable import model as model_mod
        payload = {"choices": [{"message": {"content": "ok"}}]}
        captured = {}
        def _fake_urlopen(req, *a, **kw):
            # req.data 是 POST body JSON 字节
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _FakeHttpResp(payload)
        with patch.object(model_mod.urlreq, "urlopen", side_effect=_fake_urlopen):
            model_mod._http_chat(
                base_url="https://x.example",
                api_key="k",
                model=model_name,
                system="s",
                user="u",
                temperature=requested_temp,
                max_tokens=16,
                timeout=5,
            )
        return captured["body"]

    def test_kimi_k26_forces_temperature_to_1(self):
        """kimi-k2.6 不管 caller 传啥都 send temp=1.0(避免 400)。"""
        body = self._captured_body("kimi-k2.6", 0.7)
        self.assertEqual(body["temperature"], 1.0)

    def test_non_locked_model_uses_caller_temp(self):
        """moonshot-v1-32k 等非 locked model 按 caller 传的 temp。"""
        body = self._captured_body("moonshot-v1-32k", 0.3)
        self.assertEqual(body["temperature"], 0.3)


class ReasoningModelTimeoutTests(unittest.TestCase):
    """`call_model` 对 _REASONING_MODELS 里的 model 自动用更长 timeout
    (thinking phase 慢,120s 经常打临界;reasoning 走 300s,其它仍 120s
    fast-fail)。"""

    def _captured_timeout(self, model_name: str) -> int:
        """通过 patch _http_chat,拿到 call_model 实际传过去的 timeout。"""
        from unittest.mock import patch
        from backend.roundtable import model as model_mod
        captured = {}
        def _fake_http_chat(**kwargs):
            captured.update(kwargs)
            return "ok"
        # 同时 patch 掉 _load_endpoint 避免读真实 providers.json
        with patch.object(model_mod, "_http_chat", side_effect=_fake_http_chat), \
             patch.object(model_mod, "_load_endpoint",
                          return_value={"base_url": "https://x.example", "api_key": "k"}):
            model_mod.call_model(model_name, "s", "u", 0.5)
        return captured["timeout"]

    def test_kimi_k26_uses_300s_timeout(self):
        """kimi-k2.6 是 reasoning model → 自动用 300s。"""
        self.assertEqual(self._captured_timeout("kimi-k2.6"), 300)

    def test_deepseek_v4_pro_uses_300s_timeout(self):
        self.assertEqual(self._captured_timeout("deepseek-v4-pro"), 300)

    def test_non_reasoning_model_uses_default_120s(self):
        """moonshot-v1-32k 等非 reasoning model 走 caller 默认。"""
        self.assertEqual(self._captured_timeout("moonshot-v1-32k"), 120)
        self.assertEqual(self._captured_timeout("kimi-k2-0905-preview"), 120)


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
        self.assertEqual(REVIEWER.preferred_model, "deepseek-v4-flash")
        for anchor in ("CONVERGED", "NEEDS_DRILL", "## 判断", "## 理由", "## 追问问题"):
            self.assertIn(anchor, REVIEWER.system_prompt)


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

        verdict_text = self._verdict_text(converged=True)
        def model_fn(model, system, user, temp):
            if "审查员" in (system or ""):
                return verdict_text
            return "stub"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q?",
                self._stub_roles(),
                self._synth_role(),
                model_fn,
                Path(d) / "s.jsonl",
                max_auto_drills=3,
            )

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
        self.assertEqual(types.count("follow_up"), 8)        # 2 × 4 派
        self.assertEqual(types.count("synth"), 3)            # initial + 2 drills
        self.assertEqual(types.count("review"), 3)

    def test_hits_max_auto_drills_cap(self):
        from backend.roundtable.debate import run_session

        def model_fn(model, system, user, temp):
            if "审查员" in (system or ""):
                return "## 判断\nNEEDS_DRILL\n\n## 理由\n还差点\n\n## 追问问题\n更多?"
            return "stub"

        with tempfile.TemporaryDirectory() as d:
            session = run_session(
                "Q?", self._stub_roles(), self._synth_role(), model_fn,
                Path(d) / "s.jsonl", max_auto_drills=2,
            )

        types = [t.type for t in session.turns]
        self.assertEqual(types.count("follow_up"), 8)
        self.assertEqual(types.count("synth"), 3)
        self.assertEqual(types.count("review"), 3)

    def test_max_auto_drills_zero_disables_loop(self):
        from backend.roundtable.debate import run_session

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

    def test_continue_raises_when_no_synth_turn(self):
        """续问空 session(没有 initial synth)→ ValueError。"""
        from backend.roundtable.debate import continue_session
        from backend.roundtable.data import Role, Session
        from backend.roundtable.io import write_meta

        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "empty.jsonl"
            write_meta(path, Session(question="Q", started_at=0.0))
            # 只写 meta line,没有任何 turn(尤其没有 synth)

            roles = [Role(name=f"派{i}", system_prompt="s", preferred_model="m") for i in range(4)]
            synth = Role(name="整理员", system_prompt="synth", preferred_model="m")
            def model_fn(*args, **kwargs):
                return "stub"

            with self.assertRaises(ValueError) as ctx:
                continue_session(
                    session_path=path,
                    follow_up_question="继续",
                    roles=roles,
                    synthesizer=synth,
                    model_fn=model_fn,
                    max_auto_drills=3,
                )
            self.assertIn("synth", str(ctx.exception))


class ContinueEndpointTests(unittest.TestCase):
    """POST /roundtables/{id}/continue end-to-end through TestClient."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        from unittest.mock import patch
        from backend import config
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

    def _seed_completed_session(self, name="abc"):
        """Write a minimal jsonl: meta + 1 synth turn,足以让 continue 接受。"""
        from backend import config
        from backend.roundtable.data import Session, AgentTurn
        from backend.roundtable.io import write_meta, append_turn
        path = config.ROUNDTABLES_DIR / f"{name}.jsonl"
        write_meta(path, Session(question="Q", started_at=0.0))
        append_turn(path, AgentTurn(round=3, role="整理员", type="synth", content="hi", ts=0.0))
        return path

    def test_continue_rejects_when_session_missing(self):
        r = self.client.post(
            "/roundtables/nope/continue", json={"question": "再问 X"},
        )
        self.assertEqual(r.status_code, 404)

    def test_continue_rejects_empty_question(self):
        self._seed_completed_session()
        r = self.client.post("/roundtables/abc/continue", json={"question": ""})
        self.assertEqual(r.status_code, 422)

    def test_continue_returns_202(self):
        self._seed_completed_session()
        from unittest.mock import patch
        with patch("backend.main.roundtable_runner.submit_continue") as sub:
            r = self.client.post("/roundtables/abc/continue", json={"question": "再问 X"})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertTrue(sub.called)

    def test_continue_enriches_question_with_attachments(self):
        """POST /continue 带 attachments 时,question 被附件内容拼接后传给
        submit_continue(跟 POST /roundtables 用同一 _enrich_question_with_attachments 路径)。"""
        from unittest.mock import patch
        from backend import config
        # 准备:在 ROUNDTABLE_UPLOADS_DIR 下放一个 .txt
        uploads_dir = self.tmp_path / "rt-uploads" / "upload1"
        uploads_dir.mkdir(parents=True)
        fixture = uploads_dir / "ref.txt"
        fixture.write_text("REFERENCE CONTENT", encoding="utf-8")

        self._seed_completed_session()
        captured = {}
        def _fake_continue(*args, **kwargs):
            # submit_continue(session_path, follow_up_question, ...)
            captured["question"] = args[1] if len(args) > 1 else kwargs.get("follow_up_question")
        with patch.object(config, "ROUNDTABLE_UPLOADS_DIR", self.tmp_path / "rt-uploads"), \
             patch("backend.main.roundtable_runner.submit_continue", side_effect=_fake_continue):
            r = self.client.post(
                "/roundtables/abc/continue",
                json={"question": "再问 X", "attachments": [str(fixture)]},
            )
        self.assertEqual(r.status_code, 202, r.text)
        self.assertIn("再问 X", captured["question"])
        self.assertIn("REFERENCE CONTENT", captured["question"])  # enriched

    def test_continue_rejects_attachment_outside_uploads(self):
        """attachments 路径在 ROUNDTABLE_UPLOADS_DIR 之外 → 400(防 traversal)。"""
        from unittest.mock import patch
        from backend import config
        outside = self.tmp_path / "outside.txt"
        outside.write_text("nope", encoding="utf-8")
        self._seed_completed_session()
        with patch.object(config, "ROUNDTABLE_UPLOADS_DIR", self.tmp_path / "rt-uploads"):
            (self.tmp_path / "rt-uploads").mkdir(exist_ok=True)
            r = self.client.post(
                "/roundtables/abc/continue",
                json={"question": "再问", "attachments": [str(outside)]},
            )
        self.assertEqual(r.status_code, 400)

    def test_reviewer_summary_hit_max_drills_when_last_review_needs_drill(self):
        """GET /roundtables/{id} 返回 reviewer.hit_max_drills=True
        当 last review 是 NEEDS_DRILL(说明 max 跑满未收敛)。"""
        from backend import config
        from backend.roundtable.data import Session, AgentTurn
        from backend.roundtable.io import write_meta, append_turn
        path = config.ROUNDTABLES_DIR / "drilled.jsonl"
        write_meta(path, Session(question="Q", started_at=0.0))
        append_turn(path, AgentTurn(round=3, role="整理员", type="synth", content="s", ts=0.0))
        append_turn(path, AgentTurn(
            round=3, role="审查员", type="review",
            content="## 判断\nNEEDS_DRILL\n\n## 理由\nx\n\n## 追问问题\n继续追问 Y?",
            ts=0.0,
        ))

        r = self.client.get("/roundtables/drilled")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIsNotNone(body["reviewer"])
        self.assertTrue(body["reviewer"]["hit_max_drills"])
        self.assertFalse(body["reviewer"]["converged"])
        self.assertEqual(body["reviewer"]["next_question"], "继续追问 Y?")

    def test_reviewer_summary_no_banner_when_converged(self):
        """GET /roundtables/{id} 返回 reviewer.hit_max_drills=False
        当 last review 是 CONVERGED。"""
        from backend import config
        from backend.roundtable.data import Session, AgentTurn
        from backend.roundtable.io import write_meta, append_turn
        path = config.ROUNDTABLES_DIR / "converged.jsonl"
        write_meta(path, Session(question="Q", started_at=0.0))
        append_turn(path, AgentTurn(round=3, role="整理员", type="synth", content="s", ts=0.0))
        append_turn(path, AgentTurn(
            round=3, role="审查员", type="review",
            content="## 判断\nCONVERGED\n\n## 理由\nOK",
            ts=0.0,
        ))

        r = self.client.get("/roundtables/converged")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["reviewer"]["converged"])
        self.assertFalse(body["reviewer"]["hit_max_drills"])


class RoleCustomizationTests(unittest.TestCase):
    """`runner._customize_role` 用 role_models_store 的 system_prompt override
    把 Role.system_prompt 替换。"""

    def test_customize_role_with_prompt_override_replaces_prompt(self):
        from unittest.mock import patch
        from backend.roundtable import runner, role_models_store
        from backend.roundtable.data import Role
        original = Role(name="极简派", system_prompt="default prompt", preferred_model="m")
        with patch.object(role_models_store, "load",
                          return_value={"极简派": {"system_prompt": "customized!"}}):
            result = runner._customize_role(original)
        self.assertEqual(result.system_prompt, "customized!")
        self.assertEqual(result.name, "极简派")
        self.assertEqual(result.preferred_model, "m")

    def test_customize_role_without_override_returns_same_instance(self):
        from unittest.mock import patch
        from backend.roundtable import runner, role_models_store
        from backend.roundtable.data import Role
        original = Role(name="极简派", system_prompt="default prompt", preferred_model="m")
        with patch.object(role_models_store, "load", return_value={"极简派": {"model": "kimi-k2.6"}}):
            result = runner._customize_role(original)
        self.assertIs(result, original)


class RoleModelsStoreAliasMigrationTests(unittest.TestCase):
    """`role_models_store.load()` 读到 deprecated deepseek-chat / deepseek-reasoner
    时自动重映射到新 v4 名字 — 2026-05 DeepSeek rebrand 之后避免 user 老 config
    被 MODEL_ENDPOINTS 当 unknown model 拒掉。"""

    def _write_and_load(self, raw_dict: dict) -> dict:
        """写一个 fake role_models.json,patch _PATH 让 load() 读它,返回 result。"""
        import json
        import tempfile
        from unittest.mock import patch
        from pathlib import Path as P
        from backend.roundtable import role_models_store
        with tempfile.TemporaryDirectory() as d:
            fake_path = P(d) / "role_models.json"
            fake_path.write_text(json.dumps(raw_dict), encoding="utf-8")
            with patch.object(role_models_store, "_PATH", fake_path):
                return role_models_store.load()

    def test_load_remaps_deprecated_deepseek_chat_to_v4_flash(self):
        result = self._write_and_load({"悲观派": {"model": "deepseek-chat"}})
        self.assertEqual(result["悲观派"]["model"], "deepseek-v4-flash")

    def test_load_remaps_deprecated_deepseek_reasoner_to_v4_pro(self):
        result = self._write_and_load({"整理员": {"model": "deepseek-reasoner"}})
        self.assertEqual(result["整理员"]["model"], "deepseek-v4-pro")

    def test_load_remaps_flat_legacy_format_too(self):
        # flat string 老格式(`{role: model}`)也走 alias 迁移
        result = self._write_and_load({"极简派": "deepseek-chat"})
        self.assertEqual(result["极简派"]["model"], "deepseek-v4-flash")

    def test_load_passes_through_non_deprecated_names_unchanged(self):
        result = self._write_and_load({"极简派": {"model": "kimi-k2.6"}})
        self.assertEqual(result["极简派"]["model"], "kimi-k2.6")

    def test_load_preserves_system_prompt_alongside_alias_remap(self):
        result = self._write_and_load({
            "悲观派": {"model": "deepseek-chat", "system_prompt": "be paranoid"},
        })
        self.assertEqual(result["悲观派"]["model"], "deepseek-v4-flash")
        self.assertEqual(result["悲观派"]["system_prompt"], "be paranoid")


class SessionModeFieldTests(unittest.TestCase):
    """Session.meta 加 mode 字段(roundtable / oneonone),向前兼容老 jsonl。"""

    def test_session_dataclass_defaults_mode_to_roundtable(self):
        from backend.roundtable.data import Session
        s = Session(question="Q?", started_at=0.0)
        self.assertEqual(s.mode, "roundtable")

    def test_write_meta_persists_mode_field(self):
        import json
        from backend.roundtable.data import Session
        from backend.roundtable.io import write_meta
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            s = Session(question="Q?", started_at=1.0, mode="oneonone")
            write_meta(p, s)
            head = json.loads(p.read_text().splitlines()[0])
            self.assertEqual(head["mode"], "oneonone")

    def test_read_session_back_compat_defaults_legacy_jsonl_to_roundtable(self):
        """老 jsonl 没 mode 字段 → 默认 "roundtable"。"""
        import json
        from backend.roundtable.io import read_session
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            # 老 meta line:无 mode 字段
            p.write_text(json.dumps({
                "_meta": True, "question": "Q?", "started_at": 1.0,
                "critique_rounds": 1, "version": 1,
            }) + "\n")
            s = read_session(p)
            self.assertEqual(s.mode, "roundtable")


class OneOnOneRolesTests(unittest.TestCase):
    """1v1 对抗 mode 的 PROPONENT roles 构造 + framing。"""

    def test_make_proponent_roles_returns_two_roles_named_正方_反方(self):
        from backend.roundtable.oneonone import make_proponent_roles
        roles = make_proponent_roles("做 X", "不做 X")
        self.assertEqual(len(roles), 2)
        self.assertEqual(roles[0].name, "正方")
        self.assertEqual(roles[1].name, "反方")

    def test_make_proponent_roles_injects_stances_into_prompts(self):
        """各自 system_prompt 含自己的 stance 和对方的 stance。"""
        from backend.roundtable.oneonone import make_proponent_roles
        roles = make_proponent_roles("做 X", "不做 X")
        self.assertIn("做 X", roles[0].system_prompt)
        self.assertIn("不做 X", roles[0].system_prompt)  # 对方立场也要出现
        self.assertIn("不做 X", roles[1].system_prompt)
        self.assertIn("做 X", roles[1].system_prompt)

    def test_proponent_prompt_template_carries_four_core_anchors(self):
        """Spec §3.1:4 条核心约束的关键 anchor 必须在 prompt 里。"""
        from backend.roundtable.oneonone import PROPONENT_PROMPT_TEMPLATE
        for anchor in ("立场不可摇摆", "steel-man", "中立语", "反例边界"):
            self.assertIn(anchor, PROPONENT_PROMPT_TEMPLATE)

    def test_frame_stances_parses_binary_question(self):
        """LLM 返合法 JSON → 返 (stance_a, stance_b) tuple。"""
        from backend.roundtable.oneonone import frame_stances
        def fake_llm(model, system, user, temp):
            return '{"a": "做 X", "b": "不做 X"}'
        a, b = frame_stances("应该做 X 吗?", fake_llm)
        self.assertEqual(a, "做 X")
        self.assertEqual(b, "不做 X")

    def test_frame_stances_raises_on_non_binary_question(self):
        """LLM 判定非二值(返 error JSON)→ ValueError(caller 转 400)。"""
        from backend.roundtable.oneonone import frame_stances, NonBinaryQuestionError
        def fake_llm(model, system, user, temp):
            return '{"error": "non_binary_question", "hint": "改成 用/不用 X"}'
        with self.assertRaises(NonBinaryQuestionError):
            frame_stances("怎么设计 X?", fake_llm)

    def test_frame_stances_raises_on_garbage_llm_output(self):
        """LLM 返非 JSON / 缺 a/b key → ValueError。"""
        from backend.roundtable.oneonone import frame_stances
        def fake_llm(model, system, user, temp):
            return "not json at all"
        with self.assertRaises(ValueError):
            frame_stances("Q?", fake_llm)

    def test_make_proponent_roles_rejects_template_missing_placeholders(self):
        """用户在 #settings/roles 改了 '正方' system_prompt 时,如果删了
        {stance}/{opponent_stance} 占位符,立场字符串就注入不进去。必须 raise
        而不是 silent fallback,否则用户调试不出来为啥辩士不辩了。"""
        from backend.roundtable.oneonone import make_proponent_roles
        bad_template = "你是辩士,出力辩护。"   # 缺所有 4 个占位符
        with self.assertRaises(ValueError) as ctx:
            make_proponent_roles("做 X", "不做 X", template_a=bad_template)
        self.assertIn("占位符", str(ctx.exception))

    def test_make_proponent_roles_rejects_template_missing_some_placeholders(self):
        """缺一个占位符也要 raise(部分缺 = silent 半丢)。"""
        from backend.roundtable.oneonone import make_proponent_roles, PROPONENT_PROMPT_TEMPLATE
        partial = PROPONENT_PROMPT_TEMPLATE.replace("{opponent_stance}", "")
        with self.assertRaises(ValueError):
            make_proponent_roles("a", "b", template_b=partial)

    def test_make_proponent_roles_accepts_custom_template_with_all_placeholders(self):
        """custom template 含全 4 个占位符 → 正常 format,不 raise。"""
        from backend.roundtable.oneonone import make_proponent_roles
        custom = "正方/反方 自定义:{stance_label}={stance},vs {opponent_label}={opponent_stance}"
        roles = make_proponent_roles("a", "b", template_a=custom)
        self.assertIn("a", roles[0].system_prompt)
        self.assertIn("b", roles[0].system_prompt)
        # template_b 走 default,不影响
        self.assertIn("立场不可摇摆", roles[1].system_prompt)

    def test_frame_stances_strips_code_fence(self):
        """LLM 常把 JSON 包在 ```json``` 里,framing 要能拆。"""
        from backend.roundtable.oneonone import frame_stances
        def fake_llm(model, system, user, temp):
            return '```json\n{"a": "上线", "b": "不上线"}\n```'
        a, b = frame_stances("Q?", fake_llm)
        self.assertEqual((a, b), ("上线", "不上线"))

    def test_frame_stances_retries_once_on_garbage_then_succeeds(self):
        """第一次 LLM 返非 JSON,第二次返合法 → 不抛,返立场。"""
        from backend.roundtable.oneonone import frame_stances
        calls = []
        def fake_llm(model, system, user, temp):
            calls.append(user)
            if len(calls) == 1:
                return "好的,这是 JSON: 不过我忘了格式"  # garbage
            return '{"a": "立场 A", "b": "立场 B"}'
        a, b = frame_stances("Q?", fake_llm)
        self.assertEqual((a, b), ("立场 A", "立场 B"))
        self.assertEqual(len(calls), 2)
        # 第二次 user prompt 含"严格只输出 JSON"加强提示
        self.assertIn("严格只输出 JSON", calls[1])

    def test_frame_stances_non_binary_does_not_retry(self):
        """LLM 返 NonBinaryQuestionError 是 deliberate 判断,不 retry。"""
        from backend.roundtable.oneonone import frame_stances, NonBinaryQuestionError
        calls = []
        def fake_llm(model, system, user, temp):
            calls.append(user)
            return '{"error": "non_binary_question", "hint": "..."}'
        with self.assertRaises(NonBinaryQuestionError):
            frame_stances("Q?", fake_llm)
        self.assertEqual(len(calls), 1)    # 不 retry

    def test_frame_stances_two_failures_raises(self):
        """两次都 garbage → ValueError(caller 转 500)。"""
        from backend.roundtable.oneonone import frame_stances
        def fake_llm(model, system, user, temp):
            return "not json"
        with self.assertRaises(ValueError):
            frame_stances("Q?", fake_llm)

    def test_frame_stances_uses_caller_provided_framing_model(self):
        """framing_model kwarg 透传到 model_fn(W6:用户 override 整理员 model 时 framing 同源)。"""
        from backend.roundtable.oneonone import frame_stances
        captured = {}
        def fake_llm(model, system, user, temp):
            captured["model"] = model
            return '{"a": "x", "b": "y"}'
        frame_stances("Q?", fake_llm, framing_model="moonshot-v1-32k")
        self.assertEqual(captured["model"], "moonshot-v1-32k")


class DeciderTests(unittest.TestCase):
    """决断员 opt-in 元角色 — synth 之后 reads synth + R1/R2 → 推荐方案 / 理由
    / 代价 / 备选(1v1 额外含 胜方判定)。"""

    def test_decider_role_has_required_anchors(self):
        from backend.roundtable.decider import DECIDER
        self.assertEqual(DECIDER.name, "决断员")
        for anchor in ("推荐必须具体", "拒绝中立语", "胜方判定"):
            self.assertIn(anchor, DECIDER.system_prompt)

    def test_build_decider_user_prompt_includes_question_synth_and_turns(self):
        from backend.roundtable.decider import build_decider_user_prompt
        from backend.roundtable.data import AgentTurn
        turns = [
            AgentTurn(round=1, role="极简派", type="answer", content="简单点", ts=0.0),
            AgentTurn(round=2, role="悲观派", type="critique", content="会崩", ts=0.0),
        ]
        prompt = build_decider_user_prompt(
            question="要上 TDD 吗", mode="roundtable",
            turns=turns, synth_text="共识点: 都说要小步",
        )
        self.assertIn("要上 TDD 吗", prompt)
        self.assertIn("简单点", prompt)
        self.assertIn("会崩", prompt)
        self.assertIn("共识点: 都说要小步", prompt)

    def test_build_decider_user_prompt_marks_oneonone_mode(self):
        """1v1 mode 时 prompt 显式提示决断员"额外给胜方判定"。"""
        from backend.roundtable.decider import build_decider_user_prompt
        prompt = build_decider_user_prompt(
            question="做 X 吗", mode="oneonone", turns=[], synth_text="",
        )
        self.assertIn("胜方判定", prompt)
        # 4 派 prompt 不应提胜方判定(避免干扰)
        prompt_rt = build_decider_user_prompt(
            question="X?", mode="roundtable", turns=[], synth_text="",
        )
        self.assertNotIn("胜方判定", prompt_rt)

    def test_parse_verdict_roundtable_4_sections(self):
        from backend.roundtable.decider import parse_verdict
        text = """## 推荐方案
做 X,先 spike 2 周

## 理由
- 极简派说 A
- 悲观派承认 B

## 代价
- 你必须接受 C
- 也要承担 D

## 备选
- 如果不行就 Y
"""
        parsed = parse_verdict(text)
        self.assertIn("做 X", parsed["推荐方案"])
        self.assertEqual(len(parsed["理由"]), 2)
        self.assertEqual(len(parsed["代价"]), 2)
        self.assertEqual(parsed["备选"], ["如果不行就 Y"])
        self.assertNotIn("胜方判定", parsed)  # 4 派 mode 不给胜方

    def test_parse_verdict_oneonone_includes_winner(self):
        from backend.roundtable.decider import parse_verdict
        text = """## 推荐方案
选 A

## 理由
- ...

## 代价
- ...

## 备选
- ...

## 胜方判定
正方,因为反方 R2 里 "..." 没站住
"""
        parsed = parse_verdict(text)
        self.assertIn("正方", parsed["胜方判定"])

    def test_decide_calls_model_with_decider_system_prompt(self):
        """`decide(...)` 把 DECIDER.system_prompt 当 system,
        build_decider_user_prompt 输出当 user,model_override 覆盖默认 model。"""
        from backend.roundtable.decider import decide, DECIDER
        captured = {}
        def fake_llm(model, system, user, temp):
            captured["model"] = model
            captured["system"] = system
            captured["user"] = user
            return "verdict text"
        decide(
            question="Q?", mode="roundtable", turns=[], synth_text="S",
            decider=DECIDER, model_fn=fake_llm,
        )
        self.assertEqual(captured["system"], DECIDER.system_prompt)
        self.assertIn("Q?", captured["user"])
        self.assertEqual(captured["model"], DECIDER.preferred_model)

    def test_decide_honors_model_override(self):
        from backend.roundtable.decider import decide, DECIDER
        captured = {}
        def fake_llm(model, system, user, temp):
            captured["model"] = model
            return "v"
        decide(
            question="Q?", mode="roundtable", turns=[], synth_text="",
            decider=DECIDER, model_fn=fake_llm, model_override="moonshot-v1-32k",
        )
        self.assertEqual(captured["model"], "moonshot-v1-32k")


if __name__ == "__main__":
    unittest.main()
