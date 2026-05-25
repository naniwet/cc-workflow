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
import pwd
import re
import shlex
import subprocess
import time
from pathlib import Path
from typing import Optional

from . import config

CC_LOOPS_PATH = Path("/etc/cron.d/cc-loops")
AGENT_RUN_BIN = "/usr/local/bin/agent-run"
# Where the backend listens for the localhost-only cron trigger. Cron
# rows curl this endpoint instead of calling agent-run directly — that's
# how cron-fired runs get into runs.db, become navigable from the PWA's
# run-detail page, and become eligible for Feishu push-back via
# runner.submit's on_finish callback. See main.py:run_loop_internal.
BACKEND_LOOPBACK = "http://127.0.0.1:8765"
# Wrapper installed by `scripts/install-cc-loops` — used when backend is
# not running as root, so we can atomically replace /etc/cron.d/cc-loops
# (which must be root-owned for cron to honor it). See deploy/cc-workflow.sudoers
# for the sudoers grant that makes this no-password.
INSTALL_HELPER = "/usr/local/bin/install-cc-loops"
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _cron_user() -> str:
    """The username that cron lines should run as.

    For a root-installed backend this is "root"; for the non-root install
    (User=ccw in systemd), this is "ccw". We resolve from the *current*
    process's uid so the same code path works in both deployments without
    a config flag — backend runs as the same user cron should run agent-run
    as, by design.
    """
    return pwd.getpwuid(os.getuid()).pw_name


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

# Match a single marker-bounded block in /etc/cron.d/cc-loops. Two block
# shapes are accepted:
#
#   Legacy (pre-2026-05-15): the cron line invokes agent-run directly
#   and carries workspace/prompt as positional args inline.
#
#   Current: the cron line curls a localhost-only backend endpoint that
#   triggers runner.submit(). Workspace/prompt are stored as `# meta:`
#   header lines inside the block so the file is still self-describing
#   AND list_jobs() can answer "what does this cron do?" without making
#   the curl line itself carry them.
#
# `body` captures everything between BEGIN and END (header comments +
# cron line); both _parse_cron_line variants extract from this blob.
_BLOCK_RE = re.compile(
    r"# === BEGIN cc-job: (?P<name>[A-Za-z0-9._-]+) ===\n"
    r"(?P<body>.*?)"
    r"# === END cc-job: (?P=name) ===",
    re.DOTALL,
)

# Header-comment KV lines used by the new-format block, e.g.
#   # meta: workspace=pivot-table
#   # meta: prompt="跑一下 vitest"
#   # meta: engine=claude
_META_RE = re.compile(r"^# meta: (?P<k>[a-z_]+)=(?P<v>.*)$", re.MULTILINE)


def _parse_block_body(body: str) -> Optional[dict]:
    """Return {schedule, workspace, prompt, engine} for one cc-job block,
    handling both legacy (agent-run-on-cron-line) and current (curl-trigger
    with `# meta:` headers) formats."""
    # Find the actual cron line — first non-comment, non-blank line.
    cron_line = ""
    for ln in body.splitlines():
        stripped = ln.strip()
        if not stripped or stripped.startswith("#"):
            continue
        cron_line = ln
        break
    if not cron_line:
        return None

    parts = cron_line.split(None, 5)
    if len(parts) < 6:
        return None
    schedule = " ".join(parts[:5])
    tail = parts[5]

    # Heuristic: legacy lines invoke agent-run, current lines invoke
    # curl + the loopback endpoint. Cheap-and-correct discriminator.
    if "agent-run" in tail and "/loops/" not in tail:
        return _parse_legacy_tail(schedule, tail)
    if "/loops/" in tail and "/run/internal" in tail:
        meta = {m.group("k"): _unquote_meta(m.group("v")) for m in _META_RE.finditer(body)}
        workspace = meta.get("workspace") or ""
        prompt = meta.get("prompt") or ""
        engine = meta.get("engine") or "claude"
        if not workspace or not prompt:
            return None
        return {
            "schedule": schedule,
            "workspace": workspace,
            "prompt": prompt,
            "engine": engine,
        }
    return None


def _unquote_meta(v: str) -> str:
    """Reverse the shlex.quote we did when writing `# meta: prompt=...`.
    Tolerant — accepts unquoted values too (engine=claude)."""
    v = v.strip()
    if not v:
        return ""
    try:
        # shlex.split returns the unquoted form when input is one quoted token.
        toks = shlex.split(v)
        return toks[0] if toks else ""
    except ValueError:
        return v


def _parse_legacy_tail(schedule: str, tail: str) -> Optional[dict]:
    """Legacy `<user> agent-run --engine=X ws prompt name --source cron --job-name name` tail."""
    try:
        tokens = shlex.split(tail)
    except ValueError:
        return None
    if len(tokens) < 6:
        return None
    engine = "claude"
    positionals: list[str] = []
    i = 2  # skip USER + agent-run path
    while i < len(tokens):
        t = tokens[i]
        if t.startswith("--engine="):
            engine = t[len("--engine="):]
        elif t == "--engine":
            i += 1
            if i < len(tokens):
                engine = tokens[i]
        elif t.startswith("--"):
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
        parsed = _parse_block_body(m.group("body"))
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
    """Atomic write to /etc/cron.d/cc-loops with 0644 root:root.

    Two code paths, switched on whether the current process is root:

    1. Root backend (legacy install): we own /etc/cron.d/, can rename a
       tmpfile directly. One syscall, classic atomicity.
    2. Non-root backend (User=ccw, recommended since 2026-05-14): we
       can't write under /etc/cron.d/ ourselves. Stage the content in
       our state dir, then shell out to a sudo wrapper (install-cc-loops)
       that validates the staging path and does the install as root.
       The wrapper is the only command granted in /etc/sudoers.d/cc-workflow,
       so this doesn't enlarge the trust surface beyond "ccw can replace
       this one file with this one shape".
    """
    if os.geteuid() == 0:
        CC_LOOPS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CC_LOOPS_PATH.with_suffix(".tmp")
        tmp.write_text(content, encoding="utf-8")
        os.chmod(tmp, 0o644)
        os.replace(tmp, CC_LOOPS_PATH)
        return

    # Non-root path. Stage in $STATE_DIR/cc-loops.tmp (where the sudoers
    # wrapper expects to find it — see scripts/install-cc-loops).
    stage = config.STATE_DIR / "cc-loops.tmp"
    stage.parent.mkdir(parents=True, exist_ok=True)
    stage.write_text(content, encoding="utf-8")
    os.chmod(stage, 0o644)
    try:
        result = subprocess.run(
            ["sudo", "-n", INSTALL_HELPER, str(stage)],
            capture_output=True, text=True, check=False,
            timeout=10,    # defensive — 防 sudo PAM/NSS 慢或 helper 死锁让
                           # FastAPI 线程永远 hang(参考 2026-05-25 排查记录)
        )
    except subprocess.TimeoutExpired as e:
        raise OSError(
            f"install-cc-loops wrapper timed out after {e.timeout}s — "
            "check sudoers + helper script;stage 文件留在 "
            f"{stage} 供调试"
        ) from e
    # The wrapper deletes the staged file on success. If it failed, the
    # stage stays around — useful for debugging — and we surface the
    # wrapper's stderr.
    if result.returncode != 0:
        raise OSError(
            f"install-cc-loops wrapper exited {result.returncode}: "
            f"{(result.stderr or result.stdout).strip()}"
        )


def _ensure_header(existing: str) -> str:
    """Make sure the PATH line is present at the top of cc-loops."""
    if "PATH=" in existing.splitlines()[0:3] if existing else False:
        return existing
    header = "PATH=/usr/local/bin:/usr/bin:/bin\n"
    if existing and not existing.startswith("PATH="):
        return header + existing
    return existing or header


def _build_block(*, name: str, schedule: str, workspace: str, prompt: str, engine: str) -> str:
    """Build the new-format cron block text (header `# meta:` lines + curl trigger)."""
    cron_line = (
        f"{schedule} {_cron_user()} curl -fsS -X POST "
        f"{BACKEND_LOOPBACK}/loops/{name}/run/internal "
        f"-H 'Content-Type: application/json' -d '{{}}' "
        f">/dev/null 2>&1"
    )
    return (
        f"# === BEGIN cc-job: {name} ===\n"
        f"# created @ {int(time.time())}\n"
        f"# meta: workspace={shlex.quote(workspace)}\n"
        f"# meta: prompt={shlex.quote(prompt)}\n"
        f"# meta: engine={engine}\n"
        f"{cron_line}\n"
        f"# === END cc-job: {name} ===\n"
    )


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

    New cron-line format (2026-05-15):
      The line itself just curls a localhost-only backend endpoint;
      workspace/prompt/engine live in `# meta:` header lines inside
      the block. This routes cron-fired runs through runner.submit
      (same path as PWA / Feishu) so they end up in runs.db and can
      drive Feishu push-back via on_finish callback.
    """
    _validate_name(name)
    parts = (schedule or "").split()
    if len(parts) < 5:
        raise ValueError(
            f"schedule must have at least 5 fields (got {len(parts)}): {schedule!r}"
        )
    if _job_file(name).exists():
        raise FileExistsError(f"loop {name!r} already exists")

    block = _build_block(
        name=name, schedule=schedule, workspace=workspace, prompt=prompt, engine=engine,
    )
    existing = CC_LOOPS_PATH.read_text(encoding="utf-8") if CC_LOOPS_PATH.exists() else ""
    existing = _ensure_header(existing)
    new_content = existing.rstrip() + "\n\n" + block
    _write_cron_file(new_content)
    _init_job_state(name)
    return get_job(name) or {"name": name}


def update_job_fields(name: str, **fields) -> Optional[dict]:
    """Atomic merge of arbitrary fields into jobs/<name>.json.

    Used by Feishu's `_loops_confirm` to plant:
      - chat_id              (so cron auto-push knows where to send)

    See append_recent_run_id() for the run-id history writer (was
    previously layered on top of this function but needs special
    list-prepend semantics + cap, so it got its own function).

    Both writers (agent-run's job_finish + this) use mktemp+os.replace,
    so concurrent writes don't tear — last-writer-wins on the contested
    field, but disjoint-field writes (typical case) merge cleanly.
    Returns the merged job dict, or None if jobs/<name>.json missing.
    """
    fp = _job_file(name)
    data = get_job(name)
    if data is None:
        return None
    for k, v in fields.items():
        data[k] = v
    tmp = fp.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, fp)
    return data


# Cap on how many recent run-ids we remember per cron job. 5 is enough
# to "I don't know which of the last few is the one I'm looking for"
# without bloating jobs/<name>.json or /loops response payloads.
RECENT_RUNS_CAP = 5


def append_recent_run_id(name: str, run_id: str, cap: int = RECENT_RUNS_CAP) -> Optional[dict]:
    """Prepend run_id to recent_run_ids[], truncate to `cap` entries.

    Atomically updates jobs/<name>.json. Also keeps `last_run_id` in
    sync (= recent_run_ids[0]) so existing readers (PWA's "→ open"
    link, Feishu push-back) keep working without a flag day.

    De-dup: if run_id is already at the head (or anywhere) in the list,
    we move it to the head rather than keeping a duplicate. Defensive
    against retry / double-fire scenarios.

    Returns the updated job dict, or None if jobs/<name>.json missing.
    """
    fp = _job_file(name)
    data = get_job(name)
    if data is None:
        return None
    recent = data.get("recent_run_ids")
    if not isinstance(recent, list):
        recent = []
    # Drop any pre-existing copy of run_id, then prepend, then cap.
    recent = [run_id] + [r for r in recent if r != run_id]
    recent = recent[:cap]
    data["recent_run_ids"] = recent
    data["last_run_id"] = run_id  # backward-compat mirror
    tmp = fp.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, fp)
    return data


def rewrite_legacy_cron_lines() -> int:
    """Migrate any pre-2026-05-15 cc-loops entries to the curl-trigger format.

    Idempotent: blocks already in the new format are detected and skipped.
    Called from main._on_startup so a `git pull && systemctl restart`
    auto-upgrades the cron file in place.

    Returns the count of blocks rewritten. 0 means the file was already
    fresh (or missing entirely).
    """
    if not CC_LOOPS_PATH.exists():
        return 0
    try:
        content = CC_LOOPS_PATH.read_text(encoding="utf-8")
    except OSError:
        return 0

    rewritten = 0
    blocks_out: list[tuple[int, int, str]] = []  # (start, end, replacement)

    for m in _BLOCK_RE.finditer(content):
        name = m.group("name")
        body = m.group("body")
        # Skip if already new format (contains the curl trigger line).
        if "/run/internal" in body:
            continue
        parsed = _parse_block_body(body)
        if not parsed:
            # Unparseable — leave as-is, log once via stderr (don't fail
            # startup over one busted block).
            print(
                f"cron_state.rewrite_legacy_cron_lines: skipping unparseable block {name!r}",
                flush=True,
            )
            continue
        # Pull schedule from the legacy line (now in parsed["schedule"])
        # and the rest from the parsed fields. We need to preserve any
        # other comments in the legacy body (the `# created @ ts` line)
        # — only the cron line itself + missing meta headers change.
        new_block = _build_block(
            name=name,
            schedule=parsed["schedule"],
            workspace=parsed["workspace"],
            prompt=parsed["prompt"],
            engine=parsed["engine"],
        )
        # m.end() points right after the END marker, which is what we
        # want to replace up to. new_block has its own trailing newline.
        blocks_out.append((m.start(), m.end(), new_block.rstrip("\n")))
        rewritten += 1

    if rewritten == 0:
        return 0

    # Apply replacements right-to-left so earlier offsets stay valid.
    new_content = content
    for start, end, repl in reversed(blocks_out):
        new_content = new_content[:start] + repl + new_content[end:]

    _write_cron_file(new_content)
    return rewritten


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
