"""Background-thread launcher for roundtable sessions.

Why in-process thread (not subprocess like agent-run.sh):
  - Roundtable is pure HTTP egress to LLM endpoints, no shell side effects,
    no need for the process isolation agent-run.sh provides.
  - 9 LLM calls × ~5-15s each = 45-135s typical. Threads are fine for this
    duration; FastAPI's other endpoints stay responsive (the HTTP calls
    release the GIL while waiting on the network).
  - Persistence is incremental (append_turn after every call), so even if
    the thread is killed mid-session, the jsonl up to the last completed
    turn is still valid and readable.

The PWA polls GET /roundtables/{id} every ~2s to show progress.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from .. import config
from . import roles as roles_mod
from .debate import run_session
from .io import session_path_for, write_error_marker, write_meta
from .model import ModelError, call_model
from .data import Session


def submit(question: str) -> Path:
    """Kick off a roundtable session in a background thread.

    Synchronously:
      - Compute the session_path (used as the public session id)
      - Write the meta line so GET /roundtables/{id} works immediately
      - Spawn the worker thread

    Returns the session_path. Caller can derive the id via path.stem.
    """
    started_at = time.time()
    sessions_dir = config.ROUNDTABLES_DIR
    sessions_dir.mkdir(parents=True, exist_ok=True)
    path = session_path_for(question, started_at, sessions_dir)
    # Write meta synchronously so GET /roundtables/{id} can find the row
    # immediately, before the worker thread has progressed at all.
    write_meta(path, Session(question=question, started_at=started_at))

    t = threading.Thread(
        target=_execute,
        args=(question, path),
        name=f"roundtable-{path.stem}",
        daemon=True,
    )
    t.start()
    return path


def _execute(question: str, session_path: Path) -> None:
    """Run the 3-round debate end-to-end. Any error is written to the
    session jsonl as a synthetic __error__ turn so the PWA can show it."""
    try:
        run_session(
            question=question,
            roles=roles_mod.ROLES,
            synthesizer=roles_mod.SYNTHESIZER,
            model_fn=call_model,
            session_path=session_path,
        )
    except ModelError as e:
        # Expected failure mode (provider down, rate limit exhausted,
        # placeholder API key, etc.). Surface to the user via the jsonl.
        write_error_marker(session_path, f"model error: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001 — last-ditch, never lose the error
        write_error_marker(session_path, f"unexpected: {type(e).__name__}: {e}")
