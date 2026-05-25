"""Integration tests for /agents endpoints."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth, agents_store


class AgentsEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.agents_dir = Path(self.tmp.name) / "agents"
        self.patches = [
            patch.object(agents_store, "_AGENTS_DIR", self.agents_dir),
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

    # --- GET /agents ---

    def test_get_returns_empty_when_dir_missing(self):
        r = self.client.get("/agents")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), [])

    def test_get_returns_list_of_agents(self):
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "a.md").write_text(
            "---\nname: a\ndescription: A\ntools: Read\n---\nbody A",
            encoding="utf-8",
        )
        (self.agents_dir / "b.md").write_text(
            "---\nname: b\ndescription: B\ntools: Edit, Bash\n---\nbody B",
            encoding="utf-8",
        )
        r = self.client.get("/agents")
        self.assertEqual(r.status_code, 200)
        agents = r.json()
        self.assertEqual(len(agents), 2)
        names = sorted(a["name"] for a in agents)
        self.assertEqual(names, ["a", "b"])
        a = next(a for a in agents if a["name"] == "a")
        self.assertEqual(a["description"], "A")
        self.assertEqual(a["tools"], ["Read"])
        self.assertEqual(a["system_prompt"], "body A")

    # --- PUT /agents/{name} ---

    def test_put_creates_new_agent(self):
        r = self.client.put(
            "/agents/test-one",
            json={"description": "d", "tools": ["Read"], "system_prompt": "p"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        path = self.agents_dir / "test-one.md"
        self.assertTrue(path.is_file())
        content = path.read_text(encoding="utf-8")
        self.assertIn("name: test-one", content)
        self.assertIn("description: d", content)
        self.assertIn("tools: Read", content)
        self.assertIn("p", content)

    def test_put_updates_existing_agent(self):
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "x.md").write_text(
            "---\nname: x\ndescription: old\ntools: Read\n---\nold body",
            encoding="utf-8",
        )
        r = self.client.put(
            "/agents/x",
            json={"description": "new", "tools": ["Bash"], "system_prompt": "new body"},
        )
        self.assertEqual(r.status_code, 200)
        content = (self.agents_dir / "x.md").read_text(encoding="utf-8")
        self.assertIn("description: new", content)
        self.assertIn("tools: Bash", content)
        self.assertIn("new body", content)
        self.assertNotIn("old body", content)

    def test_put_preserves_extra_frontmatter_round_trip(self):
        """已有文件含 model: 等 extra field,PUT 后保留。"""
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "x.md").write_text(
            "---\nname: x\ndescription: d\ntools: Read\nmodel: claude-3-opus\n---\nbody",
            encoding="utf-8",
        )
        r = self.client.put(
            "/agents/x",
            json={"description": "d2", "tools": ["Read"], "system_prompt": "body2"},
        )
        self.assertEqual(r.status_code, 200)
        content = (self.agents_dir / "x.md").read_text(encoding="utf-8")
        self.assertIn("model: claude-3-opus", content)
        self.assertIn("description: d2", content)

    def test_put_rejects_invalid_name(self):
        r = self.client.put(
            "/agents/Invalid_Name",
            json={"description": "d", "tools": [], "system_prompt": "p"},
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("invalid agent name", r.text)

    def test_put_rejects_invalid_tool(self):
        r = self.client.put(
            "/agents/ok-name",
            json={"description": "d", "tools": ["BadTool!"], "system_prompt": "p"},
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("invalid tool", r.text)

    # --- DELETE /agents/{name} ---

    def test_delete_removes_existing(self):
        self.agents_dir.mkdir(parents=True)
        (self.agents_dir / "x.md").write_text(
            "---\nname: x\n---\nbody", encoding="utf-8",
        )
        r = self.client.delete("/agents/x")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse((self.agents_dir / "x.md").exists())

    def test_delete_missing_returns_404(self):
        r = self.client.delete("/agents/never-existed")
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
