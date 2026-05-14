#!/bin/bash
#
# migrate-to-non-root.sh — one-shot migration from root-installed cc-workflow
# to a non-root install (User=ccw in systemd).
#
# Why: Claude CLI as of late-2026 refuses --dangerously-skip-permissions
# (and the equivalent --permission-mode bypassPermissions) when invoked as
# root, breaking trust=on workspaces. Running the backend as a non-root user
# is the correct fix.
#
# What this script does (idempotent — safe to re-run):
#   1. Create user `ccw` if missing
#   2. Create /home/ccw/.cc-workflow, .cc-state, workspaces if missing,
#      copying content from /root/ counterparts (chown to ccw:ccw)
#   3. Copy the project (cc-workflow git checkout + .venv) to /home/ccw/
#   4. Install the sudoers grant (deploy/cc-workflow.sudoers → /etc/sudoers.d/)
#   5. Install the cron-install wrapper (scripts/install-cc-loops → /usr/local/bin/)
#   6. Install the new systemd unit (deploy/cc-workflow.service)
#   7. Rewrite /etc/cron.d/cc-loops to use USER=ccw (cron lines run as ccw,
#      not root, after migration)
#
# What you do AFTER this script:
#   - systemctl daemon-reload && systemctl restart cc-workflow
#   - Verify via PWA / journalctl. Old /root/.cc-workflow etc. left in place
#     until you're confident — delete manually when done.
#
# Run as root:
#   sudo bash scripts/migrate-to-non-root.sh

set -euo pipefail

SERVICE_USER="ccw"
SERVICE_HOME="/home/${SERVICE_USER}"
OLD_HOME="/root"
PROJECT_SRC="${OLD_HOME}/projects/cc-workflow"        # current install location
PROJECT_DEST="${SERVICE_HOME}/cc-workflow"

step() { echo; echo "==> $*"; }
warn() { echo "    WARN: $*" >&2; }

# Must run as root.
if [[ "$(id -u)" != "0" ]]; then
    echo "must run as root (try: sudo bash $0)" >&2
    exit 1
fi

# Sanity: source project must exist where we think it does.
if [[ ! -d "$PROJECT_SRC" ]]; then
    echo "source project not found at $PROJECT_SRC — adjust the script if your install lives elsewhere" >&2
    exit 1
fi

step "1. Ensure user ${SERVICE_USER} exists"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd -r -m -d "${SERVICE_HOME}" -s /bin/bash "${SERVICE_USER}"
    echo "    created ${SERVICE_USER}"
else
    echo "    ${SERVICE_USER} already exists"
fi

step "2. Copy configuration + state to ${SERVICE_HOME}"
for sub in .cc-workflow .cc-state workspaces; do
    src="${OLD_HOME}/${sub}"
    dst="${SERVICE_HOME}/${sub}"
    if [[ -d "$src" && ! -d "$dst" ]]; then
        cp -a "$src" "$dst"
        chown -R "${SERVICE_USER}:${SERVICE_USER}" "$dst"
        echo "    copied $src → $dst"
    elif [[ -d "$dst" ]]; then
        # Already migrated. Just make sure ownership is right.
        chown -R "${SERVICE_USER}:${SERVICE_USER}" "$dst"
        echo "    $dst already exists (re-chowned)"
    else
        warn "$src missing — skipping (first-time install? this is fine)"
    fi
done

step "3. Copy project (code + .venv) to ${PROJECT_DEST}"
if [[ ! -d "$PROJECT_DEST" ]]; then
    cp -a "$PROJECT_SRC" "$PROJECT_DEST"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "$PROJECT_DEST"
    echo "    copied $PROJECT_SRC → $PROJECT_DEST"
else
    # Re-pull instead of re-copying — preserve the local install
    # (.venv) but bring the code current.
    cd "$PROJECT_DEST" && sudo -u "${SERVICE_USER}" git pull --ff-only || warn "git pull failed"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "$PROJECT_DEST"
    echo "    $PROJECT_DEST already exists (pulled latest + re-chowned)"
fi

step "4. Install sudoers grant"
install -m 440 -o root -g root \
    "${PROJECT_DEST}/deploy/cc-workflow.sudoers" \
    /etc/sudoers.d/cc-workflow
visudo -c -f /etc/sudoers.d/cc-workflow >/dev/null
echo "    /etc/sudoers.d/cc-workflow installed and validated"

step "5. Install cron-replace helper"
install -m 0755 -o root -g root \
    "${PROJECT_DEST}/scripts/install-cc-loops" \
    /usr/local/bin/install-cc-loops
echo "    /usr/local/bin/install-cc-loops installed"

step "6. Install new systemd unit"
install -m 644 -o root -g root \
    "${PROJECT_DEST}/deploy/cc-workflow.service" \
    /etc/systemd/system/cc-workflow.service
systemctl daemon-reload
echo "    cc-workflow.service installed; run \`systemctl restart cc-workflow\` after this script finishes"

step "7. Rewrite /etc/cron.d/cc-loops to use USER=${SERVICE_USER}"
if [[ -f /etc/cron.d/cc-loops ]]; then
    # Backup before touching anything cron-related.
    cp /etc/cron.d/cc-loops "/etc/cron.d/cc-loops.bak.$(date +%s)"
    # Replace the old user field (first non-comment field after the 5 cron
    # fields). This is sed across each non-comment line that has agent-run.
    sed -i -E "s|^(\\S+ \\S+ \\S+ \\S+ \\S+) root (/usr/local/bin/agent-run)|\\1 ${SERVICE_USER} \\2|g" \
        /etc/cron.d/cc-loops
    chown root:root /etc/cron.d/cc-loops
    chmod 644 /etc/cron.d/cc-loops
    echo "    /etc/cron.d/cc-loops rewritten (USER field root → ${SERVICE_USER}; backup saved)"
else
    echo "    /etc/cron.d/cc-loops doesn't exist yet — nothing to rewrite"
fi

echo
echo "=== Migration done. Next: ==="
echo "  systemctl restart cc-workflow"
echo "  systemctl status cc-workflow"
echo "  journalctl -u cc-workflow -f             # watch for errors"
echo
echo "After verifying everything works for a few days, you can clean up:"
echo "  rm -rf /root/.cc-workflow /root/.cc-state /root/workspaces /root/projects/cc-workflow"
