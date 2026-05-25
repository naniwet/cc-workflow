"""Unit tests for backend/agents_store.py — Claude Code subagent
file CRUD + frontmatter round-trip."""
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import agents_store


@contextmanager
def _patched_dir():
    """临时把 _AGENTS_DIR 指到 tmp 目录。"""
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d) / "agents"
        with patch.object(agents_store, "_AGENTS_DIR", tmp):
            yield tmp


class FrontmatterParserTests(unittest.TestCase):
    def test_parse_three_fields_plus_body(self):
        text = (
            "---\n"
            "name: code-dev\n"
            "description: 代码开发员\n"
            "tools: Read, Edit, Bash\n"
            "---\n"
            "# 你的身份\n\n你是 dev。"
        )
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields["name"], "code-dev")
        self.assertEqual(fields["description"], "代码开发员")
        self.assertEqual(fields["tools"], "Read, Edit, Bash")
        self.assertIn("你是 dev", body)

    def test_parse_no_frontmatter_returns_empty_and_full_body(self):
        text = "no frontmatter just body"
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields, {})
        self.assertEqual(body, text)

    def test_parse_skips_blank_lines_and_comments(self):
        text = (
            "---\n"
            "\n"
            "# this is a comment\n"
            "name: foo\n"
            "---\n"
            "body"
        )
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields, {"name": "foo"})
        self.assertEqual(body, "body")


class SerializerTests(unittest.TestCase):
    def test_roundtrip_preserves_3_fields_and_body(self):
        agent = agents_store.Agent(
            name="t1",
            description="测试 agent",
            tools=["Read", "Bash"],
            system_prompt="body content",
        )
        text = agents_store._serialize(agent)
        fields, body = agents_store._parse_frontmatter(text)
        self.assertEqual(fields["name"], "t1")
        self.assertEqual(fields["description"], "测试 agent")
        self.assertEqual(fields["tools"], "Read, Bash")
        self.assertEqual(body, "body content")

    def test_roundtrip_preserves_extra_frontmatter(self):
        """e.g. `model:` 字段我们不暴露在 UI,但保留在 file 里 round-trip 不丢。"""
        agent = agents_store.Agent(
            name="t2",
            description="",
            tools=[],
            system_prompt="body",
            extra_frontmatter={"model": "claude-3-opus", "custom": "x"},
        )
        text = agents_store._serialize(agent)
        self.assertIn("model: claude-3-opus", text)
        self.assertIn("custom: x", text)


class ListAgentsTests(unittest.TestCase):
    def test_list_returns_empty_when_dir_missing(self):
        with _patched_dir():
            # 注意 _patched_dir 不创建 agents/ 目录,所以 _AGENTS_DIR 不存在
            self.assertEqual(agents_store.list_agents(), [])

    def test_list_returns_parsed_agents(self):
        with _patched_dir() as d:
            d.mkdir()
            (d / "a.md").write_text(
                "---\nname: a\ndescription: A\ntools: Read\n---\nbody A",
                encoding="utf-8",
            )
            (d / "b.md").write_text(
                "---\nname: b\ndescription: B\ntools: Edit, Bash\n---\nbody B",
                encoding="utf-8",
            )
            agents = agents_store.list_agents()
            self.assertEqual(len(agents), 2)
            names = sorted(a.name for a in agents)
            self.assertEqual(names, ["a", "b"])

    def test_list_skips_bad_file_silently(self):
        """坏文件不应该让整个 list 炸 — 用户手编错了某个 file 时其它仍可见。"""
        with _patched_dir() as d:
            d.mkdir()
            (d / "good.md").write_text(
                "---\nname: good\ndescription: ok\ntools:\n---\nbody",
                encoding="utf-8",
            )
            # 写一个 binary file 让 read_text(utf-8) 抛 UnicodeDecodeError
            (d / "bad.md").write_bytes(b"\xff\xfe\x00\x00bin")
            agents = agents_store.list_agents()
            names = [a.name for a in agents]
            self.assertEqual(names, ["good"])


class SaveAgentTests(unittest.TestCase):
    def test_save_atomic_write_round_trip(self):
        with _patched_dir() as d:
            agent = agents_store.Agent(
                name="x", description="desc", tools=["Read"], system_prompt="hi",
            )
            agents_store.save_agent(agent)
            self.assertTrue((d / "x.md").is_file())
            loaded = agents_store.read_agent("x")
            self.assertEqual(loaded.name, "x")
            self.assertEqual(loaded.description, "desc")
            self.assertEqual(loaded.tools, ["Read"])
            self.assertEqual(loaded.system_prompt, "hi")


class DeleteAgentTests(unittest.TestCase):
    def test_delete_existing_returns_true(self):
        with _patched_dir() as d:
            d.mkdir()
            (d / "x.md").write_text(
                "---\nname: x\n---\nbody", encoding="utf-8",
            )
            self.assertTrue(agents_store.delete_agent("x"))
            self.assertFalse((d / "x.md").exists())

    def test_delete_missing_returns_false(self):
        with _patched_dir():
            self.assertFalse(agents_store.delete_agent("nope"))


if __name__ == "__main__":
    unittest.main()
