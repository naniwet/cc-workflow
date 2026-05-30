"""多 session per workspace —— GET /workspaces/{ws}/sessions 列同一 repo 的
所有并行工作线(session_key),各自 run 数 / 最近活动 / 有无 worktree。

session_key 命名(spec α):
- 默认 session 保留 `pwa-<ws>`(老 run 历史不动)
- 用户新建额外 session = `<ws>--<name>`(双横线分隔防撞)

backend 数据层早就 session_key-aware(runs.db.runs 有 session_key 列),
这个 feature 主要补:① 按 session 分组的读 endpoint ② PWA UI。
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config, db


class ListSessionsForWorkspaceTests(unittest.TestCase):
    """db.list_sessions_for_workspace —— distinct session_key + 聚合元数据。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "runs.db"
        self.p = patch.object(config, "RUNS_DB", self.db_path)
        self.p.start()
        db.init()

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()

    def _seed_run(self, *, ws, session_key, run_id, started_at, status="done"):
        db.insert_queued_run(
            run_id=run_id, workspace=ws, engine="claude",
            session_key=session_key, prompt="p", source="pwa",
        )
        # 手动改 started_at + status(insert 用 now,测试要控时间排序)
        with db._conn() as c:
            c.execute(
                "UPDATE runs SET started_at=?, status=? WHERE id=?",
                (started_at, status, run_id),
            )

    def test_empty_workspace_returns_no_sessions(self):
        self.assertEqual(db.list_sessions_for_workspace("myrepo"), [])

    def test_groups_runs_by_session_key(self):
        self._seed_run(ws="myrepo", session_key="pwa-myrepo", run_id="r1", started_at=100)
        self._seed_run(ws="myrepo", session_key="pwa-myrepo", run_id="r2", started_at=200)
        self._seed_run(ws="myrepo", session_key="myrepo--fix-bug", run_id="r3", started_at=150)
        sessions = db.list_sessions_for_workspace("myrepo")
        keys = {s["session_key"] for s in sessions}
        self.assertEqual(keys, {"pwa-myrepo", "myrepo--fix-bug"})

    def test_run_count_and_last_activity_per_session(self):
        self._seed_run(ws="myrepo", session_key="pwa-myrepo", run_id="r1", started_at=100)
        self._seed_run(ws="myrepo", session_key="pwa-myrepo", run_id="r2", started_at=200)
        sessions = db.list_sessions_for_workspace("myrepo")
        s = next(x for x in sessions if x["session_key"] == "pwa-myrepo")
        self.assertEqual(s["run_count"], 2)
        self.assertEqual(s["last_started_at"], 200)

    def test_ordered_by_last_activity_desc(self):
        self._seed_run(ws="myrepo", session_key="old", run_id="r1", started_at=100)
        self._seed_run(ws="myrepo", session_key="new", run_id="r2", started_at=300)
        self._seed_run(ws="myrepo", session_key="mid", run_id="r3", started_at=200)
        keys = [s["session_key"] for s in db.list_sessions_for_workspace("myrepo")]
        self.assertEqual(keys, ["new", "mid", "old"])

    def test_other_workspace_runs_excluded(self):
        self._seed_run(ws="myrepo", session_key="pwa-myrepo", run_id="r1", started_at=100)
        self._seed_run(ws="other", session_key="pwa-other", run_id="r2", started_at=100)
        sessions = db.list_sessions_for_workspace("myrepo")
        self.assertEqual([s["session_key"] for s in sessions], ["pwa-myrepo"])

    def test_last_status_reflects_most_recent_run(self):
        self._seed_run(ws="myrepo", session_key="s", run_id="r1", started_at=100, status="done")
        self._seed_run(ws="myrepo", session_key="s", run_id="r2", started_at=200, status="running")
        s = db.list_sessions_for_workspace("myrepo")[0]
        self.assertEqual(s["last_status"], "running")


class SessionsEndpointTests(unittest.TestCase):
    """GET /workspaces/{ws}/sessions —— db 聚合 + worktree 探测 + worktree_mode。"""

    def setUp(self):
        from fastapi.testclient import TestClient
        from backend import main, auth, ws_settings
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db_path = self.root / "runs.db"
        self.ws_dir = self.root / "workspaces"
        (self.ws_dir / "myrepo").mkdir(parents=True)
        self.patches = [
            patch.object(config, "RUNS_DB", self.db_path),
            patch.object(config, "WORKSPACES_DIR", self.ws_dir),
        ]
        for p in self.patches:
            p.start()
        db.init()
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        self.client = TestClient(main.app)

    def tearDown(self):
        from backend import main
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _seed(self, ws, key, run_id, started=100):
        db.insert_queued_run(run_id=run_id, workspace=ws, engine="claude",
                             session_key=key, prompt="p", source="pwa")
        with db._conn() as c:
            c.execute("UPDATE runs SET started_at=? WHERE id=?", (started, run_id))

    def test_unknown_workspace_404(self):
        r = self.client.get("/workspaces/nope/sessions")
        self.assertEqual(r.status_code, 404)

    def test_lists_sessions_with_default_flag(self):
        self._seed("myrepo", "pwa-myrepo", "r1")
        self._seed("myrepo", "myrepo--fix-bug", "r2")
        r = self.client.get("/workspaces/myrepo/sessions")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        by_key = {s["session_key"]: s for s in body["sessions"]}
        self.assertTrue(by_key["pwa-myrepo"]["is_default"])
        self.assertFalse(by_key["myrepo--fix-bug"]["is_default"])

    def test_worktree_detection(self):
        self._seed("myrepo", "myrepo--fix-bug", "r1")
        # 不建 worktree 目录 → has_worktree=False
        r = self.client.get("/workspaces/myrepo/sessions")
        s = next(x for x in r.json()["sessions"] if x["session_key"] == "myrepo--fix-bug")
        self.assertFalse(s["has_worktree"])
        # 建 .wt/myrepo-myrepo--fix-bug/ → has_worktree=True
        (self.ws_dir / ".wt" / "myrepo-myrepo--fix-bug").mkdir(parents=True)
        r2 = self.client.get("/workspaces/myrepo/sessions")
        s2 = next(x for x in r2.json()["sessions"] if x["session_key"] == "myrepo--fix-bug")
        self.assertTrue(s2["has_worktree"])

    def test_response_carries_worktree_mode(self):
        """PWA 用 worktree_mode 决定要不要显示多 session UI(off 时无意义)。"""
        self._seed("myrepo", "pwa-myrepo", "r1")
        r = self.client.get("/workspaces/myrepo/sessions")
        self.assertIn("worktree_mode", r.json())


if __name__ == "__main__":
    unittest.main()
