# cc-workflow — one-shot install

Target: Ubuntu 22.04 / 24.04 cloud server, single-user.

Estimated time: 10 minutes (excluding LLM API key signups).

> **⚠️ Heads-up on the service user.** The steps below install everything
> under `/root/` and run the backend as `root`. This works, but recent
> Claude CLI refuses `--dangerously-skip-permissions` (the flag agent-run
> uses for trust=on workspaces) when running as root. Two options:
>
> - **New install — recommended:** install under root first as documented,
>   then run [`scripts/migrate-to-non-root.sh`](../scripts/migrate-to-non-root.sh)
>   which flips you over to a dedicated `ccw` user. The script is idempotent
>   and keeps your data.
> - **Already running as root and don't care about trust=on:** ignore. The
>   only loss is auto-approve for trust=on workspaces; everything else works.
>
> See [§9 Non-root deployment](#9-non-root-deployment) at the bottom for
> what the migration actually does.

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
.venv/bin/pip install fastapi uvicorn pydantic tomli cryptography
```

`cryptography` is only used when Feishu Encrypt Key is configured — but it's
small and the import is lazy, so install it preemptively to avoid runtime
`pip install` surprises.

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

## 3.5. Install the tool-approval hook (路 2 — recommended)

The cc-approve-hook lets Claude pause mid-run on Bash/WebFetch calls and
surface `[Approve] [Deny]` buttons in the PWA. Workspaces marked
`trust: true` short-circuit this and never prompt.

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

## 7. (Optional) HTTPS — Phase 3

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d <your-domain>
```

certbot will edit `/etc/nginx/sites-available/cc-workflow` in place to add a
TLS server block + auto-renewal. After this you can also add HSTS to the
hardened nginx config:

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
```

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
| Browser shows nginx 504 | Backend stuck — long agent-run or LLM call exceeding 60s |
| PWA doesn't see latest deploy | Service worker cache — hard-refresh (Cmd+Shift+R) or wait 1h |
| Cron line written but never fires | `journalctl -u cron --since "10 min ago" \| grep cc-loops` |
| `/cron/parse-nl` 502 | `providers.json` profile has empty env, or the LLM endpoint is unreachable |

## Update

```bash
cd /root/projects/cc-workflow
git pull
systemctl restart cc-workflow        # only needed if backend/* changed
# nginx reload only needed if deploy/nginx.conf changed
# PWA hard-refresh only needed if pwa/* changed (browser SW caches them)
```

> If you migrated to non-root (§9), the paths are `/home/ccw/cc-workflow`
> and you should `sudo -u ccw git pull` so the working tree stays owned
> by `ccw`. The systemd unit + nginx reload commands stay the same.

## 9. Non-root deployment

By default, the backend runs as `root`. This works for everything except
`trust=on` workspaces — recent Claude CLI refuses
`--dangerously-skip-permissions` when invoked as root, so any tool call
that would normally be auto-approved gets stuck. The fix is to run the
backend as a dedicated non-root user (`ccw`).

The migration is handled by an idempotent script:

```bash
cd /root/projects/cc-workflow
git pull
sudo bash scripts/migrate-to-non-root.sh
sudo systemctl restart cc-workflow
sudo systemctl status cc-workflow      # should be "active (running)" as User=ccw
```

What it does (see the script source for details):

1. Creates user `ccw` (home `/home/ccw/`, no login shell required for service use)
2. Copies `/root/.cc-workflow`, `.cc-state`, and `workspaces` to `/home/ccw/` and chowns them
3. Re-clones the project to `/home/ccw/cc-workflow` (or pulls latest if already there)
4. Installs `deploy/cc-workflow.sudoers` to `/etc/sudoers.d/cc-workflow`
   (grants `ccw` no-password access to ONE command —
   `/usr/local/bin/install-cc-loops` — so the backend can still atomically
   replace `/etc/cron.d/cc-loops` despite being non-root)
5. Installs `scripts/install-cc-loops` to `/usr/local/bin/` (root-owned wrapper
   that the sudoers grant points at; validates the stage path and uid before
   running `install(1)`)
6. Installs the new `cc-workflow.service` (with `User=ccw`)
7. Rewrites existing cron lines in `/etc/cron.d/cc-loops` so the USER field
   is `ccw` instead of `root` (otherwise cron would still fire agent-run
   as root and we'd be back where we started)

After verifying everything works for a few days, you can clean up the old
root paths:

```bash
sudo rm -rf /root/.cc-workflow /root/.cc-state /root/workspaces /root/projects/cc-workflow
```

The legacy root install path (User=root, paths under /root/) is still
supported by the code — `cron_state.py:_write_cron_file` switches on
`os.geteuid()` and skips the sudo wrapper when it's already root. You
won't accidentally break a root install by deploying this code.
