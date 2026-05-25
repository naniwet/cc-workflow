import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.roundtable import role_models_store


@contextmanager
def _patched_path(content: dict | None):
    """临时把 _PATH 指到 tmp 文件;content=None → 文件不存在。"""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "role_models.json"
        if content is not None:
            p.write_text(json.dumps(content), encoding="utf-8")
        with patch.object(role_models_store, "_PATH", p):
            yield p


class RoleModelsStoreTests(unittest.TestCase):
    def test_load_returns_empty_when_file_missing(self):
        with _patched_path(None):
            self.assertEqual(role_models_store.load(), {})

    def test_load_returns_dict_when_file_present(self):
        with _patched_path({"极简派": "kimi-k2.6"}):
            self.assertEqual(role_models_store.load(), {"极简派": "kimi-k2.6"})

    def test_load_returns_empty_on_corrupt_json(self):
        with _patched_path(None) as p:
            p.write_text("{not json", encoding="utf-8")
            with self.assertLogs("backend.roundtable.role_models_store", level="WARNING"):
                self.assertEqual(role_models_store.load(), {})

    def test_save_then_load_roundtrip(self):
        with _patched_path(None):
            role_models_store.save({"借鉴派": "kimi-k2.6", "悲观派": "deepseek-reasoner"})
            self.assertEqual(
                role_models_store.load(),
                {"借鉴派": "kimi-k2.6", "悲观派": "deepseek-reasoner"},
            )

    def test_effective_model_for_uses_override_when_present(self):
        with _patched_path({"极简派": "kimi-k2.6"}):
            self.assertEqual(
                role_models_store.effective_model_for("极简派", "deepseek-chat"),
                "kimi-k2.6",
            )
            self.assertEqual(
                role_models_store.effective_model_for("场景派", "deepseek-chat"),
                "deepseek-chat",
            )


if __name__ == "__main__":
    unittest.main()
