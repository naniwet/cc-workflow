"""Feishu (Lark) IM adapter — webhook handler + reply sender.

Implements POST /im/feishu/webhook (dev-plan §4.2). Auth is Feishu's own
`X-Lark-Signature` scheme; this route is NOT behind basic auth.

Feishu payloads we handle:
  - url_verification         → respond with the challenge (initial setup).
  - im.message.receive_v1    → parse text, build a `run_intent` for main.py
                                to submit to runner. Reply is sent later via
                                runner's on_finish callback (reply_from_run).

Workspace parsing — MINIMAL_CHOICE text-prefix convention:
  "[repo-name] prompt..."  → workspace = "repo-name", prompt = "prompt..."
  "prompt..."               → workspace = secrets.toml [feishu].default_workspace
                               (or "test-repo")

session_key encoding: "feishu-<chat_id>" — reply_from_run reads chat_id back.

Out of scope (Phase 1):
  - Encrypted payloads — disable "加密策略" in Feishu app event subscription
  - Non-text message types (file/image/card)
  - User @ mentions — text content is used as-is

secrets.toml schema:
  [feishu]
  app_id             = "cli_xxx"
  app_secret         = "xxx"
  verification_token = "xxx"
  default_workspace  = "test-repo"   # optional
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
from typing import Optional
from urllib import error as urlerror
from urllib import request as urlreq

from . import config

FEISHU_OPENAPI = "https://open.feishu.cn/open-apis"
_PREFIX_RE = re.compile(r"^\s*\[([A-Za-z0-9._-]+)\]\s*(.+)$", re.DOTALL)


def _secrets() -> dict:
    return (config.load_secrets() or {}).get("feishu") or {}


# ---------- signature ----------


def verify_signature(body: bytes, signature: str, ts: str, nonce: str) -> bool:
    """sha256(timestamp + nonce + token + body) hex == X-Lark-Signature."""
    token = _secrets().get("verification_token", "")
    if not token or not signature or not ts:
        return False
    raw = (ts + nonce + token).encode("utf-8") + body
    expected = hashlib.sha256(raw).hexdigest()
    return hmac.compare_digest(expected, signature)


# ---------- webhook entry ----------


def handle_webhook(
    body: bytes,
    sig: Optional[str],
    ts: Optional[str],
    nonce: Optional[str],
) -> dict:
    """Return shapes (consumed by main.py):
      {"challenge": "..."}                                 url_verification
      {"ok": True, "run_intent": {...}}                    submit a run
      {"ok": True, "ignored": "<reason>"}                  no-op event
      {"error": "...", "code": <int>}                      failure
    """
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception as e:
        return {"error": f"invalid json: {e}", "code": 400}

    # url_verification does NOT carry X-Lark-Signature — bypass check.
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge", "")}

    if _secrets().get("verification_token"):
        if not verify_signature(body, sig or "", ts or "", nonce or ""):
            return {"error": "bad signature", "code": 401}

    header = payload.get("header") or {}
    event_type = header.get("event_type") or (payload.get("event") or {}).get("type", "")
    if event_type and "message.receive" in event_type:
        return _handle_message(payload)
    return {"ok": True, "ignored": event_type or "no event"}


def _handle_message(payload: dict) -> dict:
    msg = (payload.get("event") or {}).get("message") or {}
    msg_type = msg.get("message_type") or msg.get("msg_type")
    if msg_type != "text":
        return {"ok": True, "ignored": f"non-text:{msg_type}"}

    chat_id = msg.get("chat_id", "")
    raw_content = msg.get("content", "")
    # content is a JSON-encoded string: '{"text":"hello"}'
    try:
        if isinstance(raw_content, str):
            text = json.loads(raw_content).get("text", "")
        elif isinstance(raw_content, dict):
            text = raw_content.get("text", "")
        else:
            text = ""
    except Exception:
        text = raw_content if isinstance(raw_content, str) else ""
    text = (text or "").strip()
    if not text:
        return {"ok": True, "ignored": "empty"}

    workspace, prompt = _parse_workspace_prompt(text)
    return {
        "ok": True,
        "run_intent": {
            "workspace": workspace,
            "prompt": prompt,
            "engine": "claude",
            "session_key": f"feishu-{chat_id}" if chat_id else None,
            "source": "feishu",
        },
    }


def _parse_workspace_prompt(text: str) -> tuple[str, str]:
    m = _PREFIX_RE.match(text)
    if m:
        return m.group(1), m.group(2).strip()
    return _secrets().get("default_workspace") or "test-repo", text


# ---------- reply ----------


def _tenant_access_token() -> Optional[str]:
    """tenant_access_token TTL ~2h. We don't cache — replies are infrequent."""
    fs = _secrets()
    body = json.dumps(
        {"app_id": fs.get("app_id", ""), "app_secret": fs.get("app_secret", "")}
    ).encode("utf-8")
    req = urlreq.Request(
        f"{FEISHU_OPENAPI}/auth/v3/tenant_access_token/internal",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlreq.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8")).get("tenant_access_token")
    except (urlerror.URLError, json.JSONDecodeError, ValueError):
        return None


def reply_to_chat(chat_id: str, text: str) -> bool:
    if not chat_id or not text:
        return False
    token = _tenant_access_token()
    if not token:
        return False
    body = json.dumps(
        {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
    ).encode("utf-8")
    req = urlreq.Request(
        f"{FEISHU_OPENAPI}/im/v1/messages?receive_id_type=chat_id",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urlreq.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except urlerror.URLError:
        return False


def reply_from_run(run: dict) -> None:
    """runner.on_finish callback — send the run result back to the Feishu chat."""
    if not run or run.get("source") != "feishu":
        return
    sk = run.get("session_key") or ""
    if not sk.startswith("feishu-"):
        return
    chat_id = sk[len("feishu-"):]
    output = (run.get("output") or "").strip() or "(no output)"
    if len(output) > 1500:
        output = output[:1500] + "\n…(truncated)"
    summary = f"[{run.get('status', '?')} · exit {run.get('exit_code')}]\n{output}"
    reply_to_chat(chat_id, summary)
