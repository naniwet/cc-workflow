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
  if (!r.ok) {
    // Pull the most informative bit out of the JSON detail so the banner
    // tells you WHY the call failed — prefer human-readable strings (raw
    // LLM replies, error messages) over short machine codes.
    let detail = '';
    try {
      const body = await r.json();
      const d = body?.detail;
      if (typeof d === 'string') {
        detail = d;
      } else if (d && typeof d === 'object') {
        if (d.raw_reply) detail = `${d.error || 'error'} · LLM said: ${String(d.raw_reply).slice(0, 200)}`;
        else if (typeof d.detail === 'string') detail = d.detail;
        else if (d.error) detail = d.error;
        else detail = JSON.stringify(d);
      } else if (body?.error) {
        detail = body.error;
      }
    } catch { /* body not JSON; ignore */ }
    throw new Error(`${r.status} ${path}${detail ? ' — ' + detail : ''}`);
  }
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
  providers: [],
  wsSettings: {},                       // name → {provider?}
  globalProvider: '',                   // config.toml's provider field
};

async function refreshAll() {
  try {
    const [ws, sess, lp, providers, cfg] = await Promise.all([
      api('/workspaces'),
      api('/sessions'),
      api('/loops'),
      api('/providers'),
      api('/config'),
    ]);
    // Workspace settings: one fetch per workspace (small N, fine for now).
    const settingsList = await Promise.all(
      ws.map((n) =>
        api(`/workspaces/${encodeURIComponent(n)}/settings`).then(
          (s) => [n, s || {}],
          () => [n, {}],
        ),
      ),
    );
    lastData = {
      workspaces: ws,
      sessions: sess,
      loops: lp,
      providers,
      wsSettings: Object.fromEntries(settingsList),
      globalProvider: cfg?.provider || '',
    };
    clearError();
    $('status').textContent = '· ' + new Date().toLocaleTimeString();
    render();
  } catch (e) {
    showError(`fetch failed: ${e.message}`);
  }
}

// ---------- router ----------
// Two flavours:
//   #workspaces / #tasks       → tab views, handler in ROUTES
//   #runs/<id>                 → single-run detail (full output, link target
//                                 from Feishu when output is truncated)
const ROUTES = { workspaces: renderWorkspacesView, tasks: renderTasksView };
function parseRoute() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('runs/')) return { name: 'runs', id: h.slice(5) };
  return { name: h || 'workspaces', id: null };
}
function setActiveTab(name) {
  for (const a of document.querySelectorAll('.tab')) {
    a.classList.toggle('active', a.dataset.tab === name);
  }
}

// Cache terminal-state runs so polling re-renders don't re-fetch them, and so
// scroll/selection survives across the 3s render() cycle.
const runDetailCache = {};                          // id → row (status=done/failed only)

// Drafts: keep what the user is typing in each workspace's prompt box across
// re-renders. Polling re-renders blow away DOM, so we snapshot textareas/inputs
// before render() and restore them after.
const drafts = {};                                  // key: form-id, val: name → value
const detailsOpen = {};                             // key: details-id, val: bool
const timelineScroll = {};                          // key: ws name → {scrollTop, atBottom}

function snapshotDrafts() {
  for (const form of document.querySelectorAll('form[data-form-id]')) {
    const id = form.dataset.formId;
    drafts[id] = {};
    for (const el of form.querySelectorAll('textarea, input, select')) {
      if (!el.name) continue;
      // Checkboxes / radios are about .checked, not .value (their .value is
      // the literal "on"). Without this branch an unchecked box snaps back
      // to its default-checked state on the next polling re-render.
      if (el.type === 'checkbox' || el.type === 'radio') {
        drafts[id][el.name] = el.checked;
      } else {
        drafts[id][el.name] = el.value;
      }
    }
  }
  for (const d of document.querySelectorAll('details[data-details-id]')) {
    detailsOpen[d.dataset.detailsId] = d.open;
  }
  for (const t of document.querySelectorAll('.ws-timeline[data-ws]')) {
    timelineScroll[t.dataset.ws] = {
      scrollTop: t.scrollTop,
      atBottom: Math.abs(t.scrollHeight - t.clientHeight - t.scrollTop) < 40,
    };
  }
}

function restoreDrafts() {
  for (const form of document.querySelectorAll('form[data-form-id]')) {
    const id = form.dataset.formId;
    const saved = drafts[id];
    if (!saved) continue;
    for (const el of form.querySelectorAll('textarea, input, select')) {
      if (!el.name || saved[el.name] == null) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = !!saved[el.name];
      } else {
        el.value = saved[el.name];
      }
    }
  }
  for (const d of document.querySelectorAll('details[data-details-id]')) {
    if (detailsOpen[d.dataset.detailsId]) d.open = true;
  }
  // Timeline: chat-like "stick to bottom" behaviour. If user was near the
  // bottom (or it's the first render), scroll to bottom so new runs are
  // visible. If user had scrolled up to read history, preserve position.
  for (const t of document.querySelectorAll('.ws-timeline[data-ws]')) {
    const saved = timelineScroll[t.dataset.ws];
    if (!saved || saved.atBottom) {
      t.scrollTop = t.scrollHeight;
    } else {
      t.scrollTop = saved.scrollTop;
    }
  }
}

function clearDraft(formId) {
  delete drafts[formId];
}
function clearDetails(detailsId) {
  delete detailsOpen[detailsId];
}

function render() {
  // Don't tear DOM out from under a focused input — refresh resumes after blur.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;

  snapshotDrafts();
  const route = parseRoute();
  if (route.name === 'runs' && route.id) {
    setActiveTab(null);                            // no tab is active for detail page
    renderRunDetailView(route.id);
  } else {
    const handler = ROUTES[route.name] || ROUTES.workspaces;
    setActiveTab(route.name in ROUTES ? route.name : 'workspaces');
    handler();
  }
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
    <details class="add-form" data-details-id="add-ws">
      <summary>New workspace</summary>
      <form data-form-id="new-ws">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="repo-name (alphanum / . _ -)" required></label>
        <button type="submit">Create</button>
        <p class="muted" style="font-size:11px;margin:0">
          Creates <code>~/workspaces/&lt;name&gt;/</code> with <code>git init</code>
          + empty README + first commit.
        </p>
      </form>
    </details>
    ${cols
      ? `<div class="ws-grid">${cols}</div>`
      : `<p class="muted">No workspaces yet. Use the form above or create <code>~/workspaces/&lt;name&gt;/.git</code> on the server.</p>`}
  `;

  $('view').querySelector('form[data-form-id="new-ws"]')
    ?.addEventListener('submit', onAddWorkspace);
  for (const f of $('view').querySelectorAll('.trigger-form')) {
    f.addEventListener('submit', onTriggerSubmit);
  }
  for (const sel of $('view').querySelectorAll('.provider-inline')) {
    sel.addEventListener('change', onProviderInlineChange);
  }
}

async function onProviderInlineChange(e) {
  const sel = e.target;
  const name = sel.dataset.workspace;
  const provider = sel.value || null;     // "" → null = clear override
  // Snapshot the previous value so we can revert on failure.
  const before = sel.dataset.prev || '';
  sel.dataset.prev = sel.value;
  sel.disabled = true;
  try {
    await api(`/workspaces/${encodeURIComponent(name)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    refreshAll();
  } catch (err) {
    sel.value = before;
    sel.dataset.prev = before;
    showError(`save provider failed: ${err.message}`);
  } finally {
    sel.disabled = false;
  }
}

async function onAddWorkspace(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.elements.name.value.trim();
  if (!name) return;
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await api('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    form.reset();
    clearDraft('new-ws');
    clearDetails('add-ws');
    refreshAll();
  } catch (err) {
    showError(`create workspace failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Create';
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
  // ONE chat-like timeline: active + queued + recent merged, sorted by
  // started_at ascending so oldest is on top and newest at the bottom
  // (matches how you read a chat / git log / timeline). Cap at 10 rows
  // to keep the column compact; scroll-overflow for the rest.
  const all = [
    ...(data.active || []),
    ...(data.queued || []),
    ...(data.recent || []),
  ];
  all.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
  const timeline = all.slice(-10);
  const timelineHtml = timeline.length
    ? timeline.map(runRowHtml).join('')
    : '<p class="muted" style="margin:8px 0">(no runs yet — type a prompt below and hit Run)</p>';

  const wsProvider = lastData.wsSettings[name]?.provider || '';
  const providers = lastData.providers || [];
  const globalProvider = lastData.globalProvider || '';
  // Select shows the actual effective provider — workspace override if
  // set, else global default. No separate "(default)" option to avoid
  // the duplicate label. Picking any provider writes an override.
  const effective = wsProvider || globalProvider;
  const providerOptions = providers
    .map((p) => `<option value="${esc(p)}"${p === effective ? ' selected' : ''}>${esc(p)}</option>`)
    .join('');

  return `
    <div class="ws-col">
      <div class="ws-head">
        <h2>${esc(name)}</h2>
        <select class="provider-inline" data-workspace="${esc(name)}" title="LLM provider for this workspace">
          ${providerOptions}
        </select>
      </div>
      <div class="ws-timeline" data-ws="${esc(name)}">${timelineHtml}</div>
      <form class="trigger-form" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <textarea name="prompt" placeholder="reply with only OK" required></textarea>
        <button type="submit">Run</button>
      </form>
    </div>
  `;
}

function runRowHtml(r) {
  const status = r.status || '?';
  // <a> not <div> — clicking jumps to #runs/<id> for the full-output detail.
  // .run-link strips the default underline + blue; .row keeps the layout.
  return `
    <a class="row run-link" href="#runs/${esc(r.id || '')}" title="View full output">
      <span>
        <span class="tag tag-${esc(status)}">${esc(status)}</span>
        <code>${esc((r.id || '').slice(0, 8))}</code>
        ${r.elapsed_s != null ? `· ${esc(r.elapsed_s)}s` : ''}
        ${r.exit_code != null && r.exit_code !== 0 ? `· exit ${esc(r.exit_code)}` : ''}
        ${r.source ? `· ${esc(r.source)}` : ''}
      </span>
    </a>
  `;
}

async function onTriggerSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const ws = form.dataset.workspace;
  const prompt = form.elements.prompt.value.trim();
  if (!prompt) return;
  const btn = form.querySelector('button[type="submit"]') || form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    // Provider comes from workspace settings (set via the inline header
    // select). No per-trigger override here — keeps the form simple;
    // switch the header dropdown if you want a different provider.
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

// ---------- Run detail view (#runs/<id>) ----------
// Standalone page: full prompt + full output of a single run. Two callers:
//   - clicking any row in the workspace timeline
//   - opening the link Feishu sends when output exceeds 4000 chars (P0-6e)

async function renderRunDetailView(id) {
  // Cache hit on a terminal-state row: only re-paint if the DOM doesn't
  // already show it. This keeps text selection / scroll stable across the
  // 3s polling re-render after the run has finished.
  const cached = runDetailCache[id];
  if (cached && (cached.status === 'done' || cached.status === 'failed')) {
    if (!$('view').querySelector('.run-meta')) paintRunDetail(id, cached);
    return;
  }

  let row;
  try {
    row = await api(`/runs/${encodeURIComponent(id)}`);
  } catch (err) {
    $('view').innerHTML = `
      <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
      <h1>Run <code>${esc(id.slice(0, 8))}</code></h1>
      <p class="muted">Failed to load: ${esc(err.message)}</p>
    `;
    return;
  }

  if (row.status === 'done' || row.status === 'failed') {
    runDetailCache[id] = row;
  }

  // User may have navigated away while we awaited — bail if so.
  const route = parseRoute();
  if (route.name !== 'runs' || route.id !== id) return;

  paintRunDetail(id, row);
}

function paintRunDetail(id, row) {
  const status = row.status || '?';
  const startedAt = row.started_at
    ? new Date(row.started_at * 1000).toLocaleString()
    : '';
  $('view').innerHTML = `
    <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
    <h1>Run <code>${esc(id.slice(0, 8))}</code></h1>
    <div class="run-meta">
      <span class="tag tag-${esc(status)}">${esc(status)}</span>
      ${row.workspace ? ` <code>${esc(row.workspace)}</code>` : ''}
      ${row.engine ? ` · ${esc(row.engine)}` : ''}
      ${row.elapsed_s != null ? ` · ${esc(row.elapsed_s)}s` : ''}
      ${row.exit_code != null ? ` · exit ${esc(row.exit_code)}` : ''}
      ${row.source ? ` · ${esc(row.source)}` : ''}
      ${startedAt ? ` · ${esc(startedAt)}` : ''}
    </div>
    <h3>Prompt</h3>
    <pre>${esc(row.prompt || '')}</pre>
    <h3>Output</h3>
    <pre>${esc(row.output || '(empty)')}</pre>
  `;
}

// ---------- Tasks view ----------
function renderTasksView() {
  const loops = lastData.loops || [];
  const workspaces = lastData.workspaces || [];
  const rows = loops.length
    ? loops.map(loopRowHtml).join('')
    : '<p class="muted">No cron loops yet. Use the form above.</p>';
  $('view').innerHTML = `
    <h1>Tasks (cron)</h1>
    <details class="add-form" data-details-id="add-loop">
      <summary>New cron loop</summary>
      <form data-form-id="new-loop">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="daily-digest" required></label>
        <div class="form-row">
          <label>workspace
            <select name="workspace" required>
              ${workspaces.map(w => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}
            </select>
          </label>
          <label>engine
            <select name="engine">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>
        </div>
        <label>自然语言(可选,LLM 同时填 cron 和 prompt)
          <div class="parse-row">
            <input name="nl" placeholder="每天早上 9 点 拉一下最新代码" autocomplete="off">
            <button type="button" class="secondary parse-btn">Parse</button>
          </div>
        </label>
        <label>cron 表达式 (5 字段)
          <input name="schedule" pattern="[^\\s]+\\s+[^\\s]+\\s+[^\\s]+\\s+[^\\s]+\\s+[^\\s]+.*"
            placeholder="0 9 * * *" required></label>
        <label>prompt
          <textarea name="prompt" placeholder="summarize yesterday's commits" required></textarea>
        </label>
        <div class="add-loop-foot">
          <label class="inline-check">
            <input type="checkbox" name="run_now" checked>
            Run once now
          </label>
          <button type="submit">Add</button>
        </div>
      </form>
    </details>
    <p class="muted">
      Each loop writes state to <code>~/.cc-state/jobs/&lt;name&gt;.json</code>.
      Pause / resume toggles <code>enabled</code>;
      delete removes the entry from <code>/etc/cron.d/cc-loops</code>.
    </p>
    <div class="task-list">${rows}</div>
  `;

  $('view').querySelector('form[data-form-id="new-loop"]')
    ?.addEventListener('submit', onAddLoop);
  $('view').querySelector('.parse-btn')
    ?.addEventListener('click', onParseNl);
  for (const b of $('view').querySelectorAll('.pause-btn, .resume-btn, .delete-btn')) {
    b.addEventListener('click', onLoopAction);
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
        <button class="danger delete-btn" data-name="${esc(loop.name)}">Delete</button>
      </span>
    </div>
  `;
}

async function onAddLoop(e) {
  e.preventDefault();
  const form = e.target;
  const fd = Object.fromEntries(new FormData(form).entries());
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    await api('/loops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fd.name,
        workspace: fd.workspace,
        schedule: fd.schedule,
        prompt: fd.prompt,
        engine: fd.engine || 'claude',
        // Checkbox: FormData omits unchecked boxes entirely, so undefined → false.
        run_now: fd.run_now === 'on',
      }),
    });
    form.reset();
    clearDraft('new-loop');
    clearDetails('add-loop');
    refreshAll();
  } catch (err) {
    showError(`add loop failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Add';
  }
}

async function onParseNl(e) {
  const btn = e.target;
  const form = btn.closest('form');
  const formId = form.dataset.formId;           // "new-loop"
  const nl = (form.elements.nl.value || '').trim();
  if (!nl) { showError('请先输入自然语言描述(时间 + 要做的事)'); return; }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Parsing…';
  try {
    const r = await api('/cron/parse-nl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: nl }),
    });
    // Polling may have re-rendered the form while we awaited — the `form`
    // reference above can point to a now-detached DOM node, and writing
    // .value on it would be invisible. Re-query the live form and ALSO
    // update drafts so the very next polling cycle preserves these values
    // (otherwise snapshotDrafts captures the empty pre-fill state).
    const liveForm = document.querySelector(`form[data-form-id="${formId}"]`) || form;
    liveForm.elements.schedule.value = r.cron || '';
    if (r.prompt && !liveForm.elements.prompt.value.trim()) {
      liveForm.elements.prompt.value = r.prompt;
    }
    drafts[formId] ??= {};
    drafts[formId].schedule = r.cron || '';
    if (r.prompt && !(drafts[formId].prompt || '').trim()) {
      drafts[formId].prompt = r.prompt;
    }
    clearError();
  } catch (err) {
    showError(`parse-nl failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

async function onLoopAction(e) {
  const btn = e.target;
  const name = btn.dataset.name;
  let endpoint, method;
  if (btn.classList.contains('pause-btn')) {
    endpoint = `/loops/${encodeURIComponent(name)}/pause`; method = 'POST';
  } else if (btn.classList.contains('resume-btn')) {
    endpoint = `/loops/${encodeURIComponent(name)}/resume`; method = 'POST';
  } else if (btn.classList.contains('delete-btn')) {
    if (!confirm(`Delete cron loop "${name}"?\nRemoves /etc/cron.d/cc-loops entry + jobs/${name}.json.`)) return;
    endpoint = `/loops/${encodeURIComponent(name)}`; method = 'DELETE';
  } else return;
  btn.disabled = true;
  try {
    await api(endpoint, { method });
    refreshAll();
  } catch (err) {
    showError(`${method} ${name} failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- boot ----------
render();
refreshAll();
setInterval(refreshAll, 3000);
