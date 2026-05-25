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


if __name__ == "__main__":
    unittest.main()
