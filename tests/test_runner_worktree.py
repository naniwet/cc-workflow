"""单测:`backend.runner.submit()` 在 worktree_mode=off 时把 session_key
压成 "default"。3 个 case 覆盖 off/auto/None。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import runner


class SubmitSquashesSessionKeyWhenWorktreeOff(unittest.TestCase):
    def _captured(self, mode, session_key):
        """跑一次 submit,返回 (db_row_session_key, thread_arg_session_key)。"""
        with patch.object(runner.db, "insert_queued_run") as q, \
             patch.object(runner.threading, "Thread") as th, \
             patch.object(runner.ws_settings, "worktree_mode_for", return_value=mode):
            runner.submit(
                run_id="r-1",
                workspace="ws",
                prompt="hi",
                engine="claude",
                session_key=session_key,
                source="pwa",
            )
            db_sk = q.call_args.kwargs["session_key"]
            # _execute 签名:(run_id, workspace, prompt, engine, session_key, ...)
            thread_sk = th.call_args.kwargs["args"][4]
            return db_sk, thread_sk

    def test_off_squashes_to_default(self):
        db_sk, thread_sk = self._captured("off", session_key="pwa-myws")
        self.assertEqual(db_sk, "default")
        self.assertEqual(thread_sk, "default")

    def test_auto_passes_through(self):
        db_sk, thread_sk = self._captured("auto", session_key="pwa-myws")
        self.assertEqual(db_sk, "pwa-myws")
        self.assertEqual(thread_sk, "pwa-myws")

    def test_off_with_none_session_key_stays_default(self):
        db_sk, thread_sk = self._captured("off", session_key=None)
        self.assertEqual(db_sk, "default")
        self.assertEqual(thread_sk, "default")


if __name__ == "__main__":
    unittest.main()
