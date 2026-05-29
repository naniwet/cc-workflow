# cc-workflow — one-shot install

Target: Ubuntu 22.04 / 24.04 cloud server, single-user.

Estimated time: 10 minutes (excluding LLM API key signups + Let's Encrypt
DNS).

> **Deployment model — root is the only recommended setup
> (2026-05-15).** The backend runs as `root`, all data lives under
> `/root/`. Trust=on works for ~95% of cases via:
>   - `~/.claude/settings.json#permissions.allow` global list,
>     planted at backend startup by `ws_settings.sync_global_-
>     allow_rules`
>   - PreToolUse hook (`cc-approve-hook`) reading `CCW_TRUST` env
>     to either auto-approve or surface to the PWA queue
>
> **Known limitation:** [claude-code#20449](https://github.com/anthropics/claude-code/issues/20449)
> — some file-modifying Bash commands (mkdir / touch / cp / mv ...)
> still prompt despite allow rules, and writes inside `~/.claude/`
> itself are hardcoded-blocked. When you hit one of these (rare,
> e.g. installing a skill), SSH in and run the 2-line bash by hand.
>
> Non-root deployment paths exist
> ([`scripts/migrate-grant-acl.sh`](../scripts/migrate-grant-acl.sh),
> [`MIGRATE-TO-NONROOT.md`](MIGRATE-TO-NONROOT.md)) and are designed
> to fix the above edge cases by unlocking `bypassPermissions`. BUT
> field-testing showed both paths cause **backend instability**
> (Feishu webhook stops responding, claude hangs at startup) on at
> least one production setup — root cause not pinned. **Don't run
> these unless the edge case is a real daily nuisance AND you have
> time to debug + roll back.** Easy rollback recipe is at the top of
> each migration script.

## 0. Prerequisites

```bash
apt update
apt install -y python3-venv git nginx cron sqlite3
```

`sqlite3` is optional but useful for debugging (`sqlite3 ~/.cc-state/runs.db ...`).

## 1. Clone + venv

```bash
mkdir -p /root/projects
cd /root/projects
git clone https://github.com/naniwet/cc-workflow.git
cd cc-workflow

python3 -m venv .venv
.venv/bin/pip install fastapi uvicorn pydantic tomli cryptography python-multipart
```

`cryptography` is only used when Feishu Encrypt Key is configured — but it's
small and the import is lazy, so install it preemptively to avoid runtime
`pip install` surprises.

`python-multipart` is required by FastAPI's `UploadFile` (used by the PWA file
upload endpoint `POST /uploads/{workspace}`). Without it the backend raises
a clear `RuntimeError: Form data requires "python-multipart" to be installed.`
on the first upload attempt, so install it preemptively too.

## 2. Configure secrets

```bash
mkdir -p /root/.cc-workflow /root/.cc-state /root/workspaces
```

Create `/root/.cc-workflow/config.toml`:

```toml
# Which LLM profile agent-run.sh + backend/llm.py default to.
# Must match a key in providers.json below.
provider = "deepseek"

# Public origin for the PWA — used by Feishu to append a "full output" link
# when a run's reply exceeds Feishu's 4000-char text-message cap. Optional;
# if unset, Feishu just gets "(truncated)" with no link.
pwa_base_url = "http://<your-server-ip-or-domain>"
```

Create `/root/.cc-workflow/secrets.toml`:

```toml
# Login credentials. POST /auth/login validates against these; on success
# the backend sets an HMAC-signed 30-day session cookie (ccw_session).
# Generate a long random password with: openssl rand -hex 24
[ui]
username = "you"
password = "<long-random-string>"

# (Feishu section — see step 2.5 below if you use the Feishu adapter.)
```

The session HMAC key is auto-generated on first startup as
`~/.cc-workflow/.session-secret` (32 random bytes, chmod 600). You don't
need to create it manually; it persists across backend restarts so signed
cookies keep working. If you want to invalidate all existing sessions
(e.g. you suspect the key leaked), delete that file — the next startup
generates a fresh one and every browser falls back to the login page.

If you use Feishu, **append** to the same `/root/.cc-workflow/secrets.toml`
(keep the `[ui]` block above):

```toml
[feishu]
app_id            = "cli_xxx"
app_secret        = "xxx"
encrypt_key       = "xxx"           # 飞书后台 → 事件订阅 → 加密策略
default_workspace = "test-repo"     # used when message has no [prefix]

# Optional: where cron-fired runs push their result by default.
# - Loops created via the Feishu `/loops new` flow remember the chat
#   they were created in and push there (overrides this).
# - Loops created via the PWA fall back to cron_notify_chat.
# - Empty = no auto-push; output stays in PWA only.
# To find a chat_id, send any message in that chat and look at the
# backend log: `journalctl -u cc-workflow | grep chat_id`.
cron_notify_chat  = ""
```

Create `/root/.cc-workflow/providers.json` (ccswitch-style):

```json
{
  "active": "deepseek",
  "profiles": {
    "claude": { "env": {} },
    "deepseek": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-...",
        "ANTHROPIC_MODEL": "deepseek-chat"
      }
    },
    "kimi": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.moonshot.cn/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-...",
        "ANTHROPIC_MODEL": "moonshot-v1-8k"
      }
    }
  }
}
```

The empty-env `claude` profile means "use Anthropic's local OAuth login from
`agent-run.sh`" — the backend can't drive it directly (no API key for direct
HTTPS), so it won't appear in the per-workspace provider dropdown. That's
intentional.

## 3. Install agent-run

```bash
install -m 755 /root/projects/cc-workflow/agent-run.sh /usr/local/bin/agent-run
```

(Or `ln -sf` if you want edits to flow through without reinstall.)

## 3.1. Sync subagent team into ~/.claude/agents/

The repo ships a version-controlled subagent team under `.claude/agents/`
(code-dev / code-review / spec-writer / plan-writer / user-acceptance-tester).
Both the PWA `#settings/agents` CRUD **and** the claude CLI's subagent
dispatch read from `~/.claude/agents/` — NOT the repo dir. Symlink them:

```bash
bash /root/projects/cc-workflow/scripts/sync-agents.sh
```

Re-run after every `git pull` that adds/removes a file under `.claude/agents/`.
It's idempotent and won't clobber non-symlink files you put there by hand.

## 3.5. Install the tool-approval hook + global allow list

Two pieces wire together to make trust=on / trust=off behave the way
the PWA promises:

1. **PreToolUse hook** (`cc-approve-hook.sh` below) — fires on every
   Bash / WebFetch tool call. Calls back to backend; backend either
   auto-approves (trust=on) or queues a `[Approve] [Deny]` in the PWA
   (trust=off). Either way the call is logged in run-detail's Approvals
   audit panel.
2. **Global allow list** — backend writes
   `~/.claude/settings.json#permissions.allow` at startup
   (`ws_settings.sync_global_allow_rules`) so claude's *internal* L1
   permission check passes for every tool we know about. Without this,
   trust=on workspaces would still hit L1 prompts because hooks fire
   *after* L1 approves.

```bash
# 1. Install the hook script
install -m 755 /root/projects/cc-workflow/scripts/cc-approve-hook.sh \
    /usr/local/bin/cc-approve-hook

# 2. Wire it into Claude's user-level settings so every claude
#    invocation on this server picks it up.
mkdir -p /root/.claude
cat > /root/.claude/settings.json <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|WebFetch",
        "hooks": [
          {"type": "command", "command": "/usr/local/bin/cc-approve-hook"}
        ]
      }
    ]
  }
}
JSON
```

The hook calls `127.0.0.1:8765` directly (skipping nginx + basic auth)
which is why `deploy/nginx.conf` denies `/approvals/internal/*` to the
public — only same-host callers reach it.

To temporarily disable approval prompts globally without uninstalling,
remove or rename `/root/.claude/settings.json` and restart Claude. To
disable per-workspace, mark the workspace as `trust: true` via the PWA
(🔓 icon in the column header).

## 4. Install + start the backend

```bash
install -m 644 /root/projects/cc-workflow/deploy/cc-workflow.service \
  /etc/systemd/system/cc-workflow.service
systemctl daemon-reload
systemctl enable --now cc-workflow
systemctl status cc-workflow              # should show active (running)
```

## 5. Install + reload nginx

```bash
install -m 644 /root/projects/cc-workflow/deploy/nginx.conf \
  /etc/nginx/sites-available/cc-workflow
ln -sf /etc/nginx/sites-available/cc-workflow /etc/nginx/sites-enabled/cc-workflow
rm -f /etc/nginx/sites-enabled/default    # if stock welcome page is in the way
nginx -t                                  # syntax check
systemctl reload nginx
```

## 6. Smoke test

From your laptop:

```bash
curl -s http://<server-ip>/healthz                                # → {"ok":true}
curl -su you:<password> http://<server-ip>/workspaces             # → []
```

Then open `http://<server-ip>/pwa/` in a browser — basic-auth prompt → after
auth you should see the **Workspaces** view. From there, **+ New workspace**
to bootstrap your first repo dir.

## 7. HTTPS (strongly recommended once you have a domain)

Without HTTPS:
- The browser refuses to register the Service Worker on remote origins,
  so the PWA's offline fallback + version-bump UX never engages.
- iOS Safari won't let you "Add to Home Screen" in standalone/fullscreen
  display mode on plain HTTP origins.
- Cookies don't get the `Secure` flag (auth.set_session_cookie checks
  `X-Forwarded-Proto` from nginx).

DNS your domain to the server first, then:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d <your-domain>
# When prompted, pick option 2 (Redirect — make all requests redirect to HTTPS).
```

certbot edits `/etc/nginx/sites-enabled/cc-workflow` in place: adds a
`listen 443 ssl` block with cert paths, and either appends a redirect
or rewrites the existing port-80 block. Auto-renewal is set up via
`/etc/cron.d/certbot` (verify with `systemctl list-timers | grep certbot`).

Verify everything is wired correctly:

```bash
curl -I http://<your-domain>/pwa/     # → 301 Moved Permanently
curl -I https://<your-domain>/pwa/    # → 200 OK
# Set-Cookie should carry `Secure`:
curl -i -c /tmp/c.txt -X POST https://<your-domain>/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"YOU","password":"YOU"}' | grep -i set-cookie
# Expect: Set-Cookie: ccw_session=...; HttpOnly; Secure; SameSite=Strict
```

**Heads up — the repo's `deploy/nginx.conf` is still HTTP-only.**
certbot's edits live on the server, not in the repo. If you want
infra-as-code, manually diff the server's
`/etc/nginx/sites-enabled/cc-workflow` against `deploy/nginx.conf` and
flow the TLS additions back to git. Common additions to consider:

```nginx
# Force HTTP/2 (better PWA perf — multiplexes the parallel /workspaces
# /sessions /loops fetches on first paint).
listen 443 ssl http2;

# Strict-Transport-Security: tell browsers "for the next 1y, always
# use HTTPS for this host". Only deploy this when you're sure HTTPS
# is stable — once cached, browsers won't fall back to HTTP for the
# duration (so a misconfigured renewal can lock you out).
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

**Switching from a previously-deployed IP origin?** Two things to do
on the client side:

1. **Feishu open-platform console** → 事件订阅 → change webhook URL
   from `http://<IP>/im/feishu/webhook` to
   `https://<your-domain>/im/feishu/webhook`. Feishu will re-do the
   challenge handshake; backend handles it transparently.
2. **`pwa_base_url` in `config.toml`** — if you set this previously
   to `http://<IP>`, update to `https://<your-domain>` and
   `systemctl restart cc-workflow`. Used by `reply_from_run` to append
   a "full output" link when Feishu replies get truncated.

## 8. (Optional) Feishu webhook

In 飞书开放平台 → 事件订阅 → 加密策略, set Encrypt Key and copy the value
into `secrets.toml`. Then set the webhook URL to:

```
https://<your-domain>/im/feishu/webhook
```

(HTTP-only also works for the initial challenge handshake, but Feishu will
warn — get HTTPS up first per step 7.)

## Troubleshooting

| Symptom | Check |
|---|---|
| `systemctl status cc-workflow` red | `journalctl -u cc-workflow --since "10 min ago" -t cc-workflow` |
| Browser shows nginx 502 | Backend down — `systemctl status cc-workflow` |
| Browser shows nginx 504 | Backend stuck — long agent-run or LLM call exceeding 60s (consider raising `proxy_read_timeout`) |
| PWA stuck on "Loading…" after deploy | Stale browser HTTP cache feeding the SW. Clear site data for the domain (Chrome → 长按 URL → 站点设置 → Clear data) or open in private mode. SW v31+ uses `cache: 'no-store'` to prevent this. |
| Mobile PWA can't see data even when curl works | Same as above — clear site data / open private mode. After SW v31+ the issue self-heals on next visit. |
| Cron line written but never fires | `journalctl -u cron --since "10 min ago" \| grep cc-loops`. Also `cat /etc/cron.d/cc-loops` and confirm the line is `curl ...` (not legacy `agent-run ...`); if legacy, restart the backend to trigger `cron_state.rewrite_legacy_cron_lines()`. |
| Cron fires but PWA cron card has no "→ open" link | Means `last_run_id` isn't populated — possibly an old run from before the cron-through-backend refactor. Future cron runs will fill it in. |
| Cron auto-push to Feishu doesn't fire | Need either per-loop `chat_id` (set when loop created via `/loops new` in Feishu) or global `[feishu].cron_notify_chat` in secrets.toml. Verify with `cat ~/.cc-state/jobs/<name>.json \| jq .chat_id`. |
| `/cron/parse-nl` 502 | `providers.json` profile has empty env, or the LLM endpoint is unreachable |
| 401 redirect doesn't fire from PWA | Stale SW serving old app.js without `_redirectingToLogin` guard. Same fix as "Stuck on Loading…" above — clear site data. |
| Run shows "exit 66 · No conversation found with session ID" | `--resume <sid>` pointing to a session claude no longer knows about. agent-run.sh auto-recovers (clears the sid + retries fresh) since 2026-05-15; if you still see this, server is on a pre-`17e5b8a` agent-run.sh — `cp ~/projects/cc-workflow/agent-run.sh /usr/local/bin/agent-run`. |

## Update

```bash
cd /root/projects/cc-workflow
git pull

# IMPORTANT: agent-run.sh is COPIED to /usr/local/bin/ in step 3, not
# symlinked. After a pull that touches agent-run.sh, you MUST re-copy:
cp agent-run.sh /usr/local/bin/agent-run
chmod +x /usr/local/bin/agent-run

systemctl restart cc-workflow        # picks up backend/* + triggers
                                     # cron_state.rewrite_legacy_cron_lines()
                                     # to migrate cron format if needed
# nginx reload only needed if deploy/nginx.conf changed (after certbot
# you maintain /etc/nginx/sites-enabled/cc-workflow manually anyway)
# PWA: SW v31+ uses cache: no-store so updates flow without hard-refresh.
# If you're still on older SW, hard-refresh once or clear site data.
```

> If you migrated to non-root (Plan B), the paths are `/home/ccw/cc-workflow`
> and you should `sudo -u ccw git pull` so the working tree stays owned
> by `ccw`. The systemd unit + nginx reload commands stay the same.

## 9. (EXPERIMENTAL — known to break in some setups) Non-root deployment

> ⚠️ **Heads-up before you read further.** Both migration paths below
> are designed to unlock `--permission-mode bypassPermissions` (which
> claude rejects under uid 0) for the trust=on edge cases. In theory
> it's clean.
>
> In practice (field-tested 2026-05-15 on Ubuntu 24.04 +
> alibaba ECS), the ACL variant (9a) caused these symptoms shortly
> after `systemctl restart`:
> - PWA-triggered runs hung indefinitely (stream-jsonl never written)
> - Feishu webhook stopped responding
> - claude binary itself was reachable from ccw (so it wasn't a
>   PATH issue), but agent-run's invocation flow froze somewhere
>
> Rollback to `User=root` instantly restored everything. Root cause
> wasn't pinned down — likely a subtle ACL-on-claude-internal-files
> issue or a uvicorn-as-ccw IO behavior we didn't catch.
>
> **Don't run these unless** you've hit the trust=on edge case
> repeatedly enough that SSH'ing in to fix is genuinely annoying,
> AND you've taken a tarball backup, AND you have time to debug
> + roll back. Each migration script has a rollback recipe at its
> top.

You generally **do not need this.** The global-allow-list mechanism
(§3.5) plus the PreToolUse hook make trust=on workspaces work under
root for ~95% of tool calls. Run as root and SSH for the rest.

The remaining 5% is [claude-code#20449](https://github.com/anthropics/claude-code/issues/20449)
— some file-modifying Bash commands (mkdir / touch / cp / mv ...)
prompt even with allow rules. AND writes inside `~/.claude/` itself
are hardcoded-blocked. For those, SSH in and run the 2 lines yourself.

Two migration flavors are documented below for completeness:

### 9a. Keep paths under /root + ACLs (EXPERIMENTAL — see warning above)

`ccw` runs the backend, but every config / state / workspace stays at its
current `/root/...` location. **Ownership of every file stays root**;
ccw gains access via POSIX ACLs (`setfacl u:ccw:rwx ...`). `/root` itself
gets only a traverse-only ACL (`u:ccw:x`) — ccw can `cd /root`, can NOT
`ls /root` directly.

```bash
cd /root/projects/cc-workflow
git pull
sudo bash scripts/migrate-grant-acl.sh
sudo systemctl restart cc-workflow
sudo systemctl status cc-workflow     # expect: Active=running, User=ccw
```

What the script does (idempotent — safe to re-run):

1. Installs `acl` package if missing
2. Creates user `ccw` with home=/root, nologin shell (service user, not for sudo'ing into)
3. `setfacl u:ccw:x /root` — traverse only, not list
4. For each data dir (`.cc-workflow`, `.cc-state`, `workspaces`, `.claude`,
   `projects/cc-workflow`): apply `u:ccw:rwx` ACL (current + default), so
   ccw has read/write on existing files AND files claude creates later
   automatically inherit the same ACL
5. Installs the `install-cc-loops` sudoers wrapper to `/usr/local/bin/`
6. Installs the sudoers grant so `ccw` can invoke the wrapper (`/etc/sudoers.d/cc-workflow`)
7. Installs the new `cc-workflow.service` (User=ccw, HOME=/root, paths under /root)
8. Rewrites the USER field in `/etc/cron.d/cc-loops` from root → ccw

Security trade-off vs. the older chown approach: zero — owner stays root,
which means root via SSH still reads/writes everything unchanged. ccw
gets ACL-grant access ONLY to the 5 listed dirs (not /root at large).
A separate user "alice" wouldn't have any access.

Revert (if ever needed): change systemd unit back to User=root, revert
the cron USER field. The ACLs are harmless — root doesn't use them
(superuser bypass) and ccw can no longer write because the service no
longer runs as ccw. Optionally strip ACLs with
`setfacl -R -b /root/{.cc-workflow,.cc-state,...}`.

### 9b. Move everything to /home/ccw (textbook clean — fully isolated)

`ccw` runs the backend AND all config/state/workspace files live under
`/home/ccw/`. `/root/` stays at its default 0700. More invasive, but doesn't
require any chmod on system directories.

```bash
cd /root/projects/cc-workflow
git pull
sudo bash scripts/migrate-to-non-root.sh
sudo systemctl restart cc-workflow
```

The script copies `/root/{.cc-workflow,.cc-state,workspaces}` → `/home/ccw/`,
re-clones the project to `/home/ccw/cc-workflow`, and otherwise does the same
sudoers / wrapper / cron-USER-field steps as 9a. After a few days of running
clean, you can `rm -rf /root/.cc-workflow /root/.cc-state /root/workspaces`
to reclaim the disk.

### Back-compat

The legacy root install path (User=root, all paths under /root/) is still
supported by the code. `backend/cron_state.py:_write_cron_file` switches
on `os.geteuid()`: as root, it does a direct `os.replace`; as ccw, it
shells out via the sudoers wrapper. You won't accidentally break a root
install by pulling this code — only by replacing the systemd unit and not
running one of the migration scripts.
