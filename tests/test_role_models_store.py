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

    def test_load_returns_nested_dict_when_file_present(self):
        with _patched_path({"极简派": {"model": "kimi-k2.6"}}):
            self.assertEqual(role_models_store.load(), {"极简派": {"model": "kimi-k2.6"}})

    def test_load_upgrades_old_flat_format(self):
        """老 flat dict {role: str} → 自动升级 {role: {model: str}}"""
        with _patched_path({"极简派": "kimi-k2.6"}):
            self.assertEqual(role_models_store.load(), {"极简派": {"model": "kimi-k2.6"}})

    def test_load_handles_mixed_format(self):
        """同文件混合(部分 flat string、部分 nested dict)都正确处理。"""
        with _patched_path({
            "极简派": "kimi-k2.6",
            "悲观派": {"model": "deepseek-reasoner"},
            "借鉴派": {"system_prompt": "你是借鉴派(自定义)..."},
        }):
            out = role_models_store.load()
            self.assertEqual(out["极简派"], {"model": "kimi-k2.6"})
            self.assertEqual(out["悲观派"], {"model": "deepseek-reasoner"})
            self.assertEqual(out["借鉴派"], {"system_prompt": "你是借鉴派(自定义)..."})

    def test_load_skips_garbage_values(self):
        """value 不是 string 也不是 dict(int / list / null)→ 静默忽略。"""
        with _patched_path({
            "极简派": "kimi-k2.6",
            "noise1": 42,
            "noise2": ["array"],
            "noise3": None,
        }):
            out = role_models_store.load()
            self.assertIn("极简派", out)
            self.assertNotIn("noise1", out)
            self.assertNotIn("noise2", out)
            self.assertNotIn("noise3", out)

    def test_load_strips_unknown_inner_keys(self):
        """nested dict 内层未知 key 被 strip(将来 temperature 等)。当前接受 model + system_prompt。"""
        with _patched_path({"极简派": {"model": "kimi-k2.6", "temperature": 0.7, "unknown_field": "x"}}):
            out = role_models_store.load()
            self.assertEqual(out["极简派"], {"model": "kimi-k2.6"})

    def test_load_drops_empty_string_inner_values(self):
        """内层 model 或 system_prompt 是空 string → 视为没设置,过滤。"""
        with _patched_path({"极简派": {"model": "", "system_prompt": ""}}):
            out = role_models_store.load()
            self.assertNotIn("极简派", out)

    def test_load_returns_empty_on_corrupt_json(self):
        with _patched_path(None) as p:
            p.write_text("{not json", encoding="utf-8")
            with self.assertLogs("backend.roundtable.role_models_store", level="WARNING"):
                self.assertEqual(role_models_store.load(), {})

    def test_save_then_load_roundtrip_nested(self):
        with _patched_path(None):
            role_models_store.save({
                "借鉴派": {"model": "kimi-k2.6"},
                "悲观派": {"model": "deepseek-reasoner", "system_prompt": "..."},
            })
            self.assertEqual(role_models_store.load(), {
                "借鉴派": {"model": "kimi-k2.6"},
                "悲观派": {"model": "deepseek-reasoner", "system_prompt": "..."},
            })

    def test_effective_model_for_uses_override_when_present(self):
        with _patched_path({"极简派": {"model": "kimi-k2.6"}}):
            self.assertEqual(
                role_models_store.effective_model_for("极简派", "deepseek-chat"),
                "kimi-k2.6",
            )
            self.assertEqual(
                role_models_store.effective_model_for("场景派", "deepseek-chat"),
                "deepseek-chat",
            )

    def test_effective_system_prompt_for_uses_override_when_present(self):
        with _patched_path({"极简派": {"system_prompt": "自定义 prompt"}}):
            self.assertEqual(
                role_models_store.effective_system_prompt_for("极简派", "default"),
                "自定义 prompt",
            )

    def test_effective_system_prompt_for_falls_back_to_default(self):
        with _patched_path({"极简派": {"model": "kimi-k2.6"}}):
            self.assertEqual(
                role_models_store.effective_system_prompt_for("极简派", "default"),
                "default",
            )

    def test_effective_system_prompt_for_unknown_role_returns_default(self):
        with _patched_path({}):
            self.assertEqual(
                role_models_store.effective_system_prompt_for("场景派", "default"),
                "default",
            )


if __name__ == "__main__":
    unittest.main()
