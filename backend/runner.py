"""Run agent-run.sh in a background thread and persist outcome to runs.db.

Concurrency is owned by agent-run.sh's own flock-based 3-slot limit (P0-1
§4.1) — backend does not pool here. A 4th simultaneous /run request races
to acquire a slot, agent-run exits 65, and we record the run as failed
with exit_code=65 in the db.
"""
from __future__ import annotations

import subprocess
import threading
from typing import Optional

from . import config, db


def submit(
    *,
    run_id: str,
    workspace: str,
    prompt: str,
    engine: str,
    session_key: Optional[str],
    source: str,
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
        args=(run_id, workspace, prompt, engine, session_key, source),
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
) -> None:
    db.set_running(run_id)
    argv = [str(config.AGENT_RUN), f"--engine={engine}", workspace, prompt]
    if session_key:
        argv.append(session_key)
    argv += ["--source", source]
    try:
        # No outer timeout: agent-run.sh enforces its own 10-min wall (exit 68).
        proc = subprocess.run(argv, capture_output=True, text=True, check=False)
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
