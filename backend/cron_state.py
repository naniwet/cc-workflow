"""Cron job state — read/write ~/.cc-state/jobs/<name>.json + /etc/cron.d/cc-loops.

Read/toggle helpers (Phase 1):
  - list_jobs() / get_job() / set_enabled()    jobs/<name>.json
Cron-file writers (Phase 2 — P0-6c add/delete):
  - add_cron_loop()    append a marker-bounded entry to /etc/cron.d/cc-loops,
                        initialize jobs/<name>.json
  - remove_cron_loop() strip the marker block, delete jobs/<name>.json

Marker convention (per-entry, easy to find for delete):
    # === BEGIN cc-job: <name> ===
    * * * * * root /usr/local/bin/agent-run ...
    # === END cc-job: <name> ===

Both writers do tmp + os.replace for atomicity; backend systemd User=root so
the writes to /etc/cron.d/ succeed.

Out of scope (Phase 3 / P0-7g):
  - agent-run.sh respecting `enabled=false` enforcement. Today pause writes
    state but cron still fires; A0 Gate is fine without enforcement.
Out of scope (Phase 3):
  - POST /loops/<name>/trigger — needs prompt/workspace recovery from cron file.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import time
from pathlib import Path
from typing import Optional

from . import config

CC_LOOPS_PATH = Path("/etc/cron.d/cc-loops")
AGENT_RUN_BIN = "/usr/local/bin/agent-run"
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _job_file(name: str) -> Path:
    return config.JOBS_DIR / f"{name}.json"


def _validate_name(name: str) -> str:
    if not name or not _NAME_RE.match(name):
        raise ValueError(f"invalid loop name: {name!r} (allowed: [A-Za-z0-9._-]+)")
    return name


def list_jobs() -> list[dict]:
    """All jobs under ~/.cc-state/jobs/*.json, sorted by name.

    Each job dict is enriched with its `schedule`, `workspace`, `prompt`,
    and `engine` parsed from /etc/cron.d/cc-loops — these aren't stored in
    jobs.json (which is runtime state only) but the UI needs them to
    answer "what does this cron actually do?". cron file is the single
    source of truth; jobs.json holds only the timing/counter fields.
    """
    if not config.JOBS_DIR.exists():
        return []
    cron_meta = _parse_cc_loops()
    out: list[dict] = []
    for f in sorted(config.JOBS_DIR.glob("*.json")):
        try:
            job = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # Tolerate mid-write: agent-run uses mktemp+mv, but be defensive.
            continue
        meta = cron_meta.get(job.get("name", ""))
        if meta:
            # Cron file is authoritative — override any stale fields in jobs.json.
            job.update(meta)
        out.append(job)
    return out


# ---------- cron file parser (read-side enrichment for list_jobs) ----------

# Match a single marker-bounded block in /etc/cron.d/cc-loops. The cron line
# itself is the first non-# line after BEGIN; we keep capturing the comment
# lines too just so the parser is tolerant of future "# created @ ..." style
# annotations.
_BLOCK_RE = re.compile(
    r"# === BEGIN cc-job: (?P<name>[A-Za-z0-9._-]+) ===\n"
    r"(?:#[^\n]*\n)*"                                   # zero or more # comment lines
    r"(?P<line>[^#\n][^\n]*)\n"                         # the actual cron line
    r"# === END cc-job: (?P=name) ===",
    re.MULTILINE,
)


def _parse_cron_line(line: str) -> Optional[dict]:
    """Pull schedule + workspace + prompt + engine out of a cc-loops cron line.

    Expected shape (matches add_cron_loop()'s writer):
      <m> <h> <dom> <mon> <dow> root <agent-run-path> --engine=<X> \
      <ws> <prompt> <name> --source cron --job-name <name>

    Where workspace, prompt, and name are shlex-quoted by the writer when
    they contain shell metacharacters. We use shlex.split() to undo that.
    """
    parts = line.split(None, 5)                         # 5 sched fields + the rest
    if len(parts) < 6:
        return None
    schedule = " ".join(parts[:5])
    try:
        tokens = shlex.split(parts[5])
    except ValueError:
        return None
    if len(tokens) < 6 or tokens[0] != "root":
        return None

    # Walk tokens after the agent-run path. Collect positionals; pick out
    # the engine value from either --engine=X or --engine X form.
    engine = "claude"
    positionals: list[str] = []
    i = 2                                               # skip 'root' + agent-run path
    while i < len(tokens):
        t = tokens[i]
        if t.startswith("--engine="):
            engine = t[len("--engine="):]
        elif t == "--engine":
            i += 1
            if i < len(tokens):
                engine = tokens[i]
        elif t.startswith("--"):
            # Any other flag — assume `--flag value` and skip the value.
            if "=" not in t:
                i += 1
        else:
            positionals.append(t)
        i += 1

    if len(positionals) < 3:
        return None
    return {
        "schedule": schedule,
        "workspace": positionals[0],
        "prompt": positionals[1],
        "engine": engine,
    }


def _parse_cc_loops() -> dict:
    """Return {name: {schedule, workspace, prompt, engine}} for every entry
    in /etc/cron.d/cc-loops. {} when the file is missing."""
    if not CC_LOOPS_PATH.exists():
        return {}
    try:
        content = CC_LOOPS_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}
    out: dict = {}
    for m in _BLOCK_RE.finditer(content):
        parsed = _parse_cron_line(m.group("line"))
        if parsed:
            out[m.group("name")] = parsed
    return out


def get_job(name: str) -> Optional[dict]:
    fp = _job_file(name)
    if not fp.exists():
        return None
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def set_enabled(name: str, enabled: bool) -> Optional[dict]:
    """Set the `enabled` field. Returns updated job, or None if not found.

    Atomic via tmp + os.replace so a concurrent agent-run job_finish() write
    can't tear with us.
    """
    fp = _job_file(name)
    data = get_job(name)
    if data is None:
        return None
    data["enabled"] = bool(enabled)
    tmp = fp.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, fp)
    return data


# ---------- cron file writers (P0-6c) ----------


def _init_job_state(name: str) -> None:
    """Mirror agent-run.sh's job_init so /loops shows the new entry immediately."""
    fp = _job_file(name)
    if fp.exists():
        return
    config.JOBS_DIR.mkdir(parents=True, exist_ok=True)
    fp.write_text(
        json.dumps(
            {
                "name": name,
                "last_run_at": None,
                "last_finished_at": None,
                "last_exit": None,
                "last_output_summary": None,
                "consecutive_errors": 0,
                "last_error_at": None,
                "last_error_msg": None,
                "total_runs": 0,
                "enabled": True,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _write_cron_file(content: str) -> None:
    """Atomic write to /etc/cron.d/cc-loops with 0644 root:root."""
    CC_LOOPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CC_LOOPS_PATH.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.chmod(tmp, 0o644)
    os.replace(tmp, CC_LOOPS_PATH)


def _ensure_header(existing: str) -> str:
    """Make sure the PATH line is present at the top of cc-loops."""
    if "PATH=" in existing.splitlines()[0:3] if existing else False:
        return existing
    header = "PATH=/usr/local/bin:/usr/bin:/bin\n"
    if existing and not existing.startswith("PATH="):
        return header + existing
    return existing or header


def add_cron_loop(
    *,
    name: str,
    schedule: str,
    workspace: str,
    prompt: str,
    engine: str = "claude",
) -> dict:
    """Append a marker-bounded cron entry. Returns the new job state.

    Raises:
        ValueError on bad name / schedule / workspace.
        FileExistsError if a loop with this name already exists.
    """
    _validate_name(name)
    parts = (schedule or "").split()
    if len(parts) < 5:
        raise ValueError(
            f"schedule must have at least 5 fields (got {len(parts)}): {schedule!r}"
        )
    if _job_file(name).exists():
        raise FileExistsError(f"loop {name!r} already exists")

    # shlex.quote keeps the prompt safe inside a cron shell line.
    quoted_prompt = shlex.quote(prompt)
    cron_line = (
        f"{schedule} root {AGENT_RUN_BIN} --engine={engine} "
        f"{shlex.quote(workspace)} {quoted_prompt} {name} "
        f"--source cron --job-name {name}"
    )
    block = (
        f"# === BEGIN cc-job: {name} ===\n"
        f"# created @ {int(time.time())}\n"
        f"{cron_line}\n"
        f"# === END cc-job: {name} ===\n"
    )

    existing = CC_LOOPS_PATH.read_text(encoding="utf-8") if CC_LOOPS_PATH.exists() else ""
    existing = _ensure_header(existing)
    new_content = existing.rstrip() + "\n\n" + block
    _write_cron_file(new_content)
    _init_job_state(name)
    return get_job(name) or {"name": name}


def remove_cron_loop(name: str) -> bool:
    """Strip the BEGIN/END block for `name`. Return True if removed.

    Also deletes ~/.cc-state/jobs/<name>.json. No-op if no marker found.
    """
    _validate_name(name)
    if not CC_LOOPS_PATH.exists():
        return False
    content = CC_LOOPS_PATH.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"# === BEGIN cc-job: {re.escape(name)} ===\n.*?\n# === END cc-job: {re.escape(name)} ===\n?",
        re.DOTALL,
    )
    new_content, count = pattern.subn("", content)
    if count == 0:
        return False
    _write_cron_file(new_content)
    _job_file(name).unlink(missing_ok=True)
    return True
