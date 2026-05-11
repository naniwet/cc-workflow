"""HTTP Basic auth dependency.

Phase 1 partial of dev-plan §4.2 contract ("basic + CSRF"): the `basic`
half lands here so the Mac-browser UI is gated by a password before the
nginx/CSRF stack of Phase 3 (P0-7c/d).

Credentials are read from ~/.cc-workflow/secrets.toml:

    [ui]
    username = "admin"
    password = "<random-16>"

If [ui] is missing → 503 (auth not configured). Wrong credentials → 401
with WWW-Authenticate so the browser re-prompts.
"""
from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import config

_basic = HTTPBasic(realm="cc-workflow")


def _expected() -> tuple[str, str] | None:
    s = config.load_secrets()
    ui = s.get("ui") or {}
    u, p = ui.get("username"), ui.get("password")
    if isinstance(u, str) and isinstance(p, str) and u and p:
        return u, p
    return None


def require_basic_auth(
    creds: HTTPBasicCredentials = Depends(_basic),
) -> str:
    expected = _expected()
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "UI auth not configured — add [ui] section to ~/.cc-workflow/secrets.toml",
                "code": 503,
            },
        )
    exp_user, exp_pwd = expected
    ok = secrets.compare_digest(creds.username, exp_user) and secrets.compare_digest(
        creds.password, exp_pwd
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "unauthorized", "code": 401},
            headers={"WWW-Authenticate": 'Basic realm="cc-workflow"'},
        )
    return creds.username
