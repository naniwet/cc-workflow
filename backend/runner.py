"""Run agent-run.sh in a background thread and persist outcome to runs.db.

Concurrency is owned by agent-run.sh's own flock-based 3-slot limit (P0-1
§4.1) — backend does not pool here. A 4th simultaneous /run request races
to acquire a slot, agent-run exits 65, and we record the run as failed
with exit_code=65 in the db.
"""
from __future__ import annotations

import os
import subprocess
import threading
from typing import Callable, Optional

from . import config, db

# Callback type: receives the finished run row (db.get_run result dict).
OnFinish = Callable[[dict], None]


def submit(
    *,
    run_id: str,
    workspace: str,
    prompt: str,
    engine: str,
    session_key: Optional[str],
    source: str,
    provider: Optional[str] = None,
    permission_mode: Optional[str] = None,
    on_finish: Optional[OnFinish] = None,
) -> None:
    db.insert_queued_run(
        run_id=run_id,
        workspace=workspace,
        engine=engine,
        session_key=session_key,
        prompt=prompt,
        source=source,
    )
    threading.Thread(
        target=_execute,
        args=(run_id, workspace, prompt, engine, session_key, source, provider, permission_mode, on_finish),
        name=f"agent-run-{run_id}",
        daemon=True,
    ).start()


def _execute(
    run_id: str,
    workspace: str,
    prompt: str,
    engine: str,
    session_key: Optional[str],
    source: str,
    provider: Optional[str],
    permission_mode: Optional[str],
    on_finish: Optional[OnFinish],
) -> None:
    db.set_running(run_id)
    argv = [str(config.AGENT_RUN), f"--engine={engine}", workspace, prompt]
    if session_key:
        argv.append(session_key)
    argv += ["--source", source]
    if provider:
        argv += ["--provider", provider]
    if permission_mode:
        argv += ["--permission-mode", permission_mode]
    # Pass run context to agent-run's environment so the claude
    # PreToolUse hook (cc-approve-hook.sh) can identify which run is
    # asking for approval. CCW_TRUST controls the hook's short-circuit
    # behavior: trusted workspaces skip the human-approval round-trip.
    env = os.environ.copy()
    env["CCW_RUN_ID"] = run_id
    env["CCW_WORKSPACE"] = workspace
    env["CCW_TRUST"] = "true" if permission_mode == "bypassPermissions" else "false"
    try:
        # No outer timeout: agent-run.sh enforces its own 10-min wall (exit 68).
        proc = subprocess.run(argv, capture_output=True, text=True, check=False, env=env)
        output = proc.stdout
        if proc.returncode != 0:
            # stderr carries the actionable reason (e.g. exit 67 push-main,
            # exit 65 concurrency) — preserve it for /runs/{id} consumers.
            tail = (proc.stderr or "").strip()
            output = (output + ("\n\n[stderr]\n" + tail if tail else "")).strip()
        db.finish_run(run_id=run_id, exit_code=proc.returncode, output=output)
    except FileNotFoundError as e:
        db.finish_run(
            run_id=run_id, exit_code=-1, output=f"agent-run not found: {e}"
        )
    except Exception as e:  # last-ditch: never leave a row stuck in 'running'
        db.finish_run(
            run_id=run_id, exit_code=-1, output=f"runner crashed: {e!r}"
        )

    # Fire-and-forget hook so e.g. Feishu adapter can reply once the run
    # completes. We swallow exceptions — a broken callback must not crash
    # the runner thread.
    if on_finish is not None:
        try:
            row = db.get_run(run_id)
            if row:
                on_finish(row)
        except Exception:  # noqa: BLE001 — intentional broad catch
            pass
