// cc-workflow PWA — Phase 2 P0-6b/c.
//
// Two views:
//   Workspaces  4-column grid, one per ~/workspaces/* repo:
//               active sessions + recent runs + inline trigger form
//   Tasks       Cron loops list with pause / resume buttons.
//               Add / edit / delete are intentionally absent in Phase 2 —
//               they need new backend endpoints + cron-file writes that
//               are deferred to Phase 3 (or P1). For now edit /etc/cron.d/
//               cc-loops on the server to manage cron entries.
//
// Polling: every 3 s we re-fetch /workspaces + /sessions + /loops and
// re-render whichever tab is active.
//
// Auth: /pwa/* is unprotected; the first /workspaces fetch triggers basic
// auth, browser caches the credential for the session.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pwa/sw.js').catch(() => {});
}

// ---------- API + error banner ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

let errorVisible = false;
function showError(msg) {
  $('error-banner').textContent = msg;
  $('error-banner').classList.remove('hidden');
  errorVisible = true;
}
function clearError() {
  if (!errorVisible) return;
  $('error-banner').classList.add('hidden');
  errorVisible = false;
}

// ---------- shared state (refreshed every 3 s) ----------
let lastData = {
  workspaces: [],
  sessions: { active: [], queued: [], recent: [] },
  loops: [],
};

async function refreshAll() {
  try {
    const [ws, sess, lp] = await Promise.all([
      api('/workspaces'),
      api('/sessions'),
      api('/loops'),
    ]);
    lastData = { workspaces: ws, sessions: sess, loops: lp };
    clearError();
    $('status').textContent = '· ' + new Date().toLocaleTimeString();
    render();
  } catch (e) {
    showError(`fetch failed: ${e.message}`);
  }
}

// ---------- router ----------
const ROUTES = { workspaces: renderWorkspacesView, tasks: renderTasksView };
const currentRoute = () => location.hash.replace('#', '') || 'workspaces';
function setActiveTab(name) {
  for (const a of document.querySelectorAll('.tab')) {
    a.classList.toggle('active', a.dataset.tab === name);
  }
}

// Drafts: keep what the user is typing in each workspace's prompt box across
// re-renders. Polling re-renders blow away DOM, so we snapshot textareas/inputs
// before render() and restore them after.
const drafts = {};                                  // key: form-id, val: name → value

function snapshotDrafts() {
  for (const form of document.querySelectorAll('form[data-form-id]')) {
    const id = form.dataset.formId;
    drafts[id] = {};
    for (const el of form.querySelectorAll('textarea, input')) {
      if (el.name) drafts[id][el.name] = el.value;
    }
  }
}

function restoreDrafts() {
  for (const form of document.querySelectorAll('form[data-form-id]')) {
    const id = form.dataset.formId;
    const saved = drafts[id];
    if (!saved) continue;
    for (const el of form.querySelectorAll('textarea, input')) {
      if (el.name && saved[el.name] != null) el.value = saved[el.name];
    }
  }
}

function clearDraft(formId) { delete drafts[formId]; }

function render() {
  // Don't tear DOM out from under a focused input — refresh resumes after blur.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;

  snapshotDrafts();
  const name = currentRoute();
  const handler = ROUTES[name] || ROUTES.workspaces;
  setActiveTab(name in ROUTES ? name : 'workspaces');
  handler();
  restoreDrafts();
}
window.addEventListener('hashchange', render);

// ---------- Workspaces view ----------
function renderWorkspacesView() {
  const groups = groupByWorkspace(lastData.workspaces, lastData.sessions);
  const cols = Object.keys(groups)
    .sort()
    .map((w) => workspaceColHtml(w, groups[w]))
    .join('');

  $('view').innerHTML = `
    <h1>Workspaces</h1>
    ${cols
      ? `<div class="ws-grid">${cols}</div>`
      : `<p class="muted">No workspaces detected. Create <code>~/workspaces/&lt;name&gt;/.git</code> on the server.</p>`}
  `;

  for (const f of $('view').querySelectorAll('.trigger-form')) {
    f.addEventListener('submit', onTriggerSubmit);
  }
}

function groupByWorkspace(workspaces, sessions) {
  const g = {};
  for (const w of workspaces) g[w] = { active: [], recent: [] };
  for (const r of sessions.active || []) {
    (g[r.workspace] ??= { active: [], recent: [] }).active.push(r);
  }
  for (const r of sessions.recent || []) {
    (g[r.workspace] ??= { active: [], recent: [] }).recent.push(r);
  }
  return g;
}

function workspaceColHtml(name, data) {
  const active = data.active.length
    ? data.active.map(runRowHtml).join('')
    : '<p class="muted">(none)</p>';
  const recent = data.recent.length
    ? data.recent.slice(0, 5).map(runRowHtml).join('')
    : '<p class="muted">(none)</p>';
  return `
    <div class="ws-col">
      <h2>${esc(name)}</h2>
      <div>
        <strong class="muted">active</strong>
        ${active}
      </div>
      <div>
        <strong class="muted">recent</strong>
        ${recent}
      </div>
      <form class="trigger-form" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <label>prompt
          <textarea name="prompt" placeholder="reply with only OK" required></textarea>
        </label>
        <button type="submit">Run</button>
      </form>
    </div>
  `;
}

function runRowHtml(r) {
  const status = r.status || '?';
  return `
    <div class="row">
      <span>
        <span class="tag tag-${esc(status)}">${esc(status)}</span>
        <code>${esc((r.id || '').slice(0, 8))}</code>
        ${r.elapsed_s != null ? `· ${esc(r.elapsed_s)}s` : ''}
        ${r.exit_code != null && r.exit_code !== 0 ? `· exit ${esc(r.exit_code)}` : ''}
        ${r.source ? `· ${esc(r.source)}` : ''}
      </span>
    </div>
  `;
}

async function onTriggerSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const ws = form.dataset.workspace;
  const prompt = form.elements.prompt.value.trim();
  if (!prompt) return;
  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    await api('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: ws,
        prompt,
        engine: 'claude',
        session_key: `pwa-${ws}`,
        source: 'pwa',
      }),
    });
    form.reset();
    clearDraft(form.dataset.formId);
    refreshAll();
  } catch (err) {
    showError(`trigger failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
  }
}

// ---------- Tasks view ----------
function renderTasksView() {
  const loops = lastData.loops || [];
  const rows = loops.length
    ? loops.map(loopRowHtml).join('')
    : '<p class="muted">No cron loops. Add entries to <code>/etc/cron.d/cc-loops</code> on the server.</p>';
  $('view').innerHTML = `
    <h1>Tasks (cron)</h1>
    <p class="muted">
      Each loop writes state to <code>~/.cc-state/jobs/&lt;name&gt;.json</code>.
      Pause / resume below toggles <code>enabled</code>.
      <strong>Add / edit / delete via UI is deferred to Phase 3</strong> —
      for now edit <code>/etc/cron.d/cc-loops</code> on the server.
    </p>
    <div class="task-list">${rows}</div>
  `;
  for (const b of $('view').querySelectorAll('.pause-btn, .resume-btn')) {
    b.addEventListener('click', onPauseResume);
  }
}

function loopRowHtml(loop) {
  const enabled = !!loop.enabled;
  const lastRun = loop.last_run_at
    ? new Date(loop.last_run_at * 1000).toLocaleString()
    : '—';
  const last_exit = loop.last_exit != null ? loop.last_exit : '—';
  const stale = (loop.consecutive_errors || 0) >= 3;
  return `
    <div class="row">
      <span>
        <code>${esc(loop.name)}</code>
        <span class="tag ${enabled ? 'tag-done' : 'tag-failed'}">${enabled ? 'enabled' : 'paused'}</span>
        ${stale ? `<span class="tag tag-failed">stale ${esc(loop.consecutive_errors)}</span>` : ''}
        · last ${esc(lastRun)} · runs ${esc(loop.total_runs || 0)} · exit ${esc(last_exit)}
      </span>
      <span>
        ${enabled
          ? `<button class="secondary pause-btn" data-name="${esc(loop.name)}">Pause</button>`
          : `<button class="secondary resume-btn" data-name="${esc(loop.name)}">Resume</button>`}
      </span>
    </div>
  `;
}

async function onPauseResume(e) {
  const btn = e.target;
  const name = btn.dataset.name;
  const action = btn.classList.contains('pause-btn') ? 'pause' : 'resume';
  btn.disabled = true;
  try {
    await api(`/loops/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    refreshAll();
  } catch (err) {
    showError(`${action} ${name} failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- boot ----------
render();
refreshAll();
setInterval(refreshAll, 3000);
