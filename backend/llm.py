"""Direct LLM client — anthropic-compatible /v1/messages.

Backend's first direct LLM call site (until now everything went through
agent-run.sh). Reuses ~/.cc-workflow/{config.toml,providers.json} so there's
no second secret store; whichever provider agent-run uses, this uses too.

Usage:
    from backend import llm
    answer = llm.complete("Translate 'hello' to French")

Errors come out as RuntimeError — callers decide whether to surface as
HTTP 502 (HTTPException) or swallow.
"""
from __future__ import annotations

import json
from urllib import error as urlerror
from urllib import request as urlreq

from . import config


def _provider_env() -> dict:
    """Resolve the active provider's env dict from config.toml + providers.json."""
    cfg = config.load_config() or {}
    name = cfg.get("provider", "claude")
    try:
        providers = json.loads(config.PROVIDERS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f"providers.json unreadable: {e}")
    profile = (providers.get("profiles") or {}).get(name) or {}
    env = profile.get("env") or {}
    if not env:
        raise RuntimeError(
            f"provider {name!r} has no env in providers.json — "
            "anthropic OAuth profiles can't be used from backend"
        )
    return env


def complete(user_msg: str, *, max_tokens: int = 256, timeout: int = 30) -> str:
    """One-turn anthropic-compatible call. Returns the assistant's text content."""
    env = _provider_env()
    base = env.get("ANTHROPIC_BASE_URL", "").rstrip("/")
    token = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY", "")
    model = env.get("ANTHROPIC_MODEL") or "claude-3-5-sonnet-20241022"
    if not base or not token:
        raise RuntimeError("provider env missing ANTHROPIC_BASE_URL or token")

    body = json.dumps(
        {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user_msg}],
        }
    ).encode("utf-8")
    req = urlreq.Request(
        f"{base}/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": token,                     # anthropic native
            "Authorization": f"Bearer {token}",     # OpenAI-compatible fallback
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urlreq.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as e:
        snippet = e.read()[:300].decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"LLM HTTP {e.code}: {snippet}")
    except urlerror.URLError as e:
        raise RuntimeError(f"LLM network error: {e}")

    for part in data.get("content") or []:
        if part.get("type") == "text":
            return part.get("text", "")
    return ""
