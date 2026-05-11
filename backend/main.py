"""FastAPI gateway — dev-plan §4.2.

Phase 1 routes:
  GET  /healthz                             (T+0.5d)
  POST /run                                  (T+0.5d)
  GET  /runs/{task_id}                       (T+0.5d)
  GET  /sessions                             (T+0.5d)
  GET  /loops                                (T+1d)
  POST /loops/{name}/pause                   (T+1d)
  POST /loops/{name}/resume                  (T+1d)

Auth (basic + CSRF), /csrf, /loops/{name}/trigger, /im/feishu/webhook,
/push/subscribe — land in later phases (T+1.5d / Phase 2 / Phase 3).
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import cron_state, db, runner

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


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/run")
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


@app.get("/runs/{task_id}")
def get_run_endpoint(task_id: str) -> dict:
    row = db.get_run(task_id)
    if not row:
        raise HTTPException(
            status_code=404, detail={"error": "not found", "code": 404}
        )
    return row


@app.get("/sessions")
def get_sessions() -> dict:
    return db.list_sessions_view()


# ---------- /loops (T+1d — P0-2 + P0-3 后半) ----------
# pause/resume only writes the `enabled` field in jobs/<name>.json. Actual
# enforcement (agent-run early-exits when enabled=false) is Phase 3 / P0-7g.


@app.get("/loops")
def get_loops() -> list[dict]:
    return cron_state.list_jobs()


@app.post("/loops/{name}/pause")
def pause_loop(name: str) -> dict:
    job = cron_state.set_enabled(name, False)
    if job is None:
        raise HTTPException(
            status_code=404, detail={"error": "loop not found", "code": 404}
        )
    return {"status": "paused", "name": name, "enabled": False}


@app.post("/loops/{name}/resume")
def resume_loop(name: str) -> dict:
    job = cron_state.set_enabled(name, True)
    if job is None:
        raise HTTPException(
            status_code=404, detail={"error": "loop not found", "code": 404}
        )
    return {"status": "resumed", "name": name, "enabled": True}
