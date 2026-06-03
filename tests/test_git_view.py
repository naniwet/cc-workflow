"""git_view 纯函数 unit —— 全部喂固定 git stdout 字符串,纯内存 < 10ms。

run_git 是 IO 边界不在此(spec §9)。这里只测 parse_* + resolve_* 纯逻辑。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import git_view


# ---------- Task 2: parse_log ----------

class TestParseLog(unittest.TestCase):
    """git log -n N --pretty=format:'%h%x00%s%x00%cr%x00%an' → 4 字段。

    NUL(\\x00)分隔,不用空格 split —— subject 含空格/中文不破。
    """

    def test_four_fields(self):
        text = "a4ac71d\x00fix bug\x002 hours ago\x00wet"
        self.assertEqual(
            git_view.parse_log(text),
            [{"sha": "a4ac71d", "subject": "fix bug",
              "rel_date": "2 hours ago", "author": "wet"}],
        )

    def test_subject_with_spaces(self):
        text = "abc1234\x00fix(pwa): align failed token globally\x005 minutes ago\x00wet"
        out = git_view.parse_log(text)
        self.assertEqual(out[0]["subject"], "fix(pwa): align failed token globally")

    def test_subject_chinese(self):
        text = "abc1234\x00fix(pwa): 全局对齐失效设计 token\x001 day ago\x00wet"
        out = git_view.parse_log(text)
        self.assertEqual(out[0]["subject"], "fix(pwa): 全局对齐失效设计 token")

    def test_multiple_lines(self):
        text = (
            "aaa1111\x00first\x001 hour ago\x00alice\n"
            "bbb2222\x00second\x002 hours ago\x00bob"
        )
        out = git_view.parse_log(text)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[1]["sha"], "bbb2222")

    def test_empty_returns_list(self):
        self.assertEqual(git_view.parse_log(""), [])


# ---------- Task 3: parse_numstat ----------

class TestParseNumstat(unittest.TestCase):
    """git diff --numstat → [{file, additions, deletions, binary}]。

    二进制行 -\\t-\\tfile → additions/deletions None + binary True。
    文件名取第 2 个 tab 后整段(含空格/中文不裂)。
    status 字母不在此函数(来自 name-status,handler 合并)。
    """

    def test_normal_row(self):
        text = "42\t7\tpwa/app.js"
        self.assertEqual(
            git_view.parse_numstat(text),
            [{"file": "pwa/app.js", "additions": 42, "deletions": 7, "binary": False}],
        )

    def test_binary_dash_dash(self):
        text = "-\t-\tassets/logo.png"
        out = git_view.parse_numstat(text)
        self.assertIsNone(out[0]["additions"])
        self.assertIsNone(out[0]["deletions"])
        self.assertTrue(out[0]["binary"])
        self.assertEqual(out[0]["file"], "assets/logo.png")

    def test_filename_with_spaces(self):
        text = "3\t1\tdocs/my notes file.md"
        out = git_view.parse_numstat(text)
        self.assertEqual(out[0]["file"], "docs/my notes file.md")

    def test_filename_chinese(self):
        text = "5\t0\tdocs/中文 文件.md"
        out = git_view.parse_numstat(text)
        self.assertEqual(out[0]["file"], "docs/中文 文件.md")

    def test_multiple_rows(self):
        text = "1\t2\ta.py\n3\t4\tb.py"
        out = git_view.parse_numstat(text)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[1]["additions"], 3)

    def test_empty(self):
        self.assertEqual(git_view.parse_numstat(""), [])


# ---------- Task 4: parse_rev_list_count(ahead/behind 取数,见 spec §3.4)----------

class TestParseRevListCount(unittest.TestCase):
    """git rev-list --left-right --count <base>...<branch> → (ahead, behind)。

    输出 `<behind>\\t<ahead>`(left=base 独有=behind,right=branch 独有=ahead)。
    这是 spec §3.2 schema 要的 branch-vs-base 关系(status -sb 给的是
    upstream 关系,本地 cc/* 分支没 upstream,故 ahead/behind 必须用 rev-list 算)。
    """

    def test_ahead_two_behind_zero(self):
        # branch 比 base 多 2 个 commit
        self.assertEqual(git_view.parse_rev_list_count("0\t2"), (2, 0))

    def test_diverged(self):
        self.assertEqual(git_view.parse_rev_list_count("3\t1"), (1, 3))

    def test_zero(self):
        self.assertEqual(git_view.parse_rev_list_count("0\t0"), (0, 0))

    def test_empty_or_garbage_returns_zero(self):
        # rev-list 失败(base 不存在等)→ 空串 → (0,0) 兜底
        self.assertEqual(git_view.parse_rev_list_count(""), (0, 0))


# ---------- Task 5: parse_status + parse_branch ----------

class TestParseStatus(unittest.TestCase):
    """git status --porcelain → {dirty}。任意行(含 ?? untracked)→ dirty。"""

    def test_dirty_with_modification(self):
        text = " M pwa/app.js"
        self.assertTrue(git_view.parse_status(text)["dirty"])

    def test_untracked_is_dirty(self):
        text = "?? newfile.txt"
        self.assertTrue(git_view.parse_status(text)["dirty"])

    def test_clean_empty(self):
        self.assertFalse(git_view.parse_status("")["dirty"])


class TestParseBranch(unittest.TestCase):
    """git status -sb 首行 → 分支名;detached → None。"""

    def test_normal_branch(self):
        self.assertEqual(
            git_view.parse_branch("## cc/myrepo-pwa-myrepo...main [ahead 1]"),
            "cc/myrepo-pwa-myrepo",
        )

    def test_branch_no_upstream(self):
        self.assertEqual(git_view.parse_branch("## main"), "main")

    def test_detached_returns_none(self):
        self.assertIsNone(git_view.parse_branch("## HEAD (no branch)"))

    def test_no_commits_yet_returns_none(self):
        # 空仓库(git init 后 0 commit)首行 = "## No commits yet on main"
        # —— "No" 不是分支名,须返回 None(同 detached 处理,spec §7)
        self.assertIsNone(git_view.parse_branch("## No commits yet on main"))


# ---------- Task 6: parse_worktree_list ----------

class TestParseWorktreeList(unittest.TestCase):
    """git worktree list --porcelain → [{path, branch, head_short}]。

    detached → branch None。head_short 取 7 位。is_current 不在此(handler 填)。
    """

    def test_multiple(self):
        text = (
            "worktree /home/u/workspaces/myrepo\n"
            "HEAD a4ac71deadbeef\n"
            "branch refs/heads/main\n"
            "\n"
            "worktree /home/u/workspaces/.wt/myrepo-pwa-myrepo\n"
            "HEAD bbb2222cafef00d\n"
            "branch refs/heads/cc/myrepo-pwa-myrepo\n"
        )
        out = git_view.parse_worktree_list(text)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["path"], "/home/u/workspaces/myrepo")
        self.assertEqual(out[0]["branch"], "main")
        self.assertEqual(out[0]["head_short"], "a4ac71d")
        self.assertEqual(out[1]["branch"], "cc/myrepo-pwa-myrepo")

    def test_detached_branch_null(self):
        text = (
            "worktree /home/u/workspaces/det\n"
            "HEAD ccc3333abcdef\n"
            "detached\n"
        )
        out = git_view.parse_worktree_list(text)
        self.assertIsNone(out[0]["branch"])

    def test_head_short_truncated(self):
        text = "worktree /p\nHEAD 1234567890abcdef\nbranch refs/heads/x\n"
        out = git_view.parse_worktree_list(text)
        self.assertEqual(out[0]["head_short"], "1234567")

    def test_empty(self):
        self.assertEqual(git_view.parse_worktree_list(""), [])


# ---------- Task 7: parse_unified_diff ----------

class TestParseUnifiedDiff(unittest.TestCase):
    """unified diff → {hunks:[{header, lines:[{kind,text}]}], truncated, binary}。"""

    def test_single_hunk_three_kinds(self):
        text = (
            "diff --git a/f.py b/f.py\n"
            "index 111..222 100644\n"
            "--- a/f.py\n"
            "+++ b/f.py\n"
            "@@ -1,3 +1,3 @@\n"
            " ctx line\n"
            "-old line\n"
            "+new line\n"
        )
        out = git_view.parse_unified_diff(text)
        self.assertFalse(out["binary"])
        self.assertFalse(out["truncated"])
        self.assertEqual(len(out["hunks"]), 1)
        h = out["hunks"][0]
        self.assertEqual(h["header"], "@@ -1,3 +1,3 @@")
        kinds = [ln["kind"] for ln in h["lines"]]
        self.assertEqual(kinds, ["ctx", "del", "add"])
        self.assertEqual(h["lines"][0]["text"], "ctx line")
        self.assertEqual(h["lines"][1]["text"], "old line")
        self.assertEqual(h["lines"][2]["text"], "new line")

    def test_multiple_hunks(self):
        text = (
            "@@ -1,1 +1,1 @@\n"
            "-a\n"
            "+b\n"
            "@@ -10,1 +10,1 @@\n"
            "-c\n"
            "+d\n"
        )
        out = git_view.parse_unified_diff(text)
        self.assertEqual(len(out["hunks"]), 2)
        self.assertEqual(out["hunks"][1]["header"], "@@ -10,1 +10,1 @@")

    def test_binary(self):
        text = "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n"
        out = git_view.parse_unified_diff(text)
        self.assertTrue(out["binary"])
        self.assertEqual(out["hunks"], [])

    def test_empty(self):
        out = git_view.parse_unified_diff("")
        self.assertEqual(out["hunks"], [])
        self.assertFalse(out["binary"])
        self.assertFalse(out["truncated"])

    def test_truncate_over_max(self):
        # 一个 hunk 里塞 >max_lines 条改动行 → truncated True
        body = "".join(f"+line {i}\n" for i in range(50))
        text = "@@ -1,1 +1,50 @@\n" + body
        out = git_view.parse_unified_diff(text, max_lines=10)
        self.assertTrue(out["truncated"])
        # 截断后保留的行数不超过 max_lines
        total = sum(len(h["lines"]) for h in out["hunks"])
        self.assertLessEqual(total, 10)


# ---------- Task 8: resolve_git_cwd + resolve_base ----------

class TestResolveGitCwd(unittest.TestCase):
    """spec §6 退化表:off/default → 主目录;auto+非default+worktree存在 → worktree;
    auto+非default+无worktree → 退化主目录 + warning。

    worktree 存在性做可注入参数(worktree_exists),纯函数不碰 filesystem。
    """

    def _main(self, ws):
        return Path("/ws") / ws

    def test_off_mode_main(self):
        cwd, kind, warnings = git_view.resolve_git_cwd(
            "myrepo", "pwa-myrepo", "off", worktree_exists=False,
            workspaces_dir=Path("/ws"),
        )
        self.assertEqual(cwd, Path("/ws/myrepo"))
        self.assertEqual(kind, "main")
        self.assertEqual(warnings, [])

    def test_auto_default_main(self):
        cwd, kind, warnings = git_view.resolve_git_cwd(
            "myrepo", "default", "auto", worktree_exists=False,
            workspaces_dir=Path("/ws"),
        )
        self.assertEqual(cwd, Path("/ws/myrepo"))
        self.assertEqual(kind, "main")
        self.assertEqual(warnings, [])

    def test_auto_nondefault_worktree(self):
        cwd, kind, warnings = git_view.resolve_git_cwd(
            "myrepo", "pwa-myrepo", "auto", worktree_exists=True,
            workspaces_dir=Path("/ws"),
        )
        self.assertEqual(cwd, Path("/ws/.wt/myrepo-pwa-myrepo"))
        self.assertEqual(kind, "worktree")
        self.assertEqual(warnings, [])

    def test_auto_nondefault_no_worktree_degrades(self):
        cwd, kind, warnings = git_view.resolve_git_cwd(
            "myrepo", "pwa-myrepo", "auto", worktree_exists=False,
            workspaces_dir=Path("/ws"),
        )
        self.assertEqual(cwd, Path("/ws/myrepo"))
        self.assertEqual(kind, "main")
        self.assertTrue(warnings)  # 有降级 warning

    def test_session_safe_in_worktree_path(self):
        # session_key 含空格 → 路径段用 safe(空格替 _)
        cwd, kind, _ = git_view.resolve_git_cwd(
            "myrepo", "daily report", "auto", worktree_exists=True,
            workspaces_dir=Path("/ws"),
        )
        self.assertEqual(cwd, Path("/ws/.wt/myrepo-daily_report"))


class TestResolveBase(unittest.TestCase):
    """resolve_base(run_git, main_dir) → head or "main"(复用 main.py:1095)。"""

    def test_head_returned(self):
        def fake(cwd, args, timeout=60):
            return (0, "master", "")
        self.assertEqual(git_view.resolve_base(fake, Path("/ws/r")), "master")

    def test_empty_head_falls_back_main(self):
        def fake(cwd, args, timeout=60):
            return (128, "", "fatal: ambiguous")
        self.assertEqual(git_view.resolve_base(fake, Path("/ws/r")), "main")


if __name__ == "__main__":
    unittest.main()
