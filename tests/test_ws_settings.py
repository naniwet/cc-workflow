"""单测:`backend.ws_settings.worktree_mode_for()` 的 4 条 fallback 路径。"""
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import ws_settings


@contextmanager
def _patched_settings(content: dict):
    """临时把 ws_settings._PATH 指到一个 tmp 文件,写入指定内容。"""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "workspaces.json"
        p.write_text(json.dumps(content), encoding="utf-8")
        with patch.object(ws_settings, "_PATH", p):
            yield p


class WorktreeModeForTests(unittest.TestCase):
    def test_returns_off_when_field_set(self):
        with _patched_settings({"notes": {"worktree_mode": "off"}}):
            self.assertEqual(ws_settings.worktree_mode_for("notes"), "off")

    def test_returns_auto_when_field_set(self):
        with _patched_settings({"code": {"worktree_mode": "auto"}}):
            self.assertEqual(ws_settings.worktree_mode_for("code"), "auto")

    def test_returns_auto_when_field_missing(self):
        with _patched_settings({"legacy": {"trust": True}}):
            self.assertEqual(ws_settings.worktree_mode_for("legacy"), "auto")

    def test_returns_auto_when_value_garbage(self):
        with _patched_settings({"weird": {"worktree_mode": "on"}}):
            with self.assertLogs("backend.ws_settings", level="WARNING") as cm:
                self.assertEqual(ws_settings.worktree_mode_for("weird"), "auto")
            self.assertTrue(any("worktree_mode" in msg for msg in cm.output))

    def test_returns_auto_when_workspace_unknown(self):
        with _patched_settings({}):
            self.assertEqual(ws_settings.worktree_mode_for("never-heard-of"), "auto")


if __name__ == "__main__":
    unittest.main()
