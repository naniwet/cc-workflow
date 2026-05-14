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
# Default permission mode: auto-allow Edit/Write but still gate Bash/WebFetch.
# Backend sets `--permission-mode bypassPermissions` for workspaces marked
# trust=true in workspaces.json (or globally via config.toml default_trust).
PERMISSION_MODE="acceptEdits"
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
                 [--provider <name>] [--permission-mode <mode>]

  --provider <name>         Override config.toml's provider. For claude engine,
                            <name> must be a key in providers.json#profiles; for
                            codex engine, a key in providers.json#codex_profiles.
                            Falls back to config.toml then engine's default
                            ("claude" anthropic OAuth / "openai" built-in).
  --permission-mode <mode>  Claude tool-permission mode. One of:
                              acceptEdits        — default; Edit/Write auto-allowed
                              bypassPermissions  — all tools auto-allowed (use when
                                                   the workspace is "trusted")
                              plan               — planning only, no tool execution

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
        --permission-mode)
                      [[ $# -ge 2 ]] || { usage; die "$EX_USAGE" "--permission-mode needs value"; }
                      PERMISSION_MODE="$2"; shift 2 ;;
        --permission-mode=*)
                      PERMISSION_MODE="${1#--permission-mode=}"; shift ;;
        -h|--help)    usage; exit "$EX_OK" ;;
        --)           shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done ;;
        -*)           usage; die "$EX_USAGE" "unknown flag: $1" ;;
        *)            POSITIONAL+=("$1"); shift ;;
    esac
done

[[ -n "$ENGINE" ]] || { usage; die "$EX_USAGE" "missing --engine"; }
[[ "$ENGINE" =~ ^(claude|codex)$ ]] || die "$EX_USAGE" "engine must be claude|codex (got: $ENGINE)"
case "$SOURCE" in pwa|feishu|cron|manual) ;; *) die "$EX_USAGE" "bad --source: $SOURCE" ;; esac
case "$PERMISSION_MODE" in acceptEdits|bypassPermissions|plan|default) ;; *) die "$EX_USAGE" "bad --permission-mode: $PERMISSION_MODE (want acceptEdits|bypassPermissions|plan|default)" ;; esac
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

# Export env vars from providers.json's claude `profiles` section.
# No-op for engine != claude (codex has its own peer setup_codex_provider).
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

# codex peer of setup_provider. Reads providers.json's codex_profiles section
# and prepares a managed CODEX_HOME at ~/.cc-state/codex-home/ so we don't
# clobber the user's interactive ~/.codex/.
#
# Two profile shapes supported:
#
#   A. Endpoint-reference (new, DRY — shares config with roundtable):
#        codex_profiles.<name> = { "endpoint": "deepseek", "model": "..." }
#      → look up openai_endpoints[<endpoint>].{base_url, api_key, wire_api}
#      → export OPENAI_API_KEY=<api_key> (codex's standard env var name)
#      → write codex config.toml using base_url + env_key=OPENAI_API_KEY + wire_api
#
#   B. Inline (legacy, pre-2026-05-14):
#        codex_profiles.<name> = { "env": {...}, "base_url": "...",
#                                   "env_key": "...", "wire_api": "...", "model": "..." }
#      → export env, write codex config.toml using inline fields
#
#   C. env-only profile (e.g. default "openai"):
#        codex_profiles.<name> = { "env": { "OPENAI_API_KEY": "sk-..." } }
#      → just export env, codex uses its built-in default base_url.
#
# Why support all three: A is the cleanest going forward, but B is what users
# upgrading from May 2026 already have in their providers.json. C remains
# valid for the default openai.com path where you don't need any URL override.
#
# Caveat (unchanged): non-OpenAI codex endpoints support tool-use to varying
# degrees. Simple prompts probably work; complex agent flows may fail at the
# wire-api level. We bridge the config plumbing — making the model itself
# behave is upstream's problem.
CODEX_HOME_DIR="${STATE_DIR}/codex-home"
CODEX_PROFILE=""
setup_codex_provider() {
    [[ "$ENGINE" == "codex" ]] || return 0
    [[ -f "$PROVIDERS_FILE" ]] || return 0           # no providers file → codex defaults
    local profile
    profile="$(ccw_provider_name)"
    # Empty profile name → check if the user has any codex_profiles defined
    # and fall back to the first one; otherwise let codex use its built-in
    # default (needs OPENAI_API_KEY in env).
    if [[ -z "$profile" ]]; then
        profile="$(jq -r '.codex_profiles | keys | .[0] // ""' "$PROVIDERS_FILE")"
        [[ -z "$profile" ]] && return 0
    fi

    # Silently fall back to codex defaults if the profile name doesn't exist
    # under codex_profiles (e.g. user picked a name only valid for claude).
    # Note: by convention codex_profiles and profiles use parallel keys
    # ("deepseek" / "kimi") so a single config.toml provider line works
    # for both engines.
    jq -e --arg p "$profile" '.codex_profiles[$p]' "$PROVIDERS_FILE" >/dev/null 2>&1 || return 0

    # Branch on schema shape. `endpoint` field present → Shape A (ref).
    # Otherwise existing inline fields apply (Shape B/C).
    local has_endpoint
    has_endpoint="$(jq -r --arg p "$profile" '.codex_profiles[$p] | has("endpoint")' "$PROVIDERS_FILE")"

    if [[ "$has_endpoint" == "true" ]]; then
        # --- Shape A: endpoint reference ---
        local ep_name base_url api_key wire_api model
        ep_name="$(jq -r --arg p "$profile" '.codex_profiles[$p].endpoint' "$PROVIDERS_FILE")"
        # Resolve the endpoint from openai_endpoints (the shared block).
        jq -e --arg e "$ep_name" '.openai_endpoints[$e]' "$PROVIDERS_FILE" >/dev/null 2>&1 \
            || die "$EX_USAGE" "codex_profile '$profile' references endpoint '$ep_name' which is missing from openai_endpoints — edit $PROVIDERS_FILE"
        base_url="$(jq -r --arg e "$ep_name" '.openai_endpoints[$e].base_url // ""' "$PROVIDERS_FILE")"
        api_key="$( jq -r --arg e "$ep_name" '.openai_endpoints[$e].api_key  // ""' "$PROVIDERS_FILE")"
        wire_api="$(jq -r --arg e "$ep_name" '.openai_endpoints[$e].wire_api // "chat"' "$PROVIDERS_FILE")"
        model="$(   jq -r --arg p "$profile" '.codex_profiles[$p].model // "gpt-5-codex"' "$PROVIDERS_FILE")"
        [[ -n "$base_url" && -n "$api_key" ]] \
            || die "$EX_USAGE" "openai_endpoints['$ep_name'] missing base_url or api_key — edit $PROVIDERS_FILE"
        if [[ "$api_key" =~ ^\<.*\>$ ]]; then
            die "$EX_USAGE" "openai_endpoints['$ep_name'].api_key is still a placeholder ($api_key) — edit $PROVIDERS_FILE"
        fi
        # Standardize on OPENAI_API_KEY for codex's env_key — single name,
        # set per-run, doesn't collide with the user's interactive shell.
        export "OPENAI_API_KEY=$api_key"
        mkdir -p "$CODEX_HOME_DIR"
        cat > "$CODEX_HOME_DIR/config.toml" <<EOF
# Auto-generated by agent-run.sh from ~/.cc-workflow/providers.json — do not edit.
# Regenerated on every run. To customize, edit codex_profiles + openai_endpoints.
[model_providers.$profile]
base_url = "$base_url"
env_key  = "OPENAI_API_KEY"
wire_api = "$wire_api"

[profiles.$profile]
model           = "$model"
model_provider  = "$profile"
EOF
        export CODEX_HOME="$CODEX_HOME_DIR"
        CODEX_PROFILE="$profile"
        return 0
    fi

    # --- Shape B / C: legacy inline (env + optional base_url/env_key/wire_api/model) ---
    local key val
    while IFS=$'\t' read -r key val; do
        [[ -z "$key" ]] && continue
        if [[ "$val" =~ ^\<.*\>$ ]]; then
            die "$EX_USAGE" "codex_profile '$profile' has placeholder for $key — edit $PROVIDERS_FILE"
        fi
        export "$key=$val"
    done < <(jq -r --arg p "$profile" \
        '.codex_profiles[$p].env // {} | to_entries[] | "\(.key)\t\(.value)"' "$PROVIDERS_FILE")

    local has_base
    has_base="$(jq -r --arg p "$profile" '.codex_profiles[$p] | has("base_url")' "$PROVIDERS_FILE")"
    if [[ "$has_base" == "true" ]]; then
        mkdir -p "$CODEX_HOME_DIR"
        local base_url wire_api env_key model
        base_url="$(jq -r --arg p "$profile" '.codex_profiles[$p].base_url' "$PROVIDERS_FILE")"
        wire_api="$(jq -r --arg p "$profile" '.codex_profiles[$p].wire_api // "chat"' "$PROVIDERS_FILE")"
        env_key="$( jq -r --arg p "$profile" '.codex_profiles[$p].env_key  // "OPENAI_API_KEY"' "$PROVIDERS_FILE")"
        model="$(   jq -r --arg p "$profile" '.codex_profiles[$p].model    // "gpt-5-codex"' "$PROVIDERS_FILE")"
        cat > "$CODEX_HOME_DIR/config.toml" <<EOF
# Auto-generated by agent-run.sh from ~/.cc-workflow/providers.json — do not edit.
# Regenerated on every run. To customize, edit codex_profiles in providers.json.
[model_providers.$profile]
base_url = "$base_url"
env_key  = "$env_key"
wire_api = "$wire_api"

[profiles.$profile]
model           = "$model"
model_provider  = "$profile"
EOF
        export CODEX_HOME="$CODEX_HOME_DIR"
        CODEX_PROFILE="$profile"
    fi
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

# Read the input_tokens count from the last successful claude run for this
# session_key. Used by run_claude's pre-flight to decide whether to compact.
# Returns 0 when missing (fresh session) or unparseable.
get_session_tokens() {
    ensure_sessions_file
    jq -r --arg k "$SESSION_KEY" \
        '(.[$k].last_input_tokens // 0)' "$SESSIONS_FILE" 2>/dev/null || printf '0'
}

# Save the input_tokens count after a successful run, so next run's
# pre-flight can decide whether to compact.
save_session_tokens() {  # $1=tokens (integer)
    ensure_sessions_file
    local tokens="$1" tmp
    tmp="$(mktemp)"
    jq --arg k "$SESSION_KEY" --arg ws "$WORKSPACE" --argjson t "$tokens" \
        '
        (.[$k] //= {workspace:$ws, claude_session_id:null, codex_session_id:null, last_active_at:0})
        | .[$k].last_input_tokens = $t
        ' "$SESSIONS_FILE" > "$tmp" && mv "$tmp" "$SESSIONS_FILE"
}

# Used by run_compact's post-summary phase to drop the prior session_id so
# the next claude -p call starts fresh (no --resume).
clear_session_id() {  # $1=engine
    ensure_sessions_file
    local field="${1}_session_id" tmp
    tmp="$(mktemp)"
    jq --arg k "$SESSION_KEY" --arg f "$field" \
        'if .[$k] then .[$k][$f] = null else . end' \
        "$SESSIONS_FILE" > "$tmp" && mv "$tmp" "$SESSIONS_FILE"
}

# Read compact threshold from config.toml's `compact_threshold_tokens` field.
# Default 150k — leaves ~50k buffer in a 200k context (claude sonnet) for
# the new turn + system prompt + tool output. For 1M-context providers
# (deepseek-v4-pro[1m]) set compact_threshold_tokens = 800000 in config.
get_compact_threshold() {
    local default=150000 val
    [[ -f "$CCW_CONFIG" ]] || { printf '%s' "$default"; return; }
    val="$(awk -F'=' '
        /^[[:space:]]*compact_threshold_tokens[[:space:]]*=/ {
            gsub(/[[:space:]"]/, "", $2); print $2; exit
        }
    ' "$CCW_CONFIG")"
    if [[ -z "$val" ]]; then
        printf '%s' "$default"
    else
        printf '%s' "$val"
    fi
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

# ---------- DIY compact ----------
#
# Claude Code's /compact is TUI-only — not available under `claude -p`. We
# replicate it ourselves: when the prior turn's input_tokens (the size of
# everything sent to the model, including history) exceeds a threshold, run
# a summarization prompt against the current session, then drop the session
# and start fresh with the summary as preamble. The summary lives in the
# new turn's user message, not as a system prompt — claude -p doesn't
# expose system-prompt injection from the wrapper layer.
#
# Prompt structure mirrors Piebald-AI's reverse-engineered template for
# Claude Code's /compact (not Anthropic-confirmed but the closest public
# documentation of the format). 9 sections, with §6 (verbatim user messages)
# called out as non-negotiable per the Claude Code CHANGELOG note:
#   "Compaction prompt now asks the model to preserve sensitive user
#    instructions" (preserved verbatim in security-relevant places).
#
# INFERRED: structure based on Piebald-AI's repo, not official Anthropic
# docs. Adjust sections here if you find Anthropic publishes the real one.

COMPACT_PROMPT='You are compacting a long conversation between a user and an AI coding
assistant. The user is hitting context-window limits and needs the
conversation pruned to a structured summary that preserves enough state
for the conversation to continue coherently.

Output a single summary in EXACTLY this structure. Be terse but precise
— this summary IS the conversation history going forward.

## 1. Primary Request and Intent
The user'\''s core goal, in their own framing. Quote them verbatim where
their wording matters (e.g. constraints, preferences).

## 2. Key Technical Concepts
Concepts, libraries, patterns, conventions agreed on.

## 3. Files and Code Sections
- Full paths of files touched or referenced
- For each: 1-line description of role + what changed (if anything)
- Include critical code snippets (function signatures, schemas)

## 4. Errors and Fixes
Concrete bugs encountered and how they were resolved. Include exact
error messages when available.

## 5. Problem Solving
Investigation paths attempted, what was ruled out, what was confirmed.

## 6. All User Messages
List ALL of the user'\''s messages verbatim, in order. This is the most
important section — these are the user'\''s actual words and intent. Do
not paraphrase, do not omit, do not "clean up" their wording. If a
message is very long, you may truncate the middle with "[...]" but
the start and end must be verbatim.

## 7. Pending Tasks
Anything explicitly assigned but not yet completed. Use the user'\''s
words for the assignment when possible.

## 8. Current Work
What was being worked on at the moment of compaction. Include the
specific file/function, what'\''s done, what'\''s mid-flight.

## 9. Optional Next Step
One concrete, actionable next step that directly continues the user'\''s
last message. Skip if the conversation has clearly reached a natural
pause.

Preserve EXACTLY any security-relevant constraints, user preferences,
or "don'\''t do X" instructions the user explicitly stated. These are
non-negotiable and must appear verbatim where they apply.

Do not editorialize. Do not summarize the user'\''s emotional state. Do
not add your own opinions. Output the structured summary directly.'

# Run the compact prompt against the current session_id. Returns the
# summary text on stdout, or non-zero exit code on failure.
run_compact() {  # $1=old_sid
    local old_sid="$1" out rc=0 log="${LOGS_DIR}/$(date +%Y-%m-%d).jsonl"
    out="$(mktemp)"
    # Plain-text output format (no stream-json) — we just need the summary.
    # Permission mode acceptEdits since compact shouldn'\''t need write tools,
    # but a noop default is safer than bypassPermissions for a meta-prompt.
    ( cd "$WORKDIR" && timeout "$TIMEOUT_SECONDS" claude -p "$COMPACT_PROMPT" \
        --resume "$old_sid" --permission-mode acceptEdits ) >"$out" 2>>"$log" || rc=$?
    if [[ $rc -ne 0 ]]; then
        rm -f "$out"
        return 1
    fi
    cat "$out"
    rm -f "$out"
}

# ---------- engines ----------

run_claude() {
    local log="${LOGS_DIR}/$(date +%Y-%m-%d).jsonl"
    local resume=() stream rc=0 sid new_sid
    sid="$(get_session_id claude)"

    # ---------- pre-flight: DIY compact ----------
    # If the prior turn's input_tokens exceeded the configured threshold,
    # summarize the conversation and start a fresh session with the summary
    # as preamble. Skipped on fresh sessions (no sid yet) and when no prior
    # token count is recorded (first run after upgrade).
    if [[ -n "$sid" ]]; then
        local threshold last_tokens
        threshold="$(get_compact_threshold)"
        last_tokens="$(get_session_tokens)"
        if [[ "$last_tokens" =~ ^[0-9]+$ ]] && (( last_tokens > threshold )); then
            err "compact: prior turn used ${last_tokens} input tokens (> ${threshold}), summarizing"
            local summary
            if summary="$(run_compact "$sid")"; then
                # Prepend summary to PROMPT; drop sid so the next call
                # starts a fresh session that begins with this synthetic
                # "user message" containing the summary.
                PROMPT="[Previous conversation summary, auto-compacted to fit context]
${summary}

[New user message]
${PROMPT}"
                clear_session_id claude
                sid=""
                err "compact: ok — fresh session continues with summary preamble"
            else
                # Compact failed. Don't block the user — fall through to
                # the resume attempt; if it hits context limit, agent-run
                # dies with EX_ENGINE_FAIL and the user can manually reset.
                err "compact: failed; continuing with existing session (may hit context limit)"
            fi
        fi
    fi
    # ---------- end pre-flight ----------

    [[ -n "$sid" ]] && resume=(--resume "$sid")

    stream="$(mktemp)"
    ( cd "$WORKDIR" && timeout "$TIMEOUT_SECONDS" claude -p "$PROMPT" \
        --output-format stream-json --verbose \
        --permission-mode "$PERMISSION_MODE" "${resume[@]}" ) >"$stream" 2>>"$log" || rc=$?

    cat "$stream" >>"$log"

    if [[ $rc -eq 124 ]]; then rm -f "$stream"; die "$EX_TIMEOUT" "claude timeout (${TIMEOUT_SECONDS}s)"; fi
    if [[ $rc -ne 0 ]]; then  rm -f "$stream"; die "$EX_ENGINE_FAIL" "claude exit=$rc (log: $log)"; fi

    new_sid="$(jq -rs 'map(select(.type=="system" and .subtype=="init"))
                       | .[0].session_id // empty' "$stream" 2>/dev/null || true)"
    [[ -n "$new_sid" ]] && save_session_id claude "$new_sid"

    # Save input_tokens from this run so next run's pre-flight can decide
    # whether to compact. usage.input_tokens is the total prompt size sent
    # to the model — includes prior history when --resume is in play, so
    # it's the right proxy for "how big the conversation is now".
    local input_tokens
    input_tokens="$(jq -rs 'map(select(.type=="result")) | .[-1].usage.input_tokens // 0' "$stream" 2>/dev/null || echo 0)"
    if [[ "$input_tokens" =~ ^[0-9]+$ ]] && (( input_tokens > 0 )); then
        save_session_tokens "$input_tokens"
    fi

    # Final text: prefer type=result.result, fall back to concatenated assistant text.
    jq -rs 'if (map(select(.type=="result")) | length) > 0
            then (map(select(.type=="result")) | .[-1].result // "")
            else (map(select(.type=="assistant").message.content[]?
                      | select(.type=="text") | .text) | join(""))
            end' "$stream" 2>/dev/null || true

    rm -f "$stream"
}

run_codex() {
    # codex CLI (https://github.com/openai/codex) has a different surface from
    # Claude Code — translate Claude's semantics where possible, fail loudly
    # where there's no equivalent:
    #
    #   --json                       JSONL event stream → log only; we
    #                                 don't parse it (final-text path below).
    #   --output-last-message <path> Clean final assistant text to a file
    #                                 (avoids parsing JSON for the reply).
    #   -a never                     Never TTY-prompt for approval — we run
    #                                 headless, a prompt would hang.
    #   -s workspace-write           Sandbox: read all + write only inside
    #                                 WORKDIR; no network egress. (codex's
    #                                 only granularity. PreToolUse-style
    #                                 hooks don't exist upstream — see
    #                                 issue #8923 / #3817.)
    #   --skip-git-repo-check        We've already validated WORKDIR is a
    #                                 git repo at arg-parse time.
    #
    # PERMISSION_MODE is intentionally ignored here — claude's
    # acceptEdits/bypassPermissions vocabulary doesn't map. Backend enforces
    # engine=codex → trust=true at workspace-create time, so the user has
    # already opted into "auto-approve everything" by picking this engine.
    #
    # Session resume:
    # We can't fetch session_id from --json output (upstream issue #8923),
    # so claude's "store sid in sessions.json, pass --resume <sid>" pattern
    # doesn't translate. Instead use codex's own per-cwd "resume --last"
    # semantics: codex tracks the most recent session by cwd, and our
    # WORKDIR is already per-session_key (via worktree when session_key !=
    # "default"). So resume-on-this-cwd ≈ resume-on-this-session_key.
    #
    # We gate it behind a marker file under STATE_DIR so we don't try to
    # resume a session that never existed on the first run for a new
    # workspace/session_key combo — `codex exec resume --last` errors out
    # with "no prior session" in that case.
    local log="${LOGS_DIR}/$(date +%Y-%m-%d).jsonl"
    local out rc=0
    out="$(mktemp)"
    local marker_dir="${STATE_DIR}/codex-sessions"
    local marker_safe
    marker_safe="$(printf '%s' "${WORKSPACE}__${SESSION_KEY}" | tr -c 'A-Za-z0-9._-' '_')"
    local marker="${marker_dir}/${marker_safe}"
    # Build the codex command. `exec resume --last` continues the most
    # recent session in cwd; `exec` starts a fresh one. CODEX_PROFILE is set
    # by setup_codex_provider iff a custom-endpoint profile was active.
    local cmd=(codex exec)
    if [[ -f "$marker" ]]; then
        cmd+=(resume --last)
    fi
    [[ -n "$CODEX_PROFILE" ]] && cmd+=(--profile "$CODEX_PROFILE")
    cmd+=(--json --output-last-message "$out" -a never -s workspace-write --skip-git-repo-check "$PROMPT")
    (
        cd "$WORKDIR" && timeout "$TIMEOUT_SECONDS" "${cmd[@]}"
    ) >>"$log" 2>&1 || rc=$?
    if [[ $rc -eq 124 ]]; then rm -f "$out"; die "$EX_TIMEOUT" "codex timeout (${TIMEOUT_SECONDS}s)"; fi
    if [[ $rc -ne 0 ]]; then  rm -f "$out"; die "$EX_ENGINE_FAIL" "codex exit=$rc (log: $log)"; fi
    # First-run success → drop the marker so the next call resumes. If codex
    # state gets wiped externally (e.g. ~/.codex/ deleted), the resume call
    # will fail loudly with EX_ENGINE_FAIL — user can clear our marker by
    # hand. We don't auto-recover because silently dropping conversation
    # context would be more surprising than an explicit error.
    mkdir -p "$marker_dir"
    touch "$marker"
    # Emit the final assistant text so the outer OUTPUT="$(run_codex)" captures
    # it. codex writes plain text (no JSON wrapping) to --output-last-message.
    cat "$out" 2>/dev/null || true
    rm -f "$out"
}

# ---------- main ----------

job_start
setup_provider
setup_codex_provider

if [[ "$ENGINE" == "claude" ]]; then
    OUTPUT="$(run_claude)" || RC=$?
else
    OUTPUT="$(run_codex)" || RC=$?
fi

[[ -n "$OUTPUT" ]] && printf '%s\n' "$OUTPUT"
exit "$RC"
