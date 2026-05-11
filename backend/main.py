"""FastAPI gateway — dev-plan §4.2.

Phase 1 routes:
  GET  /healthz                              (T+0.5d)  PUBLIC
  GET  /                                     (Phase 1) basic
  POST /run                                  (T+0.5d)  basic
  GET  /runs/{task_id}                       (T+0.5d)  basic
  GET  /sessions                             (T+0.5d)  basic
  GET  /loops                                (T+1d)    basic
  POST /loops/{name}/pause                   (T+1d)    basic
  POST /loops/{name}/resume                  (T+1d)    basic

basic auth (the §4.2 "basic" half) implemented via backend/auth.py.
CSRF (the other half of §4.2), /csrf, /loops/{name}/trigger,
/im/feishu/webhook, /push/subscribe — Phase 2 / Phase 3.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import auth, config, cron_state, db, runner

PROTECT = [Depends(auth.require_basic_auth)]

app = FastAPI(title="cc-workflow", version="0.1.0")


@app.on_event("startup")
def _on_startup() -> None:
    db.init()


class RunRequest(BaseModel):
    workspace: str = Field(..., min_length=1, max_length=128)
    prompt: str = Field(..., min_length=1, max_length=8192)
    engine: Literal["claude", "codex"]
    session_key: Optional[str] = Field(default=None, max_length=128)
    source: Literal["pwa", "feishu", "cron", "manual"] = "manual"


@app.get("/healthz")  # intentionally NOT protected (monitoring / liveness)
def healthz() -> dict:
    return {"ok": True}


@app.post("/run", dependencies=PROTECT)
def post_run(req: RunRequest) -> dict:
    run_id = db.new_run_id()
    runner.submit(
        run_id=run_id,
        workspace=req.workspace,
        prompt=req.prompt,
        engine=req.engine,
        session_key=req.session_key,
        source=req.source,
    )
    return {"task_id": run_id, "status": "queued"}


@app.get("/runs/{task_id}", dependencies=PROTECT)
def get_run_endpoint(task_id: str) -> dict:
    row = db.get_run(task_id)
    if not row:
        raise HTTPException(
            status_code=404, detail={"error": "not found", "code": 404}
        )
    return row


@app.get("/sessions", dependencies=PROTECT)
def get_sessions() -> dict:
    return db.list_sessions_view()


# ---------- /loops (T+1d — P0-2 + P0-3 后半) ----------
# pause/resume only writes the `enabled` field in jobs/<name>.json. Actual
# enforcement (agent-run early-exits when enabled=false) is Phase 3 / P0-7g.


@app.get("/loops", dependencies=PROTECT)
def get_loops() -> list[dict]:
    return cron_state.list_jobs()


@app.post("/loops/{name}/pause", dependencies=PROTECT)
def pause_loop(name: str) -> dict:
    job = cron_state.set_enabled(name, False)
    if job is None:
        raise HTTPException(
            status_code=404, detail={"error": "loop not found", "code": 404}
        )
    return {"status": "paused", "name": name, "enabled": False}


@app.post("/loops/{name}/resume", dependencies=PROTECT)
def resume_loop(name: str) -> dict:
    job = cron_state.set_enabled(name, True)
    if job is None:
        raise HTTPException(
            status_code=404, detail={"error": "loop not found", "code": 404}
        )
    return {"status": "resumed", "name": name, "enabled": True}


# ---------- Phase 1 ugly trigger page (PRD §6.0) ----------
# GET / is the only public entry — browser prompts basic auth, then the
# HTML's fetch() calls reuse the same credentials for all protected APIs.
# No /static mount: index.html is the sole asset (no external CSS/JS/images).
_INDEX_HTML = config.REPO_ROOT / "backend" / "static" / "index.html"


@app.get("/", include_in_schema=False, dependencies=PROTECT)
def _root() -> FileResponse:
    return FileResponse(_INDEX_HTML)
