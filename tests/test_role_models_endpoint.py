import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth, config
from backend.roundtable import role_models_store


class RoundtableModelsEndpointTests(unittest.TestCase):
    """`GET /roundtables/models` — 含 REVIEWER + effective default。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.role_models_file = self.tmp_path / "role_models.json"
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

    def test_models_endpoint_includes_reviewer_role(self):
        r = self.client.get("/roundtables/models")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        role_names = [role["name"] for role in body["roles"]]
        self.assertIn("审查员", role_names)
        reviewer = next(role for role in body["roles"] if role["name"] == "审查员")
        self.assertEqual(reviewer["kind"], "reviewer")

    def test_models_endpoint_uses_persistent_override(self):
        self.role_models_file.write_text(
            json.dumps({"极简派": {"model": "kimi-k2.6"}}), encoding="utf-8",
        )
        r = self.client.get("/roundtables/models")
        body = r.json()
        minimalist = next(role for role in body["roles"] if role["name"] == "极简派")
        self.assertEqual(minimalist["default_model"], "kimi-k2.6")

    def test_models_endpoint_includes_default_system_prompt(self):
        """GET /roundtables/models 响应每个 role 含 default_system_prompt 字段。"""
        r = self.client.get("/roundtables/models")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        for role in body["roles"]:
            self.assertIn("default_system_prompt", role)
            self.assertIsInstance(role["default_system_prompt"], str)
            self.assertGreater(len(role["default_system_prompt"]), 0)


class PutRoleModelsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.role_models_file = self.tmp_path / "role_models.json"
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

    def test_put_writes_overrides_to_file(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"model": "kimi-k2.6"}}},
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
        self.assertEqual(data["极简派"]["model"], "kimi-k2.6")

    def test_put_empty_dict_clears_all_overrides(self):
        # 先写入一个 override,然后 PUT 空 dict 应该清掉
        self.role_models_file.write_text(
            json.dumps({"极简派": {"model": "kimi-k2.6"}}), encoding="utf-8",
        )
        r = self.client.put("/settings/role-models", json={"role_models": {}})
        self.assertEqual(r.status_code, 200)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
        self.assertEqual(data, {})

    def test_put_rejects_unknown_role(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"幻觉派": {"model": "kimi-k2.6"}}},
        )
        self.assertEqual(r.status_code, 400, r.text)
        body = r.json()
        self.assertIn("unknown role", str(body))

    def test_put_rejects_unknown_model(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"model": "gpt-5-turbo-pro"}}},
        )
        self.assertEqual(r.status_code, 400, r.text)
        body = r.json()
        self.assertIn("unknown model", str(body))

    def test_put_returns_current_effective_map(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"model": "kimi-k2.6"}}},
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("role_models"), {"极简派": {"model": "kimi-k2.6"}})

    def test_put_writes_prompt_override(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"system_prompt": "自定义 prompt"}}},
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
        self.assertEqual(data["极简派"]["system_prompt"], "自定义 prompt")

    def test_put_writes_both_model_and_prompt(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"model": "kimi-k2.6", "system_prompt": "..."}}},
        )
        self.assertEqual(r.status_code, 200)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8"))
        self.assertEqual(data["极简派"]["model"], "kimi-k2.6")
        self.assertEqual(data["极简派"]["system_prompt"], "...")

    def test_put_empty_prompt_treated_as_no_override(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"system_prompt": "   "}}},
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = json.loads(self.role_models_file.read_text(encoding="utf-8")) if self.role_models_file.exists() else {}
        self.assertNotIn("极简派", data)

    def test_put_prompt_too_long_422(self):
        r = self.client.put(
            "/settings/role-models",
            json={"role_models": {"极简派": {"system_prompt": "x" * 5001}}},
        )
        self.assertEqual(r.status_code, 422)


class CreateRoundtableMergesRoleModelsTests(unittest.TestCase):
    """POST /roundtables 把 per-session role_models 跟 persistent 合并 —
    per-session 字段覆盖 persistent。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.role_models_file = self.tmp_path / "role_models.json"
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

    def test_per_session_role_models_override_persistent(self):
        self.role_models_file.write_text(
            json.dumps({
                "极简派": {"model": "kimi-k2.6"},
                "悲观派": {"model": "deepseek-reasoner"},
            }),
            encoding="utf-8",
        )
        from unittest.mock import patch as _patch
        captured = {}
        def _fake_submit(*args, **kwargs):
            captured.update(kwargs)
            return Path("/tmp/fake-session.jsonl")
        with _patch("backend.main.roundtable_runner.submit", side_effect=_fake_submit):
            r = self.client.post(
                "/roundtables",
                json={
                    "question": "Q?",
                    "role_models": {"极简派": "moonshot-v1-32k"},  # per-session 还是 flat,只 model
                },
            )
        self.assertEqual(r.status_code, 202, r.text)
        merged = captured["role_models"]
        # merged 是 flat dict[str, str](submit signature),per-session override 优先,
        # persistent 其它 key 保留
        self.assertEqual(merged["极简派"], "moonshot-v1-32k")
        self.assertEqual(merged["悲观派"], "deepseek-reasoner")

    def test_ghost_key_in_persistent_does_not_break_create(self):
        """Spec §4: persistent role_models.json 里的 ghost key 不让 create_roundtable 400。"""
        self.role_models_file.write_text(
            json.dumps({
                "已删派": {"model": "kimi-k2.6"},
                "极简派": {"model": "deepseek-chat"},
            }),
            encoding="utf-8",
        )
        from unittest.mock import patch as _patch
        captured = {}
        def _fake_submit(*args, **kwargs):
            captured.update(kwargs)
            return Path("/tmp/fake-session.jsonl")
        with _patch("backend.main.roundtable_runner.submit", side_effect=_fake_submit):
            r = self.client.post("/roundtables", json={"question": "Q?"})
        self.assertEqual(r.status_code, 202, r.text)
        merged = captured["role_models"]
        # 不含 per-session,只含 persistent 的 model 部分(ghost 也在,run_session 会无视)
        self.assertIn("已删派", merged)
        self.assertEqual(merged["极简派"], "deepseek-chat")


if __name__ == "__main__":
    unittest.main()
