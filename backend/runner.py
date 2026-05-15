"""Run agent-run.sh in a background thread and persist outcome to runs.db.

Concurrency is owned by agent-run.sh's own flock-based 3-slot limit (P0-1
§4.1) — backend does not pool here. A 4th simultaneous /run request races
to acquire a slot, agent-run exits 65, and we record the run as failed
with exit_code=65 in the db.

Cancellation (2026-05-15): backend keeps a {run_id → Popen} map of every
live subprocess so POST /runs/{id}/cancel can reach in and SIGTERM the
process group. The subprocess is spawned via start_new_session=True so
the resulting PGID equals the PID — that way `killpg(pid, SIGTERM)`
takes down the whole tree (agent-run shell + the subshell it forks +
claude + every tool subprocess claude has spawned). agent-run's EXIT
trap then releases the slot flock as the bash dies, so the slot pool
naturally frees up.
"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
from typing import Callable, Optional

from . import config, db

# Callback type: receives the finished run row (db.get_run result dict).
OnFinish = Callable[[dict], None]

# In-memory registry of live subprocesses. Keyed by run_id, value is the
# Popen instance. Used by cancel() to SIGTERM and by status queries. Not
# persisted — backend restart already implies every prior subprocess is
# gone (systemd KillMode=control-group), and main._reap_orphan_runs
# updates runs.db accordingly.
_active_procs: "dict[str, subprocess.Popen]" = {}
_active_procs_lock = threading.Lock()


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
    trust: bool = False,
    job_name: Optional[str] = None,
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
        args=(run_id, workspace, prompt, engine, session_key, source, provider, permission_mode, trust, job_name, on_finish),
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
    trust: bool,
    job_name: Optional[str],
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
    # Pass --job-name when the caller is a cron-trigger or PWA "Run now"
    # for an existing loop — agent-run uses this to update
    # ~/.cc-state/jobs/<name>.json (last_run_at / last_exit / etc).
    # Backend's on_finish callback adds last_run_id on top via
    # cron_state.update_job_fields (disjoint fields, no race).
    if job_name:
        argv += ["--job-name", job_name]
    # Pass run context to agent-run's environment so the claude
    # PreToolUse hook (cc-approve-hook.sh) can identify which run is
    # asking for approval. CCW_TRUST controls the hook's short-circuit
    # behavior: trusted workspaces skip the human-approval round-trip.
    env = os.environ.copy()
    env["CCW_RUN_ID"] = run_id
    env["CCW_WORKSPACE"] = workspace
    # CCW_TRUST signals the PreToolUse hook to short-circuit (auto-approve
    # Bash/WebFetch without round-tripping through the backend approval
    # queue + PWA). Used to derive this from permission_mode == 'bypassPermissions',
    # but we don't pass bypassPermissions to claude any more (it refuses
    # root). Now trust travels through this env var only, and claude
    # itself runs with --permission-mode acceptEdits regardless.
    env["CCW_TRUST"] = "true" if trust else "false"
    try:
        # Popen + new session: lets cancel() kill the whole process group
        # in one syscall (claude + tool subprocesses + bash subshells).
        # No outer timeout — long tasks are explicitly supported now
        # (agent-run's own wall timeout was removed 2026-05-14).
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=True,
        )
        with _active_procs_lock:
            _active_procs[run_id] = proc
        try:
            stdout, stderr = proc.communicate()
        finally:
            with _active_procs_lock:
                _active_procs.pop(run_id, None)
        output = stdout or ""
        if proc.returncode != 0:
            # stderr carries the actionable reason (e.g. exit 67 push-main,
            # exit 65 concurrency) — preserve it for /runs/{id} consumers.
            # SIGTERM from cancel() shows up as a negative return code on
            # Linux (e.g. -15); db.finish_run handles that fine.
            tail = (stderr or "").strip()
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


def cancel(run_id: str) -> dict:
    """SIGTERM the subprocess for `run_id`. Returns a status dict for the
    caller to surface to the user.

    {ok: True, pid, msg}                — signal sent; _execute's wait will
                                          finish shortly and write runs.db
    {ok: False, code: 'not_active', ...} — no live process (already done,
                                          or never started)
    {ok: False, code: 'kill_failed', ...} — kernel rejected the kill
                                          (gone between lookup and signal,
                                          or permission issue)

    Idempotent: a second cancel after the first races _execute's cleanup
    and falls through to 'not_active'.
    """
    with _active_procs_lock:
        proc = _active_procs.get(run_id)
    if proc is None or proc.poll() is not None:
        return {"ok": False, "code": "not_active", "msg": "no live process for this run"}
    try:
        # killpg → entire process group, not just the bash shell. The
        # bash subshell agent-run forks for `( claude -p ... )`, claude
        # itself, and any tool subprocesses (vitest, npm, etc.) are all
        # in the same session because we set start_new_session=True at
        # spawn — killpg(pid) reaches all of them.
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        return {"ok": True, "pid": proc.pid, "msg": f"SIGTERM sent to pgid={proc.pid}"}
    except (ProcessLookupError, PermissionError) as e:
        return {"ok": False, "code": "kill_failed", "msg": f"{type(e).__name__}: {e}"}
