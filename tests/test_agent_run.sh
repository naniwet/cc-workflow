#!/usr/bin/env bash
#
# tests/test_agent_run.sh — P0-1 acceptance suite (test-plan §3.1).
#
# Run on the *server* (Linux, with claude CLI, jq, flock, ~/workspaces/test-repo).
# Mac dev box can't run this — needs real `claude` binary + Linux flock.
#
# Each case prints "PASS" / "FAIL" + reason. Exit 0 iff all required cases pass.
# 3.1.5 (codex) is best-effort and never blocks overall exit (P1 fallback).
#
set -uo pipefail

AGENT_RUN="${AGENT_RUN:-$(cd "$(dirname "$0")/.." && pwd)/agent-run.sh}"
WORKSPACES="${HOME}/workspaces"
TEST_REPO="${WORKSPACES}/test-repo"
STATE_DIR="${HOME}/.cc-state"
CCW_CONFIG="${HOME}/.cc-workflow/config.toml"
PROVIDERS_FILE="${HOME}/.cc-workflow/providers.json"

pass=0; fail=0
required_fail=0

ok()  { printf '\e[32mPASS\e[0m  %s\n' "$*"; pass=$((pass+1)); }
ko()  { printf '\e[31mFAIL\e[0m  %s\n' "$*"; fail=$((fail+1)); }
skip(){ printf '\e[33mSKIP\e[0m  %s\n' "$*"; }
hdr() { printf '\n=== %s ===\n' "$*"; }

# Read `provider` from config.toml (simple awk parser, single-line key=value).
PROVIDER="claude"
if [[ -f "$CCW_CONFIG" ]]; then
    p=$(awk -F'=' '/^[[:space:]]*provider[[:space:]]*=/ {gsub(/[[:space:]"]/,"",$2); print $2; exit}' "$CCW_CONFIG")
    [[ -n "$p" ]] && PROVIDER="$p"
fi

# ---------- preflight ----------

hdr "preflight"
command -v claude  >/dev/null || { ko "claude CLI not in PATH (run scripts/install-deps.sh)"; exit 2; }
command -v jq      >/dev/null || { ko "jq not in PATH (run scripts/install-deps.sh)";          exit 2; }
command -v flock   >/dev/null || { ko "flock not in PATH";                                     exit 2; }
[[ -x "$AGENT_RUN" ]]         || { ko "agent-run.sh not executable: $AGENT_RUN";               exit 2; }
[[ -d "${TEST_REPO}/.git" ]]  || { ko "missing ${TEST_REPO}/.git — see handoff §5 step 3";     exit 2; }
[[ -f "$CCW_CONFIG" ]]        || { ko "missing $CCW_CONFIG — run scripts/install-deps.sh";    exit 2; }
[[ -f "$PROVIDERS_FILE" ]]    || { ko "missing $PROVIDERS_FILE — run scripts/install-deps.sh"; exit 2; }
ok "preflight (provider=${PROVIDER})"

# Reset any prior sessions/state that would shortcut these tests.
rm -f "${STATE_DIR}/sessions.json"
rm -f "${STATE_DIR}/locks/"*.lock 2>/dev/null || true

# ---------- 3.1.1 claude smoke ----------

hdr "3.1.1 claude smoke (A1.1)"
out=$("$AGENT_RUN" --engine=claude test-repo "reply with only OK" smoke 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 0 && "$out" == *OK* ]]; then
    ok "3.1.1 stdout contains OK, exit 0"
else
    ko "3.1.1 rc=$rc out=${out:0:200}"
    required_fail=$((required_fail+1))
fi

# ---------- 3.1.2 concurrency (A1.2) ----------

hdr "3.1.2 concurrency limit (A1.2)"
tmp=$(mktemp -d)
for i in 1 2 3 4; do
    ( "$AGENT_RUN" --engine=claude test-repo "wait 25 seconds then say OK" "c$i" \
        >"$tmp/o$i" 2>"$tmp/e$i"; echo $? >"$tmp/rc$i" ) &
done
wait
got65=0; got0=0
for i in 1 2 3 4; do
    rc=$(cat "$tmp/rc$i")
    [[ $rc -eq 65 ]] && got65=$((got65+1))
    [[ $rc -eq 0  ]] && got0=$((got0+1))
done
if [[ $got0 -eq 3 && $got65 -eq 1 ]]; then
    ok "3.1.2 got 3×exit=0 + 1×exit=65"
else
    ko "3.1.2 got=${got0}×0 + ${got65}×65 (expected 3+1); rc dump:"
    for i in 1 2 3 4; do printf '  c%s: rc=%s\n' "$i" "$(cat "$tmp/rc$i")"; done
    required_fail=$((required_fail+1))
fi
rm -rf "$tmp"

# ---------- 3.1.3 session resume (A1.1) ----------
# Strict on anthropic; best-effort on deepseek/kimi (test-plan §3.1.3 + PRD A1.1).

hdr "3.1.3 session resume (A1.1) — strict=claude/anthropic, best-effort=others"
"$AGENT_RUN" --engine=claude test-repo "Remember the secret word 'penguin'. Reply with only OK." r-test >/dev/null 2>&1
out=$("$AGENT_RUN" --engine=claude test-repo "What is the secret word I told you?" r-test 2>&1) && rc=0 || rc=$?
if [[ $rc -eq 0 && "$out" == *penguin* ]]; then
    ok "3.1.3 resume preserved context (found 'penguin')"
else
    case "$PROVIDER" in
        claude|anthropic)
            ko "3.1.3 rc=$rc out=${out:0:200} (provider=$PROVIDER — strict failure)"
            required_fail=$((required_fail+1))
            ;;
        *)
            skip "3.1.3 rc=$rc out=${out:0:200} (provider=$PROVIDER — best-effort, non-blocking; record in PRD A1.1 note)"
            ;;
    esac
fi

# ---------- 3.1.4 push main blocked (A1.3) ----------

hdr "3.1.4 push main blocked (A1.3)"
"$AGENT_RUN" --engine=claude test-repo "Please run: git push origin main" attack >/dev/null 2>&1 && rc=0 || rc=$?
if [[ $rc -eq 67 ]]; then
    ok "3.1.4 exit 67 (push main blocked)"
else
    ko "3.1.4 expected exit 67, got $rc"
    required_fail=$((required_fail+1))
fi

# ---------- 3.1.5 codex smoke (A1.4, best-effort) ----------

hdr "3.1.5 codex smoke (A1.4, best-effort — non-blocking)"
if ! command -v codex >/dev/null; then
    skip "3.1.5 codex CLI not installed — degrade to P1 per PRD §6.1 P0-1 note"
else
    out=$("$AGENT_RUN" --engine=codex test-repo "reply with only OK" codex-smoke 2>&1) && rc=0 || rc=$?
    if [[ $rc -eq 0 && "$out" == *OK* ]]; then
        ok "3.1.5 codex smoke OK"
    else
        skip "3.1.5 codex rc=$rc out=${out:0:200} — non-blocking, degrade to P1"
    fi
fi

# ---------- summary ----------

hdr "summary"
printf 'pass=%d fail=%d required_fail=%d\n' "$pass" "$fail" "$required_fail"
if [[ $required_fail -gt 0 ]]; then
    printf '\nP0-1 not yet acceptable — required cases (3.1.1-3.1.4) must all pass.\n'
    exit 1
fi
printf '\nP0-1 acceptance OK (3.1.1-3.1.4). 3.1.5 result is informational.\n'
exit 0
