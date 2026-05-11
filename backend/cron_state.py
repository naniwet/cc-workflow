"""Cron job state — read/write ~/.cc-state/jobs/<name>.json.

agent-run.sh writes these files (per dev-plan §4.1 side effects); backend
reads them for `GET /loops` and toggles `enabled` for
`POST /loops/<name>/pause | resume`.

Phase 1 scope:
  - list_jobs()      list all jobs
  - get_job(name)    one job, or None
  - set_enabled()    toggle enabled, atomic write

Out of scope (Phase 3 / P0-7g):
  - agent-run.sh respecting `enabled=false` (manual pause / consecutive_errors
    disable enforcement). Currently pause writes state but cron still fires
    agent-run; that's fine for A0 Gate.

Out of scope (Phase 3):
  - POST /loops/<name>/trigger — needs prompt/workspace recovery.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from . import config


def _job_file(name: str) -> Path:
    return config.JOBS_DIR / f"{name}.json"


def list_jobs() -> list[dict]:
    """All jobs under ~/.cc-state/jobs/*.json, sorted by name."""
    if not config.JOBS_DIR.exists():
        return []
    out: list[dict] = []
    for f in sorted(config.JOBS_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            # Tolerate mid-write: agent-run uses mktemp+mv, but be defensive.
            continue
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
