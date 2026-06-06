"""file_download.resolve_download_target —— 路径解析 + 安全校验。

安全是核心:traversal / symlink 越权 / 绝对越界都必须挡掉。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import file_download as fd


class ResolveDownloadTargetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # 模拟 ~/workspaces 布局:
        #   <root>/myws/                  (ws 主目录)
        #   <root>/.wt/myws-feat/         (一个 worktree)
        #   <root>/outside/secret.txt     (ws 树外,不该被下到)
        self.ws_root = self.root / "myws"
        self.ws_root.mkdir()
        (self.ws_root / "doc.md").write_text("hello doc", encoding="utf-8")
        (self.ws_root / "sub").mkdir()
        (self.ws_root / "sub" / "nested.txt").write_text("n", encoding="utf-8")

        self.wt = self.root / ".wt" / "myws-feat"
        self.wt.mkdir(parents=True)
        (self.wt / "wtfile.md").write_text("from worktree", encoding="utf-8")

        self.outside = self.root / "outside"
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("SECRET", encoding="utf-8")

        self.worktrees = [self.wt]

    def tearDown(self):
        self.tmp.cleanup()

    def _resolve(self, requested):
        return fd.resolve_download_target(self.ws_root, self.worktrees, requested)

    # ---- 正常 ----
    def test_relative_path_in_ws_root(self):
        t = self._resolve("doc.md")
        self.assertEqual(t, (self.ws_root / "doc.md").resolve())

    def test_relative_nested_path(self):
        t = self._resolve("sub/nested.txt")
        self.assertEqual(t, (self.ws_root / "sub" / "nested.txt").resolve())

    def test_relative_path_in_worktree(self):
        # 相对路径在主目录找不到 → 落到 worktree
        t = self._resolve("wtfile.md")
        self.assertEqual(t, (self.wt / "wtfile.md").resolve())

    def test_absolute_path_in_ws_root(self):
        abs_p = str((self.ws_root / "doc.md").resolve())
        self.assertEqual(self._resolve(abs_p), (self.ws_root / "doc.md").resolve())

    def test_absolute_path_in_worktree(self):
        abs_p = str((self.wt / "wtfile.md").resolve())
        self.assertEqual(self._resolve(abs_p), (self.wt / "wtfile.md").resolve())

    # ---- 安全:必须挡掉 ----
    def test_traversal_relative_escape_blocked(self):
        self.assertIsNone(self._resolve("../outside/secret.txt"))

    def test_absolute_outside_tree_blocked(self):
        self.assertIsNone(self._resolve(str((self.outside / "secret.txt").resolve())))
        self.assertIsNone(self._resolve("/etc/passwd"))

    def test_symlink_escape_blocked(self):
        # ws 内放一个指向树外 secret 的 symlink → realpath 越权 → 挡掉
        link = self.ws_root / "evil-link"
        try:
            os.symlink(self.outside / "secret.txt", link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink not supported")
        self.assertIsNone(self._resolve("evil-link"))
        self.assertIsNone(self._resolve(str(link)))

    def test_directory_not_a_file(self):
        self.assertIsNone(self._resolve("sub"))      # 目录不给下

    def test_missing_file(self):
        self.assertIsNone(self._resolve("nope.md"))

    def test_empty_or_none(self):
        self.assertIsNone(self._resolve(""))
        self.assertIsNone(self._resolve(None))
        self.assertIsNone(self._resolve("   "))


class ListWorktreeDirsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_wt_dir(self):
        self.assertEqual(fd.list_worktree_dirs(self.root, "myws"), [])

    def test_globs_ws_worktrees(self):
        (self.root / ".wt" / "myws-a").mkdir(parents=True)
        (self.root / ".wt" / "myws-b").mkdir(parents=True)
        (self.root / ".wt" / "other-x").mkdir(parents=True)
        got = {p.name for p in fd.list_worktree_dirs(self.root, "myws")}
        self.assertEqual(got, {"myws-a", "myws-b"})


if __name__ == "__main__":
    unittest.main()
