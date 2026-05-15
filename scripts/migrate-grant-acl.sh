#!/usr/bin/env bash
#
# migrate-grant-acl.sh — EXPERIMENTAL
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ⚠️  KNOWN ISSUE (2026-05-15 in-field test):
#
# This migration completed cleanly (systemd active, ACLs applied,
# claude --version worked for ccw) but **broke the running backend
# in less obvious ways** — Feishu webhook stopped responding, claude
# hung at startup for PWA-triggered runs, etc. Rolling User= back to
# root fixed everything instantly. Root cause not pinned down.
#
# DON'T RUN THIS unless you (a) hit the trust=on edge case
# (~/.claude/ writes blocked) repeatedly enough that SSH'ing in to
# fix is genuinely annoying, AND (b) understand you may need to roll
# back. Even then, do a tarball backup first.
#
# Rollback recipe lives at the bottom of this comment block.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# What it does:
#
# Switch the cc-workflow backend from User=root to User=ccw without
# transferring ownership of /root/{...} to ccw. ccw gains rwx access
# via POSIX ACLs (setfacl); root remains the owner of every file.
#
# Idempotent — safe to re-run. New files inside the granted dirs
# inherit the ACL via the default-ACL plumbing on each dir.
#
# Why move off root at all (in theory):
#   Recent claude CLI rejects --permission-mode bypassPermissions when
#   invoked as uid 0. Without bypass, trust=on workspaces still get
#   blocked by claude's L1 permission system on edge-case ops (e.g.
#   writes to ~/.claude/<anything>). Moving the backend to uid != 0
#   unlocks bypassPermissions, which is what trust=on was supposed to
#   mean all along — in theory.
#
# Rollback (if migration breaks anything):
#   sudo sed -i 's/^User=ccw$/User=root/' /etc/systemd/system/cc-workflow.service
#   sudo sed -i 's/^Group=ccw$/Group=root/' /etc/systemd/system/cc-workflow.service
#   sudo sed -i 's|^Environment=HOME=/root$||' /etc/systemd/system/cc-workflow.service
#   sudo sed -i -E 's/^([0-9*/, ]+)ccw /\1root /' /etc/cron.d/cc-loops
#   sudo systemctl daemon-reload && sudo systemctl restart cc-workflow
#
# ACL grants stay (harmless — root doesn't use them, ccw is no longer
# running). To strip the ACLs entirely:
#   sudo setfacl -R -b /root/.claude /root/.cc-state /root/.cc-workflow /root/workspaces

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "must be run as root (sudo bash $0)" >&2
    exit 1
fi

# ---------- 0. Pre-flight ----------

if ! command -v setfacl >/dev/null 2>&1; then
    echo "setfacl not found, installing acl package..."
    apt update >/dev/null && apt install -y acl
fi

DIRS_TO_GRANT=(
    /root/.cc-workflow
    /root/.cc-state
    /root/workspaces
    /root/.claude
    /root/projects/cc-workflow
)
for d in "${DIRS_TO_GRANT[@]}"; do
    if [[ ! -d "$d" ]]; then
        echo "warning: $d does not exist; skipping (will pick up if created later)" >&2
    fi
done

# ---------- 1. Create ccw user (idempotent) ----------

if ! id ccw >/dev/null 2>&1; then
    echo "creating user ccw..."
    # home=/root so ~ resolves to /root for ccw processes started by
    # systemd. nologin shell — ccw is a service user, not for sudo'ing into.
    useradd --no-create-home --home-dir /root --shell /usr/sbin/nologin ccw
else
    # If ccw already exists with the wrong home, fix it. Avoids
    # silent failures where claude reads $HOME=/something-else.
    current_home=$(getent passwd ccw | cut -d: -f6)
    if [[ "$current_home" != "/root" ]]; then
        echo "ccw home was $current_home, fixing to /root..."
        usermod -d /root -s /usr/sbin/nologin ccw
    fi
fi

# ---------- 2. Traverse permission on /root ----------
# Without `x` on /root, no ACL on subdirs helps — ccw can't `cd /root`
# to reach them. We grant x ONLY (not r), so ccw can traverse but can
# NOT list the contents of /root directly. Sub-files are still gated
# by their own ACL/perms.

setfacl -m u:ccw:x /root

# ---------- 3. Grant rwx on the cc-workflow data dirs ----------
# Two passes per dir:
#   1. current ACL — covers all files/dirs that exist right now
#   2. default ACL — new files/subdirs inherit this rwx automatically
# Without the default ACL pass, the first time claude writes a new
# file in there as ccw, the file would lack u:ccw:rwx and ccw would
# lose access on its OWN newly-created file.

for d in "${DIRS_TO_GRANT[@]}"; do
    [[ -d "$d" ]] || continue
    setfacl -R   -m u:ccw:rwx "$d"
    setfacl -R -d -m u:ccw:rwx "$d"
done

# ---------- 4. /etc/cron.d/cc-loops + sudoers wrapper ----------
# Backend can't write /etc/cron.d/ directly (still root-owned area, and
# ACLs there would be system-wide overreach). Instead it shells out to
# a sudoers-allowed wrapper that does the install as root.

INSTALL_HELPER_SRC=/root/projects/cc-workflow/scripts/install-cc-loops
SUDOERS_SRC=/root/projects/cc-workflow/deploy/cc-workflow.sudoers

if [[ -f "$INSTALL_HELPER_SRC" ]]; then
    install -m 755 "$INSTALL_HELPER_SRC" /usr/local/bin/install-cc-loops
fi
if [[ -f "$SUDOERS_SRC" ]]; then
    install -m 440 "$SUDOERS_SRC" /etc/sudoers.d/cc-workflow
    # sanity-check before letting systemd reload pick it up
    visudo -cf /etc/sudoers.d/cc-workflow >/dev/null
fi

# ---------- 5. systemd unit: User=ccw, HOME=/root ----------
# Use the non-root variant from the repo if it exists; otherwise emit
# inline so this script stays self-contained.

UNIT_SRC=/root/projects/cc-workflow/deploy/cc-workflow.service.ccw
UNIT_DST=/etc/systemd/system/cc-workflow.service

if [[ -f "$UNIT_SRC" ]]; then
    install -m 644 "$UNIT_SRC" "$UNIT_DST"
else
    cat > "$UNIT_DST" <<'EOF'
[Unit]
Description=cc-workflow backend (running as ccw via ACL grant)
After=network.target

[Service]
Type=simple
User=ccw
Group=ccw
# HOME stays /root — data lives there, ccw has ACL rwx on the relevant
# subdirs. Sister script migrate-to-non-root.sh moves data to /home/ccw.
Environment="HOME=/root"
WorkingDirectory=/root/projects/cc-workflow
ExecStart=/root/projects/cc-workflow/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8765
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
fi

# ---------- 6. Cron USER field: root → ccw ----------
# Existing /etc/cron.d/cc-loops lines have `* * * * * root <command>`.
# Swap root for ccw so cron fires the curl trigger as ccw.

if [[ -f /etc/cron.d/cc-loops ]]; then
    # Match start-of-line schedule (5 fields of digit/star/slash/comma/space)
    # followed by literal "root ", swap to "ccw ". Skip lines that don't
    # match the shape (header PATH= line etc.).
    sed -i -E 's/^([0-9*/, ]+)root /\1ccw /' /etc/cron.d/cc-loops
fi

# ---------- 7. Reload + restart ----------

systemctl daemon-reload
systemctl restart cc-workflow
sleep 2
if systemctl is-active --quiet cc-workflow; then
    echo "✓ cc-workflow now running as ccw"
    systemctl status cc-workflow --no-pager | head -3
else
    echo "✗ cc-workflow failed to start. journalctl -u cc-workflow -n 30 --no-pager" >&2
    exit 1
fi

# ---------- 8. Self-test ----------

echo "--- self-test: ccw can read + write the cc-workflow dirs ---"
TEST_FILE=/root/.cc-state/.acl-migrate-check
if sudo -u ccw bash -c "touch '$TEST_FILE' && rm '$TEST_FILE'" 2>/dev/null; then
    echo "✓ ccw can write /root/.cc-state"
else
    echo "✗ ccw cannot write /root/.cc-state — ACLs may not have applied" >&2
    exit 1
fi

echo
echo "Migration done. To revert, run:"
echo "  sudo bash scripts/revert-grant-acl.sh   # (writes itself on first run)"
echo "Or roll back manually: systemd unit to User=root + cron USER field back to root."
