"""FastAPI gateway — dev-plan §4.2.

Phase 1 routes:
  GET  /healthz                              PUBLIC
  GET  /                                     basic
  POST /run                                  basic
  GET  /runs/{task_id}                       basic
  GET  /sessions                             basic
  GET  /loops                                basic
  POST /loops/{name}/pause                   basic
  POST /loops/{name}/resume                  basic
  POST /im/feishu/webhook                    Feishu signature (NOT basic)

basic auth (the §4.2 "basic" half) implemented via backend/auth.py.
CSRF (the other half of §4.2), /csrf, /loops/{name}/trigger,
/push/subscribe — Phase 2 / Phase 3.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, cron_state, db, im_feishu, runner

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


# ---------- Feishu webhook (T+1.5d — P0-4) ----------
# Auth is Feishu's own X-Lark-Signature scheme (verified inside im_feishu).
# Intentionally NOT behind basic auth — Feishu's servers don't know our password.


@app.post("/im/feishu/webhook")
async def feishu_webhook(request: Request) -> dict:
    body = await request.body()
    parsed = im_feishu.handle_webhook(
        body,
        request.headers.get("x-lark-signature"),
        request.headers.get("x-lark-request-timestamp"),
        request.headers.get("x-lark-request-nonce"),
    )
    # Bad signature → return 401 (with body too so Feishu logs are useful).
    if parsed.get("code") == 401:
        raise HTTPException(status_code=401, detail=parsed)
    # Text message → submit a run; reply goes back via runner's on_finish.
    if "run_intent" in parsed:
        intent = parsed.pop("run_intent")
        run_id = db.new_run_id()
        runner.submit(run_id=run_id, on_finish=im_feishu.reply_from_run, **intent)
        parsed["task_id"] = run_id
    return parsed


# ---------- Phase 1 ugly trigger page (PRD §6.0) ----------
# GET / is the only public entry — browser prompts basic auth, then the
# HTML's fetch() calls reuse the same credentials for all protected APIs.
# No /static mount: index.html is the sole asset (no external CSS/JS/images).
_INDEX_HTML = config.REPO_ROOT / "backend" / "static" / "index.html"


@app.get("/", include_in_schema=False, dependencies=PROTECT)
def _root() -> FileResponse:
    return FileResponse(_INDEX_HTML)


# ---------- Phase 2 PWA-lite (P0-6a shell; views land in P0-6b/c) ----------
# /pwa/* serves the SPA: manifest / sw / index / app.js / style.css / icon.svg.
#
# Auth note: StaticFiles doesn't accept FastAPI dependencies, so /pwa/* is
# UN-protected at the FastAPI layer. This is acceptable because the static
# files contain no secrets — they're just the shell. The first API call
# (e.g. /sessions) is PROTECT-ed and triggers the browser's basic-auth
# prompt; the browser then caches the credential for subsequent fetch()
# calls in the same origin. Phase 3 P0-7c can add `auth_basic` at the
# nginx location level if we ever want defense-in-depth.
#
# SW scope: /pwa/sw.js controls /pwa/ (its own directory) — no special
# Service-Worker-Allowed header required.
_PWA_DIR = config.REPO_ROOT / "pwa"
if _PWA_DIR.exists():
    app.mount("/pwa", StaticFiles(directory=str(_PWA_DIR), html=True), name="pwa")
