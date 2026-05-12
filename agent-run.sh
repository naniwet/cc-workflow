#!/usr/bin/env bash
#
# agent-run — multi-engine agent wrapper (P0-1).
# Contract: docs/02-dev-plan.md §4.1
#
set -euo pipefail

# ---------- constants ----------

readonly EX_OK=0
readonly EX_USAGE=64           # invalid usage
readonly EX_CONCURRENCY=65     # concurrency limit reached
readonly EX_ENGINE_FAIL=66     # engine call failed
readonly EX_PUSH_MAIN=67       # git push to main/master blocked
readonly EX_TIMEOUT=68         # > TIMEOUT_SECONDS

readonly STATE_DIR="${HOME}/.cc-state"
readonly LOCKS_DIR="${STATE_DIR}/locks"
readonly JOBS_DIR="${STATE_DIR}/jobs"
readonly LOGS_DIR="${STATE_DIR}/logs"
readonly SESSIONS_FILE="${STATE_DIR}/sessions.json"
readonly CCW_CONFIG="${HOME}/.cc-workflow/config.toml"
readonly PROVIDERS_FILE="${HOME}/.cc-workflow/providers.json"
readonly WORKSPACES_DIR="${HOME}/workspaces"
readonly WT_BASE="${WORKSPACES_DIR}/.wt"
readonly CONCURRENCY_LIMIT=3
readonly TIMEOUT_SECONDS=600

# ---------- state (declared before any trap can read them) ----------

ENGINE=""
SOURCE="manual"
JOB_NAME=""
JOB_FILE=""
PROVIDER_OVERRIDE=""
SESSION_KEY="default"
WORKSPACE=""
PROMPT=""
WORKSPACE_PATH=""
WORKDIR=""
OUTPUT=""
RC=0
POSITIONAL=()

# ---------- utils ----------

usage() {
    cat >&2 <<'EOF'
Usage: agent-run --engine=<claude|codex> <workspace> "<prompt>" [session_key]
                 [--source <pwa|feishu|cron|manual>] [--job-name <name>]
                 [--provider <name>]

  --provider <name>   Override config.toml's provider (must match a profile
                      key in ~/.cc-workflow/providers.json). For per-workspace
                      LLM backend; falls back to config.toml then "claude".

Exit (sysexits.h): 0 ok | 64 usage | 65 concurrency | 66 engine | 67 push-main | 68 timeout
EOF
}

err() { printf 'agent-run: %s\n' "$*" >&2; }
die() { local rc=$1; shift; err "$*"; RC="$rc"; exit "$rc"; }

# ---------- arg parse ----------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --engine=*)   ENGINE="${1#--engine=}"; shift ;;
        --source)     [[ $# -ge 2 ]] || { usage; die "$EX_USAGE" "--source needs value"; }
                      SOURCE="$2"; shift 2 ;;
        --source=*)   SOURCE="${1#--source=}"; shift ;;
        --job-name)   [[ $# -ge 2 ]] || { usage; die "$EX_USAGE" "--job-name needs value"; }
                      JOB_NAME="$2"; shift 2 ;;
        --job-name=*) JOB_NAME="${1#--job-name=}"; shift ;;
        --provider)   [[ $# -ge 2 ]] || { usage; die "$EX_USAGE" "--provider needs value"; }
                      PROVIDER_OVERRIDE="$2"; shift 2 ;;
        --provider=*) PROVIDER_OVERRIDE="${1#--provider=}"; shift ;;
        -h|--help)    usage; exit "$EX_OK" ;;
        --)           shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done ;;
        -*)           usage; die "$EX_USAGE" "unknown flag: $1" ;;
        *)            POSITIONAL+=("$1"); shift ;;
    esac
done

[[ -n "$ENGINE" ]] || { usage; die "$EX_USAGE" "missing --engine"; }
[[ "$ENGINE" =~ ^(claude|codex)$ ]] || die "$EX_USAGE" "engine must be claude|codex (got: $ENGINE)"
case "$SOURCE" in pwa|feishu|cron|manual) ;; *) die "$EX_USAGE" "bad --source: $SOURCE" ;; esac
[[ ${#POSITIONAL[@]} -ge 2 ]] || { usage; die "$EX_USAGE" "need <workspace> and <prompt>"; }
[[ ${#POSITIONAL[@]} -le 3 ]] || die "$EX_USAGE" "too many positional args"

WORKSPACE="${POSITIONAL[0]}"
PROMPT="${POSITIONAL[1]}"
SESSION_KEY="${POSITIONAL[2]:-default}"

WORKSPACE_PATH="${WORKSPACES_DIR}/${WORKSPACE}"
[[ -d "${WORKSPACE_PATH}/.git" ]] || die "$EX_USAGE" "workspace not a git repo: ${WORKSPACE_PATH}"

# ---------- push-main static guard ----------
# MINIMAL_CHOICE: prompt-level static check only. Runtime tool-call inspection
# (scanning stream-json for Bash tool_use calls) is deferred to P1.
PROMPT_FLAT="$(printf '%s' "$PROMPT" | tr '\n' ' ')"
if grep -qiE 'git[[:space:]]+push[[:space:]].*\b(main|master)\b' <<<"$PROMPT_FLAT"; then
    die "$EX_PUSH_MAIN" "prompt requests git push to main/master — blocked"
fi

# ---------- ensure state dirs ----------

mkdir -p "$STATE_DIR" "$LOCKS_DIR" "$LOGS_DIR" "$JOBS_DIR"
chmod 700 "$LOGS_DIR" 2>/dev/null || true   # P0-7e

[[ -n "$JOB_NAME" ]] && JOB_FILE="${JOBS_DIR}/${JOB_NAME}.json"

# ---------- provider switching (dev-plan §4.1.1-2) ----------
#
# Two config files in ~/.cc-workflow/:
#   - config.toml     non-secret, single line:  provider = "deepseek"
#   - providers.json  ccswitch-style schema:
#       { "profiles": { "<name>": { "env": { "KEY": "VAL", ... } } } }
#
# A profile with empty env (e.g. "claude") = "use anthropic local OAuth, export nothing".
# Schema and placeholder convention (<...>) borrowed from ccswitch.

# Read provider name. Priority:
#   1. --provider <name> CLI flag (PROVIDER_OVERRIDE)
#   2. ~/.cc-workflow/config.toml [provider]
#   3. fallback "claude" (empty-env profile → no env vars exported)
ccw_provider_name() {
    if [[ -n "$PROVIDER_OVERRIDE" ]]; then
        printf '%s' "$PROVIDER_OVERRIDE"
        return
    fi
    [[ -f "$CCW_CONFIG" ]] || { printf 'claude'; return; }
    awk -F'=' '
        /^[[:space:]]*provider[[:space:]]*=/ {
            gsub(/[[:space:]"]/, "", $2); print $2; exit
        }
    ' "$CCW_CONFIG"
}

# Export the env vars for the configured profile. No-op for engine != claude.
setup_provider() {
    [[ "$ENGINE" == "claude" ]] || return 0
    local profile key val
    profile="$(ccw_provider_name)"
    [[ -z "$profile" ]] && profile="claude"
    # Empty-env profile (claude / anthropic) = local OAuth fallback.
    [[ "$profile" == "claude" || "$profile" == "anthropic" ]] && return 0

    [[ -f "$PROVIDERS_FILE" ]] \
        || die "$EX_USAGE" "missing $PROVIDERS_FILE — run scripts/install-deps.sh"
    jq -e --arg p "$profile" '.profiles[$p].env' "$PROVIDERS_FILE" >/dev/null 2>&1 \
        || die "$EX_USAGE" "profile '$profile' not in $PROVIDERS_FILE"

    while IFS=$'\t' read -r key val; do
        [[ -z "$key" ]] && continue
        if [[ "$val" =~ ^\<.*\>$ ]]; then
            die "$EX_USAGE" "profile '$profile' has placeholder for $key — edit $PROVIDERS_FILE"
        fi
        export "$key=$val"
    done < <(jq -r --arg p "$profile" \
        '.profiles[$p].env | to_entries[] | "\(.key)\t\(.value)"' "$PROVIDERS_FILE")
}

# ---------- sessions.json helpers ----------

ensure_sessions_file() {
    [[ -f "$SESSIONS_FILE" ]] || printf '%s\n' '{}' >"$SESSIONS_FILE"
}

get_session_id() {  # $1=engine; stdout=sid or empty
    ensure_sessions_file
    jq -r --arg k "$SESSION_KEY" --arg f "${1}_session_id" \
        '(.[$k][$f] // "")' "$SESSIONS_FILE" 2>/dev/null || true
}

save_session_id() {  # $1=engine, $2=sid
    ensure_sessions_file
    local field="${1}_session_id" sid="$2" now tmp
    now="$(date +%s)"
    tmp="$(mktemp)"
    jq --arg k "$SESSION_KEY" --arg ws "$WORKSPACE" --arg f "$field" \
       --arg sid "$sid" --argjson now "$now" '
        (.[$k] //= {workspace:$ws, claude_session_id:null, codex_session_id:null, last_active_at:0})
        | .[$k][$f] = $sid
        | .[$k].workspace = $ws
        | .[$k].last_active_at = $now' \
        "$SESSIONS_FILE" >"$tmp" && mv "$tmp" "$SESSIONS_FILE"
}

# ---------- job-state helpers (cron) ----------

job_init_if_missing() {
    [[ -z "$JOB_FILE" ]] && return 0
    [[ -f "$JOB_FILE" ]] && return 0
    jq -n --arg n "$JOB_NAME" \
        '{name:$n, last_run_at:null, last_finished_at:null, last_exit:null,
          last_output_summary:null, consecutive_errors:0, last_error_at:null,
          last_error_msg:null, total_runs:0, enabled:true}' >"$JOB_FILE"
}

job_start() {
    [[ -z "$JOB_FILE" ]] && return 0
    job_init_if_missing
    local now tmp
    now="$(date +%s)"
    tmp="$(mktemp)"
    jq --argjson now "$now" '.last_run_at=$now | .total_runs=((.total_runs//0)+1)' \
        "$JOB_FILE" >"$tmp" && mv "$tmp" "$JOB_FILE"
}

job_finish() {
    [[ -z "$JOB_FILE" ]] && return 0
    [[ -f "$JOB_FILE" ]] || return 0
    local rc="$1" summary="$2" now tmp
    now="$(date +%s)"
    tmp="$(mktemp)"
    if [[ "$rc" -eq 0 ]]; then
        jq --argjson now "$now" --argjson rc "$rc" --arg s "$summary" \
           '.last_finished_at=$now | .last_exit=$rc | .last_output_summary=$s
            | .consecutive_errors=0 | .last_error_at=null | .last_error_msg=null' \
            "$JOB_FILE" >"$tmp" && mv "$tmp" "$JOB_FILE"
    else
        jq --argjson now "$now" --argjson rc "$rc" --arg s "$summary" \
           '.last_finished_at=$now | .last_exit=$rc | .last_output_summary=$s
            | .consecutive_errors=((.consecutive_errors//0)+1)
            | .last_error_at=$now | .last_error_msg=$s' \
            "$JOB_FILE" >"$tmp" && mv "$tmp" "$JOB_FILE"
    fi
}

# ---------- trap: cleanup + job-state on any exit path ----------

on_exit() {
    local rc=$?
    local summary
    summary="$(printf '%s' "${OUTPUT:-}" | head -c 200)"
    [[ "$rc" -ne 0 && -z "$summary" ]] && summary="exit=$rc"
    job_finish "$rc" "$summary" 2>/dev/null || true
    rm -f "${LOCKS_DIR}/$$.lock" 2>/dev/null || true
}
trap on_exit EXIT

# ---------- concurrency lock (3 slots via flock) ----------

acquire_slot() {
    local slot
    for slot in $(seq 1 "$CONCURRENCY_LIMIT"); do
        exec 9>"${LOCKS_DIR}/slot-${slot}.lock"
        if flock -n 9; then
            touch "${LOCKS_DIR}/$$.lock"
            return 0
        fi
    done
    exec 9>&-
    return 1
}

acquire_slot || die "$EX_CONCURRENCY" "concurrency limit ($CONCURRENCY_LIMIT) reached"

# ---------- workdir: worktree only when session_key != default ----------

if [[ "$SESSION_KEY" == "default" ]]; then
    WORKDIR="$WORKSPACE_PATH"
else
    SESSION_SAFE="$(printf '%s' "$SESSION_KEY" | tr -c 'A-Za-z0-9._-' '_')"
    WORKDIR="${WT_BASE}/${WORKSPACE}-${SESSION_SAFE}"
    if [[ ! -d "$WORKDIR" ]]; then
        mkdir -p "$WT_BASE"
        BRANCH="cc/${WORKSPACE}-${SESSION_SAFE}"
        ( cd "$WORKSPACE_PATH" && git worktree add -B "$BRANCH" "$WORKDIR" >&2 ) \
            || die "$EX_ENGINE_FAIL" "git worktree add failed: $WORKDIR"
    fi
fi

# ---------- engines ----------

run_claude() {
    local log="${LOGS_DIR}/$(date +%Y-%m-%d).jsonl"
    local resume=() stream rc=0 sid new_sid
    sid="$(get_session_id claude)"
    [[ -n "$sid" ]] && resume=(--resume "$sid")

    stream="$(mktemp)"
    ( cd "$WORKDIR" && timeout "$TIMEOUT_SECONDS" claude -p "$PROMPT" \
        --output-format stream-json --verbose \
        --permission-mode acceptEdits "${resume[@]}" ) >"$stream" 2>>"$log" || rc=$?

    cat "$stream" >>"$log"

    if [[ $rc -eq 124 ]]; then rm -f "$stream"; die "$EX_TIMEOUT" "claude timeout (${TIMEOUT_SECONDS}s)"; fi
    if [[ $rc -ne 0 ]]; then  rm -f "$stream"; die "$EX_ENGINE_FAIL" "claude exit=$rc (log: $log)"; fi

    new_sid="$(jq -rs 'map(select(.type=="system" and .subtype=="init"))
                       | .[0].session_id // empty' "$stream" 2>/dev/null || true)"
    [[ -n "$new_sid" ]] && save_session_id claude "$new_sid"

    # Final text: prefer type=result.result, fall back to concatenated assistant text.
    jq -rs 'if (map(select(.type=="result")) | length) > 0
            then (map(select(.type=="result")) | .[-1].result // "")
            else (map(select(.type=="assistant").message.content[]?
                      | select(.type=="text") | .text) | join(""))
            end' "$stream" 2>/dev/null || true

    rm -f "$stream"
}

run_codex() {
    # Codex is best-effort in P0. Day-0 reality check verifies `codex exec` syntax.
    local log="${LOGS_DIR}/$(date +%Y-%m-%d).jsonl"
    local rc=0
    ( cd "$WORKDIR" && timeout "$TIMEOUT_SECONDS" codex exec "$PROMPT" ) 2>>"$log" || rc=$?
    if [[ $rc -eq 124 ]]; then die "$EX_TIMEOUT" "codex timeout"; fi
    if [[ $rc -ne 0 ]]; then die "$EX_ENGINE_FAIL" "codex exit=$rc (log: $log)"; fi
}

# ---------- main ----------

job_start
setup_provider

if [[ "$ENGINE" == "claude" ]]; then
    OUTPUT="$(run_claude)" || RC=$?
else
    OUTPUT="$(run_codex)" || RC=$?
fi

[[ -n "$OUTPUT" ]] && printf '%s\n' "$OUTPUT"
exit "$RC"
