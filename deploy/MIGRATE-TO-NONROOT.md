## Migration: root → non-root deployment (Plan A1)

Switch the backend from `User=root` to `User=ccw`. Triggered when the
global-allow-rules approach (`ws_settings.sync_global_allow_rules`)
still leaves trust=on workspaces blocked on specific operations
(GitHub claude-code #20449 — Bash file-modifying commands sometimes
prompt despite `permissions.allow`). Under a non-root uid claude
accepts `--permission-mode bypassPermissions`, which is the only path
that bypasses L1 entirely.

**This doc is a plan, not an executed migration. Run it only when the
trust=on UX is still broken after the global-allow approach is deployed.**

---

### Pre-flight

```bash
# 0. Confirm 方案 B-revised is actually failing on real cases.
#    Trigger a trust=on run that invokes a file-modifying bash
#    command (e.g. "跑 vitest 并把结果写到 docs/notes.md").
#    Look at run-detail's Live output: if L1 still surfaces a
#    "permission required" message, A1 is justified.

# 1. Stop the service.
systemctl stop cc-workflow

# 2. Tarball-backup the state. mv-only would be reversible too,
#    but a tar is recoverable even after partial chown failures.
tar czf /root/cc-workflow-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
    /root/.cc-state /root/.cc-workflow /root/workspaces /root/.claude \
    /root/projects/cc-workflow
```

### Migration

```bash
# 3. Create ccw user. -m: create /home/ccw. -s: ensure usable shell
#    (for ad-hoc debugging via `sudo -u ccw`).
useradd -m -d /home/ccw -s /bin/bash ccw

# 4. Move data. Order is important — repo last so dependent paths
#    inside ~/.cc-state/sessions.json don't reference stale paths
#    mid-migration. NB: all four targets must NOT exist under
#    /home/ccw yet (useradd -m doesn't create them).
mv /root/.cc-state        /home/ccw/.cc-state
mv /root/.cc-workflow     /home/ccw/.cc-workflow
mv /root/workspaces       /home/ccw/workspaces
mv /root/.claude          /home/ccw/.claude
mkdir -p /home/ccw/projects
mv /root/projects/cc-workflow /home/ccw/projects/cc-workflow
chown -R ccw:ccw /home/ccw

# 5. git "dubious ownership" preemptive fix. After the chown, ccw
#    owns workspace working dirs, but git config has been cached
#    under root in /etc/gitconfig — we explicitly mark workspaces
#    as safe to silence the runtime warning that otherwise breaks
#    `git status` / `git pull` invocations from inside agent-run.
sudo -u ccw git config --global --add safe.directory '*'

# 6. Sanity-check runs.db doesn't store absolute paths anywhere
#    (agent-run.sh references workspaces by name, but old data
#    might be different). Should return empty:
sqlite3 /home/ccw/.cc-state/runs.db \
    "SELECT id, workspace FROM runs WHERE workspace LIKE '/%' LIMIT 5"
# Non-empty result → manual UPDATE before proceeding.
```

### systemd unit swap

Replace `deploy/cc-workflow.service` with the ccw variant:

```ini
[Unit]
Description=cc-workflow backend
After=network.target

[Service]
Type=simple
User=ccw
Group=ccw
# No HOME override — systemd reads it from /etc/passwd entry for ccw.
WorkingDirectory=/home/ccw/projects/cc-workflow
ExecStart=/home/ccw/projects/cc-workflow/.venv/bin/uvicorn \
    backend.main:app --host 127.0.0.1 --port 8765
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Install + reload:

```bash
cp deploy/cc-workflow.service /etc/systemd/system/cc-workflow.service
systemctl daemon-reload
systemctl start cc-workflow
journalctl -u cc-workflow -f   # watch for crash loops
```

### Code change paired with this migration

Once running under uid != 0, `ws_settings.permission_mode_for` should
flip:

```python
def permission_mode_for(workspace: str) -> str:
    return "bypassPermissions" if trust_for(workspace) else "acceptEdits"
```

And `sync_global_allow_rules` can be removed (or kept harmlessly —
bypassPermissions short-circuits L1 entirely, allow list becomes a
no-op).

### Verification checklist

After service starts:

1. `whoami` from inside a `sudo -u ccw bash` session works.
2. PWA login still works (HMAC cookie auth — no uid dependency).
3. Trust=on workspace + "跑 vitest" → claude executes without prompt.
4. Trust=on workspace + arbitrary `mkdir -p tmp/x && touch tmp/x/y` →
   no prompt. (This is the GH #20449 scenario; bypassPermissions
   should swallow it where allow-rules alone could not.)
5. Trust=off workspace + Bash tool → PWA shows Approve/Deny.
6. Cron-triggered run (existing entry in /etc/cron.d/cc-loops) still
   fires and writes to ~/.cc-state/jobs/<name>.json under ccw.

### Rollback

```bash
systemctl stop cc-workflow
# Restore the tar from step 2.
cd / && tar xzf /root/cc-workflow-backup-YYYYMMDD-HHMMSS.tar.gz
# Restore prior systemd unit from git history.
cd /root/projects/cc-workflow
git show HEAD~1:deploy/cc-workflow.service > /etc/systemd/system/cc-workflow.service
systemctl daemon-reload
systemctl start cc-workflow
```

### Open items (handle if hit during execution)

- **Cron file path** (`/etc/cron.d/cc-loops`): currently invokes
  `/usr/local/bin/agent-run` with no HOME override. Under root that
  resolves `~/.cc-state` to `/root/.cc-state`. After migration the
  cron entries need to be regenerated so HOME resolves to `/home/ccw`
  — easiest: have backend regenerate the file on first startup under
  the new user (cron_state.write_cron_file walks all loops and emits).
- **Nginx config** (`deploy/nginx.conf`): proxies to 127.0.0.1:8765 —
  no change needed since the listen port stays.
- **PreToolUse hook script** (`/usr/local/bin/cc-approve-hook`):
  shebang + body don't reference user-specific paths; CCW_BACKEND_URL
  defaults to 127.0.0.1:8765 — no change needed.
