"""Single external API egress for roundtable LLM calls.

Diverges from upstream AgentRoundtable's model.py:
  - No `openai` SDK dependency — uses stdlib urllib (matches backend/llm.py's
    pattern). Cost: ~50 fewer lines of dependency surface. Trade-off: we
    re-implement the retry / error classification logic in plain Python.
  - Endpoint config comes from ~/.cc-workflow/providers.json#roundtable_endpoints
    (NOT env vars DEEPSEEK_API_KEY / MOONSHOT_API_KEY). One config file
    per-cc-workflow install, same source of truth as claude/codex profiles.
  - Same model-name → endpoint mapping in the MODEL_ENDPOINTS table below
    (we keep this in code, not config — adding a new model name is a code
    change; this matches the upstream "code is the registry" design choice).

Retry: 3 attempts with 0.5/1/2s backoffs on transient errors (timeout,
connection drop, 429, 5xx). 4xx is permanent. Empty output is permanent.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Optional
from urllib import error as urlerror
from urllib import request as urlreq

from .. import config

# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #


ModelFn = Callable[[str, str, str, float], str]
"""Signature: (model_name, system_prompt, user_prompt, temperature) -> answer.
Injected into debate.run_session so tests can substitute a fake."""


class ModelError(Exception):
    """Base for anything that goes wrong at the model layer."""


class ModelTransientError(ModelError):
    """Retryable: timeout / 429 / 5xx / connection drop."""


class ModelBadRequestError(ModelError):
    """Permanent: 4xx (except 429). Retrying won't help."""


class EmptyModelOutputError(ModelError):
    """Model returned no usable content. Treated as permanent — empty on a
    real LLM means a refusal or stop-condition, not a flaky blip."""


# --------------------------------------------------------------------------- #
# Model name → endpoint key                                                   #
# --------------------------------------------------------------------------- #
# Adding a new model: append here AND make sure providers.json has the
# matching roundtable_endpoints.<endpoint> block. Both deepseek-chat and
# deepseek-reasoner share endpoint key "deepseek" — same base_url / api_key,
# only the model string differs in the request body.

MODEL_ENDPOINTS: dict[str, str] = {
    "deepseek-chat": "deepseek",
    "deepseek-reasoner": "deepseek",
    "kimi-k2-0905-preview": "moonshot",
    "moonshot-v1-32k": "moonshot",
}


def _load_endpoint(name: str) -> dict:
    """Resolve providers.json#roundtable_endpoints.<name> → {base_url, api_key}.
    Raises ModelBadRequestError if the endpoint isn't configured (so the user
    gets a clean error in the PWA rather than a network error 60s later)."""
    try:
        data = json.loads(config.PROVIDERS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ModelBadRequestError(f"providers.json unreadable: {e}")
    endpoints = data.get("roundtable_endpoints") or {}
    ep = endpoints.get(name)
    if not ep:
        raise ModelBadRequestError(
            f"roundtable_endpoints.{name!r} missing in providers.json — "
            f"add a {{ base_url, api_key }} block"
        )
    base_url = (ep.get("base_url") or "").rstrip("/")
    api_key = ep.get("api_key") or ""
    if not base_url or not api_key:
        raise ModelBadRequestError(
            f"roundtable_endpoints.{name!r} missing base_url or api_key"
        )
    if api_key.startswith("<") and api_key.endswith(">"):
        raise ModelBadRequestError(
            f"roundtable_endpoints.{name!r}.api_key is still a placeholder "
            f"({api_key}) — fill the real key in providers.json"
        )
    return {"base_url": base_url, "api_key": api_key}


# --------------------------------------------------------------------------- #
# HTTP call — OpenAI-compatible Chat Completions                              #
# --------------------------------------------------------------------------- #


def _http_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    system: str,
    user: str,
    temperature: float,
    max_tokens: int,
    timeout: int,
) -> str:
    """POST {base}/chat/completions, return choices[0].message.content.

    Classifies HTTP failures into ModelTransientError vs ModelBadRequestError
    so call_model's retry loop knows what to do.
    """
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
    ).encode("utf-8")
    req = urlreq.Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urlreq.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as e:
        snippet = ""
        try:
            snippet = (e.read() or b"")[:300].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
        msg = f"HTTP {e.code}: {snippet}"
        if e.code == 429 or 500 <= e.code < 600:
            raise ModelTransientError(msg) from e
        raise ModelBadRequestError(msg) from e
    except urlerror.URLError as e:
        # Timeouts and connection errors all bucket here.
        raise ModelTransientError(f"network: {e}") from e

    try:
        return payload["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise ModelBadRequestError(f"unexpected response shape: {payload!r}") from e


# --------------------------------------------------------------------------- #
# Dispatch + retry                                                            #
# --------------------------------------------------------------------------- #

_RETRY_BACKOFFS: tuple[float, ...] = (0.5, 1.0, 2.0)


def call_model(
    model: str,
    system: str,
    user: str,
    temp: float,
    *,
    max_tokens: int = 8192,
    timeout: int = 120,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> str:
    """Single egress for all roundtable LLM calls.

    Resolves the endpoint from providers.json, retries transient errors
    with 0.5/1/2s backoffs (3 attempts total then raise). Empty output is
    permanent — treated as the model refusing.
    """
    if model not in MODEL_ENDPOINTS:
        raise ModelBadRequestError(
            f"unknown model {model!r}. Known: {sorted(MODEL_ENDPOINTS)}"
        )
    endpoint_name = MODEL_ENDPOINTS[model]
    ep = _load_endpoint(endpoint_name)

    for attempt in range(len(_RETRY_BACKOFFS) + 1):
        try:
            out = _http_chat(
                base_url=ep["base_url"],
                api_key=ep["api_key"],
                model=model,
                system=system,
                user=user,
                temperature=temp,
                max_tokens=max_tokens,
                timeout=timeout,
            )
        except ModelTransientError:
            if attempt >= len(_RETRY_BACKOFFS):
                raise
            sleep_fn(_RETRY_BACKOFFS[attempt])
            continue

        if not out.strip():
            raise EmptyModelOutputError(f"model {model!r} returned empty content")
        return out

    raise RuntimeError("unreachable")  # pragma: no cover
