"""Single external API egress for roundtable LLM calls.

Diverges from upstream AgentRoundtable's model.py:
  - No `openai` SDK dependency — uses stdlib urllib (matches backend/llm.py's
    pattern). Cost: ~50 fewer lines of dependency surface.
  - Endpoint config comes from ~/.cc-workflow/providers.json#openai_endpoints.
    Each entry is {base_url, api_key} for an OpenAI-compatible /v1 endpoint
    (DeepSeek / Moonshot etc).
  - Model-name → endpoint mapping in the MODEL_ENDPOINTS table below.
    Adding a new model name is a code change (matches the upstream "code
    is the registry" design choice).

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
    # DeepSeek 2026-05 rebrand:deepseek-chat / deepseek-reasoner 改成
    # deepseek-v4-flash / deepseek-v4-pro。v4-flash 同时支持 thinking
    # (default)和 non-thinking;v4-pro 是更强的 reasoning model。
    # 老名字 deepseek-chat / deepseek-reasoner 仍兼容但官方标 deprecated,
    # 留作 backward compat — 用户老 config 不破。
    "deepseek-v4-flash": "deepseek",
    "deepseek-v4-pro": "deepseek",
    "deepseek-chat": "deepseek",         # deprecated alias → v4-flash non-thinking
    "deepseek-reasoner": "deepseek",     # deprecated alias → v4-flash thinking
    # Kimi: per platform.kimi.com/docs (2026-05-14), kimi-k2.6 is the
    # current top model (256k context, function calling, multimodal)。
    # Old preview name kept as alias so anyone with stale config doesn't
    # break — moonshot's gateway may also still accept it.
    "kimi-k2.6": "moonshot",
    "kimi-k2-0905-preview": "moonshot",
    "moonshot-v1-32k": "moonshot",
}


def _load_endpoint(name: str) -> dict:
    """Resolve providers.json#openai_endpoints.<name> → {base_url, api_key}.

    Raises ModelBadRequestError if the endpoint isn't configured (so the
    user gets a clean error in the PWA rather than a network error 60s later).
    """
    try:
        data = json.loads(config.PROVIDERS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ModelBadRequestError(f"providers.json unreadable: {e}")
    endpoints = data.get("openai_endpoints") or {}
    ep = endpoints.get(name)
    if not ep:
        raise ModelBadRequestError(
            f"openai_endpoints.{name!r} missing in providers.json — "
            f"add a {{ base_url, api_key }} block"
        )
    base_url = (ep.get("base_url") or "").rstrip("/")
    api_key = ep.get("api_key") or ""
    if not base_url or not api_key:
        raise ModelBadRequestError(
            f"openai_endpoints.{name!r} missing base_url or api_key"
        )
    if api_key.startswith("<") and api_key.endswith(">"):
        raise ModelBadRequestError(
            f"openai_endpoints.{name!r}.api_key is still a placeholder "
            f"({api_key}) — fill the real key in providers.json"
        )
    return {"base_url": base_url, "api_key": api_key}


# --------------------------------------------------------------------------- #
# HTTP call — OpenAI-compatible Chat Completions                              #
# --------------------------------------------------------------------------- #

# Reasoning model API quirk:某些 model 强制 temperature=1.0,传别的值直接 400。
# 已知:kimi-k2.6 → "invalid temperature: only 1 is allowed for this model"。
# o1 / o3 / deepseek-reasoner 类似,但 deepseek 是静默忽略不报错。
# 这里 hardcode 锁列表 — 真到 3 个以上 model 受影响再考虑抽 config。
_TEMP_LOCKED_MODELS = frozenset({"kimi-k2.6"})

# Reasoning model 的另一个 quirk:thinking phase 一轮就能 60-180s,默认 120s
# timeout 经常打在临界。这些 model 进 API 时用 300s timeout(其它 model 仍
# 120 — fast-fail 是优势,reasoning 才需要长)。spec:per-model quirk 在
# egress 层处理,caller 不动。已知 reasoning:kimi K2.6 / K2.5 / thinking 系列
# + DeepSeek reasoner。其它(kimi-k2-0905-preview / moonshot-v1-*)是非
# reasoning model,继续用 120。
_REASONING_MODELS = frozenset({
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2-thinking",
    "kimi-k2-thinking-turbo",
    "deepseek-reasoner",     # deprecated alias,仍纳入(thinking 阶段慢)
    "deepseek-v4-flash",     # thinking default(2026-05 rebrand)
    "deepseek-v4-pro",       # always reasoning
})
_REASONING_TIMEOUT_S = 300


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

    `_TEMP_LOCKED_MODELS` 里的 model 会被强制 temperature=1.0(reasoning model
    API quirk),caller 传的 temperature 被忽略。
    """
    effective_temp = 1.0 if model in _TEMP_LOCKED_MODELS else temperature
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": effective_temp,
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
        msg = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as e:
        raise ModelBadRequestError(f"unexpected response shape: {payload!r}") from e
    # Reasoning model(kimi-k2.6 / DeepSeek reasoner / o1 系列)把答案放
    # `reasoning_content` 字段,留 `content=""`。content 优先,缺则 fallback
    # 到 reasoning_content,两者皆空回 "" 让 call_model 抛 EmptyModelOutputError。
    # 跟 backend/llm.py:115-127 的 thinking-block fallback 同一思路。
    return (msg.get("content") or msg.get("reasoning_content") or "")


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

    # Reasoning model 自动延长 timeout — thinking phase 慢,caller 不用关心
    effective_timeout = _REASONING_TIMEOUT_S if model in _REASONING_MODELS else timeout

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
                timeout=effective_timeout,
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
