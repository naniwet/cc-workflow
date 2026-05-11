"""FastAPI gateway — dev-plan §4.2.

Phase 1 (this file, T+0.5d) routes:
  GET  /healthz
  POST /run
  GET  /runs/{task_id}
  GET  /sessions

Auth (basic + CSRF) and the /csrf, /loops/*, /im/feishu/webhook,
/push/subscribe routes land in later phases (T+1d / T+1.5d / Phase 3).
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import db, runner

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
