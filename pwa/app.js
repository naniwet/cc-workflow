// cc-workflow PWA — Phase 2 P0-6a shell.
//
// This commit (P0-6a) is the SHELL ONLY:
//   • register service worker
//   • hash-based router (#workspaces / #tasks)
//   • placeholder views
//   • 3-second polling tick (no-op until views land in P0-6b/c)
//
// P0-6b / P0-6c will replace the placeholder views with the real ones.

const $ = (id) => document.getElementById(id);

// ---------- service worker (cache-only) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pwa/sw.js').catch((e) => {
    console.warn('[cc] sw register failed:', e);
  });
}

// ---------- API helper ----------
async function api(path) {
  // Same-origin fetch; basic auth headers are auto-replayed by browser
  // after the first /pwa/ load (which itself triggers the auth prompt).
  const r = await fetch(path, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// ---------- error banner ----------
let errorVisible = false;
function showError(msg) {
  const b = $('error-banner');
  b.textContent = msg;
  b.classList.remove('hidden');
  errorVisible = true;
}
function clearError() {
  if (!errorVisible) return;
  $('error-banner').classList.add('hidden');
  errorVisible = false;
}

// ---------- router ----------
const ROUTES = {
  workspaces: renderWorkspacesPlaceholder,
  tasks: renderTasksPlaceholder,
};
function currentRoute() {
  return (location.hash.replace('#', '') || 'workspaces');
}
function setActiveTab(name) {
  for (const a of document.querySelectorAll('.tab')) {
    a.classList.toggle('active', a.dataset.tab === name);
  }
}
function navigate() {
  const name = currentRoute();
  const handler = ROUTES[name] || ROUTES.workspaces;
  setActiveTab(name in ROUTES ? name : 'workspaces');
  handler();
}
window.addEventListener('hashchange', navigate);

// ---------- placeholder views (replaced by P0-6b/c) ----------
function renderWorkspacesPlaceholder() {
  $('view').innerHTML = `
    <h1>Workspaces</h1>
    <p class="muted">Coming in P0-6b — 4 columns, one per repo, with active sessions + inline trigger.</p>
    <pre id="raw"></pre>
  `;
}
function renderTasksPlaceholder() {
  $('view').innerHTML = `
    <h1>Tasks (cron)</h1>
    <p class="muted">Coming in P0-6c — cron list + add/edit/pause/delete + 5-run history per job.</p>
    <pre id="raw"></pre>
  `;
}

// ---------- 3-second polling tick (just probes /sessions for connectivity now) ----------
async function tick() {
  try {
    const data = await api('/sessions');
    clearError();
    $('status').textContent = `· ${new Date().toLocaleTimeString()}`;
    const raw = $('raw');
    if (raw) raw.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    showError(`fetch /sessions failed: ${e.message}`);
  }
}

// ---------- boot ----------
navigate();
tick();
setInterval(tick, 3000);
