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

Workspace resolution — 4-tier priority (highest first):
  1. "[repo-name] prompt..."     → one-shot override, doesn't change state
  2. /use'd default for chat_id  → from ~/.cc-workflow/feishu_chats.json
  3. secrets.toml [feishu].default_workspace
  4. "test-repo"                  → hard fallback

`/use <workspace>` slash command stores the per-chat default so users with
multiple workspaces don't have to type the [prefix] every message. `/where`
queries the current effective default for the calling chat.

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
import os
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
_SLASH_RE = re.compile(r"^/([a-z][a-z0-9_-]*)\b\s*(.*)$", re.IGNORECASE | re.DOTALL)

# Per-chat workspace memory — survives backend restart. Format:
#   {"<chat_id>": {"workspace": "<repo-name>"}}
# Atomic write via tmp + os.replace so concurrent /use requests can't tear.
_CHAT_WS_FILE = config.CCW_DIR / "feishu_chats.json"


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


def _verify_and_decrypt(
    body: bytes,
    sig: Optional[str],
    ts: Optional[str],
    nonce: Optional[str],
) -> "tuple[Optional[dict], Optional[dict]]":
    """Verify signature + decrypt body. Shared between event webhook and card
    callback (both use the same Encrypt Key scheme).

    Returns (payload, None) on success or (None, error_dict) on failure.
    error_dict has shape {"error": str, "code": int}.
    """
    encrypt_key = _secrets().get("encrypt_key", "")

    # Signature check first — body bytes used as-is (encrypted or plain).
    # Only enforced if Encrypt Key is configured AND a signature header is present;
    # this lets the initial app setup (no Encrypt Key yet) still accept events.
    if encrypt_key and sig:
        if not verify_signature(body, sig, ts or "", nonce or ""):
            return None, {"error": "bad signature", "code": 401}

    try:
        raw_payload = json.loads(body.decode("utf-8"))
    except Exception as e:
        return None, {"error": f"invalid json: {e}", "code": 400}

    if isinstance(raw_payload, dict) and "encrypt" in raw_payload:
        if not encrypt_key:
            return None, {
                "error": "encrypted body but [feishu].encrypt_key not set",
                "code": 500,
            }
        try:
            plain = _aes_decrypt(raw_payload["encrypt"], encrypt_key)
            return json.loads(plain.decode("utf-8")), None
        except Exception as e:
            return None, {"error": f"decrypt failed: {e}", "code": 500}

    return raw_payload, None


def handle_webhook(
    body: bytes,
    sig: Optional[str],
    ts: Optional[str],
    nonce: Optional[str],
) -> dict:
    """Return shapes (consumed by main.py):
      {"challenge": "..."}                                 url_verification
      {"ok": True, "run_intent": {...}}                    submit a run
      {"ok": True, "card_reply": True}                     slash command — card sent inline
      {"ok": True, "ignored": "<reason>"}                  no-op event
      {"error": "...", "code": <int>}                      failure
    """
    payload, err = _verify_and_decrypt(body, sig, ts, nonce)
    if err:
        return err

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

    # Slash commands — handled before workspace resolution so "/use foo"
    # doesn't get misread as a prompt for the default workspace.
    m = _SLASH_RE.match(text)
    if m and chat_id:
        handled = _handle_slash(m.group(1).lower(), m.group(2).strip(), chat_id)
        if handled is not None:
            return handled
        # Unknown slash falls through to LLM — the user gets a response
        # instead of silent ignore.

    workspace, prompt = _resolve_workspace(chat_id, text)
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


def _handle_slash(cmd: str, rest: str, chat_id: str) -> Optional[dict]:
    """Dispatch a slash command. Returns:
      dict  — handled (skip the run-intent path; reply has already been sent)
      None  — unknown command (caller falls through to LLM)
    """
    from . import ui_cards                    # lazy: avoid potential import order issues

    # Card-rendering slashes — wrap a Card factory and send via reply_card.
    cards = {
        "sessions": ui_cards.sessions_card,
        "loops": ui_cards.loops_card,
        "run": ui_cards.run_form_card,
    }
    if cmd in cards:
        reply_card(chat_id, cards[cmd]())
        return {"ok": True, "card_reply": True, "slash": cmd}

    # /use <workspace> — set this chat's default workspace. Persists across
    # backend restart in ~/.cc-workflow/feishu_chats.json.
    if cmd == "use":
        ws = (rest or "").strip()
        if not ws:
            current = (_load_chat_ws().get(chat_id) or {}).get("workspace")
            tip = "用法: /use <workspace-name>"
            if current:
                tip += f"\n当前默认: {current}"
            reply_to_chat(chat_id, tip)
            return {"ok": True, "slash": "use", "missing_arg": True}
        chats = _load_chat_ws()
        chats[chat_id] = {"workspace": ws}
        _save_chat_ws(chats)
        reply_to_chat(
            chat_id,
            f"✓ 这个聊天的默认 workspace = {ws}\n"
            f"后续不打 [prefix] 都进 {ws}。临时换用 [别的] prompt;改默认用 /use <别的>。",
        )
        return {"ok": True, "slash": "use", "workspace": ws}

    # /where — query the effective default for this chat.
    if cmd == "where":
        chats = _load_chat_ws()
        chat_default = (chats.get(chat_id) or {}).get("workspace")
        global_default = _secrets().get("default_workspace") or "test-repo"
        if chat_default:
            body = f"当前 workspace: {chat_default}\n(per-chat /use 设置;全局默认是 {global_default})"
        else:
            body = f"当前 workspace: {global_default}\n(全局默认 — /use <name> 改成本聊天专属)"
        reply_to_chat(chat_id, body)
        return {"ok": True, "slash": "where"}

    return None


def _load_chat_ws() -> dict:
    """Read feishu_chats.json. Returns {} when file is missing or corrupt."""
    if not _CHAT_WS_FILE.exists():
        return {}
    try:
        return json.loads(_CHAT_WS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_chat_ws(data: dict) -> None:
    """Atomic write so concurrent /use requests don't tear the file."""
    _CHAT_WS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _CHAT_WS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _CHAT_WS_FILE)


def _resolve_workspace(chat_id: str, text: str) -> "tuple[str, str]":
    """Pick (workspace, prompt) using the 4-tier priority documented at the
    top of this module.
        1. [prefix]  — one-shot override
        2. /use'd default for this chat
        3. secrets.toml [feishu].default_workspace
        4. "test-repo" hard fallback
    """
    m = _PREFIX_RE.match(text)
    if m:
        return m.group(1), m.group(2).strip()

    if chat_id:
        chat_default = (_load_chat_ws().get(chat_id) or {}).get("workspace")
        if chat_default:
            return chat_default, text

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


# ---------- interactive cards (P0-5b/c/d) ----------
# Card rendering follows Feishu's schema 2.0 interactive-card JSON.
# Reference: open.feishu.cn → 互动卡片 → 卡片结构 (schema 2.0). The shapes
# here cover what ui_cards.py emits today; richer kinds (e.g. image, chart)
# would need new branches in render_card's section dispatch.


def render_card(card) -> dict:
    """IM-agnostic Card → Feishu interactive-card JSON dict.

    Pure function — no IO. Test it standalone:
        from backend import ui_cards, im_feishu
        print(im_feishu.render_card(ui_cards.sessions_card()))
    """
    elements: list = []

    # ----- sections -----
    for sec in card.sections:
        if sec.kind == "divider":
            elements.append({"tag": "hr"})
        elif sec.kind == "text":
            elements.append({"tag": "markdown", "content": str(sec.content or "")})
        elif sec.kind == "code":
            elements.append({"tag": "markdown", "content": f"```\n{sec.content}\n```"})
        elif sec.kind == "kv":
            fields = [
                {"is_short": True, "text": {"tag": "lark_md", "content": f"**{k}**\n{v}"}}
                for k, v in (sec.content or {}).items()
            ]
            elements.append({"tag": "div", "fields": fields})
        elif sec.kind == "table":
            rows = sec.content or []
            if rows:
                md = ["| " + " | ".join(map(str, rows[0])) + " |",
                      "| " + " | ".join(["---"] * len(rows[0])) + " |"]
                for r in rows[1:]:
                    md.append("| " + " | ".join(map(str, r)) + " |")
                elements.append({"tag": "markdown", "content": "\n".join(md)})

    # ----- form fields (if any) — wrap fields + buttons in a <form> so the
    # button click submits the field values to the callback. -----
    form_inner: list = []
    for f in card.fields:
        if f.kind == "dropdown":
            form_inner.append({
                "tag": "select_static",
                "name": f.name,
                "placeholder": {"tag": "plain_text", "content": f.label},
                "options": [
                    {"text": {"tag": "plain_text", "content": str(o)}, "value": str(o)}
                    for o in f.options
                ],
                **({"initial_option": f.default} if f.default else {}),
            })
        elif f.kind == "textarea":
            form_inner.append({
                "tag": "input",
                "name": f.name,
                "placeholder": {"tag": "plain_text", "content": f.label},
                "type": "multiline",
            })
        else:                                # "text" default
            form_inner.append({
                "tag": "input",
                "name": f.name,
                "placeholder": {"tag": "plain_text", "content": f.label},
                "type": "text",
            })

    # ----- buttons -----
    button_blocks = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": b.label},
            "type": "primary" if b.action in ("submit_run", "refresh_card") else "default",
            "value": {"action": b.action, **b.params},
        }
        for b in card.buttons
    ]

    if card.fields:
        # Form: buttons must be INSIDE the form so form_value is populated.
        if button_blocks:
            form_inner.append({"tag": "action", "actions": button_blocks})
        elements.append({"tag": "form", "name": "ccw_form", "elements": form_inner})
    else:
        if button_blocks:
            elements.append({"tag": "action", "actions": button_blocks})

    # ----- footer -----
    if card.footer:
        elements.append({"tag": "hr"})
        elements.append({"tag": "markdown", "content": f"_{card.footer}_"})

    return {
        "schema": "2.0",
        "config": {"update_multi": True, "wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": card.title},
            "template": "blue",
        },
        "body": {"elements": elements},
    }


def reply_card(chat_id: str, card) -> bool:
    """Send an interactive Card to a Feishu chat. Analog of reply_to_chat."""
    if not chat_id:
        return False
    token = _tenant_access_token()
    if not token:
        return False
    body = json.dumps(
        {
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": json.dumps(render_card(card), ensure_ascii=False),
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


def parse_card_action(payload: dict):
    """Feishu card.action.trigger payload → ui_cards.CardAction.

    Defensive parser — Feishu's exact shape has churned across schema
    versions, so we accept value as either dict or stringified JSON and
    merge form_value into params.
    """
    from . import ui_cards                    # lazy

    action_block = payload.get("action") or {}
    value = action_block.get("value") or {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = {}
    if not isinstance(value, dict):
        value = {}

    action_name = value.pop("action", "") if isinstance(value, dict) else ""
    form_value = action_block.get("form_value") or {}

    # button params come from value; form fields come from form_value.
    # form takes precedence in case of name collision (form is user input).
    params = {**value, **(form_value if isinstance(form_value, dict) else {})}

    ctx = payload.get("context") or {}
    operator = payload.get("operator") or {}
    return ui_cards.CardAction(
        action=action_name,
        params=params,
        chat_id=ctx.get("open_chat_id") or "",
        user_id=operator.get("open_id") or operator.get("user_id") or "",
    )


def handle_card_callback(
    body: bytes,
    sig: Optional[str],
    ts: Optional[str],
    nonce: Optional[str],
) -> dict:
    """Process a Feishu card-button callback.

    Feishu sends these to a DIFFERENT URL than the message-event webhook
    (configured in 飞书后台 → 消息卡片 → 回调地址). Auth is the same
    Encrypt Key signature scheme as the event webhook.

    Return shapes:
        {"error": "...", "code": 401/400/500}    failure (becomes HTTP error)
        {"challenge": "..."}                      url_verification on initial setup
        {"toast": {...}, "card": {...}}           Feishu-shaped response that
                                                  updates the card / shows a toast
    """
    payload, err = _verify_and_decrypt(body, sig, ts, nonce)
    if err:
        return err

    # url_verification handshake — same as the event webhook
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge", "")}

    action = parse_card_action(payload)
    return _dispatch_action(action)


def _dispatch_action(action) -> dict:
    """Route a CardAction to its handler. Returns Feishu-shaped response.

    Supported actions (must match ui_cards button factories):
        refresh_card    — re-run the registered factory, replace the card
        pause_loop      — set enabled=false, re-render loops_card
        resume_loop     — set enabled=true, re-render loops_card
        submit_run      — queue a runner.submit from the run_form_card
    """
    # Lazy imports — avoid circular at module load (these import ui_cards
    # which doesn't depend on us, so no real cycle, but keep symmetric).
    from . import cron_state, db, runner, ui_cards

    a = (action.action or "").strip()

    if a == "refresh_card":
        token = action.params.get("token", "")
        card = ui_cards.regenerate(token)
        if card is None:
            return _toast("error", "card expired — re-issue the slash command")
        return _card_update(card)

    if a in ("pause_loop", "resume_loop"):
        name = (action.params.get("name") or "").strip()
        if not name:
            return _toast("error", "missing loop name")
        cron_state.set_enabled(name, a == "resume_loop")
        return _card_update(ui_cards.loops_card())

    if a == "submit_run":
        workspace = (action.params.get("workspace") or "").strip()
        prompt = (action.params.get("prompt") or "").strip()
        if not workspace or not prompt:
            return _toast("error", "workspace and prompt are required")
        run_id = db.new_run_id()
        runner.submit(
            run_id=run_id,
            workspace=workspace,
            prompt=prompt,
            engine="claude",
            session_key=f"feishu-{action.chat_id}" if action.chat_id else None,
            source="feishu",
            on_finish=reply_from_run,
        )
        return _toast("success", f"queued: {run_id[:8]}")

    return _toast("error", f"unknown action: {a}")


def _toast(level: str, content: str) -> dict:
    """Feishu toast response shape — flashes briefly after a button click."""
    return {"toast": {"type": level, "content": content}}


def _card_update(card) -> dict:
    """Feishu card-replace response shape — swaps the entire card in-chat."""
    # Per Feishu docs, schema-2.0 card updates go under card.type=raw + data.
    return {"card": {"type": "raw", "data": render_card(card)}}
