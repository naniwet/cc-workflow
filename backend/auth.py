"""Session-cookie auth (replaces Phase 1's HTTP Basic auth).

Why we left basic auth:
    - In-app / Chinese mobile browsers (Quark, QQ, WeChat) handle the
      WWW-Authenticate dialog inconsistently; some never prompt, some
      drop the Authorization header, leaving the user staring at a
      silent 401.
    - A custom login form sidesteps every quirk: it's just an HTML page
      that POSTs to /auth/login, gets back an HMAC-signed cookie, and
      from then on all API calls succeed via the cookie.

Cookie format:
    base64url(payload) . base64url(sig)
        payload = { "u": "<username>", "exp": <unix-ts> }
        sig     = HMAC-SHA256(secret, payload-bytes)

    HMAC-SHA256 is stdlib (hmac + hashlib), no extra deps. JSON for the
    payload so we can extend later without a wire-format break.

Secret:
    ~/.cc-workflow/.session-secret, 32 random bytes from os.urandom,
    chmod 600. Auto-generated on first call if missing; persists across
    backend restarts so signed cookies keep working.

Credentials live in ~/.cc-workflow/secrets.toml under [ui]
(kept for backward compat — earlier Phase 1 docs used the same key):

    [ui]
    username = "you"
    password = "<long-random-string>"

If [ui] is missing → /auth/login returns 503 with an actionable hint.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Optional

from fastapi import Cookie, HTTPException, Request, Response, status

from . import config


# ---------- secret loading ----------

_SECRET_PATH: Path = config.CCW_DIR / ".session-secret"
_secret_cache: Optional[bytes] = None


def _load_or_generate_secret() -> bytes:
    """Read the HMAC secret from disk; generate + persist if missing.

    Module-level cache so we only hit the filesystem once per process.
    A backend restart re-reads the same file → cookies signed before
    restart remain valid.
    """
    global _secret_cache
    if _secret_cache is not None:
        return _secret_cache

    if _SECRET_PATH.exists():
        try:
            data = _SECRET_PATH.read_bytes()
            if len(data) >= 16:
                _secret_cache = data
                return data
        except OSError:
            pass

    # No usable secret on disk — generate, persist, return.
    new_secret = os.urandom(32)
    _SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SECRET_PATH.write_bytes(new_secret)
    try:
        os.chmod(_SECRET_PATH, 0o600)
    except OSError:
        pass     # non-POSIX filesystem; not fatal
    _secret_cache = new_secret
    return new_secret


# ---------- cookie sign / verify ----------

COOKIE_NAME = "ccw_session"
COOKIE_MAX_AGE = 30 * 24 * 3600                     # 30 days

# Constant for the dot separator between payload and signature.
_SEP = b"."


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def make_cookie(username: str, *, ttl: int = COOKIE_MAX_AGE) -> str:
    """Mint a signed cookie for `username`, valid for `ttl` seconds."""
    payload = json.dumps(
        {"u": username, "exp": int(time.time()) + ttl},
        separators=(",", ":"), ensure_ascii=True,
    ).encode("ascii")
    sig = hmac.new(_load_or_generate_secret(), payload, hashlib.sha256).digest()
    return f"{_b64url(payload)}.{_b64url(sig)}"


def verify_cookie(token: str) -> Optional[str]:
    """Return the username if the token's signature is valid AND not
    expired; else None."""
    if not token or token.count(".") != 1:
        return None
    payload_b64, sig_b64 = token.split(".", 1)
    try:
        payload = _b64url_decode(payload_b64)
        sig = _b64url_decode(sig_b64)
    except Exception:
        return None
    expected = hmac.new(_load_or_generate_secret(), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        data = json.loads(payload.decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if int(data.get("exp", 0)) < int(time.time()):
        return None
    u = data.get("u")
    return u if isinstance(u, str) and u else None


# ---------- credentials check (POST /auth/login) ----------


def _expected() -> Optional[tuple[str, str]]:
    """Return (username, password) from secrets.toml [ui], or None when
    the section is absent / incomplete."""
    s = config.load_secrets()
    ui = s.get("ui") or {}
    u, p = ui.get("username"), ui.get("password")
    if isinstance(u, str) and isinstance(p, str) and u and p:
        return u, p
    return None


def credentials_valid(username: str, password: str) -> bool:
    """Constant-time check vs. secrets.toml's [ui] section."""
    expected = _expected()
    if expected is None:
        return False
    eu, ep = expected
    return secrets.compare_digest(username, eu) and secrets.compare_digest(password, ep)


def credentials_configured() -> bool:
    """True if secrets.toml has a working [ui] block."""
    return _expected() is not None


# ---------- response helpers (set / clear cookie) ----------


def set_session_cookie(response: Response, username: str, *, secure: bool) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=make_cookie(username),
        max_age=COOKIE_MAX_AGE,
        path="/",
        secure=secure,
        httponly=True,
        samesite="strict",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=COOKIE_NAME, path="/", samesite="strict")


# ---------- FastAPI dependency ----------


def require_user(
    request: Request,
    ccw_session: Optional[str] = Cookie(default=None),
) -> str:
    """Auth dependency for all PROTECT-decorated routes. Returns the
    username on success, or raises 401 (with NO WWW-Authenticate header
    so browsers don't pop the native dialog — JS detects the 401 and
    redirects to /pwa/login.html instead)."""
    user = verify_cookie(ccw_session) if ccw_session else None
    if user:
        return user
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"error": "not authenticated", "code": 401},
    )


def request_is_https(request: Request) -> bool:
    """Detect whether the request reached us via HTTPS, accounting for
    nginx terminating TLS upstream (X-Forwarded-Proto header)."""
    fwd = request.headers.get("x-forwarded-proto", "").lower()
    if fwd in ("https", "http"):
        return fwd == "https"
    return request.url.scheme == "https"
