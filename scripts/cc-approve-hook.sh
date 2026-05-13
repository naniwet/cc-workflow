#!/usr/bin/env bash
# cc-workflow PreToolUse hook — forwards Claude's pending tool-call to the
# backend, which surfaces it as an [Approve]/[Deny] block on the PWA run
# row. Exit 0 = allow the tool. Exit 1 (or any non-zero) = deny.
#
# Installed at /usr/local/bin/cc-approve-hook by deploy/INSTALL.md step.
# Wired in via /root/.claude/settings.json:
#   { "hooks": { "PreToolUse": [{ "matcher": "Bash|WebFetch", "hooks": [
#       { "type": "command", "command": "/usr/local/bin/cc-approve-hook" }
#   ]}]}}
#
# Environment (set by backend/runner.py before invoking agent-run):
#   CCW_RUN_ID     — db run id; used to attach the approval to its row
#   CCW_WORKSPACE  — workspace name; same purpose, plus display hint
#   CCW_TRUST      — "true" / "false". On "true" the hook short-circuits
#                    (exit 0) without calling the backend at all, because
#                    bypassPermissions workspaces have explicitly opted
#                    out of approval gating.

set -eu

BACKEND="${CCW_BACKEND_URL:-http://127.0.0.1:8765}"
# Total wall-clock budget. Matches backend approvals.TTL_SECONDS so the
# server-side wait_for_decision agrees on when to expire.
TIMEOUT=300

# --- short-circuit for trusted workspaces ---
if [[ "${CCW_TRUST:-false}" == "true" ]]; then
    exit 0
fi

# --- parse PreToolUse JSON from stdin ---
# Claude sends: { "session_id", "transcript_path", "tool_name",
#                 "tool_input": { ... }, ... }
INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
    # Defensive: empty stdin means hook was invoked without context. Don't
    # block (let Claude proceed) — most likely a setup test.
    exit 0
fi

TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // empty')"
TOOL_INPUT_JSON="$(echo "$INPUT" | jq -c '.tool_input // {}')"
if [[ -z "$TOOL_NAME" ]]; then
    exit 0
fi

# --- ask backend ---
BODY="$(jq -nc \
    --arg rid "${CCW_RUN_ID:-unknown}" \
    --arg ws  "${CCW_WORKSPACE:-unknown}" \
    --arg tn  "$TOOL_NAME" \
    --argjson ti "$TOOL_INPUT_JSON" \
    '{run_id:$rid, workspace:$ws, tool_name:$tn, tool_input:$ti}')"

AID="$(curl -fsS -X POST "$BACKEND/approvals/internal/pending" \
        -H 'Content-Type: application/json' -d "$BODY" \
       | jq -r '.approval_id // empty')"

if [[ -z "$AID" ]]; then
    echo "cc-approve-hook: backend refused to register the approval; failing closed (deny)." >&2
    exit 1
fi

# --- long-poll for decision ---
# Server holds the connection up to TIMEOUT then returns. curl --max-time
# is set slightly higher so we don't drop the connection before the
# server's own timeout fires.
STATUS="$(curl -fsS --max-time $((TIMEOUT + 10)) \
            "$BACKEND/approvals/internal/${AID}/wait?timeout=${TIMEOUT}" \
          | jq -r '.status // empty')"

case "$STATUS" in
    approved)
        exit 0
        ;;
    denied)
        echo "cc-approve-hook: user denied ${TOOL_NAME}." >&2
        exit 1
        ;;
    expired)
        echo "cc-approve-hook: timed out waiting for ${TOOL_NAME} approval." >&2
        exit 1
        ;;
    *)
        echo "cc-approve-hook: unexpected status '$STATUS'; failing closed." >&2
        exit 1
        ;;
esac
