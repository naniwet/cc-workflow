"""Feishu (Lark) IM adapter — webhook handler + reply sender.

Implements POST /im/feishu/webhook (dev-plan §4.2). Auth is Feishu's own
`X-Lark-Signature` scheme; this route is NOT behind basic auth.

Feishu payloads we handle:
  - url_verification         → respond with the challenge (initial setup).
  - im.message.receive_v1    → parse text, build a `run_intent` for main.py
                                to submit to runner. Reply is sent later via
                                runner's on_finish callback (reply_from_run).

Feishu v2 security (per official docs 加密策略):
  - Signature (X-Lark-Signature) = sha256(ts + nonce + ENCRYPT_KEY + body)
    NOTE: signing key is the Encrypt Key — NOT the Verification Token.
    Verification Token only applies to legacy v1 (where it sits inside the body).
  - When Encrypt Key is enabled, body comes as {"encrypt": "<base64>"} and must
    be AES-256-CBC-decrypted before parsing. Key = sha256(encrypt_key),
    IV = first 16 bytes of the AES cipher blob.

Workspace parsing — MINIMAL_CHOICE text-prefix convention:
  "[repo-name] prompt..."  → workspace = "repo-name", prompt = "prompt..."
  "prompt..."               → workspace = secrets.toml [feishu].default_workspace
                               (or "test-repo")

session_key encoding: "feishu-<chat_id>" — reply_from_run reads chat_id back.

Out of scope (Phase 1):
  - Non-text message types (file/image/card)
  - User @ mentions — text content is used as-is

secrets.toml schema:
  [feishu]
  app_id            = "cli_xxx"
  app_secret        = "xxx"
  encrypt_key       = "xxx"           # from 飞书 → 事件订阅 → 加密策略 (enabled)
  default_workspace = "test-repo"     # optional

config.toml schema (for the long-output PWA link in reply_from_run):
  pwa_base_url      = "https://your-server.example.com"
  # Used in the truncation footer when a run's output exceeds Feishu's 4000-char
  # text-message cap. Set this to the public origin where /pwa/ is served so
  # the appended link "{base}/pwa/#runs/{run_id}" lets the user open the full
  # output in the PWA detail view. If unset, the footer just says "(truncated)"
  # without a link.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from typing import Optional
from urllib import error as urlerror
from urllib import request as urlreq

# cryptography is required iff Encrypt Key is configured. Imported lazily so
# this module loads even on a server that hasn't yet `pip install cryptography`.
try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    _HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    _HAVE_CRYPTO = False

from . import config

FEISHU_OPENAPI = "https://open.feishu.cn/open-apis"
_PREFIX_RE = re.compile(r"^\s*\[([A-Za-z0-9._-]+)\]\s*(.+)$", re.DOTALL)


def _secrets() -> dict:
    return (config.load_secrets() or {}).get("feishu") or {}


# ---------- signature + decryption (Feishu v2 — Encrypt Key) ----------


def verify_signature(body: bytes, signature: str, ts: str, nonce: str) -> bool:
    """Feishu v2: sha256(ts + nonce + ENCRYPT_KEY + body_raw) hex (lower).

    `body_raw` is the request body as received — i.e. the encrypted blob
    when Encrypt Key is enabled, not the decrypted plaintext.
    """
    key = _secrets().get("encrypt_key", "")
    if not key or not signature or not ts:
        return False
    raw = (ts + nonce + key).encode("utf-8") + body
    expected = hashlib.sha256(raw).hexdigest()
    return hmac.compare_digest(expected, signature)


def _aes_decrypt(encrypted_b64: str, encrypt_key: str) -> bytes:
    """AES-256-CBC decrypt: key=sha256(encrypt_key), IV=first 16 bytes."""
    if not _HAVE_CRYPTO:
        raise RuntimeError(
            "cryptography not installed — run: .venv/bin/pip install cryptography"
        )
    key = hashlib.sha256(encrypt_key.encode("utf-8")).digest()
    raw = base64.b64decode(encrypted_b64)
    iv, ciphertext = raw[:16], raw[16:]
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    dec = cipher.decryptor()
    padded = dec.update(ciphertext) + dec.finalize()
    # PKCS7 unpad
    pad_len = padded[-1]
    if pad_len < 1 or pad_len > 16:
        raise ValueError(f"bad PKCS7 padding length: {pad_len}")
    return padded[:-pad_len]


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
    encrypt_key = _secrets().get("encrypt_key", "")

    # Signature check first — body bytes used as-is (encrypted or plain).
    # Only enforced if Encrypt Key is configured AND a signature header is present;
    # this lets the initial app setup (no Encrypt Key yet) still accept events.
    if encrypt_key and sig:
        if not verify_signature(body, sig, ts or "", nonce or ""):
            return {"error": "bad signature", "code": 401}

    # Parse body. With Encrypt Key on, body is {"encrypt": "<base64>"} → decrypt.
    try:
        raw_payload = json.loads(body.decode("utf-8"))
    except Exception as e:
        return {"error": f"invalid json: {e}", "code": 400}

    if isinstance(raw_payload, dict) and "encrypt" in raw_payload:
        if not encrypt_key:
            return {
                "error": "encrypted body but [feishu].encrypt_key not set",
                "code": 500,
            }
        try:
            plain = _aes_decrypt(raw_payload["encrypt"], encrypt_key)
            payload = json.loads(plain.decode("utf-8"))
        except Exception as e:
            return {"error": f"decrypt failed: {e}", "code": 500}
    else:
        payload = raw_payload

    # url_verification — respond with challenge (works for both plain + encrypted modes)
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge", "")}

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


# Feishu text message hard cap is 4000 chars. We aim slightly under so the
# status header + (optional) truncation footer fit. Leaving room for a long
# absolute URL on the footer side.
_FEISHU_TEXT_BUDGET = 3500


def _pwa_run_url(run_id: str) -> Optional[str]:
    """Public URL to the PWA's run-detail view, or None if pwa_base_url unset."""
    cfg = (config.load_config() or {})
    base = (cfg.get("pwa_base_url") or "").rstrip("/")
    if not base or not run_id:
        return None
    return f"{base}/pwa/#runs/{run_id}"


def _format_reply(run: dict) -> str:
    """Compose the Feishu reply text, truncating output to fit 4000 chars.

    Layout:
        [status · exit N]
        <output>
        \n…(truncated, full output: <url>)        # only if output > budget

    Pure function — easy to unit-test without touching network.
    """
    status_line = f"[{run.get('status', '?')} · exit {run.get('exit_code')}]\n"
    output = (run.get("output") or "").strip() or "(no output)"

    body_budget = _FEISHU_TEXT_BUDGET - len(status_line)
    if len(output) <= body_budget:
        return status_line + output

    link = _pwa_run_url(run.get("id", ""))
    footer = (
        f"\n…(truncated, full output: {link})" if link else "\n…(truncated)"
    )
    head = output[: max(0, body_budget - len(footer))]
    return status_line + head + footer


def reply_from_run(run: dict) -> None:
    """runner.on_finish callback — send the run result back to the Feishu chat.

    Truncates output that exceeds Feishu's 4000-char text-message cap and,
    when pwa_base_url is configured, appends a link so the user can open the
    full output in the PWA's #runs/<id> detail view.
    """
    if not run or run.get("source") != "feishu":
        return
    sk = run.get("session_key") or ""
    if not sk.startswith("feishu-"):
        return
    chat_id = sk[len("feishu-"):]
    reply_to_chat(chat_id, _format_reply(run))
