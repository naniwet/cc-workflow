#!/usr/bin/env bash
#
# scripts/install-deps.sh — install P0-1 dependencies on Linux server.
# Contract: dev-plan §8 + §10 (deps-only, NOT a deploy setup.sh).
# Idempotent: re-running is safe.
#
set -euo pipefail

err()  { printf '\e[31m[install-deps]\e[0m %s\n' "$*" >&2; }
log()  { printf '\e[32m[install-deps]\e[0m %s\n' "$*"; }
warn() { printf '\e[33m[install-deps]\e[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ "$(uname -s)" == "Linux" ]] || { err "this script targets Linux server (got $(uname -s)); see dev-plan §8"; exit 1; }

# ---------- claude code CLI ----------
if have claude; then
    log "claude: $(claude --version 2>/dev/null || echo '?')"
else
    have npm || { err "npm missing — install Node.js first: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"; exit 1; }
    log "installing @anthropic-ai/claude-code..."
    sudo npm install -g @anthropic-ai/claude-code
fi

# ---------- codex CLI ----------
# C1+ (May 2026): codex is no longer best-effort. agent-run's run_codex calls
# codex non-interactively and a workspace created with engine=codex actually
# routes through here. Install it unconditionally so users picking codex in
# the PWA don't hit "command not found".
#
# The /usr/local/bin/codex symlink is essential: npm's global install
# typically lands under ~/.npm-global/bin or similar, which IS NOT in
# systemd's default PATH. cc-workflow.service runs as a systemd unit, so
# without the symlink agent-run subprocess fails with exit 127 (timeout
# wrapper reports "No such file or directory"). /usr/local/bin is in
# systemd's default PATH on Ubuntu, so a symlink there fixes it.
if have codex; then
    log "codex: $(codex --version 2>/dev/null || codex --help 2>&1 | head -1)"
else
    have npm || { err "npm missing — install Node.js first (see claude install step above)"; exit 1; }
    log "installing @openai/codex..."
    sudo npm install -g @openai/codex
fi

# Ensure /usr/local/bin/codex symlink exists (systemd PATH visibility).
if [[ ! -e /usr/local/bin/codex ]]; then
    if have codex; then
        sudo ln -sf "$(command -v codex)" /usr/local/bin/codex
        log "linked /usr/local/bin/codex → $(command -v codex)"
    else
        warn "codex not on PATH after install — manually: sudo ln -sf <path> /usr/local/bin/codex"
    fi
fi

# ---------- jq ----------
if have jq; then
    log "jq: $(jq --version)"
else
    log "installing jq..."
    sudo apt-get update -qq && sudo apt-get install -y jq
fi

# ---------- flock (util-linux, usually pre-installed) ----------
have flock || { err "flock missing — sudo apt install -y util-linux"; exit 1; }
log "flock: OK"

# ---------- gh CLI (optional but recommended for PR creation) ----------
if have gh; then
    log "gh: $(gh --version | head -1)"
    if gh auth status >/dev/null 2>&1; then
        log "gh auth: OK"
    else
        warn "gh not authenticated — run: gh auth login"
    fi
else
    warn "gh CLI not installed (recommended). Install: https://cli.github.com/"
fi

# ---------- ~/.cc-workflow/config.toml + providers.json + secrets.toml ----------
CCW_DIR="${HOME}/.cc-workflow"
CCW_CONFIG="${CCW_DIR}/config.toml"
PROVIDERS_FILE="${CCW_DIR}/providers.json"
SECRETS_FILE="${CCW_DIR}/secrets.toml"
mkdir -p "$CCW_DIR"

if [[ -f "$CCW_CONFIG" ]]; then
    log "config.toml exists at $CCW_CONFIG — not overwriting"
else
    log "writing config.toml template to $CCW_CONFIG"
    cat > "$CCW_CONFIG" <<'TOML'
# cc-workflow non-secret config. Safe to commit.
# Which LLM-backend profile to use (matches a key under "profiles" in providers.json).
# "claude" (or "anthropic") = empty profile → use Anthropic local OAuth.
provider = "deepseek"

# DIY compact threshold — when the prior PWA turn's input_tokens exceeds
# this, agent-run.sh auto-summarizes the conversation and starts a fresh
# session with the summary as preamble. Tune per your provider's context:
#   200000 (claude sonnet):    leave at 150000 for ~50k headroom
#   128000 (kimi etc):         drop to 90000
#   1000000 (deepseek-v4-pro): bump to 800000 (or leave; rarely triggers)
# compact_threshold_tokens = 150000
fi

if [[ -f "$PROVIDERS_FILE" ]]; then
    log "providers.json exists at $PROVIDERS_FILE — not overwriting"
else
    log "writing providers.json template to $PROVIDERS_FILE"
    # Schema borrowed from ccswitch: profiles.<name>.env is a flat dict of
    # env vars to export. Placeholder values <...> trigger an error in agent-run
    # if the profile is selected before keys are filled.
    cat > "$PROVIDERS_FILE" <<'JSON'
{
  "profiles": {
    "deepseek": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "<api-key>",
        "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
        "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
        "CLAUDE_CODE_EFFORT_LEVEL": "max"
      }
    },
    "kimi": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.kimi.com/coding/",
        "ANTHROPIC_API_KEY": "<api-key>"
      }
    }
  },
  "openai_endpoints": {
    "deepseek": { "base_url": "https://api.deepseek.com/v1", "api_key": "<api-key>", "wire_api": "chat" },
    "moonshot": { "base_url": "https://api.moonshot.cn/v1", "api_key": "<api-key>", "wire_api": "chat" }
  },
  "codex_profiles": {
    "deepseek": { "endpoint": "deepseek", "model": "deepseek-chat" },
    "kimi":     { "endpoint": "moonshot", "model": "kimi-k2.6" }
  }
}
JSON
fi
chmod 0600 "$PROVIDERS_FILE"
log "providers.json: 0600"

# ---------- secrets.toml ([ui] for HTTP Basic, future: Feishu/VAPID) ----------
GENERATED_PASSWORD=""
if [[ -f "$SECRETS_FILE" ]]; then
    log "secrets.toml exists at $SECRETS_FILE — not overwriting"
    if ! grep -q '^\[ui\]' "$SECRETS_FILE"; then
        warn "secrets.toml has no [ui] section — backend UI returns 503 until you add one"
        warn "  example: printf '\\n[ui]\\nusername = \"admin\"\\npassword = \"<pick-one>\"\\n' >> $SECRETS_FILE"
    fi
else
    GENERATED_PASSWORD=$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(20)))')
    log "writing secrets.toml template to $SECRETS_FILE"
    cat > "$SECRETS_FILE" <<TOML
# cc-workflow secrets — DO NOT COMMIT to git
# Permissions enforced to 0600 by install-deps.sh

[ui]
# HTTP Basic Auth for the backend UI / API (dev-plan §4.2 "basic").
# Change anytime; then: sudo systemctl restart cc-workflow
username = "admin"
password = "$GENERATED_PASSWORD"

[feishu]
# Feishu adapter — P0-4. Fill from Feishu 开放平台.
# Webhook URL to register in Feishu: http://<your-server>/im/feishu/webhook
# 事件订阅 → 加密策略:  ENABLE Encrypt Key and paste it below.
#                       Verification Token alone is the legacy v1 scheme and is NOT used here.
app_id            = "<app_id>"
app_secret        = "<app_secret>"
encrypt_key       = "<encrypt_key>"     # 加密策略 tab → Encrypt Key (enable + copy plaintext)
default_workspace = "test-repo"          # used when message has no [repo-name] prefix

# Future:
# [vapid]    private_key / public_key   (P0-6)
TOML
fi
chmod 0600 "$SECRETS_FILE"
log "secrets.toml: 0600"

# ---------- state dirs (also created on-demand by agent-run, but safer here) ----------
mkdir -p "${HOME}/.cc-state/"{locks,logs,jobs,backup}
chmod 0700 "${HOME}/.cc-state/logs"
log "state dirs ready under ~/.cc-state/"

log ""
log "DONE. Next:"
log "  1. edit $CCW_CONFIG — pick provider (deepseek | kimi | claude)"
log "  2. edit $PROVIDERS_FILE — fill <api-key> for the provider you picked"
log "  3. auth (depends on provider):"
log "       deepseek / kimi → no login needed; env vars handle auth"
log "       claude (= anthropic local OAuth) → run 'claude login' once"
log "  4. create test workspace:"
log "       mkdir -p ~/workspaces/test-repo && cd \$_ && git init && touch README.md && git add . && git commit -m init"
log "  5. run acceptance tests: bash tests/test_agent_run.sh"

if [[ -n "$GENERATED_PASSWORD" ]]; then
    log ""
    warn "============================================================"
    warn "  HTTP Basic Auth credentials (saved to $SECRETS_FILE):"
    warn "    user: admin"
    warn "    pass: $GENERATED_PASSWORD"
    warn "  SAVE THIS NOW — needed for http://<server>:8765/"
    warn "============================================================"
fi
