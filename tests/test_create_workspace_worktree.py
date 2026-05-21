"""Integration:POST /workspaces / PUT /workspaces/<n>/settings 处理
worktree_mode 字段的端到端行为。完全沙箱:workspaces dir / settings
file 都重定到 tmp。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from backend import main, ws_settings, config, auth


class WorkspaceWorktreeModeApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.ws_dir = self.tmp_path / "workspaces"
        self.ws_dir.mkdir()
        self.cfg_file = self.tmp_path / "workspaces.json"

        self.patches = [
            patch.object(config, "WORKSPACES_DIR", self.ws_dir),
            patch.object(ws_settings, "_PATH", self.cfg_file),
            patch.object(main, "_list_provider_names", return_value=[]),
        ]
        for p in self.patches:
            p.start()
        # 绕开 cookie 鉴权 — TestClient 不走 nginx,直接命 FastAPI
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _read_settings(self) -> dict:
        if not self.cfg_file.exists():
            return {}
        return json.loads(self.cfg_file.read_text(encoding="utf-8"))

    # ---------- POST /workspaces ----------

    def test_create_with_explicit_off_persists(self):
        r = self.client.post(
            "/workspaces",
            json={"name": "notes", "engine": "claude", "worktree_mode": "off"},
        )
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self._read_settings()["notes"]["worktree_mode"], "off")

    def test_create_with_default_auto_not_persisted(self):
        # 跟 trust 一致:默认值不写,留给 fallback。
        r = self.client.post(
            "/workspaces", json={"name": "code", "engine": "claude"},
        )
        self.assertEqual(r.status_code, 201, r.text)
        self.assertNotIn("worktree_mode", self._read_settings().get("code", {}))

    def test_create_with_bogus_value_422(self):
        r = self.client.post(
            "/workspaces",
            json={"name": "bad", "engine": "claude", "worktree_mode": "yolo"},
        )
        self.assertEqual(r.status_code, 422)

    # ---------- PUT /workspaces/<n>/settings ----------

    def test_put_flip_to_off(self):
        self.client.post("/workspaces", json={"name": "ws", "engine": "claude"})
        r = self.client.put(
            "/workspaces/ws/settings", json={"worktree_mode": "off"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._read_settings()["ws"]["worktree_mode"], "off")

    def test_put_flip_to_auto_removes_field(self):
        # 先建一个 off,再翻回 auto — 字段应被删掉(跟 trust=None 一致)
        self.client.post(
            "/workspaces",
            json={"name": "ws", "engine": "claude", "worktree_mode": "off"},
        )
        r = self.client.put(
            "/workspaces/ws/settings", json={"worktree_mode": "auto"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(
            "worktree_mode", self._read_settings().get("ws", {}),
        )

    def test_put_bogus_value_422(self):
        self.client.post("/workspaces", json={"name": "ws", "engine": "claude"})
        r = self.client.put(
            "/workspaces/ws/settings", json={"worktree_mode": "yolo"},
        )
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
