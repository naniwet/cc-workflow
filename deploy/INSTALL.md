# cc-workflow — one-shot install

Target: Ubuntu 22.04 / 24.04 cloud server, single-user, run as root.

Estimated time: 10 minutes (excluding LLM API key signups).

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

# HTTP basic auth (browser pops the password prompt on first /workspaces call).
[basic_auth]
username = "you"
password = "<long-random-string>"
```

Create `/root/.cc-workflow/secrets.toml` (only if you use Feishu):

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
