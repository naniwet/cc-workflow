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
            json.dumps({"极简派": "kimi-k2.6"}), encoding="utf-8",
        )
        r = self.client.get("/roundtables/models")
        body = r.json()
        minimalist = next(role for role in body["roles"] if role["name"] == "极简派")
        self.assertEqual(minimalist["default_model"], "kimi-k2.6")


if __name__ == "__main__":
    unittest.main()
