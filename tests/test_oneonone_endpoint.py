"""Integration tests for `POST /oneonone` — 1v1 对抗 mode endpoint.

Mocks framing(`oneonone.frame_stances`)和 runner.submit_oneonone,验证:
- 二值问题 happy path:framing 拿到立场 → submit 被调
- 非二值问题 → 400 + hint
- framing LLM 输出 garbage → 500
- role_models override 透传 + 校验
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth
from backend.roundtable import role_models_store, oneonone


class OneOnOneEndpointTests(unittest.TestCase):
    """`POST /oneonone` — framing + 提交 1v1 session。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.role_models_file = Path(self.tmp.name) / "role_models.json"
        self.patches = [
            patch.object(role_models_store, "_PATH", self.role_models_file),
        ]
        for p in self.patches:
            p.start()
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_happy_path_framing_succeeds_then_submit_called(self):
        """二值问题 → framing 拿立场 → submit_oneonone 被调 → 202。"""
        captured = {}
        def _fake_submit(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return Path("/tmp/fake-1v1-session.jsonl")
        with patch.object(oneonone, "frame_stances",
                          return_value=("做 X", "不做 X")), \
             patch.object(main.roundtable_runner, "submit_oneonone",
                          side_effect=_fake_submit):
            r = self.client.post("/oneonone", json={"question": "应该做 X 吗?"})
        self.assertEqual(r.status_code, 202, r.text)
        body = r.json()
        self.assertEqual(body["stance_a"], "做 X")
        self.assertEqual(body["stance_b"], "不做 X")
        self.assertEqual(captured["kwargs"]["stance_a"], "做 X")
        self.assertEqual(captured["kwargs"]["stance_b"], "不做 X")

    def test_non_binary_question_returns_400_with_hint(self):
        """framing 判定非二值 → 400 + hint,不调 submit。"""
        submit_calls = []
        def _track(*a, **kw):
            submit_calls.append((a, kw))
            return Path("/tmp/x.jsonl")
        with patch.object(oneonone, "frame_stances",
                          side_effect=oneonone.NonBinaryQuestionError(
                              "改成 用/不用 X")), \
             patch.object(main.roundtable_runner, "submit_oneonone",
                          side_effect=_track):
            r = self.client.post("/oneonone", json={"question": "怎么设计 X?"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"]["error"], "non_binary_question")
        self.assertIn("改成 用/不用 X", r.json()["detail"]["hint"])
        self.assertEqual(submit_calls, [])  # submit 没被调

    def test_framing_garbage_output_returns_500(self):
        """framing LLM 抽风(non-JSON / 缺 key)→ 500,不是 400(用户没错)。"""
        with patch.object(oneonone, "frame_stances",
                          side_effect=ValueError("framing LLM returned non-JSON")):
            r = self.client.post("/oneonone", json={"question": "Q?"})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["detail"]["error"], "framing_failed")

    def test_role_models_validates_against_endpoints(self):
        """正方 / 反方 / 整理员 之外的角色名 → 400(typo 兜底)。"""
        with patch.object(oneonone, "frame_stances",
                          return_value=("a", "b")):
            r = self.client.post("/oneonone", json={
                "question": "Q?",
                "role_models": {"未知角色": "kimi-k2.6"},
            })
        self.assertEqual(r.status_code, 400)
        self.assertIn("unknown role", r.json()["detail"]["error"])

    def test_role_models_rejects_unknown_model(self):
        with patch.object(oneonone, "frame_stances",
                          return_value=("a", "b")):
            r = self.client.post("/oneonone", json={
                "question": "Q?",
                "role_models": {"正方": "not-a-real-model"},
            })
        self.assertEqual(r.status_code, 400)
        self.assertIn("unknown model", r.json()["detail"]["error"])

    def test_persistent_role_models_override_merged(self):
        """role_models.json 里给正方设了 model → 透传给 submit。"""
        self.role_models_file.write_text(
            json.dumps({"正方": {"model": "moonshot-v1-32k"}}),
            encoding="utf-8",
        )
        captured = {}
        def _fake_submit(*args, **kwargs):
            captured.update(kwargs)
            return Path("/tmp/x.jsonl")
        with patch.object(oneonone, "frame_stances",
                          return_value=("a", "b")), \
             patch.object(main.roundtable_runner, "submit_oneonone",
                          side_effect=_fake_submit):
            r = self.client.post("/oneonone", json={"question": "Q?"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(captured["role_models"]["正方"], "moonshot-v1-32k")


if __name__ == "__main__":
    unittest.main()
