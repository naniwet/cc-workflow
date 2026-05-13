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
  POST   /im/feishu/card_callback              Feishu signature (NOT basic) — P0-5d
  /pwa/*                                       static, unprotected layer

basic auth via backend/auth.py. CSRF + /csrf endpoint stay Phase 3.
"""
from __future__ import annotations

from typing import Literal, Optional

import json
import os
import re
import subprocess
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, cron_state, db, im_feishu, llm, runner, ws_settings

PROTECT = [Depends(auth.require_basic_auth)]

app = FastAPI(title="cc-workflow", version="0.1.0")


@app.on_event("startup")
def _on_startup() -> None:
    db.init()


class RunRequest(BaseModel):
    workspace: str = Field(..., min_length=1, max_length=128)
    prompt: str = Field(..., min_length=1, max_length=8192)
    # engine is no longer per-run — backend derives it from the workspace's
    # immutable engine setting. Field accepted for backward compat but ignored.
    engine: Optional[Literal["claude", "codex"]] = None
    session_key: Optional[str] = Field(default=None, max_length=128)
    source: Literal["pwa", "feishu", "cron", "manual"] = "manual"
    provider: Optional[str] = Field(default=None, max_length=64)   # one-shot LLM override


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
        engine=ws_settings.engine_for(req.workspace),       # bound to workspace
        session_key=req.session_key,
        source=req.source,
        provider=ws_settings.provider_for(req.workspace, req.provider),
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
    # Optional: pin the workspace to a specific LLM provider at creation
    # time. Same semantics as PUT /workspaces/{name}/settings — saved into
    # workspaces.json. Empty/None means "use global config.toml default".
    provider: Optional[str] = Field(default=None, max_length=64)
    # Engine is set ONCE at creation time. No endpoint allows changing it
    # later — to switch engines, delete + recreate. The field is always
    # written to workspaces.json so ws_settings.engine_for() can read it
    # without falling back to DEFAULT_ENGINE for fresh workspaces.
    engine: Literal["claude", "codex"] = "claude"


@app.get("/config", dependencies=PROTECT)
def get_global_config() -> dict:
    """Read-only view of ~/.cc-workflow/config.toml. PWA uses .provider to label
    the 'use global default' option with the actual provider name."""
    return config.load_config() or {}


@app.get("/providers", dependencies=PROTECT)
def list_providers() -> list[str]:
    """Provider names that the backend can actually drive — i.e. with non-empty env.

    Empty-env profiles like the default `claude` slot map to "use anthropic
    local OAuth from agent-run.sh"; the backend (llm.py) can't talk to them
    directly because there's no API key. So we omit them from the dropdown.
    Users who want anthropic-OAuth still get it as the global config.toml
    fallback when no per-workspace override is set.
    """
    try:
        data = json.loads(config.PROVIDERS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    profiles = data.get("profiles") or {}
    return sorted(
        name for name, p in profiles.items() if (p.get("env") or {})
    )


@app.get("/workspaces/{name}/settings", dependencies=PROTECT)
def get_workspace_settings(name: str) -> dict:
    """Return per-workspace settings ({} when none set). Includes provider + engine."""
    return ws_settings.load().get(name, {})


class WorkspaceSettingsRequest(BaseModel):
    # provider=None or absent → clear the per-workspace override (use global).
    # engine intentionally NOT a field here: it's immutable post-creation,
    # so PUT can't touch it. Any "engine" key in the body is silently dropped.
    provider: Optional[str] = Field(default=None, max_length=64)


@app.put("/workspaces/{name}/settings", dependencies=PROTECT)
def put_workspace_settings(name: str, body: WorkspaceSettingsRequest) -> dict:
    # Validate workspace exists.
    target = config.WORKSPACES_DIR / name
    if not (target / ".git").exists():
        raise HTTPException(404, {"error": "workspace not found", "name": name})

    # Validate provider name against providers.json keys.
    if body.provider is not None and body.provider != "":
        valid = set(list_providers())
        if body.provider not in valid:
            raise HTTPException(
                400, {"error": "unknown provider", "got": body.provider, "valid": sorted(valid)}
            )

    # Mutate provider only — engine field (if present) is preserved untouched.
    data = ws_settings.load()
    current = data.get(name, {})
    if body.provider in (None, ""):
        current.pop("provider", None)
    else:
        current["provider"] = body.provider

    if current:
        data[name] = current
    else:
        data.pop(name, None)
    ws_settings.save(data)
    return current


@app.post("/workspaces", dependencies=PROTECT, status_code=201)
def create_workspace(req: NewWorkspaceRequest) -> dict:
    """Create ~/workspaces/<name>/ as a fresh git repo (init + empty README + first commit).

    Saves both provider (optional, mutable later) and engine (mandatory,
    immutable) into workspaces.json.
    """
    target = config.WORKSPACES_DIR / req.name
    if target.exists():
        raise HTTPException(409, {"error": "workspace already exists", "name": req.name})

    # Validate the optional provider FIRST so we don't leave a half-created
    # repo behind if the provider name is bad.
    if req.provider:
        valid = set(list_providers())
        if req.provider not in valid:
            raise HTTPException(
                400,
                {"error": "unknown provider", "got": req.provider, "valid": sorted(valid)},
            )

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

    # Save settings. Engine is always written so engine_for() doesn't have
    # to fall back to DEFAULT_ENGINE for freshly-created workspaces.
    data = ws_settings.load()
    settings = data.get(req.name, {})
    if req.provider:
        settings["provider"] = req.provider
    settings["engine"] = req.engine
    data[req.name] = settings
    ws_settings.save(data)

    return {
        "ok": True, "name": req.name, "path": str(target),
        "provider": req.provider, "engine": req.engine,
    }


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
    # engine intentionally absent — derived from workspace's immutable setting.
    # When true (the PWA's default), fire one immediate run right after the
    # cron entry is written — so the user gets a "first result" without
    # waiting for the next scheduled tick. Source is "pwa" (not "cron")
    # because cron didn't fire it, the Add button did; session_key matches
    # what future cron-fired runs use so the agent sees a contiguous chat.
    run_now: bool = True


@app.post("/loops", dependencies=PROTECT, status_code=201)
def create_loop(req: NewLoopRequest) -> dict:
    """Add a cron entry to /etc/cron.d/cc-loops + initialize jobs/<name>.json.

    Engine is read from the workspace's settings — there's no per-loop
    engine override. To use a different engine, create a separate workspace.

    If `run_now` is true, also fires one immediate run via runner.submit().
    The immediate run is tagged source="pwa", NOT source="cron", and is NOT
    counted in jobs/<name>.json's total_runs — that file tracks cron-fired
    runs only, this one's a PWA-initiated sanity check that happens to
    share the loop's session_key.
    """
    engine = ws_settings.engine_for(req.workspace)
    try:
        result = cron_state.add_cron_loop(
            name=req.name,
            schedule=req.schedule,
            workspace=req.workspace,
            prompt=req.prompt,
            engine=engine,
        )
    except FileExistsError as e:
        raise HTTPException(409, {"error": str(e)})
    except ValueError as e:
        raise HTTPException(400, {"error": str(e)})
    except OSError as e:
        raise HTTPException(500, {"error": f"cron file write failed: {e}"})

    if req.run_now:
        first_run_id = db.new_run_id()
        runner.submit(
            run_id=first_run_id,
            workspace=req.workspace,
            prompt=req.prompt,
            engine=engine,
            session_key=req.name,        # align with cron-fired runs for this loop
            source="pwa",                # honest: PWA triggered this, not cron
            provider=ws_settings.provider_for(req.workspace),
        )
        result["first_run_id"] = first_run_id
    return result


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


# 5-field cron pattern, allowing day-of-week names (MON, TUE…) too.
_CRON_TOKEN = r"[0-9*/,\-]+"
_CRON_DOW_TOKEN = r"[0-9*/,\-A-Za-z]+"
_CRON_INLINE_RE = re.compile(
    rf"(?<![A-Za-z0-9])({_CRON_TOKEN}\s+{_CRON_TOKEN}\s+{_CRON_TOKEN}\s+{_CRON_DOW_TOKEN}\s+{_CRON_DOW_TOKEN})(?![A-Za-z0-9])"
)
_CODE_FENCE_RE = re.compile(r"^```(?:\w+)?\s*|\s*```$", flags=re.MULTILINE)


@app.post("/cron/parse-nl", dependencies=PROTECT)
def parse_nl_cron(req: ParseNlRequest) -> dict:
    """Parse a natural-language input into BOTH a cron expression and the task prompt.

    The user typically writes one sentence like "每天早上 9 点拉一下最新代码"
    — that's a schedule ("每天早上 9 点") + a task ("拉一下最新代码"). We ask
    the LLM to split them and reply as JSON `{"cron": "...", "prompt": "..."}`.

    Strategy:
      1. JSON contract: try json.loads; take .cron and .prompt.
      2. Fallback: regex-sweep for any 5-token cron-shaped substring; .prompt
         stays empty so the user can fill it manually.
    """
    prompt = (
        "Parse the user's input into a SCHEDULE and a TASK.\n"
        "  schedule = WHEN (a moment in time, like '每天早上 9 点' / 'every Monday')\n"
        "  task     = WHAT to do (the rest, e.g. '拉一下最新代码')\n"
        "\n"
        "Output ONLY a one-line JSON object:\n"
        '  {"cron": "<5-field-cron>", "prompt": "<task description verbatim>"}\n'
        "\n"
        "Rules:\n"
        "- cron is the standard 5-field POSIX form: minute hour day-of-month month day-of-week.\n"
        "- prompt is in the user's original language; if they gave only a time and no task, prompt=\"\".\n"
        "- No code fences, no commentary outside the JSON.\n"
        "\n"
        f"User input: {req.text}"
    )
    try:
        reply = llm.complete(prompt, max_tokens=200).strip()
    except RuntimeError as e:
        raise HTTPException(502, {"error": "llm_call_failed", "detail": str(e)})

    cleaned = _CODE_FENCE_RE.sub("", reply).strip()

    # Pass 1: JSON contract.
    try:
        parsed = json.loads(cleaned)
        cron = (parsed.get("cron") or "").strip().strip("`'\"")
        task = (parsed.get("prompt") or "").strip()
        if cron and len(cron.split()) >= 5:
            return {"cron": cron, "prompt": task, "raw_reply": reply}
    except (json.JSONDecodeError, AttributeError):
        pass

    # Pass 2: regex sweep — cron only, no prompt extraction.
    m = _CRON_INLINE_RE.search(cleaned)
    if m:
        return {"cron": m.group(1).strip(), "prompt": "", "raw_reply": reply}

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
        # _handle_message hardcodes engine="claude" since it has no access to
        # workspaces.json; override here with the resolved per-workspace engine.
        intent["engine"] = ws_settings.engine_for(intent["workspace"])
        run_id = db.new_run_id()
        runner.submit(run_id=run_id, on_finish=im_feishu.reply_from_run, **intent)
        parsed["task_id"] = run_id
    return parsed


# Feishu card-callback URL — register this in 飞书开放平台 → 消息卡片 → 回调地址:
#   https://<your-domain>/im/feishu/card_callback
# Distinct from /im/feishu/webhook (events) by Feishu's design; both use the
# same Encrypt Key signature scheme so handle_card_callback delegates to the
# shared _verify_and_decrypt helper inside im_feishu.
@app.post("/im/feishu/card_callback")
async def feishu_card_callback(request: Request) -> dict:
    body = await request.body()
    parsed = im_feishu.handle_card_callback(
        body,
        request.headers.get("x-lark-signature"),
        request.headers.get("x-lark-request-timestamp"),
        request.headers.get("x-lark-request-nonce"),
    )
    code = parsed.get("code")
    if code == 401:
        raise HTTPException(status_code=401, detail=parsed)
    if code and code >= 400:
        raise HTTPException(status_code=code, detail=parsed)
    # Either {"challenge": "..."} (initial setup) or {"toast": ..., "card": ...}
    # — both are returned to Feishu verbatim.
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
