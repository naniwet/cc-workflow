"""Integration:GET /workspaces/{ws}/git + /git/diff 两个只读 git 端点。

用 tmp_path 建真 git repo(真 git init + commit,mac 有 git 能跑),
打端点断言 spec §3.2 schema + 边缘降级。沙箱:WORKSPACES_DIR 重定到 tmp,
worktree_mode 走 ws_settings._PATH 重定。
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from backend import main, config, auth, ws_settings


def _git(cwd, *args):
    """测试辅助:在 cwd 跑 git,失败抛(测试自己 setup 用)。"""
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True, capture_output=True, text=True,
    )


class GitEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ws_dir = self.root / "workspaces"
        self.ws_dir.mkdir()
        self.cfg_file = self.root / "workspaces.json"

        self.patches = [
            patch.object(config, "WORKSPACES_DIR", self.ws_dir),
            patch.object(ws_settings, "_PATH", self.cfg_file),
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

    # ---------- helpers ----------

    def _init_repo(self, name, *, commits=1):
        """建一个真 git repo,默认分支 main + N 个 commit。"""
        repo = self.ws_dir / name
        repo.mkdir()
        _git(repo, "init", "-b", "main")
        _git(repo, "config", "user.email", "t@t.com")
        _git(repo, "config", "user.name", "tester")
        for i in range(commits):
            (repo / f"file{i}.txt").write_text(f"content {i}\n", encoding="utf-8")
            _git(repo, "add", ".")
            _git(repo, "commit", "-m", f"commit {i}")
        return repo

    # ---------- GET /workspaces/{ws}/git ----------

    def test_unknown_workspace_404(self):
        r = self.client.get("/workspaces/nope/git")
        self.assertEqual(r.status_code, 404)

    def test_git_overview_schema(self):
        self._init_repo("myrepo", commits=2)
        r = self.client.get("/workspaces/myrepo/git?session=default")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        # spec §3.2 逐字段在
        for field in (
            "is_git_repo", "branch", "head_short", "base", "ahead", "behind",
            "dirty", "session", "cwd_kind", "recent_commits", "diff_stat",
            "diff_truncated", "worktrees", "warnings",
        ):
            self.assertIn(field, body, f"missing field {field}")
        self.assertTrue(body["is_git_repo"])
        self.assertEqual(body["branch"], "main")
        self.assertEqual(body["base"], "main")
        self.assertEqual(body["session"], "default")
        self.assertEqual(body["cwd_kind"], "main")
        self.assertIsInstance(body["recent_commits"], list)
        self.assertEqual(len(body["recent_commits"]), 2)
        self.assertIn("subject", body["recent_commits"][0])
        self.assertFalse(body["dirty"])

    def test_build_overview_non_git_degrades(self):
        # 注意:这条不打 HTTP 端点 —— 端点入口被 _discover_workspaces 白名单
        # 挡住(非 git 目录不在白名单 → 404,spec §7)。这里直调 handler,
        # 验证 build_git_overview 对 run_git rc!=0(非 git 目录)的降级:
        # 返回 {is_git_repo: false},不抛 500。
        from backend import git_view
        empty = self.root / "empty"
        empty.mkdir()
        ov = git_view.build_git_overview(
            git_view.run_git, "empty", "default", empty, "main", "main",
        )
        self.assertFalse(ov["is_git_repo"])
        self.assertEqual(ov["session"], "default")

    def test_empty_repo_no_commits(self):
        repo = self.ws_dir / "fresh"
        repo.mkdir()
        _git(repo, "init", "-b", "main")
        _git(repo, "config", "user.email", "t@t.com")
        _git(repo, "config", "user.name", "tester")
        r = self.client.get("/workspaces/fresh/git?session=default")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["is_git_repo"])
        self.assertEqual(body["recent_commits"], [])
        # spec §7:0 commit → branch=null + warning + head_short=null
        # ("## No commits yet on main" 不是分支名,parse_branch 须识别)
        self.assertIsNone(body["branch"])
        self.assertIsNone(body["head_short"])
        self.assertTrue(body["warnings"])

    def test_dirty_flag(self):
        repo = self._init_repo("dirtyrepo", commits=1)
        (repo / "file0.txt").write_text("modified\n", encoding="utf-8")
        r = self.client.get("/workspaces/dirtyrepo/git?session=default")
        self.assertTrue(r.json()["dirty"])

    def test_worktree_net_contribution(self):
        """auto 模式 + 真 session worktree + cc 分支:三点 base...branch 净贡献。

        spec §3.4 核心:cwd_kind=worktree、ahead 计数、diff_stat 只含 session
        自己加的改动(不含 base 噪声)。
        """
        repo = self._init_repo("wtrepo", commits=1)
        # 建 session worktree(命名同 agent-run.sh:376 / merge endpoint)
        session = "pwa-wtrepo"
        wt = self.ws_dir / ".wt" / f"wtrepo-{session}"
        wt.parent.mkdir(parents=True, exist_ok=True)
        _git(repo, "worktree", "add", "-b", f"cc/wtrepo-{session}", str(wt))
        # 在 worktree 的 cc 分支上提交一个新文件(= 这一会儿的净贡献)
        (wt / "feature.py").write_text("print('hello')\n", encoding="utf-8")
        _git(wt, "config", "user.email", "t@t.com")
        _git(wt, "config", "user.name", "tester")
        _git(wt, "add", ".")
        _git(wt, "commit", "-m", "add feature")
        r = self.client.get(f"/workspaces/wtrepo/git?session={session}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["cwd_kind"], "worktree")
        self.assertEqual(body["branch"], f"cc/wtrepo-{session}")
        self.assertEqual(body["base"], "main")
        self.assertEqual(body["ahead"], 1)
        self.assertEqual(body["behind"], 0)
        files = {d["file"] for d in body["diff_stat"]}
        self.assertEqual(files, {"feature.py"})  # 只含净贡献,不含 base 的 file0.txt
        # status 字母合并(新增 → A)
        feat = next(d for d in body["diff_stat"] if d["file"] == "feature.py")
        self.assertEqual(feat["status"], "A")
        # 当前 worktree 在列表里且 is_current=True
        cur = [w for w in body["worktrees"] if w["is_current"]]
        self.assertEqual(len(cur), 1)
        self.assertEqual(cur[0]["branch"], f"cc/wtrepo-{session}")

    def test_off_mode_degrades(self):
        """off 模式:session 压成 main 目录,diff_stat 走工作区 diff(git diff HEAD)。"""
        repo = self._init_repo("notes", commits=1)
        # 标 worktree_mode=off
        import json
        self.cfg_file.write_text(json.dumps({"notes": {"worktree_mode": "off"}}), encoding="utf-8")
        # 改工作区(未 commit)
        (repo / "file0.txt").write_text("dirty change\n", encoding="utf-8")
        r = self.client.get("/workspaces/notes/git?session=pwa-notes")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["cwd_kind"], "main")
        self.assertEqual(body["ahead"], 0)
        self.assertEqual(body["behind"], 0)
        # off 退化:diff_stat 走工作区 diff,应能看到改动文件
        files = {d["file"] for d in body["diff_stat"]}
        self.assertIn("file0.txt", files)

    # ---------- GET /workspaces/{ws}/git/diff ----------

    def test_file_diff_hunks(self):
        repo = self._init_repo("diffrepo", commits=1)
        # 改文件并 commit(让它进 HEAD vs base 的 diff)—— 这里用 uncommitted
        # 路径更直接:改工作区不 commit,uncommitted=1 拉 git diff HEAD。
        (repo / "file0.txt").write_text("line A\nline B\nline C\n", encoding="utf-8")
        r = self.client.get(
            "/workspaces/diffrepo/git/diff?session=default&file=file0.txt&uncommitted=1"
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["file"], "file0.txt")
        self.assertFalse(body["binary"])
        self.assertGreaterEqual(len(body["hunks"]), 1)
        kinds = {ln["kind"] for h in body["hunks"] for ln in h["lines"]}
        self.assertTrue(kinds & {"add", "del", "ctx"})

    def test_path_traversal_rejected(self):
        self._init_repo("safe", commits=1)
        r = self.client.get(
            "/workspaces/safe/git/diff?session=default&file=../etc/passwd"
        )
        self.assertEqual(r.status_code, 400)

    def test_absolute_path_rejected(self):
        self._init_repo("safe2", commits=1)
        r = self.client.get(
            "/workspaces/safe2/git/diff?session=default&file=/etc/passwd"
        )
        self.assertEqual(r.status_code, 400)

    def test_uncommitted_flag(self):
        repo = self._init_repo("uncrepo", commits=1)
        (repo / "file0.txt").write_text("changed in worktree\n", encoding="utf-8")
        r = self.client.get(
            "/workspaces/uncrepo/git/diff?session=default&file=file0.txt&uncommitted=1"
        )
        self.assertEqual(r.status_code, 200, r.text)
        # 工作区改动能拉到 hunk
        self.assertGreaterEqual(len(r.json()["hunks"]), 1)


if __name__ == "__main__":
    unittest.main()
