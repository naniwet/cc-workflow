#!/bin/bash
#
# migrate-keep-root-paths.sh — flip a root-installed cc-workflow over to
# being LAUNCHED as `ccw` while keeping every path under /root/.
#
# Why this exists (vs. the more thorough migrate-to-non-root.sh):
# the user already has their workflow muscle memory on /root/, doesn't
# want to learn /home/ccw paths, and doesn't want to copy gigabytes of
# git history out of /root/workspaces/. The only real problem is Claude
# CLI's "root + --dangerously-skip-permissions" refusal — that's solved
# by NOT being root at launch time, no matter where the files live.
#
# Trade-off vs. the full migrate: this needs /root itself to be 0755
# (so `ccw` can traverse INTO it). Subfile/subdir perms are untouched —
# /root/.ssh stays 700/600, etc. — but a less-trusted user account on
# the same box could now `stat` filenames directly under /root. For a
# single-user VPS, that's fine. For shared boxes, prefer migrate-to-non-root.sh.
#
# Run as root, idempotent. Safe to re-run.

set -euo pipefail

SERVICE_USER="ccw"
ROOT_HOME="/root"
PROJECT_DIR="${ROOT_HOME}/projects/cc-workflow"

step() { echo; echo "==> $*"; }
warn() { echo "    WARN: $*" >&2; }

[[ "$(id -u)" == "0" ]] || { echo "must run as root (try: sudo bash $0)" >&2; exit 1; }
[[ -d "${PROJECT_DIR}" ]] || { echo "project not found at ${PROJECT_DIR} — adjust the script" >&2; exit 1; }

step "1. Ensure user ${SERVICE_USER} exists with HOME=${ROOT_HOME}"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    # -d /root: ccw's pw_dir is /root, so login as ccw and $HOME inside
    # a ccw process both resolve to /root. -r marks it a system user
    # (no UID_MIN range conflicts, no expire date). -s sh so it's at
    # least usable for `sudo -u ccw bash` debugging.
    useradd -r -d "${ROOT_HOME}" -s /bin/bash "${SERVICE_USER}"
    echo "    created ${SERVICE_USER} (home=${ROOT_HOME})"
else
    # If the user already exists with a different home, fix it.
    cur_home=$(getent passwd "${SERVICE_USER}" | cut -d: -f6)
    if [[ "${cur_home}" != "${ROOT_HOME}" ]]; then
        usermod -d "${ROOT_HOME}" "${SERVICE_USER}"
        echo "    updated ${SERVICE_USER} home: ${cur_home} → ${ROOT_HOME}"
    else
        echo "    ${SERVICE_USER} already correct"
    fi
fi

step "2. chmod 755 /root (let ${SERVICE_USER} traverse into it)"
chmod 755 "${ROOT_HOME}"
# Subdirs / files inside /root keep their own perms. /root/.ssh, /root/.bashrc
# etc. are still 700/600 and don't leak to ccw — only the directory entry
# (the names) of /root become visible. That's the security trade-off the
# script header documents.

step "3. chown data dirs to ${SERVICE_USER}"
for sub in .cc-workflow .cc-state workspaces; do
    target="${ROOT_HOME}/${sub}"
    if [[ -d "${target}" ]]; then
        chown -R "${SERVICE_USER}:${SERVICE_USER}" "${target}"
        echo "    chowned ${target}"
    else
        warn "${target} missing — skipping (fresh install? this is fine)"
    fi
done

step "4. chown the project dir (+ .venv) to ${SERVICE_USER}"
# Without this, .venv tries to write *.pyc under uvicorn startup as ccw
# and fails. Also lets `sudo -u ccw git pull` work without permission errors.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${PROJECT_DIR}"

step "5. Install the cron-replace wrapper"
install -m 0755 -o root -g root \
    "${PROJECT_DIR}/scripts/install-cc-loops" \
    /usr/local/bin/install-cc-loops
echo "    /usr/local/bin/install-cc-loops"

step "6. Install sudoers grant"
install -m 0440 -o root -g root \
    "${PROJECT_DIR}/deploy/cc-workflow.sudoers" \
    /etc/sudoers.d/cc-workflow
visudo -c -f /etc/sudoers.d/cc-workflow >/dev/null
echo "    /etc/sudoers.d/cc-workflow (validated)"

step "7. Install the new systemd unit (User=ccw, paths still under /root)"
install -m 644 -o root -g root \
    "${PROJECT_DIR}/deploy/cc-workflow.service" \
    /etc/systemd/system/cc-workflow.service
systemctl daemon-reload
echo "    systemd unit installed and reloaded"

step "8. Rewrite cron USER field root → ${SERVICE_USER} (if cron file exists)"
if [[ -f /etc/cron.d/cc-loops ]]; then
    cp /etc/cron.d/cc-loops "/etc/cron.d/cc-loops.bak.$(date +%s)"
    sed -i -E "s|^(\\S+ \\S+ \\S+ \\S+ \\S+) root (/usr/local/bin/agent-run)|\\1 ${SERVICE_USER} \\2|g" \
        /etc/cron.d/cc-loops
    chown root:root /etc/cron.d/cc-loops
    chmod 644 /etc/cron.d/cc-loops
    echo "    rewrote /etc/cron.d/cc-loops; backup saved"
else
    echo "    /etc/cron.d/cc-loops doesn't exist yet — nothing to rewrite"
fi

echo
echo "=== Done ==="
echo "Next:"
echo "  sudo systemctl restart cc-workflow"
echo "  sudo systemctl status cc-workflow            # expect: Active=running, User=ccw"
echo "  curl -sS http://127.0.0.1:8765/healthz       # expect: {\"ok\":true}"
echo
echo "Verify the trust=on path now works:"
echo "  - Pick any workspace with trust=on in PWA"
echo "  - Send a prompt that does shell work (e.g. 'ls -la')"
echo "  - Run should complete without a 'cannot be used with root' error"
