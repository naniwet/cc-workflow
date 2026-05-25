import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth, config


class RoundtableUploadEndpointTests(unittest.TestCase):
    """POST /roundtable-uploads — 接 multipart 文件,落到独立顶层目录。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.uploads_dir = self.tmp_path / "roundtable-uploads"
        self.patches = [
            patch.object(config, "ROUNDTABLE_UPLOADS_DIR", self.uploads_dir),
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

    def test_upload_writes_file_to_dest_dir(self):
        r = self.client.post(
            "/roundtable-uploads",
            files=[("files", ("hello.md", b"# hi\n", "text/markdown"))],
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("upload_id", body)
        self.assertEqual(len(body["paths"]), 1)
        # 文件真的落盘了
        path = Path(body["paths"][0])
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_text(encoding="utf-8"), "# hi\n")
        # 路径在 ROUNDTABLE_UPLOADS_DIR 下
        path.relative_to(self.uploads_dir)   # 抛 ValueError 测试失败

    def test_upload_empty_files_400(self):
        r = self.client.post("/roundtable-uploads", files=[])
        # FastAPI 422 (validation) 或 400 都接受 — 关键是不是 200
        self.assertNotEqual(r.status_code, 200)
        self.assertGreaterEqual(r.status_code, 400)


class CreateRoundtableAttachmentsTests(unittest.TestCase):
    """POST /roundtables with attachments — backend 读文件,拼进
    Session.question 喂给所有 派。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.uploads_dir = self.tmp_path / "roundtable-uploads"
        self.uploads_dir.mkdir()
        self.patches = [
            patch.object(config, "ROUNDTABLE_UPLOADS_DIR", self.uploads_dir),
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

    def _create_attachment(self, name: str, content: bytes) -> str:
        sub = self.uploads_dir / "abc123"
        sub.mkdir(exist_ok=True)
        path = sub / name
        path.write_bytes(content)
        return str(path)

    def _capture_submit(self, body):
        """跑 POST /roundtables,返回 mock 收到的 kwargs。"""
        captured = {}
        def _fake_submit(*args, **kwargs):
            captured["question_arg"] = args[0] if args else None
            captured.update(kwargs)
            return Path("/tmp/fake-session.jsonl")
        with patch("backend.main.roundtable_runner.submit", side_effect=_fake_submit):
            r = self.client.post("/roundtables", json=body)
        return r, captured

    def test_attachments_enriches_question(self):
        path = self._create_attachment("hello.md", b"# hi\n\ncontent here")
        r, captured = self._capture_submit(
            {"question": "看一下这个文件", "attachments": [path]},
        )
        self.assertEqual(r.status_code, 202, r.text)
        q = captured["question_arg"]
        self.assertIn("看一下这个文件", q)
        self.assertIn("参考文件:", q)
        self.assertIn("hello.md", q)
        self.assertIn("content here", q)

    def test_attachments_path_outside_uploads_rejected(self):
        evil = self.tmp_path / "evil.txt"
        evil.write_text("oops", encoding="utf-8")
        r, _ = self._capture_submit(
            {"question": "Q?", "attachments": [str(evil)]},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("outside", r.text)

    def test_attachments_binary_rejected(self):
        path = self._create_attachment("evil.bin", b"\xff\xfe\x00\x01")
        r, _ = self._capture_submit(
            {"question": "Q?", "attachments": [path]},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("utf8", r.text.lower())

    def test_attachments_total_over_100kb_413(self):
        p1 = self._create_attachment("a.txt", b"a" * (50 * 1024))
        p2 = self._create_attachment("b.txt", b"b" * (60 * 1024))
        r, _ = self._capture_submit(
            {"question": "Q?", "attachments": [p1, p2]},
        )
        self.assertEqual(r.status_code, 413, r.text)
        body = r.json()
        self.assertIn("b.txt", str(body))

    def test_empty_attachments_list_no_enrichment(self):
        r, captured = self._capture_submit(
            {"question": "Q?", "attachments": []},
        )
        self.assertEqual(r.status_code, 202)
        self.assertEqual(captured["question_arg"], "Q?")
        self.assertNotIn("参考文件", captured["question_arg"])


if __name__ == "__main__":
    unittest.main()
