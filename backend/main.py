"""FastAPI gateway — dev-plan §4.2.

Routes:
  GET    /healthz                              PUBLIC
  GET    /                                     basic   (Phase 1 simple page)
  POST   /run                                  basic
  GET    /runs/{task_id}                       basic
  GET    /sessions                             basic
  GET    /workspaces                           basic   (P0-6b)
  POST   /workspaces                           basic   (P0-6c — new)
  GET    /loops                                basic
  POST   /loops                                basic   (P0-6c — add cron)
  DELETE /loops/{name}                         basic   (P0-6c — delete cron)
  POST   /loops/{name}/pause                   basic
  POST   /loops/{name}/resume                  basic
  POST   /cron/parse-nl                        basic   (P0-6c — NL → cron via LLM)
  POST   /im/feishu/webhook                    Feishu signature (NOT basic)
  /pwa/*                                       static, unprotected layer

basic auth via backend/auth.py. CSRF + /csrf endpoint stay Phase 3.
"""
from __future__ import annotations

from typing import Literal, Optional

import re
import subprocess

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, cron_state, db, im_feishu, llm, runner

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


@app.get("/workspaces", dependencies=PROTECT)
def get_workspaces() -> list[str]:
    """List ~/workspaces/* git repos. Used by PWA Workspaces view + run_form_card."""
    from . import ui_cards
    return ui_cards._discover_workspaces()


class NewWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")


@app.post("/workspaces", dependencies=PROTECT, status_code=201)
def create_workspace(req: NewWorkspaceRequest) -> dict:
    """Create ~/workspaces/<name>/ as a fresh git repo (init + empty README + first commit)."""
    target = config.WORKSPACES_DIR / req.name
    if target.exists():
        raise HTTPException(409, {"error": "workspace already exists", "name": req.name})
    target.mkdir(parents=True, exist_ok=False)
    try:
        for cmd in (
            ["git", "init", "-q"],
            ["git", "config", "user.email", "cc-workflow@local"],
            ["git", "config", "user.name", "cc-workflow"],
        ):
            subprocess.run(cmd, cwd=target, check=True)
        (target / "README.md").write_text(f"# {req.name}\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=target, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=target, check=True)
    except subprocess.CalledProcessError as e:
        # Leave the half-initialized dir for inspection; surface error.
        raise HTTPException(500, {"error": "git init failed", "detail": str(e)})
    return {"ok": True, "name": req.name, "path": str(target)}


# ---------- /loops (T+1d — P0-2 + P0-3 后半) ----------
# pause/resume only writes the `enabled` field in jobs/<name>.json. Actual
# enforcement (agent-run early-exits when enabled=false) is Phase 3 / P0-7g.


@app.get("/loops", dependencies=PROTECT)
def get_loops() -> list[dict]:
    return cron_state.list_jobs()


class NewLoopRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    schedule: str = Field(..., min_length=9, max_length=128)  # at least "* * * * *"
    workspace: str = Field(..., min_length=1, max_length=128)
    prompt: str = Field(..., min_length=1, max_length=4096)
    engine: Literal["claude", "codex"] = "claude"


@app.post("/loops", dependencies=PROTECT, status_code=201)
def create_loop(req: NewLoopRequest) -> dict:
    """Add a cron entry to /etc/cron.d/cc-loops + initialize jobs/<name>.json."""
    try:
        return cron_state.add_cron_loop(
            name=req.name,
            schedule=req.schedule,
            workspace=req.workspace,
            prompt=req.prompt,
            engine=req.engine,
        )
    except FileExistsError as e:
        raise HTTPException(409, {"error": str(e)})
    except ValueError as e:
        raise HTTPException(400, {"error": str(e)})
    except OSError as e:
        raise HTTPException(500, {"error": f"cron file write failed: {e}"})


@app.delete("/loops/{name}", dependencies=PROTECT)
def delete_loop(name: str) -> dict:
    """Remove the marker block from cc-loops + delete jobs/<name>.json."""
    try:
        removed = cron_state.remove_cron_loop(name)
    except ValueError as e:
        raise HTTPException(400, {"error": str(e)})
    except OSError as e:
        raise HTTPException(500, {"error": f"cron file write failed: {e}"})
    if not removed:
        raise HTTPException(404, {"error": "loop not found in cc-loops", "name": name})
    return {"ok": True, "name": name}


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


# ---------- /cron/parse-nl ----------
# First user-facing LLM call from backend (not via agent-run.sh).
# llm.complete() reuses the same providers.json profile agent-run uses.


class ParseNlRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200)


_CRON_LINE_RE = re.compile(r"^([0-9*/,\-]+\s+){4}[0-9*/,\-]+$")


@app.post("/cron/parse-nl", dependencies=PROTECT)
def parse_nl_cron(req: ParseNlRequest) -> dict:
    """Convert natural-language schedule (zh/en) to a 5-field cron expression."""
    prompt = (
        "Convert the following natural-language schedule description (Chinese or English) "
        "to a STANDARD 5-field cron expression: minute hour day-of-month month day-of-week. "
        "Reply with ONLY the cron expression on one line — no quotes, no explanation, no markdown.\n\n"
        f"Description: {req.text}\nCron:"
    )
    try:
        reply = llm.complete(prompt, max_tokens=64).strip()
    except RuntimeError as e:
        raise HTTPException(502, {"error": "llm_call_failed", "detail": str(e)})

    for line in reply.splitlines():
        line = line.strip().strip("`").strip("'\"")
        if _CRON_LINE_RE.match(line):
            return {"cron": line, "raw_reply": reply}
    raise HTTPException(
        422,
        {"error": "llm_did_not_return_cron", "raw_reply": reply},
    )


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
