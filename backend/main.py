"""FastAPI gateway — dev-plan §4.2.

Routes:
  GET    /healthz                              PUBLIC
  POST   /auth/login                           PUBLIC (sets session cookie)
  POST   /auth/logout                          PUBLIC (clears session cookie)
  GET    /auth/me                              session   (returns current username)
  GET    /                                     session   (Phase 1 simple page)
  POST   /run                                  session
  GET    /runs/{task_id}                       session
  GET    /sessions                             session
  GET    /workspaces                           session
  POST   /workspaces                           session
  DELETE /workspaces/{name}/session            session   (reset PWA conversation)
  GET    /providers/codex                       session   (codex_profiles list)
  GET    /skills                               session   (slash command discovery)
  GET    /loops                                session
  POST   /loops                                session
  DELETE /loops/{name}                         session
  POST   /loops/{name}/pause                   session
  POST   /loops/{name}/resume                  session
  POST   /loops/{name}/run                     session   (fire one immediate run)
  POST   /cron/parse-nl                        session
  GET    /approvals/pending                    session
  POST   /approvals/{id}/decision              session
  POST   /approvals/internal/pending           localhost-only (claude hook creates entry)
  GET    /approvals/internal/{id}/wait         localhost-only (claude hook long-polls)
  POST   /im/feishu/webhook                    Feishu signature (NOT session)
  POST   /im/feishu/card_callback              Feishu signature (NOT session) — P0-5d
  /pwa/*                                       static, unprotected layer (login.html lives here)

Auth: HMAC-signed session cookie set by POST /auth/login. Replaced the
Phase 1 HTTP Basic auth in May 2026 because in-app / mobile browsers
(Quark, WeChat, etc.) handled the WWW-Authenticate dialog inconsistently.
"""
from __future__ import annotations

from typing import Literal, Optional

import json
import os
import re
import subprocess
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import approvals, auth, config, cron_state, db, im_feishu, llm, runner, skills, ws_settings

PROTECT = [Depends(auth.require_user)]

app = FastAPI(title="cc-workflow", version="0.1.0")


@app.on_event("startup")
def _on_startup() -> None:
    db.init()
    _verify_agent_run_capabilities()


def _verify_agent_run_capabilities() -> None:
    """Sanity-check the agent-run binary at startup. The single most common
    deployment trap is forgetting to reinstall /usr/local/bin/agent-run
    after a `git pull` — the backend then passes flags the old binary
    doesn't understand, every run dies with exit 64. Log a loud warning
    so the journal makes the cause obvious instead of just the symptom.
    """
    import subprocess
    import sys

    try:
        result = subprocess.run(
            [str(config.AGENT_RUN), "--help"],
            capture_output=True, text=True, timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(
            f"WARNING: could not invoke agent-run at {config.AGENT_RUN}: {e}. "
            f"Runs will fail until this is fixed.",
            file=sys.stderr, flush=True,
        )
        return

    help_text = (result.stdout or "") + (result.stderr or "")
    required = ("--provider", "--permission-mode")
    missing = [flag for flag in required if flag not in help_text]
    if missing:
        print(
            f"WARNING: agent-run at {config.AGENT_RUN} is missing flags "
            f"{missing!r}. The binary is stale — pull the repo + re-run: "
            f"sudo install -m 755 {config.REPO_ROOT}/agent-run.sh /usr/local/bin/agent-run",
            file=sys.stderr, flush=True,
        )


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


# ---------- Auth (session cookie) ----------


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


@app.post("/auth/login")
def auth_login(req: LoginRequest, request: Request, response: Response) -> dict:
    if not auth.credentials_configured():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "login credentials not configured — "
                         "add [ui] username + password to ~/.cc-workflow/secrets.toml",
            },
        )
    if not auth.credentials_valid(req.username, req.password):
        raise HTTPException(
            status_code=401, detail={"error": "invalid username or password"}
        )
    auth.set_session_cookie(response, req.username, secure=auth.request_is_https(request))
    return {"ok": True, "username": req.username}


@app.post("/auth/logout")
def auth_logout(response: Response) -> dict:
    auth.clear_session_cookie(response)
    return {"ok": True}


@app.get("/auth/me", dependencies=PROTECT)
def auth_me(request: Request) -> dict:
    """Return the username encoded in the current session cookie. Used by
    the PWA to confirm "still logged in" without making a heavier API call."""
    user = auth.verify_cookie(request.cookies.get(auth.COOKIE_NAME, ""))
    return {"username": user}


@app.post("/run", dependencies=PROTECT)
def post_run(req: RunRequest) -> dict:
    run_id = db.new_run_id()
    runner.submit(
        run_id=run_id,
        workspace=req.workspace,
        prompt=req.prompt,
        engine=ws_settings.engine_for(req.workspace),
        session_key=req.session_key,
        source=req.source,
        provider=ws_settings.provider_for(req.workspace, req.provider),
        permission_mode=ws_settings.permission_mode_for(req.workspace),
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
    # When trust=True, agent-run is invoked with --permission-mode
    # bypassPermissions for this workspace (Claude auto-approves Bash /
    # WebFetch / etc.). Mutable post-creation via PUT settings, unlike
    # engine. None at create time → inherit config.toml default_trust.
    trust: Optional[bool] = None


@app.get("/config", dependencies=PROTECT)
def get_global_config() -> dict:
    """Read-only view of ~/.cc-workflow/config.toml. PWA uses .provider to label
    the 'use global default' option with the actual provider name."""
    return config.load_config() or {}


def _load_providers_json() -> dict:
    """Shared loader. Returns {} on any error so callers can keep going."""
    try:
        return json.loads(config.PROVIDERS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


@app.get("/providers", dependencies=PROTECT)
def list_providers() -> list[str]:
    """Provider names that the backend can actually drive — i.e. with non-empty env.

    Empty-env profiles like the default `claude` slot map to "use anthropic
    local OAuth from agent-run.sh"; the backend (llm.py) can't talk to them
    directly because there's no API key. So we omit them from the dropdown.
    Users who want anthropic-OAuth still get it as the global config.toml
    fallback when no per-workspace override is set.
    """
    profiles = _load_providers_json().get("profiles") or {}
    return sorted(name for name, p in profiles.items() if (p.get("env") or {}))


@app.get("/skills", dependencies=PROTECT)
def get_skills(workspace: Optional[str] = None) -> list[dict]:
    """Discover slash commands (skills) for the PWA's `/` autocomplete menu.

    Project-level skills are scoped to ?workspace=<name> when supplied.
    User-level (~/.claude/commands) and plugin-level
    (~/.claude/plugins/*/commands) are always included.

    cc-workflow does NOT execute these — claude -p resolves them itself.
    This endpoint only enumerates what exists. Called on-demand from the
    PWA Sync button (not polled), so a fresh disk scan per call is fine.
    """
    ws_path = None
    if workspace:
        target = config.WORKSPACES_DIR / workspace
        if target.is_dir():
            ws_path = target
    return skills.scan_skills(ws_path)


@app.get("/providers/codex", dependencies=PROTECT)
def list_codex_providers() -> list[str]:
    """codex_profiles keys. Returned in a separate endpoint (not merged with
    /providers) because the dropdown shown for a codex workspace must be
    different from the one shown for a claude workspace — the keys here are
    consumed by agent-run.sh's setup_codex_provider, not setup_provider.

    Filter: include only profiles with non-empty `env` OR a `base_url` —
    everything else is a placeholder that can't actually run.
    """
    cprofiles = _load_providers_json().get("codex_profiles") or {}
    return sorted(
        name for name, p in cprofiles.items()
        if (p.get("env") or {}) or p.get("base_url")
    )


def _valid_providers_for_engine(engine: str) -> set[str]:
    """Used to validate the `provider` field of create/put-settings against
    the right list — claude profiles vs codex_profiles, by engine."""
    return set(list_codex_providers() if engine == "codex" else list_providers())


@app.get("/workspaces/{name}/settings", dependencies=PROTECT)
def get_workspace_settings(name: str) -> dict:
    """Return per-workspace settings ({} when none set). Includes provider + engine."""
    return ws_settings.load().get(name, {})


class WorkspaceSettingsRequest(BaseModel):
    # provider=None or absent → clear the per-workspace override (use global).
    # engine intentionally NOT a field here: it's immutable post-creation,
    # so PUT can't touch it. Any "engine" key in the body is silently dropped.
    provider: Optional[str] = Field(default=None, max_length=64)
    # trust=None or absent → don't touch (preserves existing). Explicit
    # true/false → set. Use Pydantic's model_fields_set to distinguish
    # "field absent" from "field present with null".
    trust: Optional[bool] = None


@app.put("/workspaces/{name}/settings", dependencies=PROTECT)
def put_workspace_settings(name: str, body: WorkspaceSettingsRequest) -> dict:
    # Validate workspace exists.
    target = config.WORKSPACES_DIR / name
    if not (target / ".git").exists():
        raise HTTPException(404, {"error": "workspace not found", "name": name})

    # Validate provider name against the right list based on this workspace's
    # engine (claude → profiles, codex → codex_profiles). Look up engine
    # from existing settings since put_settings can't change it.
    if body.provider is not None and body.provider != "":
        existing_engine = (ws_settings.load().get(name) or {}).get("engine") or ws_settings.DEFAULT_ENGINE
        valid = _valid_providers_for_engine(existing_engine)
        if body.provider not in valid:
            raise HTTPException(
                400,
                {"error": "unknown provider for engine",
                 "got": body.provider, "engine": existing_engine, "valid": sorted(valid)},
            )

    # Mutate ONLY fields the client explicitly sent. Pydantic v2's
    # model_fields_set lists keys that appeared in the request body
    # (vs. just defaulted to None). Without this check, a PUT
    # {"trust": true} would also wipe the provider override.
    sent = body.model_fields_set
    data = ws_settings.load()
    current = data.get(name, {})

    if "provider" in sent:
        if body.provider in (None, ""):
            current.pop("provider", None)
        else:
            current["provider"] = body.provider

    if "trust" in sent:
        # engine=codex always forces trust=true (see ws_settings.trust_for).
        # Reject attempts to flip it off — silently coercing would leave the
        # client thinking it succeeded; better to 400 so the UI knows to
        # show its own explanation.
        if current.get("engine") == "codex" and body.trust is False:
            raise HTTPException(
                400,
                {"error": "engine=codex requires trust=true (codex has no fine-grained approval API)",
                 "name": name},
            )
        if body.trust is None:
            current.pop("trust", None)              # null → revert to default
        else:
            current["trust"] = bool(body.trust)

    if current:
        data[name] = current
    else:
        data.pop(name, None)
    ws_settings.save(data)
    return current


@app.delete("/workspaces/{name}/session", dependencies=PROTECT)
def reset_workspace_session(name: str) -> dict:
    """Reset the PWA's conversation session for this workspace.

    Clears two pieces of state, both keyed by the PWA's session_key
    convention `pwa-<workspace>`:

      1. ~/.cc-state/sessions.json[pwa-<name>].claude_session_id
         (the resume pointer; absent → next agent-run starts fresh)
      2. ~/.cc-state/codex-sessions/<name>__pwa-<name>
         (the marker file; absent → codex skips `resume --last`)

    Returns {"cleared": [...]} listing what was actually removed (so
    the PWA can show a precise toast — "session_id + codex marker"
    vs "session_id only" depending on engine history).

    Does NOT touch cron loops' or Feishu chats' sessions — those use
    different session_keys and their own UX would call this with
    different parameters (not implemented yet — single-user can edit
    sessions.json by hand).
    """
    target = config.WORKSPACES_DIR / name
    if not (target / ".git").exists():
        raise HTTPException(404, {"error": "workspace not found", "name": name})

    key = f"pwa-{name}"
    cleared: list[str] = []

    # 1. Claude session_id
    try:
        if config.SESSIONS_FILE.exists():
            data = json.loads(config.SESSIONS_FILE.read_text(encoding="utf-8"))
            if key in data:
                # Drop the whole row (both claude and codex slots — they
                # share the session_key entry). Empty file is fine; agent-run
                # ensure_sessions_file handles missing dict keys.
                data.pop(key)
                tmp = config.SESSIONS_FILE.with_suffix(".tmp")
                tmp.write_text(
                    json.dumps(data, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                os.replace(tmp, config.SESSIONS_FILE)
                cleared.append("claude_session_id")
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, {"error": f"sessions.json write failed: {e}"})

    # 2. Codex marker
    # Marker name mirrors agent-run.sh setup_codex_provider's safe-name logic.
    import re
    marker_safe = re.sub(r"[^A-Za-z0-9._-]", "_", f"{name}__{key}")
    marker = config.CODEX_SESSIONS_DIR / marker_safe
    try:
        if marker.exists():
            marker.unlink()
            cleared.append("codex_marker")
    except OSError as e:
        raise HTTPException(500, {"error": f"codex marker delete failed: {e}"})

    return {"ok": True, "workspace": name, "session_key": key, "cleared": cleared}


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
    # repo behind if the provider name is bad. Engine determines which list
    # to validate against.
    if req.provider:
        valid = _valid_providers_for_engine(req.engine)
        if req.provider not in valid:
            raise HTTPException(
                400,
                {"error": "unknown provider for engine",
                 "got": req.provider, "engine": req.engine, "valid": sorted(valid)},
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
    # engine=codex implies trust=true (codex doesn't support fine-grained
    # approval — see ws_settings.trust_for docstring). Persist that explicitly
    # so the PWA shows the trust state correctly without having to special-
    # case codex everywhere. User-supplied req.trust is overridden.
    if req.engine == "codex":
        settings["trust"] = True
        effective_trust: Optional[bool] = True
    elif req.trust is not None:
        settings["trust"] = bool(req.trust)
        effective_trust = bool(req.trust)
    else:
        # If req.trust is None we DON'T write anything — trust_for() will
        # fall back to config.toml default_trust at runtime. Avoids freezing
        # the current global default into the workspace.
        effective_trust = None
    data[req.name] = settings
    ws_settings.save(data)

    return {
        "ok": True, "name": req.name, "path": str(target),
        "provider": req.provider, "engine": req.engine, "trust": effective_trust,
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
    # No `run_now` field: on-demand triggering is its own endpoint
    # (POST /loops/{name}/run) so Add is purely "register the schedule" and
    # users can fire any loop on demand from the list without re-entering
    # name/schedule/prompt.


@app.post("/loops", dependencies=PROTECT, status_code=201)
def create_loop(req: NewLoopRequest) -> dict:
    """Add a cron entry to /etc/cron.d/cc-loops + initialize jobs/<name>.json.

    Engine is read from the workspace's settings — there's no per-loop
    engine override. To use a different engine, create a separate workspace.

    Does NOT fire an immediate run. Use POST /loops/{name}/run for that.
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
    return result


@app.post("/loops/{name}/run", dependencies=PROTECT, status_code=202)
def run_loop_now(name: str) -> dict:
    """Fire one immediate run of an existing cron loop on demand.

    Looks up the loop's prompt/workspace/engine from /etc/cron.d/cc-loops
    (parsed by cron_state.list_jobs — the cron file is the source of
    truth, jobs.json holds only runtime counters). Submits via
    runner.submit() tagged source="pwa" so it's distinguishable from
    cron-fired runs, but reuses the loop name as session_key so the
    agent sees one contiguous chat across cron-fired + manually-fired
    invocations.
    """
    jobs = cron_state.list_jobs()
    job = next((j for j in jobs if j.get("name") == name), None)
    if job is None:
        raise HTTPException(404, {"error": "loop not found", "name": name})
    workspace = job.get("workspace")
    prompt = job.get("prompt")
    engine = job.get("engine") or ws_settings.engine_for(workspace or "")
    if not workspace or not prompt:
        # cron file is corrupt or the entry was deleted out-of-band;
        # jobs.json on its own doesn't know the prompt.
        raise HTTPException(
            500,
            {"error": "loop spec missing in cron file — try Delete + re-Add", "name": name},
        )
    run_id = db.new_run_id()
    runner.submit(
        run_id=run_id,
        workspace=workspace,
        prompt=prompt,
        engine=engine,
        session_key=name,            # align with cron-fired runs for this loop
        source="pwa",                # honest: PWA triggered this, not cron
        provider=ws_settings.provider_for(workspace),
        permission_mode=ws_settings.permission_mode_for(workspace),
    )
    return {"task_id": run_id, "status": "queued", "name": name}


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


# ---------- Tool-approval queue (路 2 ask_human) ----------
# Three endpoints split by trust boundary:
#   - /approvals/internal/*    accept localhost-only (nginx denies public)
#                              called by cc-approve-hook.sh inside the
#                              claude subprocess. No auth needed because
#                              the only caller is on the same machine.
#   - /approvals/pending       basic-auth — PWA polls to know which run
#                              rows need [Approve]/[Deny] buttons.
#   - /approvals/{id}/decision basic-auth — PWA writes the user's choice.


class PendingApprovalRequest(BaseModel):
    run_id: str = Field(..., min_length=1, max_length=64)
    workspace: str = Field(..., min_length=1, max_length=128)
    tool_name: str = Field(..., min_length=1, max_length=64)
    tool_input: dict = Field(default_factory=dict)


@app.post("/approvals/internal/pending")
def post_pending_approval(req: PendingApprovalRequest) -> dict:
    aid = approvals.request(
        run_id=req.run_id,
        workspace=req.workspace,
        tool_name=req.tool_name,
        tool_input=req.tool_input,
    )
    return {"approval_id": aid}


@app.get("/approvals/internal/{approval_id}/wait")
def wait_approval(approval_id: str, timeout: int = 60) -> dict:
    """Long-poll. Blocks up to `timeout` seconds (capped at approvals.TTL).
    Returns the final status — hook treats anything except 'pending' as a
    decision and exits accordingly."""
    timeout = max(1, min(timeout, approvals.TTL_SECONDS))
    status = approvals.wait_for_decision(approval_id, timeout=float(timeout))
    return {"approval_id": approval_id, "status": status}


@app.get("/approvals/pending", dependencies=PROTECT)
def list_pending_approvals() -> list[dict]:
    return [a.public() for a in approvals.list_pending()]


class DecisionRequest(BaseModel):
    decision: Literal["approved", "denied"]


@app.post("/approvals/{approval_id}/decision", dependencies=PROTECT)
def post_approval_decision(approval_id: str, req: DecisionRequest) -> dict:
    a = approvals.decide(approval_id, req.decision)
    if a is None:
        raise HTTPException(404, {"error": "approval not found"})
    return {"ok": True, "approval_id": approval_id, "status": a.status}


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
        intent["permission_mode"] = ws_settings.permission_mode_for(intent["workspace"])
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
