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
from collections.abc import Callable
from pathlib import Path
from typing import Optional

from .. import config
from . import roles as roles_mod
from .debate import run_session, continue_session
from .io import session_path_for, write_error_marker, write_meta
from .model import ModelError, call_model
from .data import Session


OnCompleteFn = Callable[[Path], None]
"""Callback signature: receives the session jsonl path. Fired EXACTLY ONCE
per submit() call, regardless of success/failure — the caller is expected
to re-read the jsonl to decide what happened (look for type='synth' = done,
role='__error__' = failed). Kept narrow so we don't leak Session internals
to subscribers (e.g. the Feishu adapter)."""


def submit(
    question: str,
    *,
    role_models: dict[str, str] | None = None,
    critique_rounds: int = 1,
    on_complete: Optional[OnCompleteFn] = None,
) -> Path:
    """Kick off a roundtable session in a background thread.

    role_models: optional per-role model override. Map role name → model
    name. Caller (main.py) is responsible for validating against
    MODEL_ENDPOINTS — we just pass through.

    critique_rounds: 1 (default) or 2. See debate.run_session docstring.
    Caller is responsible for clamping — we just pass through.

    on_complete: optional callback fired when the worker thread finishes
    (success or failure). Receives the session_path.

    NB: callbacks DON'T survive backend restart. If the worker thread is
    killed mid-debate, no callback fires. jsonl is still the source of
    truth — callback is just opportunistic push.

    Returns the session_path. Caller can derive the id via path.stem.
    """
    started_at = time.time()
    sessions_dir = config.ROUNDTABLES_DIR
    sessions_dir.mkdir(parents=True, exist_ok=True)
    path = session_path_for(question, started_at, sessions_dir)
    # Write meta synchronously so GET /roundtables/{id} can find the row
    # immediately, before the worker thread has progressed at all.
    write_meta(path, Session(
        question=question,
        started_at=started_at,
        critique_rounds=critique_rounds,
    ))

    t = threading.Thread(
        target=_execute,
        args=(question, path, dict(role_models or {}), critique_rounds, on_complete),
        name=f"roundtable-{path.stem}",
        daemon=True,
    )
    t.start()
    return path


def _execute(
    question: str,
    session_path: Path,
    role_models: dict[str, str],
    critique_rounds: int,
    on_complete: Optional[OnCompleteFn],
) -> None:
    """Run the debate end-to-end. Any error is written to the session
    jsonl as a synthetic __error__ turn so the PWA can show it.

    on_complete fires in a `finally` — so subscribers see both happy and
    sad paths, and a broken callback can't poison the next session (we
    swallow its exceptions: it's an opportunistic push, failures shouldn't
    cascade)."""
    try:
        run_session(
            question=question,
            roles=roles_mod.ROLES,
            synthesizer=roles_mod.SYNTHESIZER,
            model_fn=call_model,
            session_path=session_path,
            role_model_overrides=role_models,
            critique_rounds=critique_rounds,
        )
    except ModelError as e:
        # Expected failure mode (provider down, rate limit exhausted,
        # placeholder API key, etc.). Surface to the user via the jsonl.
        write_error_marker(session_path, f"model error: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001 — last-ditch, never lose the error
        write_error_marker(session_path, f"unexpected: {type(e).__name__}: {e}")
    finally:
        if on_complete is not None:
            try:
                on_complete(session_path)
            except Exception:    # noqa: BLE001 — broken callback must not poison the thread
                pass


def submit_continue(
    session_path: Path,
    follow_up_question: str,
    *,
    role_models: dict[str, str] | None = None,
    on_complete: Optional[OnCompleteFn] = None,
) -> None:
    """跟 submit 同模式 — 在 background thread 里跑 continue_session。"""
    t = threading.Thread(
        target=_execute_continue,
        args=(session_path, follow_up_question, dict(role_models or {}), on_complete),
        name=f"roundtable-continue-{session_path.stem}",
        daemon=True,
    )
    t.start()


def _execute_continue(
    session_path: Path,
    follow_up_question: str,
    role_models: dict[str, str],
    on_complete: Optional[OnCompleteFn],
) -> None:
    """在 background thread 里跑 continue_session。错误写入 jsonl 的 __error__ turn。"""
    try:
        continue_session(
            session_path=session_path,
            follow_up_question=follow_up_question,
            roles=roles_mod.ROLES,
            synthesizer=roles_mod.SYNTHESIZER,
            model_fn=call_model,
            role_model_overrides=role_models,
        )
    except ModelError as e:
        write_error_marker(session_path, f"model error during continue: {type(e).__name__}: {e}")
    except Exception as e:    # noqa: BLE001
        write_error_marker(session_path, f"unexpected during continue: {type(e).__name__}: {e}")
    finally:
        if on_complete is not None:
            try:
                on_complete(session_path)
            except Exception:  # noqa: BLE001
                pass
