#!/usr/bin/env bash
#
# agent-run — Claude Code CLI wrapper (was P0-1).
# Original interface contract: docs/archive/02-dev-plan.md §4.1
# (Note: implementation has evolved past the original contract; see file body.)
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
# Wall-clock cap for the compact pre-flight only (the 9-section summary
# prompt; should finish in 30-60s, anything past 600s is a hang). Main
# `claude -p` calls run unbounded — see run_claude. Removed the main-task
# timeout 2026-05-14 because (a) the 'protect against hang' rationale was
# weaker than thought (flock is a global 3-slot pool, not per-workspace,
# so a hung task only blocks 1/3 of concurrency), (b) the user-facing
# cost was real: any task > 10 min got murdered.
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
Usage: agent-run --engine=claude <workspace> "<prompt>" [session_key]
                 [--source <pwa|feishu|cron|manual>] [--job-name <name>]
                 [--provider <name>] [--permission-mode <mode>]

  --engine=claude           Only "claude" is supported. The flag is kept for
                            backward compat with cron entries; codex support
                            was removed 2026-05-14 after upstream removed
                            wire_api=chat in codex-cli 0.130+, which broke
                            non-OpenAI providers (DeepSeek/Kimi). See README
                            "engine 现状" for re-enable steps.
  --provider <name>         Override config.toml's provider. <name> must be
                            a key in ~/.cc-workflow/providers.json#profiles.
                            Falls back to config.toml then "claude" (anthropic
                            OAuth via local `claude login`).
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
# codex was removed 2026-05-14 — see usage doc. Old cron entries or
# workspaces.json rows with engine=codex will fail here with a clear
# error rather than silently working in a half-broken state.
[[ "$ENGINE" == "claude" ]] || die "$EX_USAGE" "engine must be claude (codex support removed; got: $ENGINE)"
case "$SOURCE" in pwa|feishu|cron|manual) ;; *) die "$EX_USAGE" "bad --source: $SOURCE" ;; esac
case "$PERMISSION_MODE" in acceptEdits|bypassPermissions|plan|default|dontAsk|auto) ;; *) die "$EX_USAGE" "bad --permission-mode: $PERMISSION_MODE (want acceptEdits|bypassPermissions|plan|default|dontAsk|auto)" ;; esac
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

# Export env vars from providers.json's `profiles` section before
# invoking claude. (Only "claude" engine is supported — see arg parse
# above. Function-level guard kept for defense-in-depth in case a
# future engine is added without removing the guard.)
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

# NOTE: setup_codex_provider() + run_codex() removed 2026-05-14.
# codex-cli 0.130+ dropped wire_api=chat, breaking DeepSeek/Kimi support.
# See README "engine 现状" section + git history (commits 35afb12 / acac176)
# if you want to revive codex support later.


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

    # Stream path: when backend passed CCW_RUN_ID, write to a deterministic
    # path under LOGS_DIR. That lets the backend's GET /runs/{id}/tail
    # endpoint stream the live output to PWA's run-detail page — so the
    # user can tell "claude is still working" vs "claude is stuck" without
    # ssh'ing in. Fallback to mktemp keeps `agent-run` usable from the
    # CLI without the wrapper env (e.g. manual debugging).
    if [[ -n "${CCW_RUN_ID:-}" ]]; then
        stream="${LOGS_DIR}/run-${CCW_RUN_ID}.stream.jsonl"
        : >"$stream"   # truncate (a new turn replaces the previous tail)
    else
        stream="$(mktemp)"
    fi
    # Capture claude's stderr to a tmpfile so on failure we can both:
    #   - append it to the day log (existing behavior)
    #   - echo it back to OUR stderr → backend's subprocess pipe sees it
    #     → PWA detail page shows the real error, not just
    #       "agent-run: claude exit=1"
    errfile="$(mktemp)"
    # No `timeout` wrapper — long tasks (>10 min) should be able to run to
    # completion. If claude actually hangs (rare; would need a tool call
    # waiting on stdin or a stuck stream), an admin can `kill <pid>` it
    # manually; the EXIT trap will free the concurrency slot. The slot pool
    # is global 3-wide, so one hung task doesn't block other workspaces.
    ( cd "$WORKDIR" && claude -p "$PROMPT" \
        --output-format stream-json --verbose \
        --permission-mode "$PERMISSION_MODE" "${resume[@]}" ) >"$stream" 2>"$errfile" || rc=$?

    # ---------- stale-session recovery ----------
    # When --resume <sid> points to a conversation claude no longer
    # knows about, claude exits non-zero with stderr:
    #     "No conversation found with session ID: <sid>"
    # Causes we've seen:
    #   - ~/.claude/projects/ was manually cleaned
    #   - claude expired old sessions but sessions.json wasn't invalidated
    #   - state migration / deploy mode flip left orphan sids
    # Recover transparently: clear the stale sid, rerun without --resume.
    # User just sees the fresh-session reply (with no prior context); much
    # better than a baffling "exit 66" they can't act on.
    #
    # Only retry once — second-attempt failure means something else is
    # wrong, fall through to the normal failure path.
    if [[ $rc -ne 0 ]] && [[ -n "$sid" ]] \
       && grep -qF "No conversation found with session ID" "$errfile"; then
        err "claude: --resume ${sid} failed (session not in claude store); clearing + retrying fresh"
        clear_session_id claude \
            || err "warn: clear_session_id failed; sessions.json may still contain stale sid"
        sid=""
        resume=()
        rc=0
        : >"$stream"     # discard partial output from the failed first attempt
        : >"$errfile"
        ( cd "$WORKDIR" && claude -p "$PROMPT" \
            --output-format stream-json --verbose \
            --permission-mode "$PERMISSION_MODE" ) >"$stream" 2>"$errfile" || rc=$?
    fi
    # ---------- end stale-session recovery ----------

    cat "$stream" >>"$log"
    cat "$errfile" >>"$log"

    if [[ $rc -ne 0 ]]; then
        # Bubble claude's stderr out so backend's pipe captures it (otherwise
        # PWA detail page just shows our useless "claude exit=1" with the
        # actual root cause buried in /root/.cc-state/logs/$(date).jsonl).
        cat "$errfile" >&2
        rm -f "$errfile"
        # Don't rm the deterministic-path stream — backend's tail endpoint
        # still wants to surface the partial output to the user (e.g. to
        # show what claude printed before the error).
        [[ "$stream" == /tmp/* ]] && rm -f "$stream"
        die "$EX_ENGINE_FAIL" "claude exit=$rc (log: $log)"
    fi
    rm -f "$errfile"

    new_sid="$(jq -rs 'map(select(.type=="system" and .subtype=="init"))
                       | .[0].session_id // empty' "$stream" 2>/dev/null || true)"
    # save_session_id internal failure (sessions.json corrupt / unwritable /
    # jq error) used to bubble through set -e and kill the whole script
    # with exit 1 EVEN THOUGH claude itself succeeded and printed a reply.
    # The PWA then showed the run as "failed exit 1" with the full claude
    # output visible in the Output panel — a baffling user experience.
    # Demote these to warnings: session_id save failures are real but
    # non-fatal (worst case: next turn doesn't resume cleanly, claude
    # starts a fresh session). Same treatment below for save_session_tokens.
    if [[ -n "$new_sid" ]]; then
        save_session_id claude "$new_sid" \
            || err "warn: save_session_id failed; session resume next turn may not work"
    fi

    # Save input_tokens from this run so next run's pre-flight can decide
    # whether to compact. usage.input_tokens is the total prompt size sent
    # to the model — includes prior history when --resume is in play, so
    # it's the right proxy for "how big the conversation is now".
    local input_tokens
    input_tokens="$(jq -rs 'map(select(.type=="result")) | .[-1].usage.input_tokens // 0' "$stream" 2>/dev/null || echo 0)"
    if [[ "$input_tokens" =~ ^[0-9]+$ ]] && (( input_tokens > 0 )); then
        save_session_tokens "$input_tokens" \
            || err "warn: save_session_tokens failed; DIY compact may misjudge size next turn"
    fi

    # Final text: prefer type=result.result, fall back to concatenated assistant text.
    jq -rs 'if (map(select(.type=="result")) | length) > 0
            then (map(select(.type=="result")) | .[-1].result // "")
            else (map(select(.type=="assistant").message.content[]?
                      | select(.type=="text") | .text) | join(""))
            end' "$stream" 2>/dev/null || true

    # Only rm temp-path streams; leave deterministic-path streams in place
    # so backend can show them in run-detail history after the fact (the
    # next turn for the same run_id will truncate them).
    #
    # NB: written as `if … fi` rather than `[[ … ]] && rm …` on purpose.
    # The `&&` form would make this the function's final expression, and
    # when `stream` is NOT in /tmp (the common deterministic-path case),
    # the `[[ … ]]` short-circuits to exit 1 — propagating up as
    # `run_claude` returning 1, which the main script then reports as
    # exit=1 even though claude actually succeeded. Cost the user
    # one "你好 → failed exit 1" before I caught it.
    if [[ "$stream" == /tmp/* ]]; then
        rm -f "$stream"
    fi
}

# NOTE: run_codex() removed 2026-05-14. See setup_codex_provider removal
# note above and the README "engine 现状" section.

# ---------- main ----------

job_start
setup_provider

OUTPUT="$(run_claude)" || RC=$?

[[ -n "$OUTPUT" ]] && printf '%s\n' "$OUTPUT"
exit "$RC"
