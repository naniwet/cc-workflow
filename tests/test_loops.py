import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import main


class LoopRunNowTests(unittest.TestCase):
    def test_run_now_links_new_run_to_loop_before_worker_finishes(self):
        calls = {"append": [], "submit": []}

        old_list_jobs = main.cron_state.list_jobs
        old_append = main.cron_state.append_recent_run_id
        old_new_run_id = main.db.new_run_id
        old_submit = main.runner.submit
        old_engine_for = main.ws_settings.engine_for
        old_provider_for = main.ws_settings.provider_for
        old_permission_mode_for = main.ws_settings.permission_mode_for
        old_trust_for = main.ws_settings.trust_for
        try:
            main.cron_state.list_jobs = lambda: [
                {
                    "name": "daily",
                    "workspace": "demo",
                    "prompt": "reply with current status",
                    "engine": "claude",
                }
            ]
            main.cron_state.append_recent_run_id = (
                lambda name, run_id: calls["append"].append((name, run_id))
            )
            main.db.new_run_id = lambda: "run123"
            main.runner.submit = lambda **kwargs: calls["submit"].append(kwargs)
            main.ws_settings.engine_for = lambda workspace: "claude"
            main.ws_settings.provider_for = lambda workspace: "anthropic"
            main.ws_settings.permission_mode_for = lambda workspace: "acceptEdits"
            main.ws_settings.trust_for = lambda workspace: False

            resp = main.run_loop_now("daily")

            self.assertEqual(resp["task_id"], "run123")
            self.assertEqual(calls["append"], [("daily", "run123")])
            self.assertEqual(calls["submit"][0]["run_id"], "run123")
        finally:
            main.cron_state.list_jobs = old_list_jobs
            main.cron_state.append_recent_run_id = old_append
            main.db.new_run_id = old_new_run_id
            main.runner.submit = old_submit
            main.ws_settings.engine_for = old_engine_for
            main.ws_settings.provider_for = old_provider_for
            main.ws_settings.permission_mode_for = old_permission_mode_for
            main.ws_settings.trust_for = old_trust_for


if __name__ == "__main__":
    unittest.main()
