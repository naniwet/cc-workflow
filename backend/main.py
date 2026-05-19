"""FastAPI gateway — dev-plan §4.2.

Routes:
  GET    /healthz                              PUBLIC
  POST   /auth/login                           PUBLIC (sets session cookie)
  POST   /auth/logout                          PUBLIC (clears session cookie)
  GET    /auth/me                              session   (returns current username)
  GET    /                                     redirect → /pwa/  (no auth)
  POST   /run                                  session
  GET    /runs/{task_id}                       session
  POST   /runs/{task_id}/cancel                session   (SIGTERM running subprocess)
  GET    /runs/{task_id}/tail                  session   (live stream jsonl tail)
  GET    /sessions                             session
  GET    /workspaces                           session
  POST   /workspaces                           session
  POST   /workspaces/{name}/pull                session   (git pull --ff-only)
  DELETE /workspaces/{name}/session            session   (reset PWA conversation)
  DELETE /workspaces/{name}                    session   (hard delete: rm dir + settings + session)
  GET    /skills                               session   (slash command discovery)
  GET    /loops                                session
  POST   /loops                                session
  DELETE /loops/{name}                         session
  POST   /loops/{name}/pause                   session
  POST   /loops/{name}/resume                  session
  POST   /loops/{name}/run                     session   (fire one immediate run)
  GET    /roundtables                           session   (list multi-agent debates)
  POST   /roundtables                           session   (start new one)
  GET    /roundtables/models                    session   (model registry for PWA model picker)
  GET    /roundtables/{id}                      session   (full session content)
  DELETE /roundtables/{id}                      session
  POST   /cron/parse-nl                        session
  GET    /approvals/pending                    session
  POST   /approvals/{id}/decision              session
  GET    /runs/{run_id}/approvals              session   (read-only audit, incl. auto_approved)
  POST   /approvals/internal/pending           localhost-only (claude hook creates entry)
  GET    /approvals/internal/{id}/wait         localhost-only (claude hook long-polls)
  POST   /loops/{name}/run/internal            localhost-only (cron timer triggers run)
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
import shutil
import subprocess
from pathlib import Path
from typing import Optional

import uuid

from fastapi import Body, Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import approvals, auth, config, cron_state, db, im_feishu, llm, runner, skills, ws_settings
from .roundtable import io as roundtable_io
from .roundtable import model as roundtable_model
from .roundtable import roles as roundtable_roles
from .roundtable import runner as roundtable_runner
from .roundtable.synth import parse_synthesis

PROTECT = [Depends(auth.require_user)]

app = FastAPI(title="cc-workflow", version="0.1.0")


@app.on_event("startup")
def _on_startup() -> None:
    db.init()
    _reap_orphan_runs()
    # 提前建好 uploads 根目录 + 严格权限 0700,避免第一次 POST /uploads 时
    # 因为父目录不存在而抛 OSError。cron 每周清理 7 天以上的内容,这里不做。
    try:
        config.UPLOADS_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    except OSError as e:    # noqa: BLE001
        print(f"WARNING: could not create UPLOADS_DIR {config.UPLOADS_DIR}: {e}", flush=True)
    # Plant our blanket `permissions.allow` list into ~/.claude/settings.json
    # so claude's L1 permission check passes for every tool we know about,
    # in every cwd (workspace root AND git worktree). Trust=on/off
    # differentiation is delegated to the PreToolUse hook layer
    # (cc-approve-hook reads CCW_TRUST). Replaced the older per-workspace
    # .claude/settings.local.json sync on 2026-05-15 — that path was
    # invisible to worktree runs.
    try:
        ws_settings.sync_global_allow_rules()
    except Exception:    # noqa: BLE001
        pass
    # Migrate /etc/cron.d/cc-loops entries that still use the legacy
    # agent-run-on-cron-line format to the curl-trigger format. After
    # this, cron-fired runs go through runner.submit() like any other
    # source, so they land in runs.db (= PWA run-detail) and become
    # eligible for Feishu push-back via on_finish callback.
    try:
        n = cron_state.rewrite_legacy_cron_lines()
        if n > 0:
            print(f"cron_state: rewrote {n} legacy cron block(s) → curl-trigger format", flush=True)
    except Exception as e:    # noqa: BLE001
        print(f"cron_state.rewrite_legacy_cron_lines failed: {e}", flush=True)
    _verify_agent_run_capabilities()


def _reap_orphan_runs() -> None:
    """Mark any leftover status='running' or 'queued' rows as failed.

    Assumption: when systemd starts the backend, every agent-run
    subprocess from the previous run is gone (cgroup-kill on stop kills
    them all). So any 'running' row at startup is by definition stale —
    its agent-run died without writing a terminal status.

    Without this reap, stale rows occupy the 3-slot flock pool indefinitely
    (slot lock file is fd-bound to the dead process, so it's actually
    released, but the runs.db row stays 'running' forever and new submits
    see "already busy" via the backend's same-workspace concurrency guard).
    User has to manually `sqlite3 ... UPDATE` otherwise — exactly what
    this hook is here to prevent.
    """
    import logging
    log = logging.getLogger("cc-workflow")
    swept = db.fail_stale_runs(reason="orphan: backend restarted while running")
    if swept:
        log.warning(
            "Reaped %d orphan run(s) at startup (status running/queued → failed). "
            "These were left over from a previous backend instance that didn't "
            "write a terminal status. IDs: %s",
            len(swept), ", ".join(swept[:5]) + ("..." if len(swept) > 5 else ""),
        )


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
    # Only "claude" is supported as of 2026-05-14 (codex removed; see README).
    engine: Optional[Literal["claude"]] = None
    session_key: Optional[str] = Field(default=None, max_length=128)
    source: Literal["pwa", "feishu", "cron", "manual"] = "manual"
    provider: Optional[str] = Field(default=None, max_length=64)   # one-shot LLM override
    # PWA 提交时附带的上传文件绝对路径(从 POST /uploads/{ws} 拿到)。后端会校验
    # 每个 path 必须在 UPLOADS_DIR/<workspace>/ 子树下(防路径穿越),然后 append
    # 到 prompt 末尾 `(附件: p1, p2)`,让 claude CLI 自己识别走 Read / vision。
    # max_length=10 是为了避免恶意提交超长列表把 argv 撑爆。
    attachments: Optional[list[str]] = Field(default=None, max_length=10)


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
    # Reject concurrent submits in the same workspace. Two claude --resume
    # processes hitting the same session_key would race each other (claude
    # has no internal lock on session-id reuse), and the second one's
    # output is at best confusing, at worst written over the first's.
    # Single-workspace single-flight matches a chat UX anyway — you don't
    # send turn N+1 while turn N is still streaming.
    in_flight = db.active_in_workspace(req.workspace)
    if in_flight:
        active = in_flight[0]
        raise HTTPException(
            status_code=409,
            detail={
                "error": "workspace_busy",
                "active_run_id": active["id"],
                "since": active.get("started_at"),
                "msg": (
                    f"workspace 「{req.workspace}」 已经有 1 个 run 在跑 "
                    f"(id={active['id'][:8]})。"
                ),
                "hint": "PWA 会自动排队 — 不需要手动操作;若卡死要终止,点 Fix 跳到 run 详情 cancel。",
                "fixUrl": f"#runs/{active['id']}",
                "fixLabel": "Run detail",
            },
        )
    final_prompt = req.prompt
    if req.attachments:
        # 校验每个 path:必须绝对路径、存在、且在 UPLOADS_DIR/<workspace>/
        # 子树下。第 3 条防"用户传 ../../../etc/passwd 让 claude 读"。
        ws_uploads = (config.UPLOADS_DIR / req.workspace).resolve()
        validated: list[str] = []
        for p in req.attachments:
            try:
                path = Path(p).resolve(strict=True)
            except (OSError, RuntimeError) as e:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "attachment_invalid", "msg": f"path 不存在或无法访问: {p} ({e})"},
                )
            if not path.is_file():
                raise HTTPException(
                    status_code=400,
                    detail={"error": "attachment_not_file", "msg": f"不是文件: {p}"},
                )
            try:
                path.relative_to(ws_uploads)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "attachment_outside_uploads",
                        "msg": f"attachment 必须在 {ws_uploads}/ 下,不能用别处的路径: {p}",
                    },
                )
            validated.append(str(path))
        # claude CLI 不需要 @ 前缀 — 它能识别 prompt 文本里出现的绝对路径,自己
        # 决定走 Read tool / vision(.png/.jpg 自动 vision)。用中文括号是为了
        # 跟 prompt 文本视觉区分;claude 不在意。
        final_prompt = f"{req.prompt}\n\n(附件: {', '.join(validated)})"

    run_id = db.new_run_id()
    runner.submit(
        run_id=run_id,
        workspace=req.workspace,
        prompt=final_prompt,
        engine=ws_settings.engine_for(req.workspace),
        session_key=req.session_key,
        source=req.source,
        provider=ws_settings.provider_for(req.workspace, req.provider),
        permission_mode=ws_settings.permission_mode_for(req.workspace),
        trust=ws_settings.trust_for(req.workspace),
    )
    return {"task_id": run_id, "status": "queued"}


# ---------- PWA 上传文件 (multipart) → ~/.cc-state/uploads/<ws>/<turn>/ ----------

# 文件名清洗白名单:中英数字 + . _ -。不在白名单里的字符全部替换成 _,
# 避免 shell-special / 路径穿越字符。注意:即使后端不走 shell(subprocess argv
# 直接传),保守清洗成本极低、收益是"prompt 里看到的路径永远是 ASCII/中文",
# 后续如果有人 grep 日志 / cat 路径不会被特殊字符卡。
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._一-鿿-]")
# workspace 名校验:跟 RunRequest.workspace 同款约束(避免 ../ 之类直接走进 ws 目录)
_WS_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_UPLOAD_MAX_BYTES = 10 * 1024 * 1024   # 10 MB 单请求合计上限,跟 nginx location 对齐


def _safe_filename(name: str) -> str:
    """把上传文件名清洗成只含白名单字符。空 / 全被滤掉 → 给个 fallback 名。"""
    base = Path(name).name   # 去掉 ../ 之类
    cleaned = _SAFE_FILENAME_RE.sub("_", base).strip("._")
    return cleaned or "file"


@app.post("/uploads/{workspace}", dependencies=PROTECT)
async def post_uploads(workspace: str, files: list[UploadFile] = File(...)) -> dict:
    """接 PWA 输入框旁 📎 上传的文件,落到 ~/.cc-state/uploads/<ws>/<turn>/。

    返回 {"turn_id": <12-hex>, "paths": [<abs path>, ...]}。前端把这些 path
    塞进 /run 的 attachments 字段,后端会 append 到 prompt 末尾。

    单请求合计 10 MB 上限(同 nginx /uploads location 的 client_max_body_size)。
    超限或写盘失败会清掉这次的半成品目录,抛 413 / 500,前端用 toast 提示。
    """
    if not _WS_NAME_RE.match(workspace):
        raise HTTPException(status_code=400, detail={"error": "workspace_invalid"})
    # workspace 必须真实存在,避免被恶意当作"随便建目录"的入口
    if not (config.WORKSPACES_DIR / workspace).is_dir():
        raise HTTPException(status_code=404, detail={"error": "workspace_not_found"})
    if not files:
        raise HTTPException(status_code=400, detail={"error": "no_files"})

    turn_id = uuid.uuid4().hex[:12]
    dest_dir = config.UPLOADS_DIR / workspace / turn_id
    try:
        dest_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    except OSError as e:
        raise HTTPException(status_code=500, detail={"error": "mkdir_failed", "msg": str(e)})

    paths: list[str] = []
    total = 0
    seen_names: dict[str, int] = {}
    try:
        for upload in files:
            safe = _safe_filename(upload.filename or "file")
            # 同次上传同名 → 后缀 -2 / -3 ...
            count = seen_names.get(safe, 0) + 1
            seen_names[safe] = count
            if count > 1:
                stem = Path(safe).stem
                ext = Path(safe).suffix
                safe = f"{stem}-{count}{ext}"
            target = dest_dir / safe

            # 流式读 + 累加大小 + 超限即停。FastAPI UploadFile 默认 SpooledTemporaryFile,
            # 大文件不会一次性塞内存,但我们还要做 hard cap 避免单个 file 撑爆 10 MB。
            with open(target, "wb") as fh:
                while chunk := await upload.read(64 * 1024):
                    total += len(chunk)
                    if total > _UPLOAD_MAX_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail={
                                "error": "too_large",
                                "msg": f"上传文件合计超过 {_UPLOAD_MAX_BYTES // (1024*1024)} MB",
                                "hint": "拆几次小批量上传,或者大文件 scp 到服务器再用 path 引用。",
                            },
                        )
                    fh.write(chunk)
            os.chmod(target, 0o600)
            paths.append(str(target))
    except HTTPException:
        # 主动抛的(too_large),清掉半成品后透传
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise
    except OSError as e:
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail={"error": "write_failed", "msg": str(e)})

    return {"turn_id": turn_id, "paths": paths}


@app.get("/runs/{task_id}/tail", dependencies=PROTECT)
def tail_run(task_id: str, lines: int = 50) -> dict:
    """Return the most recent N lines from this run's live stream jsonl.

    Used by run-detail's "Live output" panel so the user can tell whether
    claude is actually doing something or has hung. Stream file is
    written by agent-run.sh at ${LOGS_DIR}/run-${CCW_RUN_ID}.stream.jsonl
    when CCW_RUN_ID is set (always, when invoked via backend).

    Response shape:
      {
        exists: bool,                  # stream file present at all
        size: int,                     # bytes (useful for "is it growing?")
        mtime: float,                  # last-modified unix ts
        seconds_since_update: float,   # now - mtime (UI shows "Xs ago")
        lines: list[str]               # last `lines` jsonl lines (raw)
      }
    """
    # Live-tail polling uses small N (40). Run-detail "Transcript" panel
    # fetches once with a large N to render the full per-run conversation
    # after the run finishes. Cap 5000 is more than any realistic claude
    # session (typical: 20-100 jsonl events even for long tasks).
    if lines < 1 or lines > 5000:
        raise HTTPException(400, {"error": "lines must be 1..5000"})
    row = db.get_run(task_id)
    if row is None:
        raise HTTPException(404, {"error": "run not found", "id": task_id})

    path = config.STATE_DIR / "logs" / f"run-{task_id}.stream.jsonl"
    if not path.is_file():
        return {"exists": False, "size": 0, "mtime": 0, "seconds_since_update": 0, "lines": []}

    try:
        st = path.stat()
        # Read tail efficiently for small N. The stream rarely exceeds a
        # few MB; full read + slice is fine and avoids seek-from-end
        # complexity. If this ever shows up in profiles, switch to
        # reverse seek.
        all_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        raise HTTPException(500, {"error": f"stream unreadable: {e}"})

    import time as _t
    return {
        "exists": True,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "seconds_since_update": max(0.0, _t.time() - st.st_mtime),
        "lines": all_lines[-lines:],
    }


@app.post("/runs/{task_id}/cancel", dependencies=PROTECT)
def cancel_run(task_id: str) -> dict:
    """SIGTERM a running agent-run subprocess.

    The PWA shows a cancel button only for runs that have been 'running'
    > 5 min (see app.js timeline rendering) — short-runs aren't worth
    interrupting and the button would be misclick bait. Backend doesn't
    enforce the 5-min gate; the UI does.

    The kill is sent to the whole process group so claude + any tool
    subprocesses (npm test, vitest, etc.) all go down. agent-run's
    EXIT trap then releases its flock slot. The runner thread's
    proc.communicate() returns shortly after, with a negative exit code
    (e.g. -15 for SIGTERM), and runs.db finally moves to 'failed'.
    """
    row = db.get_run(task_id)
    if row is None:
        raise HTTPException(404, {"error": "run not found", "id": task_id})
    if row.get("status") not in ("running", "queued"):
        raise HTTPException(
            409,
            {
                "error": "not_cancellable",
                "msg": f"run is already {row.get('status')!r}, nothing to cancel",
            },
        )
    result = runner.cancel(task_id)
    if not result.get("ok"):
        # 409 instead of 500: the situation is "you asked to cancel
        # something that's not actually running" — caller error, not
        # server crash. Message tells which sub-case.
        raise HTTPException(409, {"error": result.get("code"), "msg": result.get("msg")})
    return result


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
    # Engine is set ONCE at creation time. Field accepted for backward
    # compat with older clients / cron entries; only "claude" is supported
    # since 2026-05-14 (codex support removed; see README "engine 现状").
    engine: Literal["claude"] = "claude"
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


def _save_providers_json(data: dict) -> None:
    """Atomic write — temp file + rename so partial writes don't corrupt the file.
    Used by POST/PUT/DELETE /providers endpoints。"""
    tmp = config.PROVIDERS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(config.PROVIDERS_FILE)


def _list_provider_names() -> list[str]:
    """Provider names that the backend can actually drive — i.e. with non-empty env.

    Empty-env profiles like the default `claude` slot map to "use anthropic
    local OAuth from agent-run.sh"; the backend (llm.py) can't talk to them
    directly because there's no API key. So we omit them from the dropdown.
    Users who want anthropic-OAuth still get it as the global config.toml
    fallback when no per-workspace override is set.

    Internal helper — used by RunRequest / NewWorkspaceRequest provider
    validators (set membership check). GET /providers endpoint returns
    list[dict] for the PWA settings page,不能直接给 set() 用。
    """
    profiles = _load_providers_json().get("profiles") or {}
    return sorted(name for name, p in profiles.items() if (p.get("env") or {}))


def _mask_key(token: str) -> str:
    """Mask API key for display:show first 4 + last 4, middle ***。短 key 全 mask。"""
    if not token:
        return ""
    if len(token) <= 8:
        return "*" * len(token)
    return f"{token[:4]}***{token[-4:]}"


@app.get("/providers", dependencies=PROTECT)
def list_providers() -> list[dict]:
    """List all providers with masked API keys for PWA settings page.

    每个 entry:{name, is_default, base_url, model, key_masked, has_key}。
    is_default 标记 config.toml#provider 当前默认 — UI 用来防止删 default。
    """
    profiles = _load_providers_json().get("profiles") or {}
    cfg_default = (config.load_config() or {}).get("provider", "")
    out = []
    for name, p in sorted(profiles.items()):
        env = p.get("env") or {}
        if not env:
            continue
        token = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""
        out.append({
            "name": name,
            "is_default": name == cfg_default,
            "base_url": env.get("ANTHROPIC_BASE_URL", ""),
            "model": env.get("ANTHROPIC_MODEL", ""),
            "key_masked": _mask_key(token),
            "has_key": bool(token),
        })
    return out


# ---------- providers CRUD + test ----------
# PWA #settings/providers 页面用。当前 providers.json 唯一改的入口除了 ssh 就是
# 这里;agent-run.sh 和 backend.llm 都只读不写,所以并发风险只来自"用户同时
# 在两个 tab 改"—— 单用户场景不会发生,_save_providers_json 用 temp+rename
# atomic write 已经足够。


class ProviderForm(BaseModel):
    """Form payload for POST/PUT /providers。

    api_key 空字符串在 PUT 时表示"不改 key",POST 时报 400(新建必须给 key)。
    name pattern 跟其他 name field 一致 — 字母数字 + . _ -,避免路径 / shell 问题。
    """
    name: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    base_url: str = Field(..., min_length=1, max_length=256)
    model: str = Field(..., min_length=1, max_length=128)
    api_key: str = Field(default="", max_length=512)


@app.post("/providers", dependencies=PROTECT)
def add_provider(req: ProviderForm) -> dict:
    if not req.api_key:
        raise HTTPException(400, {"error": "api_key_required", "msg": "新建 provider 必须填 API key"})
    data = _load_providers_json()
    profiles = data.setdefault("profiles", {})
    if req.name in profiles:
        raise HTTPException(409, {"error": "exists", "msg": f"provider {req.name!r} 已存在,用 PUT 改"})
    profiles[req.name] = {
        "env": {
            "ANTHROPIC_BASE_URL": req.base_url,
            "ANTHROPIC_AUTH_TOKEN": req.api_key,
            "ANTHROPIC_MODEL": req.model,
        },
    }
    try:
        _save_providers_json(data)
    except OSError as e:
        raise HTTPException(500, {"error": "write_failed", "msg": str(e)})
    return {"ok": True}


@app.put("/providers/{name}", dependencies=PROTECT)
def update_provider(name: str, req: ProviderForm) -> dict:
    if name != req.name:
        raise HTTPException(400, {"error": "name_mismatch", "msg": "URL 里的 name 必须跟 body.name 一致"})
    data = _load_providers_json()
    profiles = data.setdefault("profiles", {})
    if name not in profiles:
        raise HTTPException(404, {"error": "not_found"})
    env = profiles[name].setdefault("env", {})
    env["ANTHROPIC_BASE_URL"] = req.base_url
    env["ANTHROPIC_MODEL"] = req.model
    if req.api_key:
        # 空字符串 = 不改 key(原值保留)。非空 = 覆盖。
        env["ANTHROPIC_AUTH_TOKEN"] = req.api_key
        # 兼容:历史 profile 可能用 ANTHROPIC_API_KEY,一起更新避免出现两个不同
        # 的 key。新 profile 不会再写 ANTHROPIC_API_KEY,只用 ANTHROPIC_AUTH_TOKEN。
        if "ANTHROPIC_API_KEY" in env:
            env["ANTHROPIC_API_KEY"] = req.api_key
    try:
        _save_providers_json(data)
    except OSError as e:
        raise HTTPException(500, {"error": "write_failed", "msg": str(e)})
    return {"ok": True}


@app.delete("/providers/{name}", dependencies=PROTECT)
def delete_provider(name: str) -> dict:
    data = _load_providers_json()
    profiles = data.get("profiles") or {}
    if name not in profiles:
        raise HTTPException(404, {"error": "not_found"})
    cfg_default = (config.load_config() or {}).get("provider", "")
    if cfg_default == name:
        raise HTTPException(
            400,
            {"error": "is_default",
             "msg": f"{name!r} 是当前 default provider,不能删",
             "hint": "ssh 改 ~/.cc-workflow/config.toml 的 provider 字段指向另一个 provider,然后回来删。"},
        )
    del profiles[name]
    try:
        _save_providers_json(data)
    except OSError as e:
        raise HTTPException(500, {"error": "write_failed", "msg": str(e)})
    return {"ok": True}


@app.post("/providers/{name}/test", dependencies=PROTECT)
def test_provider(name: str) -> dict:
    """Try one LLM call to verify connectivity。返回 {ok, reply, model}。
    HTTP error → 502 + detail.detail 含 raw,让前端 toast 显示具体问题。"""
    profiles = _load_providers_json().get("profiles") or {}
    if name not in profiles:
        raise HTTPException(404, {"error": "not_found"})
    try:
        reply = llm.complete(
            "reply with just OK",
            # max_tokens=256(不是 16)是因为 reasoning model(deepseek-v4-pro /
            # claude opus thinking / o1 等)需要先 thinking 才出 text,16 不够
            # 跑完 thinking,response 只有 thinking block 没 text → 报"no
            # recognizable text content"。256 对 reasoning model 也足够 thinking
            # + 输出"OK"。
            max_tokens=256,
            # timeout=30 是因为 reasoning model 推理慢,15s 经常打不进 / 截断
            timeout=30,
            profile_name=name,
        )
    except RuntimeError as e:
        raise HTTPException(502, {
            "error": "test_failed",
            "detail": str(e),
            "msg": f"调用 provider {name!r} 失败",
            "hint": "检查 base_url 能否访问 / API key 是否过期 / model 名是否拼对 / 余额是否充足。",
            "fixUrl": "#settings/providers",
            "fixLabel": f"Edit {name}",
        })
    return {"ok": True, "reply": reply, "name": name}


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


# NOTE: GET /providers/codex + _valid_providers_for_engine removed
# 2026-05-14 when codex was dropped from the supported engine list.
# Provider validation below now uses list_providers() directly.


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

    # Validate provider name against providers.json#profiles keys (claude
    # is currently the only supported engine; codex was removed 2026-05-14).
    if body.provider is not None and body.provider != "":
        valid = set(_list_provider_names())
        if body.provider not in valid:
            raise HTTPException(
                400,
                {"error": "unknown provider", "got": body.provider, "valid": sorted(valid)},
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
        if body.trust is None:
            current.pop("trust", None)              # null → revert to default
        else:
            current["trust"] = bool(body.trust)

    if current:
        data[name] = current
    else:
        data.pop(name, None)
    ws_settings.save(data)
    # No claude-settings sync needed here: allow rules are global (see
    # sync_global_allow_rules in ws_settings.py), and trust=on/off
    # differentiation happens in the PreToolUse hook via CCW_TRUST env
    # at run-spawn time. Was: per-workspace settings.local.json sync
    # (removed 2026-05-15).
    return current


@app.post("/workspaces/{name}/pull", dependencies=PROTECT)
def pull_workspace(name: str) -> dict:
    """两步 pull:先把 origin 拉进主 worktree 的 main,再把 PWA session 的
    cc/* 分支 rebase 到新 main 上 —— 让 claude 下次跑能看到 upstream 的
    新代码。

    背景:PWA session 跑在 ~/workspaces/.wt/<name>-pwa-<name>/ 这个独立
    worktree 上(agent-run.sh:354 worktree 隔离),分支是
    cc/<name>-pwa-<name>。如果只 pull 主 worktree,worktree 的工作目录
    还停在老 commit,claude 看不到刚拉的更新。

    流程:
      1. git -C ~/workspaces/<name> pull --ff-only(主 worktree,跟之前一样)
         失败直接抛 —— 主线没动就别动 worktree
      2. 若 .wt/<name>-pwa-<name>/ 存在:
         git -C <worktree> rebase main —— 把主上新增的 commit 平铺进
         worktree 分支的 base。冲突就 --abort 留干净状态,warning 返回。

    Fast-forward-only on main:跟之前一样,merge 冲突 silent-merge-commit
    比 "branch diverged" 错误难 debug 得多。

    Returns:
      { ok, workspace, summary, stdout, stderr,
        worktree_rebase_ok, worktree_msg }
    main pull 失败:抛 4xx;worktree rebase 失败:ok=True + worktree_rebase_ok=False
    (主线已经拉成功了,worktree 失败不该把整体当失败)。
    """
    # Path-traversal + existence guard. Reuse the discover helper so this
    # endpoint can't be tricked into running git outside ~/workspaces/.
    from . import ui_cards
    known = set(ui_cards._discover_workspaces())
    if name not in known:
        raise HTTPException(404, {"error": "workspace not found", "name": name})

    target = config.WORKSPACES_DIR / name
    if not (target / ".git").exists():
        raise HTTPException(
            400,
            {"error": "not a git repo (no .git/ inside workspace)", "name": name},
        )

    import subprocess

    def _git(cwd, args, timeout=60):
        try:
            p = subprocess.run(
                ["git", "-C", str(cwd), *args],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
            return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
        except subprocess.TimeoutExpired:
            return 124, "", f"git {args[0]} timed out ({timeout}s)"
        except OSError as e:
            return 127, "", f"git not runnable: {e}"

    # === Step 1: pull 主 worktree ===
    rc, stdout, stderr = _git(target, ["pull", "--ff-only"])
    if rc != 0:
        raise HTTPException(
            400,
            {
                "error": "git_pull_failed",
                "msg": stderr or stdout or f"git pull exit {rc}",
                "stdout": stdout,
                "stderr": stderr,
            },
        )

    # git pull's success output is multi-line; pull the most informative
    # one-liner for the toast. Typical cases:
    #   "Already up to date." → that exact string
    #   "Updating <sha>..<sha>\n Fast-forward\n ... files changed ..." → keep the "Fast-forward" line
    summary = "Already up to date."
    for line in stdout.splitlines():
        if "Already up to date" in line:
            summary = line.strip()
            break
        if line.lstrip().startswith(("Updating ", "Fast-forward", "From ")):
            summary = line.strip()
            # Don't break — let later "X files changed" overwrite if present
    # If stdout had "Updating" + "X files changed", prefer the latter for
    # the toast since it's more informative.
    for line in stdout.splitlines():
        if "file" in line and "changed" in line:
            summary = line.strip()
            break

    # === Step 2: rebase PWA worktree 的 cc/* 分支到新 main ===
    # 命名跟 agent-run.sh 一致(session_key="pwa-<ws>", SESSION_SAFE=
    # 同名因为只有 ASCII)。
    session_key = f"pwa-{name}"
    worktree_path = config.WORKSPACES_DIR / ".wt" / f"{name}-{session_key}"
    worktree_rebase_ok = True
    worktree_msg = ""

    if worktree_path.exists():
        # 拿 main 的实际分支名(可能是 main / master)
        rc, head, _ = _git(target, ["rev-parse", "--abbrev-ref", "HEAD"])
        main_branch = head or "main"

        rc, out, err = _git(worktree_path, ["rebase", main_branch])
        if rc == 0:
            # 静默成功别填 msg 也行,但 toast 想看到 "session worktree 同步了"
            # 这条信号,挑一行简短描述。
            for line in out.splitlines():
                if line.startswith(("Successfully rebased", "Current branch")):
                    worktree_msg = line.strip()
                    break
            if not worktree_msg:
                worktree_msg = f"session worktree rebased onto {main_branch}"
        else:
            # 冲突就 --abort 留干净状态,reset 不算整体失败
            _git(worktree_path, ["rebase", "--abort"])
            worktree_rebase_ok = False
            worktree_msg = f"rebase conflict on session worktree — resolve via ssh: {(err or out)[:200]}"
    else:
        worktree_msg = "no PWA session worktree yet (nothing to sync)"

    return {
        "ok": True,
        "workspace": name,
        "summary": summary,
        "stdout": stdout,
        "stderr": stderr,
        "worktree_rebase_ok": worktree_rebase_ok,
        "worktree_msg": worktree_msg,
    }


@app.post("/workspaces/{name}/merge-session-branch", dependencies=PROTECT)
def merge_session_branch(name: str, body: dict = Body(default={})) -> dict:
    """Rebase 当前 PWA session 的 cc/* 分支到 main,fast-forward 合进 main,然后 push。

    背景:agent-run.sh 在 session_key != "default" 时会建独立 worktree +
    `cc/<ws>-<session_safe>` 分支(见 PRD §A8 worktree 隔离),PWA 默认
    session_key = `pwa-<ws>`,所以 PWA 里 claude 做的 commit 都困在
    cc/* 分支不进 main。这个端点给 PWA ⚙ menu 的 "Merge to main" 按钮
    用,一键把 cc/* 推到 main + remote。

    流程(用户选的:rebase + ff-merge + auto-push,保留 cc/* 分支):
      1. 校验 worktree 在(否则没东西可 merge)
      2. 校验 main worktree 干净(uncommitted changes 不动手)
      3. 在 worktree 里 `git rebase main` 把 cc/* 平铺到 main 上
         —— 失败就 `--abort`,返回 conflict 错误让用户 ssh 处理
      4. 在 main worktree 里 `git merge --ff-only <branch>` —— rebase 之后
         必然能 ff
      5. `git push origin <main_branch>`,失败不算整体失败:本地已并入
         main,push 失败只表示推 remote 没成,返回 push_ok=False 让用户
         看到
      6. **cc/* 分支保留**,下一轮 PWA session 继续在同一个 worktree 上
         append commit
    """
    from . import ui_cards
    known = set(ui_cards._discover_workspaces())
    if name not in known:
        raise HTTPException(404, {"error": "workspace not found", "name": name})

    target = config.WORKSPACES_DIR / name
    if not (target / ".git").exists():
        raise HTTPException(400, {"error": "not a git repo", "name": name})

    # session_key 来源:body 里给就用 body 的,否则默认 PWA 用的 `pwa-<ws>`。
    # 跟 agent-run.sh 的 session_safe 处理保持一致(非 [A-Za-z0-9._-] 替成 _)。
    import re
    session_key = (body or {}).get("session_key") or f"pwa-{name}"
    session_safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_key)
    branch_name = f"cc/{name}-{session_safe}"
    worktree_path = config.WORKSPACES_DIR / ".wt" / f"{name}-{session_safe}"

    if not worktree_path.exists():
        raise HTTPException(
            400,
            {"error": "no_worktree", "msg": f"no worktree at {worktree_path} — this session has no claude work to merge yet"},
        )

    import subprocess

    def _git(cwd, args, timeout=60):
        try:
            p = subprocess.run(
                ["git", "-C", str(cwd), *args],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
            return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
        except subprocess.TimeoutExpired:
            return 124, "", f"git {args[0]} timed out ({timeout}s)"
        except OSError as e:
            return 127, "", f"git not runnable: {e}"

    # 1. main worktree 干净?
    rc, out, err = _git(target, ["status", "--porcelain"])
    if rc != 0:
        raise HTTPException(500, {"error": "git_status_failed", "msg": err or out})
    if out:
        raise HTTPException(
            400,
            {"error": "main_dirty", "msg": "main worktree has uncommitted changes; resolve via ssh first"},
        )

    # 拿 main 实际分支名(可能是 main / master / 别的),用来做 rebase
    # 目标和 push refspec。
    rc, out, err = _git(target, ["rev-parse", "--abbrev-ref", "HEAD"])
    if rc != 0:
        raise HTTPException(500, {"error": "git_head_failed", "msg": err})
    main_branch = out or "main"

    # 2. 在 worktree 里把 cc/* rebase 到 main 上。
    rc, out, err = _git(worktree_path, ["rebase", main_branch])
    if rc != 0:
        # 留个干净的状态再返回,免得用户下次进 PWA 看到一个半 rebase
        # 的工作目录又得 ssh 救场。
        _git(worktree_path, ["rebase", "--abort"])
        raise HTTPException(
            400,
            {
                "error": "rebase_conflict",
                "msg": f"rebase {branch_name} onto {main_branch} failed (likely conflict). Aborted. err: {(err or out)[:500]}",
            },
        )

    # 3. ff-merge cc/* 进 main(rebase 后必然能 ff)。
    rc, out, err = _git(target, ["merge", "--ff-only", branch_name])
    if rc != 0:
        raise HTTPException(
            500,
            {"error": "ff_merge_failed", "msg": (err or out)[:500]},
        )

    # 4. push。失败不抛 500,返回 push_ok=False 让前端 toast 区分"已经
    # 进 main 但没推 remote"和"完全失败"。
    rc, out, err = _git(target, ["push", "origin", main_branch], timeout=120)
    push_ok = (rc == 0)

    return {
        "ok": True,
        "workspace": name,
        "branch": branch_name,
        "main_branch": main_branch,
        "push_ok": push_ok,
        "push_msg": (err or out)[:500] if not push_ok else "",
    }


@app.delete("/workspaces/{name}/session", dependencies=PROTECT)
def reset_workspace_session(name: str) -> dict:
    """Reset the PWA's conversation session for this workspace.

    Drops ~/.cc-state/sessions.json[pwa-<name>] (the row containing
    claude_session_id + the token-tracking last_input_tokens used by
    DIY compact). Next agent-run for this workspace starts a fresh
    session with no --resume.

    Does NOT touch cron loops' or Feishu chats' sessions — those use
    different session_keys.
    """
    target = config.WORKSPACES_DIR / name
    if not (target / ".git").exists():
        raise HTTPException(404, {"error": "workspace not found", "name": name})

    key = f"pwa-{name}"
    cleared: list[str] = []

    try:
        if config.SESSIONS_FILE.exists():
            data = json.loads(config.SESSIONS_FILE.read_text(encoding="utf-8"))
            if key in data:
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

    # 真删 runs.db 里这条 PWA 会话的所有 run + 对应的 stream-jsonl
    # log 文件。设计图 §3.1:"旧 turn 立刻从 UI 消失,不留痕迹"。
    # cron / 飞书 session_key 不一样,他们的历史 run 不受影响。
    deleted_ids = db.delete_runs_for_session(name, key)
    if deleted_ids:
        logs_dir = config.STATE_DIR / "logs"
        for rid in deleted_ids:
            log_path = logs_dir / f"run-{rid}.stream.jsonl"
            try:
                log_path.unlink(missing_ok=True)
            except OSError:
                # 删 log 文件失败不算 reset 失败 —— db 行才是真相,孤儿
                # log 留着不影响 UI(没了 db 行 /tail 就 404)。
                pass
        cleared.append(f"{len(deleted_ids)} runs")

    return {"ok": True, "workspace": name, "session_key": key, "cleared": cleared}


@app.delete("/workspaces/{name}", dependencies=PROTECT)
def delete_workspace(name: str) -> dict:
    """Hard-delete a workspace.

    Removes three things:
      1. ~/workspaces/<name>/ directory (rm -rf — code, git history, all)
      2. workspaces.json entry (provider / engine / trust)
      3. sessions.json entry for `pwa-<name>` (claude session_id +
         last_input_tokens used by DIY compact)

    Does NOT touch:
      - cron loops referencing this workspace (they'll start failing
        once the dir is gone — user should delete the loop separately)
      - feishu chat-to-workspace mappings in feishu_chats.json
        (harmless — `/use` simply binds a name that no longer resolves)

    Path-traversal guard: regex on name + resolved-path-is-under-
    WORKSPACES_DIR check (defense in depth).

    404 only when nothing was found to clean (no dir, no settings, no
    session — i.e. it's already fully gone or never existed).
    """
    if not re.match(r"^[A-Za-z0-9._\-]+$", name):
        raise HTTPException(400, {"error": "invalid workspace name"})

    target = config.WORKSPACES_DIR / name
    try:
        resolved = target.resolve()
        ws_root = config.WORKSPACES_DIR.resolve()
        # 3.9+: is_relative_to; on older Pythons we'd need a try/except on relative_to
        if not resolved.is_relative_to(ws_root):
            raise HTTPException(400, {"error": "path escapes WORKSPACES_DIR", "name": name})
    except FileNotFoundError:
        # target doesn't exist — that's fine, we still try to clean settings/sessions
        pass

    cleaned: list[str] = []

    # 1. Remove the directory tree
    if target.exists():
        try:
            shutil.rmtree(target)
            cleaned.append("workspace_dir")
        except OSError as e:
            raise HTTPException(500, {"error": f"rm -rf failed: {e}"})

    # 2. Remove the workspaces.json entry
    settings = ws_settings.load()
    if name in settings:
        del settings[name]
        ws_settings.save(settings)
        cleaned.append("workspaces.json")

    # 3. Remove the sessions.json row for pwa-<name>
    try:
        if config.SESSIONS_FILE.exists():
            data = json.loads(config.SESSIONS_FILE.read_text(encoding="utf-8"))
            key = f"pwa-{name}"
            if key in data:
                del data[key]
                tmp = config.SESSIONS_FILE.with_suffix(".tmp")
                tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, config.SESSIONS_FILE)
                cleaned.append("sessions.json")
    except (OSError, json.JSONDecodeError):
        # Non-fatal — the workspace dir is already gone, sessions.json
        # leftover is harmless (just an orphan claude_session_id).
        pass

    # 4. Drop run history from runs.db. Without this, the /sessions
    # endpoint still returns historic rows tagged workspace=<name>, and
    # PWA's groupByWorkspace would resurrect a phantom card from them.
    try:
        n = db.delete_runs_for_workspace(name)
        if n > 0:
            cleaned.append(f"runs.db ({n} rows)")
    except Exception:  # noqa: BLE001 — never fail the delete because of db cleanup
        pass

    # Tolerant: even if nothing was actually found (dir gone, no settings,
    # no session), return 200 with cleaned=[]. The PWA's card might be
    # stale (3s polling delay between filesystem rm and refresh) — the
    # user already wanted this workspace gone; "404 / Not Found" is
    # surprising UX when the answer is "yeah, it's already gone".
    # PWA decides the toast wording based on len(cleaned).
    return {"ok": True, "name": name, "cleaned": cleaned}


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
    if req.provider:
        valid = set(_list_provider_names())
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

    # Save settings. Engine is always written ("claude" only — codex removed
    # 2026-05-14) so engine_for() doesn't have to fall back to DEFAULT_ENGINE.
    data = ws_settings.load()
    settings = data.get(req.name, {})
    if req.provider:
        settings["provider"] = req.provider
    settings["engine"] = req.engine
    if req.trust is not None:
        settings["trust"] = bool(req.trust)
    # If req.trust is None we DON'T write anything — trust_for() will
    # fall back to config.toml default_trust at runtime. Avoids freezing
    # the current global default into the workspace.
    data[req.name] = settings
    ws_settings.save(data)
    # No per-workspace claude-settings sync — allow rules live globally
    # in ~/.claude/settings.json (planted at backend startup via
    # sync_global_allow_rules). Trust=on/off is decided per-run by the
    # PreToolUse hook reading CCW_TRUST.

    return {
        "ok": True, "name": req.name, "path": str(target),
        "provider": req.provider, "engine": req.engine, "trust": req.trust,
    }


# ---------- /search(全文搜索历史 runs 的 prompt + output)----------
# D 改造(易用性 §3):跑几百次 run 后,想找回"上周跟 claude 讨论过 X"那条,
# 需要全文搜索。LIKE 实现(KISS,见 db.search_runs docstring)。

@app.get("/search", dependencies=PROTECT)
def search_runs(q: str = "", limit: int = 50) -> list[dict]:
    if limit < 1 or limit > 200:
        raise HTTPException(400, {"error": "limit_out_of_range",
                                  "msg": "limit 必须在 1..200",
                                  "hint": "默认 50 通常够用,翻页交给前端 query 二次过滤"})
    return db.search_runs(q, limit=limit)


# ---------- /loops (T+1d — P0-2 + P0-3 后半) ----------
# pause/resume only writes the `enabled` field in jobs/<name>.json. Actual
# enforcement (agent-run early-exits when enabled=false) is Phase 3 / P0-7g.


@app.get("/loops", dependencies=PROTECT)
def get_loops() -> list[dict]:
    """List cron loops + enrich each with up to 5 most recent runs.

    `recent_runs` is a list of {id, status, finished_at, exit_code}
    dicts in newest-first order, joined from runs.db. The PWA renders
    this as a foldout history under each cron card so users can open
    the right one when there are several recent fires (P0-6f).

    Back-compat: jobs predating recent_run_ids fall back to single-item
    list derived from `last_run_id`. Once they fire once after upgrade,
    the new field is populated and the fallback drops out naturally.
    """
    jobs = cron_state.list_jobs()
    for j in jobs:
        ids = j.get("recent_run_ids") or []
        if not ids and j.get("last_run_id"):
            # Bootstrap from the legacy single-id field.
            ids = [j["last_run_id"]]
        runs: list[dict] = []
        for rid in ids:
            r = db.get_run(rid)
            if r is None:
                # Run was deleted (or never made it to db); skip rather
                # than emit a {id, ...nulls} placeholder the UI can't use.
                continue
            # output_preview:跟 _RUN_SUMMARY_COLS 的 head+tail+elision
            # 语义一致的 200 char 预览,给 PWA 前端 turn 卡片的 reply
            # preview 行用。output 可能是 None / 空,兜底成空字符串。
            output = r.get("output") or ""
            if len(output) <= 200:
                output_preview = output
            else:
                output_preview = output[:100] + "\n…\n" + output[-100:]
            runs.append({
                "id": rid,
                "status": r.get("status"),
                "started_at": r.get("started_at"),
                "finished_at": r.get("finished_at"),
                "elapsed_s": r.get("elapsed_s"),
                "exit_code": r.get("exit_code"),
                "output_preview": output_preview,
            })
        j["recent_runs"] = runs
    return jobs


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


def _build_loop_on_finish(name: str, source: str):
    """Shared callback factory for /loops/{name}/run and /run/internal.

    - Always: write last_run_id into ~/.cc-state/jobs/<name>.json so the
      PWA cron card can link straight to run-detail.
    - When source=="cron": also push a reply back to Feishu (per-loop
      chat_id from job state, falling back to global cron_notify_chat).
    """
    def _on_finish(run: dict) -> None:
        # 1. Append run-id to history (also keeps last_run_id in sync
        #    for back-compat with anything still reading the old field).
        try:
            cron_state.append_recent_run_id(name, run.get("id"))
        except Exception:    # noqa: BLE001 — never crash the runner thread
            pass
        # 2. Feishu push-back (cron only — PWA "Run now" doesn't need it)
        if source == "cron":
            try:
                im_feishu.reply_from_cron_run(run, loop_name=name)
            except Exception:    # noqa: BLE001
                pass
    return _on_finish


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
        trust=ws_settings.trust_for(workspace),
        job_name=name,
        on_finish=_build_loop_on_finish(name, "pwa"),
    )
    # Link immediately so the Tasks card's "open" target is the run that
    # was just queued, not the previous completed run. on_finish writes the
    # same id again after completion; append_recent_run_id de-dups.
    try:
        cron_state.append_recent_run_id(name, run_id)
    except Exception:    # noqa: BLE001 — run has been queued; UI link failure is non-fatal
        pass
    return {"task_id": run_id, "status": "queued", "name": name}


@app.post("/loops/{name}/run/internal", status_code=202)
def run_loop_internal(name: str) -> dict:
    """Localhost-only trigger fired by /etc/cron.d/cc-loops curl lines.

    SAME submit() path as run_loop_now() — the difference is source="cron"
    (not "pwa") so the audit trail / Feishu callback can distinguish
    "user clicked Run now in PWA" vs "system cron timer expired". nginx
    denies this path to external traffic; the curl call from cron is
    same-host loopback only.

    No auth: the localhost-only boundary is enforced at the nginx layer
    (location ~ /loops/.+/run/internal { deny all; }), mirroring how
    /approvals/internal/* is gated. If you accidentally lose the nginx
    rule, the failure mode is "anyone on the internet can trigger your
    cron loops" — not catastrophic but worth flagging in a deploy
    smoke test.
    """
    jobs = cron_state.list_jobs()
    job = next((j for j in jobs if j.get("name") == name), None)
    if job is None:
        raise HTTPException(404, {"error": "loop not found", "name": name})
    workspace = job.get("workspace")
    prompt = job.get("prompt")
    engine = job.get("engine") or ws_settings.engine_for(workspace or "")
    if not workspace or not prompt:
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
        session_key=name,
        source="cron",
        provider=ws_settings.provider_for(workspace),
        permission_mode=ws_settings.permission_mode_for(workspace),
        trust=ws_settings.trust_for(workspace),
        job_name=name,
        on_finish=_build_loop_on_finish(name, "cron"),
    )
    try:
        cron_state.append_recent_run_id(name, run_id)
    except Exception:    # noqa: BLE001 — run has been queued; Feishu callback still fires later
        pass
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


# ---------- /roundtables (multi-agent debate) ----------
# 4 personas + 1 synthesizer × 3 rounds = 9 sequential LLM calls in a
# background thread. PWA polls the detail endpoint every ~2s to render
# progress. See backend/roundtable/__init__.py for the port story.


class NewRoundtableRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4096)
    # Optional per-role model override. Map role name → model name.
    # Missing roles fall back to that role's preferred_model in roles.py.
    # Validated server-side against MODEL_ENDPOINTS — see create_roundtable.
    role_models: Optional[dict[str, str]] = None
    # Number of critique rounds. 1 = current behavior (R2 only).
    # 2 = R2 + R3 deep-dive (empirically validated worth shipping;
    #     adds ~45s wall clock per session). Higher values rejected —
    #     N≥3 hasn't been validated and is likely to produce padded output.
    critique_rounds: int = Field(default=1, ge=1, le=2)


def _roundtable_session_summary(path: Path) -> dict:
    """Lightweight row for the list view — reads meta + counts turns
    without parsing each content field."""
    try:
        # Cheap: parse one small JSON object per turn, but never load content
        # into the detail shape. This lets list rows distinguish failed
        # sessions from merely-running ones.
        with path.open(encoding="utf-8") as f:
            head_line = f.readline()
            rest = [json.loads(line) for line in f if line.strip()]
        head = json.loads(head_line)
    except (OSError, json.JSONDecodeError):
        return {
            "id": path.stem, "question": "(unreadable)",
            "started_at": 0, "turns_done": 0, "turns_expected": 9, "status": "error",
        }
    # Expected turn count depends on critique_rounds:
    #   N=1 → 4 (R1) + 4 (R2) + 1 (synth) = 9
    #   N=2 → 4 (R1) + 4 (R2) + 4 (R3) + 1 (synth) = 13
    # Legacy jsonl (no critique_rounds in meta) defaults to N=1 → 9.
    critique_rounds = head.get("critique_rounds", 1)
    turns_expected = 4 + 4 * critique_rounds + 1
    has_error = any(rec.get("role") == "__error__" for rec in rest)
    turns_done = sum(1 for rec in rest if rec.get("role") != "__error__")
    status = "error" if has_error else (
        "done" if turns_done >= turns_expected else
        ("running" if turns_done > 0 else "queued")
    )
    return {
        "id": path.stem,
        "question": head.get("question", ""),
        "started_at": head.get("started_at", 0),
        "turns_done": turns_done,
        "turns_expected": turns_expected,
        "critique_rounds": critique_rounds,
        "status": status,
    }


@app.get("/roundtables", dependencies=PROTECT)
def list_roundtables() -> list[dict]:
    """All roundtable sessions, newest first (by filename prefix which is
    a UTC timestamp). Cheap rows — only enough for the list view."""
    d = config.ROUNDTABLES_DIR
    if not d.is_dir():
        return []
    paths = sorted(d.glob("*.jsonl"), reverse=True)
    return [_roundtable_session_summary(p) for p in paths]


@app.get("/roundtables/models", dependencies=PROTECT)
def list_roundtable_models() -> dict:
    """Surface the model registry + role defaults so the PWA can render
    a per-role model selector in the new-roundtable form.

    Returns:
      {
        "models": [{"name": "deepseek-chat", "endpoint": "deepseek"}, ...],
        "roles":  [{"name": "极简派", "default_model": "...", "kind": "persona"},
                   ..., {"name": "整理员", "default_model": "...", "kind": "synthesizer"}]
      }

    Adding a new model = append to MODEL_ENDPOINTS in model.py (code-as-
    registry). Adding a new role = edit roles.py (no schema migration).
    """
    return {
        "models": [
            {"name": m, "endpoint": ep}
            for m, ep in sorted(roundtable_model.MODEL_ENDPOINTS.items())
        ],
        "roles": [
            {"name": r.name, "default_model": r.preferred_model, "kind": "persona"}
            for r in roundtable_roles.ROLES
        ] + [
            {
                "name": roundtable_roles.SYNTHESIZER.name,
                "default_model": roundtable_roles.SYNTHESIZER.preferred_model,
                "kind": "synthesizer",
            }
        ],
    }


@app.post("/roundtables", dependencies=PROTECT, status_code=202)
def create_roundtable(req: NewRoundtableRequest) -> dict:
    """Kick off a new roundtable session. Returns immediately with the
    session id; the 9 LLM calls run in a background thread."""
    if req.role_models:
        valid_roles = (
            {r.name for r in roundtable_roles.ROLES}
            | {roundtable_roles.SYNTHESIZER.name}
        )
        for role_name, model_name in req.role_models.items():
            if role_name not in valid_roles:
                raise HTTPException(400, {"error": f"unknown role: {role_name!r}"})
            if model_name not in roundtable_model.MODEL_ENDPOINTS:
                raise HTTPException(400, {
                    "error": f"unknown model: {model_name!r}",
                    "known": sorted(roundtable_model.MODEL_ENDPOINTS),
                })
    path = roundtable_runner.submit(
        req.question.strip(),
        role_models=req.role_models,
        critique_rounds=req.critique_rounds,
    )
    return {"id": path.stem, "status": "queued", "question": req.question}


@app.get("/roundtables/{session_id}", dependencies=PROTECT)
def get_roundtable(session_id: str) -> dict:
    """Full session content for the detail view.

    Returns:
      {
        id, question, started_at, status,
        turns: [{round, role, type, content, ts}, ...],
        r3:    {raw: str, parsed: {共识点, 分歧轴, 关键判断, 条件性结论, 下一步行动}} | null,
        error: str | null,
      }
    """
    # Validate id shape — slug generation in io.py allows Unicode word chars
    # (so Chinese question titles flow through to filenames), so this
    # validator must too. Reject only the path-traversal markers: `/` and `..`.
    if "/" in session_id or ".." in session_id or session_id.startswith("."):
        raise HTTPException(400, {"error": "bad session id"})
    path = config.ROUNDTABLES_DIR / f"{session_id}.jsonl"
    if not path.is_file():
        raise HTTPException(404, {"error": "session not found", "id": session_id})
    try:
        session = roundtable_io.read_session(path)
    except (ValueError, OSError) as e:
        raise HTTPException(500, {"error": f"session unreadable: {e}"})
    # Pull synthesis + any error marker out separately for convenience.
    r3_turns = [t for t in session.turns if t.type == "synth"]
    error_turns = [t for t in session.turns if t.role == "__error__"]
    normal_turns = [t for t in session.turns if t.role != "__error__"]
    r3 = None
    if r3_turns:
        raw = r3_turns[-1].content
        r3 = {"raw": raw, "parsed": parse_synthesis(raw)}
    status = "done" if r3_turns else ("error" if error_turns else
              ("running" if normal_turns else "queued"))
    turns_expected = 4 + 4 * session.critique_rounds + 1
    return {
        "id": session_id,
        "question": session.question,
        "started_at": session.started_at,
        "status": status,
        "critique_rounds": session.critique_rounds,
        "turns_expected": turns_expected,
        "turns": [
            {"round": t.round, "role": t.role, "type": t.type, "content": t.content, "ts": t.ts}
            for t in normal_turns
        ],
        "r3": r3,
        "error": error_turns[-1].content if error_turns else None,
    }


@app.delete("/roundtables/{session_id}", dependencies=PROTECT)
def delete_roundtable(session_id: str) -> dict:
    """Remove a session file. No running-thread tracking — if you delete
    while a session is in flight, the worker's next append_turn will
    silently re-create the file (acceptable for single-user)."""
    # Same Unicode-tolerant guard as GET — see comment there.
    if "/" in session_id or ".." in session_id or session_id.startswith("."):
        raise HTTPException(400, {"error": "bad session id"})
    path = config.ROUNDTABLES_DIR / f"{session_id}.jsonl"
    if not path.is_file():
        raise HTTPException(404, {"error": "session not found", "id": session_id})
    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(500, {"error": f"delete failed: {e}"})
    return {"ok": True, "id": session_id}


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
        raise HTTPException(502, {
            "error": "llm_call_failed",
            "detail": str(e),
            "msg": "LLM 调用失败,无法解析自然语言",
            "hint": "检查 default provider 配置(config.toml#provider 指向的那个);可能 API key 过期 / base_url 不通 / model 名错。",
            "fixUrl": "#settings/providers",
            "fixLabel": "Edit providers",
        })

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
        {
            "error": "llm_did_not_return_cron",
            "raw_reply": reply,
            "msg": "LLM 没返回合法的 cron 表达式",
            "hint": "可能 LLM 模型不擅长 JSON 输出 / 你输入的描述里没有时间词。试试换 model(deepseek-chat / kimi-k2 等)或者手动填 cron 表达式。",
        },
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
    # When the run was submitted with trust=on, backend auto-approves the
    # request at creation so the hook returns ~instantly. Default false so
    # older hook versions still get the manual-prompt behavior.
    trust: bool = False


@app.post("/approvals/internal/pending")
def post_pending_approval(req: PendingApprovalRequest) -> dict:
    aid = approvals.request(
        run_id=req.run_id,
        workspace=req.workspace,
        tool_name=req.tool_name,
        tool_input=req.tool_input,
        trust=req.trust,
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


@app.get("/runs/{run_id}/approvals", dependencies=PROTECT)
def list_run_approvals(run_id: str) -> list[dict]:
    """Read-only audit trail for one run — every tool-call PreToolUse hook
    that fired during this run, including auto-approved ones under
    trust=on. PWA renders this in the run-detail "Approvals" panel so
    the user can see what claude actually did even when no approval
    prompt was surfaced."""
    return [a.public() for a in approvals.list_audit_for_run(run_id)]


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
        intent["trust"] = ws_settings.trust_for(intent["workspace"])
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


# ---------- Root redirect → PWA ----------
# The Phase 1 minimalist HTML at backend/static/index.html was deleted
# 2026-05-14 — the PWA is the sole UI now. Visiting / redirects to /pwa/.
# Not PROTECT-gated: the /pwa/ static layer is public anyway (no secrets
# in the shell), and the login page lives under it.
# GET + HEAD both — health-check tools (curl -sI, monitoring scrapers,
# load balancers) typically send HEAD; without explicit HEAD support
# FastAPI returns 405.
@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def _root() -> RedirectResponse:
    return RedirectResponse(url="/pwa/", status_code=307)


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
