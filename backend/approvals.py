"""In-memory approval queue for the Claude PreToolUse hook.

Flow:
    1. Claude wants to use a tool (e.g. Bash). PreToolUse hook fires.
    2. cc-approve-hook.sh POSTs `/approvals/internal/pending` here →
       request() creates an Approval entry, returns its id.
    3. The hook then long-polls `/approvals/internal/<id>/wait` →
       wait_for_decision() blocks on a Condition until either:
         - decide(id, "approved" | "denied") flips the status
         - TTL expires (auto-deny on stale entries)
    4. PWA renders [Approve]/[Deny] buttons on the run row that owns this
       approval (via list_pending). Click → POST decision.

State is process-local — backend restart loses pending entries. That's
acceptable because the hook has its own outer timeout in the polling
loop and will auto-deny if the server goes away.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Optional


# How long an approval can sit in "pending" before we auto-expire it.
# Matches cc-approve-hook.sh's curl --max-time so the two agree on the
# wall-clock budget.
TTL_SECONDS = 300


@dataclass
class Approval:
    approval_id: str
    run_id: str
    workspace: str
    tool_name: str
    tool_input: dict
    created_at: int
    status: str = "pending"             # pending | approved | denied | expired | auto_approved
    decided_at: Optional[int] = None
    auto: bool = False                  # True when trust=on short-circuited the user prompt

    def public(self) -> dict:
        d = asdict(self)
        return d


# All synchronization goes through `_cond` (which IS `_lock` for `with`
# block convenience). _pending stays small in practice (a handful at any
# time), so a single global lock is fine.
_cond = threading.Condition()
_pending: dict[str, Approval] = {}
# Bounded audit ring. Stores every approval (auto-approved AND manually
# decided) so the PWA can render a per-run "Approvals" panel — even when
# trust=on means the user never had to click anything. Capped at
# AUDIT_MAX so a long-running deploy doesn't leak memory.
_audit: "list[Approval]" = []
_AUDIT_MAX = 500


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def request(
    *,
    run_id: str,
    workspace: str,
    tool_name: str,
    tool_input: dict,
    trust: bool = False,
) -> str:
    """Hook entry point — create an approval entry, return its id.

    When `trust=True` the entry is marked `auto_approved` at creation
    time. wait_for_decision returns "approved" immediately. The entry
    is still recorded in the audit ring so the PWA can show it as a
    read-only trace ("auto-approved Bash(...)") — that's the
    visibility win over the previous design where the hook
    short-circuited and the backend never heard about it at all.
    """
    aid = _new_id()
    now = int(time.time())
    a = Approval(
        approval_id=aid,
        run_id=run_id,
        workspace=workspace,
        tool_name=tool_name,
        tool_input=tool_input,
        created_at=now,
        auto=trust,
    )
    if trust:
        # auto-approve at birth; wait_for_decision returns instantly.
        a.status = "auto_approved"
        a.decided_at = now
    with _cond:
        _pending[aid] = a
        _audit.append(a)
        if len(_audit) > _AUDIT_MAX:
            _audit.pop(0)
    return aid


def get(approval_id: str) -> Optional[Approval]:
    with _cond:
        return _pending.get(approval_id)


def decide(approval_id: str, decision: str) -> Optional[Approval]:
    """PWA entry point — flip status from pending → approved/denied, wake
    any hook that's blocked waiting on this id."""
    if decision not in ("approved", "denied"):
        return None
    with _cond:
        a = _pending.get(approval_id)
        if a is None or a.status != "pending":
            return a
        a.status = decision
        a.decided_at = int(time.time())
        _cond.notify_all()
        return a


def wait_for_decision(approval_id: str, timeout: float = TTL_SECONDS) -> str:
    """Block until the approval's status changes or `timeout` elapses.
    Returns the final status (approved / denied / expired / pending /
    auto_approved). Hook calls this via /approvals/internal/<id>/wait."""
    deadline = time.time() + timeout
    with _cond:
        while True:
            a = _pending.get(approval_id)
            if a is None:
                return "expired"
            if a.status != "pending":
                return a.status
            remaining = deadline - time.time()
            if remaining <= 0:
                a.status = "expired"
                a.decided_at = int(time.time())
                _cond.notify_all()
                return "expired"
            _cond.wait(remaining)


def list_pending() -> list[Approval]:
    """Snapshot of currently-pending approvals — used by PWA polling to
    decide which run rows show [Approve]/[Deny] buttons. Auto-approved
    entries are explicitly excluded (their decision is already settled,
    they show up in the audit panel not the action buttons)."""
    _sweep_expired()
    with _cond:
        return [a for a in _pending.values() if a.status == "pending"]


def list_audit_for_run(run_id: str, limit: int = 100) -> list[Approval]:
    """All approval entries (auto + manual) for one run, oldest first.
    Used by the PWA run-detail page's Approvals panel so the user can
    see what claude wanted to do — including the trust=on auto-approved
    tool calls that would otherwise be invisible."""
    with _cond:
        out = [a for a in _audit if a.run_id == run_id]
    return out[-limit:]


def _sweep_expired() -> None:
    """Move stale pending entries into "expired". Called opportunistically."""
    now = int(time.time())
    with _cond:
        for a in _pending.values():
            if a.status == "pending" and now - a.created_at > TTL_SECONDS:
                a.status = "expired"
                a.decided_at = now
        _cond.notify_all()
