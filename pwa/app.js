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

// ---------- inline SVG icon set (lucide-style 24px line icons) ----------
// All icons share the same stroke / linecap / linejoin attrs so they look
// consistent regardless of where they're embedded. CSS sets the actual
// rendered size (.tag svg { 12px }, .toast svg { 16px }).
const _S = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  // status icons (used inside .tag chips)
  done:    `<svg ${_S}><polyline points="20 6 9 17 4 12"/></svg>`,
  running: `<svg ${_S}><polygon points="6 3 20 12 6 21"/></svg>`,
  queued:  `<svg ${_S}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`,
  failed:  `<svg ${_S}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  paused:  `<svg ${_S}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  // toast icons
  error:   `<svg ${_S}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>`,
  success: `<svg ${_S}><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg>`,
  info:    `<svg ${_S}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  warning: `<svg ${_S}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  // 6-dot vertical grip — drag handle on PC workspace cards
  grip:    `<svg ${_S}><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`,
  // Maximize / minimize corner arrows (kept for potential reuse)
  maximize: `<svg ${_S}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  minimize: `<svg ${_S}><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  // Eye with a slash — "hide this card from the overview"
  eyeOff:   `<svg ${_S}><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
  // Lock / unlock — workspace trust state (auto-approve tools or not)
  lock:    `<svg ${_S}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock:  `<svg ${_S}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
};

// Tag helper — status string → <span class="tag tag-X"> with icon prefix.
function statusTag(status) {
  return `<span class="tag tag-${esc(status)}">${ICONS[status] || ''}${esc(status)}</span>`;
}

// Compact relative-time formatter — "2m ago", "3h ago", "5d ago". Used in
// the mobile overview cards to indicate when each workspace last ran.
function timeAgo(unixSec) {
  if (!unixSec) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Cron expression → human-readable Chinese (server timezone). Covers the
// common shapes; unrecognized expressions fall through to the raw form so
// power users still see what's actually scheduled. Caller is expected to
// keep the raw expression as a hover title for verification.
function humanizeCron(expr) {
  if (!expr || typeof expr !== 'string') return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [m, h, dom, mon, dow] = parts.slice(0, 5);
  const isNum = (s) => /^\d+$/.test(s);
  const pad = (n) => String(n).padStart(2, '0');
  const time = isNum(m) && isNum(h) ? `${pad(h)}:${pad(m)}` : null;

  const dowName = {
    '0': '周日', '1': '周一', '2': '周二', '3': '周三',
    '4': '周四', '5': '周五', '6': '周六', '7': '周日',
    sun: '周日', mon: '周一', tue: '周二', wed: '周三',
    thu: '周四', fri: '周五', sat: '周六',
  };
  const dk = (dow || '').toLowerCase();

  // every minute — explicit catchall before the M-only branch
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return '每分钟';
  }
  // M H * * *  → 每天 HH:MM
  if (time && dom === '*' && mon === '*' && dow === '*') return `每天 ${time}`;

  // M H * * <weekday>
  if (time && dom === '*' && mon === '*') {
    if (dow === '1-5') return `工作日 ${time}`;
    if (dow === '0,6' || dow === '6,0' || dow === '6,7') return `周末 ${time}`;
    if (dowName[dk]) return `每${dowName[dk]} ${time}`;
  }
  // M H D * *  → 每月 D 日 HH:MM
  if (time && isNum(dom) && mon === '*' && dow === '*') {
    return `每月 ${dom} 日 ${time}`;
  }
  // */N * * * *  → 每 N 分钟
  const mEvery = m.match(/^\*\/(\d+)$/);
  if (mEvery && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每 ${mEvery[1]} 分钟`;
  }
  // 0 */N * * *  → 每 N 小时
  const hEvery = h.match(/^\*\/(\d+)$/);
  if (m === '0' && hEvery && dom === '*' && mon === '*' && dow === '*') {
    return `每 ${hEvery[1]} 小时`;
  }
  // M * * * *  → 每小时 M 分 (0 → 每小时整点)
  if (isNum(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return m === '0' ? '每小时整点' : `每小时 ${m} 分`;
  }

  // Anything else (multiple values, ranges in DOM/MON, etc.) — show raw.
  return expr;
}

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pwa/sw.js').catch(() => {});
}

// ---------- API + error banner ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  // Session expired or never logged in → jump to login. We preserve the
  // current location in ?next= so the form sends the user back here on
  // success.
  if (r.status === 401 && !path.startsWith('/auth/')) {
    const next = encodeURIComponent(location.pathname + location.search + location.hash);
    location.href = `/pwa/login.html?next=${next}`;
    throw new Error('not authenticated; redirecting to login');
  }
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

// ---------- toast (replaces the old banner-error) ----------
// Stack at bottom-right (desktop) / bottom-edge above bottom-nav (mobile).
// Auto-dismiss after 4s; click × to dismiss manually. Identical API surface
// as the old showError/clearError so call sites don't have to change.
let _toastSeq = 0;
const TOAST_TTL_MS = 4000;

function showToast(level, message, opts = {}) {
  let container = $('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const id = ++_toastSeq;
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  el.dataset.id = id;
  el.innerHTML = `
    <span class="toast-icon">${ICONS[level] || ICONS.info}</span>
    <span class="toast-message">${esc(message)}</span>
    <button class="toast-close" type="button" aria-label="Dismiss">×</button>
  `;
  el.querySelector('.toast-close').addEventListener('click', () => dismissToast(id));
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => dismissToast(id), opts.ttl ?? TOAST_TTL_MS);
  return id;
}

function dismissToast(id) {
  const el = document.querySelector(`.toast[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('toast-show');
  el.classList.add('toast-hide');
  setTimeout(() => el.remove(), 200);                  // matches CSS exit transition
}

function showError(msg) { showToast('error', msg); }
function clearError()   { /* no-op — toasts auto-dismiss themselves */ }

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
    const [ws, sess, lp, providers, cfg, approvals] = await Promise.all([
      api('/workspaces'),
      api('/sessions'),
      api('/loops'),
      api('/providers'),
      api('/config'),
      api('/approvals/pending').catch(() => []),   // graceful: backend may not have it yet
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
      globalDefaultTrust: !!cfg?.default_trust,
      // Pending approvals from /approvals/pending — claude's PreToolUse
      // hook has blocked a tool call and is waiting for the user. Each
      // entry has {approval_id, run_id, workspace, tool_name, tool_input}.
      // Attached to run rows by run_id in renderWorkspacesView path.
      pendingApprovals: Array.isArray(approvals) ? approvals : [],
    };
    clearError();
    $('status').textContent = '· ' + new Date().toLocaleTimeString();
    render();
  } catch (e) {
    showError(`fetch failed: ${e.message}`);
  }
}

// ---------- router ----------
// Three flavours:
//   #workspaces / #tasks       → tab views, handler in ROUTES
//   #workspaces/<name>         → single-workspace detail (carousel on mobile,
//                                wide single-column on PC). overview→detail
//                                pattern: tap card on mobile, click h2 link
//                                on PC.
//   #runs/<id>                 → single-run detail (full output, link target
//                                 from Feishu when output is truncated)
const ROUTES = { workspaces: renderWorkspacesView, tasks: renderTasksView };
function parseRoute() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('runs/')) return { name: 'runs', id: h.slice(5) };
  if (h.startsWith('workspaces/')) return { name: 'workspace-detail', id: decodeURIComponent(h.slice(11)) };
  return { name: h || 'workspaces', id: null };
}

// Tracks the hash we last rendered. When parseRoute() returns a different
// hash than this, it's a "fresh navigation" — detail-mode initial scroll
// fires only on fresh nav so polling re-renders don't keep yanking the
// carousel back to its entry point after the user has swiped sideways.
let _lastRenderedHash = '__init__';
function setActiveTab(name) {
  // [data-tab] covers BOTH the topbar tabs (.tab) and the mobile bottom-nav
  // tabs (.bottom-tab) — same active class, same router target.
  for (const a of document.querySelectorAll('[data-tab]')) {
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
const carouselScroll = { left: 0 };                 // mobile carousel scrollLeft

// IntersectionObserver for the mobile workspace carousel — disconnect+rebuild
// on every renderWorkspacesView so it's bound to the live DOM.
let _carouselObserver = null;

// PC row-based layout. Persisted as localStorage['ws-layout'] — a 2D
// array of workspace names, one inner array per row. e.g.
//     [["demo-repo", "test-repo", "ai-meeting"], ["chat-history-room"]]
// gives a "3 on top, 1 on bottom" layout. Within a row, every card gets
// an equal flex share, so the bottom card here would be full-width.
// Per-browser; not synced to server.
let _wsLayout = [];

// Hard cap on row width — 4 cards max per row. No user-facing toggle:
// keeps the UI focused on the row-split-by-drag interaction.
const WS_MAX_PER_ROW = 4;

// Names of workspaces the user hid from the overview. Hidden cards
// don't render in any row; instead a slim "Hidden: …" strip at the
// bottom of the layout lets the user restore them.
let _wsHidden = new Set();

function _sanitizeLayout(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row) => Array.isArray(row))
    .map((row) => row.filter((n) => typeof n === 'string'))
    .filter((row) => row.length > 0);
}

function loadWsLayout() {
  try {
    _wsLayout = _sanitizeLayout(JSON.parse(localStorage.getItem('ws-layout')));
    if (_wsLayout.length > 0) return;
  } catch { /* fall through to migration */ }
  // Migration: older sessions stored a flat order under "ws-order".
  // Treat it as a single row so the user's prior reorder isn't lost.
  try {
    const order = JSON.parse(localStorage.getItem('ws-order'));
    if (Array.isArray(order) && order.length > 0) {
      _wsLayout = [order.filter((n) => typeof n === 'string')];
      saveWsLayout();
      return;
    }
  } catch {}
  _wsLayout = [];
}

function saveWsLayout() {
  try {
    localStorage.setItem('ws-layout', JSON.stringify(_wsLayout));
  } catch { /* private-mode / quota — silently skip */ }
}

function loadWsHidden() {
  try {
    const arr = JSON.parse(localStorage.getItem('ws-hidden'));
    _wsHidden = new Set(Array.isArray(arr) ? arr.filter((n) => typeof n === 'string') : []);
  } catch { _wsHidden = new Set(); }
}

function saveWsHidden() {
  try { localStorage.setItem('ws-hidden', JSON.stringify([..._wsHidden])); } catch {}
}

// Build the effective layout for the current workspaces:
//   - drop names no longer present (deleted workspaces)
//   - drop names in _wsHidden (user explicitly hid them)
//   - append fresh names (newly-created since last save) to the last row,
//     creating a new row when the last is at max-per-row
//   - drop now-empty rows
function effectiveLayout(allNames) {
  const present = new Set(allNames);
  const placed = new Set();
  const layout = [];
  for (const row of _wsLayout) {
    const kept = row.filter((n) => present.has(n) && !placed.has(n) && !_wsHidden.has(n));
    if (kept.length) {
      layout.push(kept);
      for (const n of kept) placed.add(n);
    }
  }
  const fresh = allNames.filter((n) => !placed.has(n) && !_wsHidden.has(n)).sort();
  for (const n of fresh) {
    if (layout.length === 0 || layout[layout.length - 1].length >= WS_MAX_PER_ROW) {
      layout.push([n]);
    } else {
      layout[layout.length - 1].push(n);
    }
  }
  return layout;
}

// Mutators — call save+render after.
function _removeFromLayout(name) {
  for (const row of _wsLayout) {
    const i = row.indexOf(name);
    if (i >= 0) { row.splice(i, 1); return; }
  }
}

function _findLayoutCoord(name) {
  for (let r = 0; r < _wsLayout.length; r++) {
    const c = _wsLayout[r].indexOf(name);
    if (c >= 0) return { row: r, col: c };
  }
  return null;
}

loadWsLayout();
loadWsHidden();

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
  // Mobile carousel: which workspace is currently snapped into view.
  const grid = document.querySelector('.ws-grid');
  if (grid && grid.scrollLeft > 0) carouselScroll.left = grid.scrollLeft;
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
  // Mobile carousel: restore which workspace was in view. Without this,
  // every 3s polling cycle would snap the user back to workspace #1.
  const grid = document.querySelector('.ws-grid');
  if (grid && carouselScroll.left) grid.scrollLeft = carouselScroll.left;
}

function clearDraft(formId) {
  delete drafts[formId];
}
function clearDetails(detailsId) {
  delete detailsOpen[detailsId];
  // Also collapse the live DOM element — without this, the next
  // snapshotDrafts() captures `<details open>` and restoreDrafts() puts
  // detailsOpen back to true, so the panel never actually closes.
  const el = document.querySelector(`details[data-details-id="${detailsId}"]`);
  if (el) el.open = false;
}

function render() {
  // Don't tear DOM out from under a focused input — refresh resumes after blur.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;

  snapshotDrafts();
  const route = parseRoute();
  const isFreshNav = location.hash !== _lastRenderedHash;
  _lastRenderedHash = location.hash;

  if (route.name === 'runs' && route.id) {
    setActiveTab(null);                            // no tab is active for detail page
    renderRunDetailView(route.id);
  } else if (route.name === 'workspace-detail' && route.id) {
    setActiveTab('workspaces');                    // Workspaces tab stays highlighted
    renderWorkspaceDetailView(route.id, { isFreshNav });
  } else {
    const handler = ROUTES[route.name] || ROUTES.workspaces;
    setActiveTab(route.name in ROUTES ? route.name : 'workspaces');
    handler();
  }
  restoreDrafts();
}
window.addEventListener('hashchange', render);

// ---------- Workspaces view (#workspaces) ----------
// Overview level — different shape on PC vs mobile:
//   PC      : current 4-col grid, every column has timeline + chat input.
//             Clicking a column's name navigates to #workspaces/<name> for
//             a focused single-workspace detail view (PC's "zoom in" mode).
//   Mobile  : compact card list, one card per workspace, NO trigger input.
//             Tapping a card navigates to #workspaces/<name> which renders
//             the carousel detail view (the previous mobile default).
function renderWorkspacesView() {
  if (window.matchMedia('(max-width: 768px)').matches) {
    renderMobileOverview();
  } else {
    renderDesktopOverview();
  }
}

// PC overview = row-based layout. Each row is a flex container where
// cards share width equally; drop a card on the gap above/below a row
// to create a new row. Max 4 per row (hardcoded). Hidden cards drop
// out of the layout and appear in a slim strip below.
function renderDesktopOverview() {
  const groups = groupByWorkspace(lastData.workspaces, lastData.sessions);
  const allNames = Object.keys(groups);
  const layout = effectiveLayout(allNames);

  const globalProvider = lastData.globalProvider || '';
  const newWsProviderOptions = [
    `<option value="">(use global default${globalProvider ? `: ${esc(globalProvider)}` : ''})</option>`,
    ...(lastData.providers || []).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`),
  ].join('');

  // Render: alternating row-gap + row. The trailing gap (after the last
  // row) is a drop target for "create new row at the bottom".
  const layoutHtml = layout.length === 0
    ? ''
    : layout.map((row, rowIdx) => {
        const cells = row.map((n) =>
          workspaceColHtml(n, groups[n] || { active: [], queued: [], recent: [] })
        ).join('');
        return `
          <div class="ws-row-gap" data-gap-before="${rowIdx}" aria-hidden="true"></div>
          <div class="ws-row" data-row-idx="${rowIdx}">${cells}</div>
        `;
      }).join('') + `<div class="ws-row-gap" data-gap-before="${layout.length}" aria-hidden="true"></div>`;

  // Hidden strip — only visible when the user has actually hidden things.
  // Each pill is a "restore" button.
  const hiddenNamesPresent = [...allNames].filter((n) => _wsHidden.has(n));
  const hiddenHtml = hiddenNamesPresent.length
    ? `<div class="ws-hidden-strip">
         <span class="muted">Hidden (${hiddenNamesPresent.length}):</span>
         ${hiddenNamesPresent
            .map((n) => `<button class="ws-restore-btn" type="button" data-ws="${esc(n)}" title="Restore to overview">${esc(n)}</button>`)
            .join('')}
       </div>`
    : '';

  $('view').innerHTML = `
    <h1>Workspaces</h1>
    <details class="add-form" data-details-id="add-ws">
      <summary>New workspace</summary>
      <form data-form-id="new-ws">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="repo-name (alphanum / . _ -)" required></label>
        <div class="form-row">
          <label>provider <select name="provider">${newWsProviderOptions}</select></label>
          <label>engine
            <select name="engine">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>
        </div>
        <label class="inline-check">
          <input type="checkbox" name="trust" ${lastData.globalDefaultTrust ? 'checked' : ''}>
          Auto-approve all tools (trust this workspace — Bash / git / WebFetch / etc. won't ask for permission)
        </label>
        <button type="submit">Create</button>
        <p class="muted" style="font-size:11px;margin:0">
          Creates <code>~/workspaces/&lt;name&gt;/</code> with <code>git init</code>
          + empty README + first commit. <strong>Engine is locked once created</strong>.
          Provider and trust can be flipped anytime via the column header (🔒/🔓).
        </p>
      </form>
    </details>
    ${layoutHtml
      ? `<div class="ws-layout">${layoutHtml}</div>`
      : `<p class="muted">No workspaces yet. Use the form above or create <code>~/workspaces/&lt;name&gt;/.git</code> on the server.</p>`}
    ${hiddenHtml}
  `;

  bindOverviewHandlers();
  for (const gap of $('view').querySelectorAll('.ws-row-gap')) {
    gap.addEventListener('dragover', onRowGapDragOver);
    gap.addEventListener('dragleave', onRowGapDragLeave);
    gap.addEventListener('drop', onRowGapDrop);
  }
  for (const b of $('view').querySelectorAll('.ws-hide-btn')) {
    b.addEventListener('click', onHideBtnClick);
  }
  for (const b of $('view').querySelectorAll('.ws-restore-btn')) {
    b.addEventListener('click', onRestoreBtnClick);
  }
}

// ---------- Hide / restore handlers ----------
function onHideBtnClick(e) {
  const name = e.currentTarget.dataset.ws;
  if (!name) return;
  _wsHidden.add(name);
  // Also drop the workspace from the saved layout so restore can decide
  // where to put it back (last row of remaining layout).
  _removeFromLayout(name);
  _wsLayout = _wsLayout.filter((row) => row.length > 0);
  saveWsHidden();
  saveWsLayout();
  render();
}

function onRestoreBtnClick(e) {
  const name = e.currentTarget.dataset.ws;
  if (!name) return;
  _wsHidden.delete(name);
  // Append to the last row, or start a new row if it'd exceed max.
  if (_wsLayout.length === 0 || _wsLayout[_wsLayout.length - 1].length >= WS_MAX_PER_ROW) {
    _wsLayout.push([name]);
  } else {
    _wsLayout[_wsLayout.length - 1].push(name);
  }
  saveWsHidden();
  saveWsLayout();
  render();
}

// Mobile overview = compact card list. Each card is a hyperlink that
// drills into the carousel detail view via #workspaces/<name>. The "+ New
// workspace" form stays available at the top of the list, same form as PC.
function renderMobileOverview() {
  const groups = groupByWorkspace(lastData.workspaces, lastData.sessions);
  const sortedNames = Object.keys(groups).sort();

  const cards = sortedNames.map((name) => {
    const data = groups[name] || { active: [], queued: [], recent: [] };
    const all = [
      ...(data.active || []),
      ...(data.queued || []),
      ...(data.recent || []),
    ];
    all.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));     // newest first
    const last = all[0];
    const wsProvider =
      lastData.wsSettings[name]?.provider || lastData.globalProvider || '';
    const wsEngine = lastData.wsSettings[name]?.engine || 'claude';
    const trusted = effectiveTrust(name);
    const trustBadge = trusted ? ` · <span class="ws-card-trust" title="Auto-approves tools">${ICONS.unlock}</span>` : '';
    const pendingCount = pendingApprovalsForWorkspace(name).length;
    const pendingBadge = pendingCount > 0
      ? `<span class="ws-card-pending" title="${pendingCount} pending approval${pendingCount > 1 ? 's' : ''}">${ICONS.warning}${pendingCount} 待批准</span>`
      : '';
    const promptSnippet = last?.prompt ? last.prompt.slice(0, 50) : '';
    const promptOverflow = last?.prompt && last.prompt.length > 50 ? '…' : '';
    return `
      <a class="ws-card" href="#workspaces/${encodeURIComponent(name)}">
        <div class="ws-card-head">
          <h3>${esc(name)}</h3>
          <span class="ws-card-provider">${esc(wsProvider) || '—'} · ${esc(wsEngine)}${trustBadge}</span>
        </div>
        ${pendingBadge ? `<div class="ws-card-pending-row">${pendingBadge}</div>` : ''}
        ${last
          ? `<div class="ws-card-meta">
               ${statusTag(last.status || '?')}
               <span class="muted">
                 ${last.elapsed_s != null ? `· ${esc(last.elapsed_s)}s` : ''}
                 ${last.source ? `· ${esc(last.source)}` : ''}
                 ${last.started_at ? `· ${esc(timeAgo(last.started_at))}` : ''}
               </span>
             </div>`
          : '<div class="ws-card-meta muted">(no runs yet)</div>'}
        ${promptSnippet
          ? `<div class="ws-card-prompt">▸ ${esc(promptSnippet)}${promptOverflow}</div>`
          : ''}
      </a>
    `;
  }).join('');

  const globalProvider = lastData.globalProvider || '';
  const newWsProviderOptions = [
    `<option value="">(use global default${globalProvider ? `: ${esc(globalProvider)}` : ''})</option>`,
    ...(lastData.providers || []).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`),
  ].join('');

  $('view').innerHTML = `
    <h1>Workspaces</h1>
    <details class="add-form" data-details-id="add-ws">
      <summary>New workspace</summary>
      <form data-form-id="new-ws">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="repo-name (alphanum / . _ -)" required></label>
        <div class="form-row">
          <label>provider <select name="provider">${newWsProviderOptions}</select></label>
          <label>engine
            <select name="engine">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>
        </div>
        <label class="inline-check">
          <input type="checkbox" name="trust" ${lastData.globalDefaultTrust ? 'checked' : ''}>
          Auto-approve all tools (trust)
        </label>
        <button type="submit">Create</button>
        <p class="muted" style="font-size:11px;margin:0">
          Engine is locked once created.
        </p>
      </form>
    </details>
    ${cards
      ? `<div class="ws-list">${cards}</div>`
      : `<p class="muted">No workspaces yet. Use the form above.</p>`}
  `;

  $('view').querySelector('form[data-form-id="new-ws"]')
    ?.addEventListener('submit', onAddWorkspace);
}

// Bind handlers that exist on every .ws-col-rendering view (PC overview,
// PC single-ws detail, mobile carousel detail). Approval buttons in
// particular live INSIDE the timeline so they're re-emitted whenever
// workspaceColHtml runs — without this binder, they were dead on the
// mobile carousel + PC detail views (only PC overview was wired up).
function bindWorkspaceColHandlers(root) {
  for (const f of root.querySelectorAll('.trigger-form')) {
    f.addEventListener('submit', onTriggerSubmit);
  }
  for (const sel of root.querySelectorAll('.provider-inline')) {
    sel.addEventListener('change', onProviderInlineChange);
  }
  for (const b of root.querySelectorAll('.ws-trust-toggle')) {
    b.addEventListener('click', onTrustToggleClick);
  }
  for (const b of root.querySelectorAll('.approval-approve, .approval-deny')) {
    b.addEventListener('click', onApprovalClick);
    // Mobile fallback. Approval buttons live inside .ws-timeline which has
    // overflow-y: auto AND is itself inside .ws-grid with scroll-snap-type:
    // x mandatory (mobile carousel). Some Android browsers (Quark, the
    // Vivo/Mi/Huawei stock browsers, sometimes even Chrome) decide that a
    // tap which touches anywhere inside a nested-scroll container is
    // "ambiguous" and silently swallow the click event. `touchend` still
    // fires reliably, so we synthesize a click from it when the touch
    // didn't drift far enough to count as a swipe.
    _addTapFallback(b, onApprovalClick);
  }
}

// Generic helper: turn a finger tap (≤ 15px movement, ≤ 600ms) into a
// click handler invocation. Skips when the touch turned into a scroll
// gesture so we don't fire on swipe-pass-through. Pairs WITH a regular
// click listener, not instead of — on platforms where click works
// normally (i.e. PC), touchend simply isn't fired.
function _addTapFallback(el, handler) {
  let start = null;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!start) return;
    const begin = start;
    start = null;
    const end = e.changedTouches[0];
    if (!end) return;
    const dx = end.clientX - begin.x;
    const dy = end.clientY - begin.y;
    if (Math.hypot(dx, dy) > 15 || Date.now() - begin.t > 600) return;
    // Only fire if the corresponding 'click' didn't already — set a flag
    // on the element and clear in next microtask.
    if (el.dataset.tapHandled === '1') return;
    el.dataset.tapHandled = '1';
    setTimeout(() => { delete el.dataset.tapHandled; }, 400);
    e.preventDefault();
    handler({ currentTarget: el, preventDefault() {}, stopPropagation() {} });
  });
  // If a normal click fires (PC, Android Chrome usually), claim the
  // tap-handled flag so the touchend fallback above doesn't double-fire.
  el.addEventListener('click', () => {
    el.dataset.tapHandled = '1';
    setTimeout(() => { delete el.dataset.tapHandled; }, 400);
  }, { capture: true });
}

// PC-overview-specific bindings: new-ws form + drag-to-reorder. Always
// also runs the shared bindWorkspaceColHandlers so every card has its
// trigger / provider / trust / approval handlers wired.
function bindOverviewHandlers() {
  $('view').querySelector('form[data-form-id="new-ws"]')
    ?.addEventListener('submit', onAddWorkspace);
  bindWorkspaceColHandlers($('view'));
  setupCarousel();
  setupDragReorder();
}

// ---------- PC drag-to-reorder ----------
// Mobile: drag handles are display:none via CSS, so the handlers below are
// no-ops there. Strategy:
//   - dragstart on .ws-drag-handle stores the source workspace name
//   - dragover on .ws-col allows drop; visual marker via .drop-target
//   - drop on .ws-col reorders: insert source before/after the target
//     depending on whether the cursor is left or right of the target's
//     horizontal midpoint
// HTML5 drag API does the heavy lifting (momentum, drag image, etc).
function setupDragReorder() {
  // Bind from #view directly — PC overview puts .ws-col under .ws-layout
  // > .ws-row, while the mobile-detail carousel puts them under .ws-grid.
  // Earlier this function only queried .ws-grid, so PC card-drop handlers
  // never got attached (only the row-gap handlers, bound elsewhere). That
  // made card-to-card dragging visually start but drop with no effect.
  // .ws-drag-handle is only emitted in non-detail mode so the handle
  // selector naturally skips mobile carousel.
  for (const col of $('view').querySelectorAll('.ws-col')) {
    col.addEventListener('dragover', onColDragOver);
    col.addEventListener('dragleave', onColDragLeave);
    col.addEventListener('drop', onColDrop);
  }
  for (const h of $('view').querySelectorAll('.ws-drag-handle')) {
    h.addEventListener('dragstart', onHandleDragStart);
    h.addEventListener('dragend', onHandleDragEnd);
  }
}

function onHandleDragStart(e) {
  const col = e.target.closest('.ws-col');
  if (!col) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', col.dataset.ws);
  // Use the entire column as the drag preview, not just the handle icon.
  // Offset slightly so the preview's top-left sits a bit below the cursor.
  e.dataTransfer.setDragImage(col, Math.min(80, col.offsetWidth / 2), 20);
  col.classList.add('dragging');
  // Global drag flag — CSS uses body.is-dragging to "wake up" row-gap
  // drop zones and add a subtle lift to non-source cards.
  document.body.classList.add('is-dragging');
}

function onHandleDragEnd(e) {
  e.target.closest('.ws-col')?.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  // Clear any lingering target classes (defensive — should already be
  // gone via the per-element drop / dragleave handlers).
  for (const el of document.querySelectorAll('.drop-target, .drop-target-left, .drop-target-right')) {
    el.classList.remove('drop-target', 'drop-target-left', 'drop-target-right');
  }
}

function onColDragOver(e) {
  // preventDefault is what enables dropping; without it the browser refuses
  // to fire drop events.
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.currentTarget;
  // Insertion-line side based on cursor horizontal position relative to
  // the target's midpoint. CSS renders the line on the matching edge so
  // the user sees exactly where the drop will land.
  const rect = target.getBoundingClientRect();
  const insertBefore = e.clientX < rect.left + rect.width / 2;
  target.classList.toggle('drop-target-left', insertBefore);
  target.classList.toggle('drop-target-right', !insertBefore);
}

function onColDragLeave(e) {
  e.currentTarget.classList.remove('drop-target-left', 'drop-target-right');
}

function onColDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  const insertBefore = target.classList.contains('drop-target-left');
  target.classList.remove('drop-target-left', 'drop-target-right');
  const sourceName = e.dataTransfer.getData('text/plain');
  const targetName = target.dataset.ws;
  if (!sourceName || !targetName || sourceName === targetName) return;
  reorderWorkspaceTo(sourceName, targetName, insertBefore);
}

function reorderWorkspaceTo(sourceName, targetName, insertBefore) {
  // Layout-aware: target card lives in some row; insert source into
  // that row at the right position. If source comes from a different
  // row and target's row is at max-per-row, reject and tell the user.
  const targetCoord = _findLayoutCoord(targetName);
  if (!targetCoord) return;
  const sourceCoord = _findLayoutCoord(sourceName);

  if (
    sourceCoord &&
    sourceCoord.row !== targetCoord.row &&
    _wsLayout[targetCoord.row].length >= WS_MAX_PER_ROW
  ) {
    showToast(
      'warning',
      `Row already at max ${WS_MAX_PER_ROW}. Drop to a row gap (between rows) to create a new row instead.`,
      { ttl: 3000 },
    );
    return;
  }

  _removeFromLayout(sourceName);
  // Recompute target position — splicing source out might have shifted
  // indices when source was in the same row.
  const fresh = _findLayoutCoord(targetName);
  if (!fresh) return;
  const insertCol = insertBefore ? fresh.col : fresh.col + 1;
  _wsLayout[fresh.row].splice(insertCol, 0, sourceName);
  // Drop any rows we just emptied.
  _wsLayout = _wsLayout.filter((row) => row.length > 0);
  saveWsLayout();
  render();
}

// ---------- Row-gap drop zone (create a new row at this position) ----------
function onRowGapDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drop-target');
}

function onRowGapDragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}

function onRowGapDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop-target');
  const sourceName = e.dataTransfer.getData('text/plain');
  if (!sourceName) return;
  const gapBefore = parseInt(e.currentTarget.dataset.gapBefore, 10);
  if (isNaN(gapBefore)) return;

  // Reject no-op: if source is alone in its row AND we're dropping into
  // a gap adjacent to that row, the result would be identical.
  const src = _findLayoutCoord(sourceName);
  if (
    src && _wsLayout[src.row].length === 1 &&
    (gapBefore === src.row || gapBefore === src.row + 1)
  ) {
    return;
  }

  _removeFromLayout(sourceName);
  // Recompute insert position — removal may have shifted things if the
  // source's row collapsed.
  let insertAt = gapBefore;
  if (src && src.row < gapBefore && _wsLayout.length < gapBefore + 1) {
    // source's row collapsed → indices shift left
    insertAt = Math.max(0, gapBefore - 1);
  }
  _wsLayout.splice(insertAt, 0, [sourceName]);
  _wsLayout = _wsLayout.filter((row) => row.length > 0);
  saveWsLayout();
  render();
}

// Wire up the mobile carousel: each .ws-col is a scroll-snap target inside
// .ws-grid. IntersectionObserver tracks which column is centered; clicking
// a dot scrolls to that column. On desktop where .ws-grid is `display: grid`
// (not a scroll container), all columns intersect 100% — the observer fires
// once on init but the dots are CSS `display: none` so the no-op is invisible.
function setupCarousel() {
  if (_carouselObserver) {
    _carouselObserver.disconnect();
    _carouselObserver = null;
  }
  const grid = $('view').querySelector('.ws-grid');
  const dots = [...$('view').querySelectorAll('.ws-dot')];
  if (!grid || dots.length === 0) return;

  const cols = [...grid.children];

  _carouselObserver = new IntersectionObserver((entries) => {
    let bestIdx = -1, bestRatio = 0;
    for (const e of entries) {
      const idx = cols.indexOf(e.target);
      if (idx < 0) continue;
      if (e.intersectionRatio > bestRatio) {
        bestRatio = e.intersectionRatio;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      dots.forEach((d, i) => d.classList.toggle('active', i === bestIdx));
    }
  }, { root: grid, threshold: [0.25, 0.5, 0.75, 1] });

  cols.forEach((c) => _carouselObserver.observe(c));
  dots.forEach((d, i) => {
    d.addEventListener('click', () => {
      cols[i]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  });
}

// Effective per-workspace trust (mirrors backend ws_settings.trust_for):
//   explicit setting > config.toml default_trust > false
function effectiveTrust(name) {
  const s = lastData.wsSettings[name];
  if (s && typeof s.trust === 'boolean') return s.trust;
  return !!lastData.globalDefaultTrust;
}

// Render the per-workspace trust toggle button (only in non-detail mode).
function trustToggleHtml(name) {
  const trusted = effectiveTrust(name);
  const icon = trusted ? ICONS.unlock : ICONS.lock;
  const tip = trusted
    ? '工具已自动批准 (bypassPermissions). 点击改回 ask.'
    : '工具需要批准 (acceptEdits). 点击改成自动 (慎用).';
  return `<button class="ws-trust-toggle${trusted ? ' is-trusted' : ''}" type="button"
                  data-ws="${esc(name)}" data-trusted="${trusted ? '1' : '0'}"
                  title="${esc(tip)}" aria-label="Toggle trust">${icon}</button>`;
}

async function onTrustToggleClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  const wasTrusted = btn.dataset.trusted === '1';
  const next = !wasTrusted;
  // Only confirm when ENABLING trust — it's the security-relevant direction.
  if (next && !confirm(
    `将 "${name}" 切到 trusted 模式?\n\n` +
    `开启后 Claude 自动批准所有工具(Bash / git / WebFetch / 文件 IO),\n` +
    `不再发"请批准"的提示。\n\n` +
    `仅当你信任这个 workspace 跑的所有 prompt 时启用。`,
  )) return;
  btn.disabled = true;
  try {
    await api(`/workspaces/${encodeURIComponent(name)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trust: next }),
    });
    showToast('success', `${name}: ${next ? 'trusted (auto-approve)' : 'untrusted (will ask)'}`, { ttl: 2500 });
    refreshAll();
  } catch (err) {
    showError(`save trust failed: ${err.message}`);
  } finally {
    btn.disabled = false;
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
  // Empty string from the "(use global default)" option → send null so the
  // backend skips writing a per-workspace override into workspaces.json.
  const provider = (form.elements.provider?.value || '').trim() || null;
  // Engine is required at creation (locked thereafter). Backend defaults
  // to "claude" if the field is omitted; we send the selected value to be
  // explicit. The select always has a value (claude is the first option).
  const engine = (form.elements.engine?.value || 'claude').trim();
  // Trust checkbox value. Always send explicit true/false at creation time
  // so the workspace's resolution doesn't drift if the global default changes
  // later.
  const trust = !!form.elements.trust?.checked;
  if (!name) return;
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await api('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, engine, trust }),
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

function workspaceColHtml(name, data, opts = {}) {
  // ONE chat-like timeline: active + queued + recent merged, sorted by
  // started_at ascending so oldest is on top and newest at the bottom
  // (matches how you read a chat / git log / timeline). Default cap 10,
  // detail mode shows 30 (PC zoom-in wants more history).
  const maxRows = opts.maxRows ?? 10;
  const detail = !!opts.detail;
  const extraClass = opts.extraClass ?? '';

  const all = [
    ...(data.active || []),
    ...(data.queued || []),
    ...(data.recent || []),
  ];
  all.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
  const timeline = all.slice(-maxRows);
  const timelineHtml = timeline.length
    ? timeline.map((r) => {
        const approvals = pendingApprovalsFor(r.id || '');
        return runRowHtml(r) + approvals.map(approvalBlockHtml).join('');
      }).join('')
    : '<p class="muted" style="margin:8px 0">(no runs yet — type a prompt below and hit Run)</p>';

  const wsProvider = lastData.wsSettings[name]?.provider || '';
  const wsEngine = lastData.wsSettings[name]?.engine || 'claude';
  const providers = lastData.providers || [];
  const globalProvider = lastData.globalProvider || '';
  const effective = wsProvider || globalProvider;
  const providerOptions = providers
    .map((p) => `<option value="${esc(p)}"${p === effective ? ' selected' : ''}>${esc(p)}</option>`)
    .join('');

  // Overview: h2 wraps in a link so clicking it drills into detail; also
  // gets a drag handle for PC drag-to-reorder.
  // Detail: plain h2 (we're already in detail; the back-link handles exit).
  // No drag handle either — we're focused on one workspace.
  const headerTitle = detail
    ? `<h2>${esc(name)}</h2>`
    : `<h2><a class="ws-name-link" href="#workspaces/${encodeURIComponent(name)}">${esc(name)}</a></h2>`;

  const dragHandle = detail
    ? ''
    : `<span class="ws-drag-handle" draggable="true" title="Drag to reorder / move to another row" aria-label="Drag to reorder">${ICONS.grip}</span>`;

  const hideBtn = detail
    ? ''
    : `<button class="ws-hide-btn" type="button" data-ws="${esc(name)}"
               title="Hide from overview (restore via the strip at bottom)"
               aria-label="Hide">${ICONS.eyeOff}</button>`;

  return `
    <div class="ws-col ${extraClass}" data-ws="${esc(name)}">
      <div class="ws-head">
        <div class="ws-head-row">
          ${dragHandle}
          ${headerTitle}
          ${hideBtn}
        </div>
        <div class="ws-provider">
          <span class="ws-provider-label">as</span>
          <select class="provider-inline" data-workspace="${esc(name)}" title="LLM provider for this workspace">
            ${providerOptions}
          </select>
          <span class="ws-engine" title="Engine (immutable)">· ${esc(wsEngine)}</span>
          ${detail ? '' : trustToggleHtml(name)}
        </div>
      </div>
      <div class="ws-timeline" data-ws="${esc(name)}">${timelineHtml}</div>
      <form class="trigger-form" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <textarea name="prompt" placeholder="reply with only OK" required></textarea>
        <button type="submit">Run</button>
      </form>
    </div>
  `;
}

// Pending approvals for a single run — used to render [Approve][Deny]
// blocks alongside the timeline row.
function pendingApprovalsFor(runId) {
  if (!runId) return [];
  return (lastData.pendingApprovals || []).filter((a) => a.run_id === runId);
}

// Pending approvals for a workspace — used by the mobile overview card
// to badge workspaces that are blocked waiting on the user. Without
// this badge, mobile users had to tap into each workspace to discover
// a pending approval.
function pendingApprovalsForWorkspace(name) {
  if (!name) return [];
  return (lastData.pendingApprovals || []).filter((a) => a.workspace === name);
}

// Compact human description of a pending tool call — what Claude wants
// to do. Special-cases Bash + WebFetch (the two we currently hook); other
// tools fall back to "tool_name + JSON snippet".
function approvalSummary(a) {
  const ti = a.tool_input || {};
  if (a.tool_name === 'Bash' && ti.command) {
    const cmd = String(ti.command);
    return `Bash · <code>${esc(cmd.slice(0, 240))}${cmd.length > 240 ? '…' : ''}</code>`;
  }
  if (a.tool_name === 'WebFetch' && ti.url) {
    return `WebFetch · <code>${esc(ti.url)}</code>`;
  }
  const inputStr = JSON.stringify(ti).slice(0, 200);
  return `${esc(a.tool_name)} · <code>${esc(inputStr)}</code>`;
}

function approvalBlockHtml(a) {
  return `
    <div class="approval-pending" data-approval-id="${esc(a.approval_id)}">
      <div class="approval-pending-head">
        ${ICONS.warning} Claude wants to run a tool — waiting on you.
      </div>
      <div class="approval-tool">${approvalSummary(a)}</div>
      <div class="approval-actions">
        <button class="approval-approve" data-id="${esc(a.approval_id)}">Approve</button>
        <button class="approval-deny" data-id="${esc(a.approval_id)}">Deny</button>
      </div>
    </div>
  `;
}

async function onApprovalClick(e) {
  // Stop the click from bubbling up into any parent that might preventDefault
  // it (e.g. the run-link <a> earlier in the timeline). Both stopPropagation
  // AND preventDefault on the click event are belt-and-suspenders for mobile
  // browsers that sometimes treat tap-on-button as tap-on-nearest-link.
  e.preventDefault();
  e.stopPropagation();

  const btn = e.currentTarget;
  const id = btn.dataset.id;
  const decision = btn.classList.contains('approval-approve') ? 'approved' : 'denied';
  // Visible feedback FIRST — before the network call. Confirms the click
  // actually registered (covers the "tap → silence" failure mode).
  const block = btn.closest('.approval-pending');
  const originalText = btn.textContent;
  if (block) for (const b of block.querySelectorAll('button')) b.disabled = true;
  btn.textContent = decision === 'approved' ? 'Approving…' : 'Denying…';

  try {
    await api(`/approvals/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    showToast(decision === 'approved' ? 'success' : 'info', `Tool ${decision}.`, { ttl: 1800 });
    refreshAll();
  } catch (err) {
    showError(`decision failed: ${err.message}`);
    btn.textContent = originalText;
    if (block) for (const b of block.querySelectorAll('button')) b.disabled = false;
  }
}

function runRowHtml(r) {
  const status = r.status || '?';
  // 3-row layout: meta line · prompt preview · output preview.
  //   ▸ <prompt>            user's input (gray)
  //   ↳ <output_preview>    Claude's reply (green) — only when run finished
  // Both snippets are SQL-capped at 200 chars by db.py. Click anywhere on
  // the row navigates to the full-output detail page.
  const prompt = r.prompt || '';
  const output = r.output_preview || '';
  // Relative "Nm ago" with absolute timestamp on hover — matches the
  // pattern used in loopRowHtml ("last 2m ago" + title=absolute).
  const startedRel = r.started_at ? timeAgo(r.started_at) : '';
  const startedAbs = r.started_at
    ? new Date(r.started_at * 1000).toLocaleString()
    : '';

  return `
    <a class="row run-link" href="#runs/${esc(r.id || '')}" title="Click for full output">
      <div class="row-head">
        ${statusTag(status)}
        <code>${esc((r.id || '').slice(0, 8))}</code>
        ${r.elapsed_s != null ? `· ${esc(r.elapsed_s)}s` : ''}
        ${r.exit_code != null && r.exit_code !== 0 ? `· exit ${esc(r.exit_code)}` : ''}
        ${r.source ? `· ${esc(r.source)}` : ''}
        ${r.started_at ? `· <span class="row-time" title="${esc(startedAbs)}">${esc(startedRel)}</span>` : ''}
      </div>
      ${prompt ? `<div class="row-prompt">▸ ${esc(prompt)}</div>` : ''}
      ${output ? `<div class="row-output">↳ ${esc(output)}</div>` : ''}
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
    // select). Engine is also workspace-bound — backend derives it from
    // workspaces.json so we deliberately don't send it from here.
    await api('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: ws,
        prompt,
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

// ---------- Workspace detail view (#workspaces/<name>) ----------
// Drilled-into-one-workspace mode. Renders differently on PC vs mobile:
//   PC      : single .ws-col centered, wider, more history rows (30 vs 10).
//             Trigger form is still at the bottom of the column.
//   Mobile  : the full carousel (all workspaces), scrolled to <name> on
//             fresh navigation. Swipe between siblings. Pre-existing
//             setupCarousel / dot-indicator wiring all applies.
function renderWorkspaceDetailView(startName, opts = {}) {
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile) {
    renderMobileWorkspaceDetail(startName, opts);
  } else {
    renderDesktopWorkspaceDetail(startName);
  }
}

function renderMobileWorkspaceDetail(startName, opts = {}) {
  const groups = groupByWorkspace(lastData.workspaces, lastData.sessions);
  const sortedNames = Object.keys(groups).sort();
  const cols = sortedNames.map((w) => workspaceColHtml(w, groups[w], { detail: true })).join('');
  const dots = sortedNames.length > 1
    ? sortedNames.map((n) =>
        `<button class="ws-dot${n === startName ? ' active' : ''}" data-ws="${esc(n)}" aria-label="${esc(n)}"></button>`
      ).join('')
    : '';

  $('view').innerHTML = `
    <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
    ${cols
      ? `<div class="ws-grid">${cols}</div>${dots ? `<div class="ws-dots">${dots}</div>` : ''}`
      : `<p class="muted">No workspaces.</p>`}
  `;

  bindWorkspaceColHandlers($('view'));
  setupCarousel();

  // Jump to the requested workspace only on fresh navigation. Polling re-
  // renders within the same detail view should NOT yank the user back —
  // they may have swiped sideways since entering.
  if (opts.isFreshNav) {
    carouselScroll.left = 0;                       // forget previous detail's scroll
    const idx = sortedNames.indexOf(startName);
    if (idx >= 0) {
      requestAnimationFrame(() => {
        const grid = $('view').querySelector('.ws-grid');
        const target = grid?.children[idx];
        if (target) target.scrollIntoView({ inline: 'center', block: 'nearest' });
      });
    }
  }
}

function renderDesktopWorkspaceDetail(name) {
  const groups = groupByWorkspace(lastData.workspaces, lastData.sessions);
  if (!Object.prototype.hasOwnProperty.call(groups, name)) {
    $('view').innerHTML = `
      <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
      <p class="muted">Workspace <code>${esc(name)}</code> not found.</p>
    `;
    return;
  }
  const data = groups[name];

  $('view').innerHTML = `
    <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
    ${workspaceColHtml(name, data, { maxRows: 30, detail: true, extraClass: 'ws-col-detail' })}
  `;

  bindWorkspaceColHandlers($('view'));
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
      ${statusTag(status)}
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
        <label>workspace
          <select name="workspace" required>
            ${workspaces.map(w => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}
          </select>
        </label>
        <p class="muted" style="font-size:11px;margin:0">
          Engine is determined by the workspace's setting (see the column header).
        </p>
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
  const last_exit = loop.last_exit != null ? loop.last_exit : '—';
  const stale = (loop.consecutive_errors || 0) >= 3;

  // Use relative time for "last" with absolute as a tooltip — fits the
  // chat-bubble style of compact-first, click-for-details.
  const lastRel = loop.last_run_at ? timeAgo(loop.last_run_at) : '—';
  const lastAbs = loop.last_run_at
    ? new Date(loop.last_run_at * 1000).toLocaleString()
    : '';

  const enabledTag = enabled
    ? `<span class="tag tag-done">${ICONS.done}enabled</span>`
    : `<span class="tag tag-failed">${ICONS.paused}paused</span>`;

  // Static fields parsed from /etc/cron.d/cc-loops by cron_state.list_jobs.
  // For corrupt / missing entries, fall back to "—" rather than hiding the
  // whole row (something is better than nothing for debugging).
  const schedule = loop.schedule || '';
  const workspace = loop.workspace || '—';
  const engine = loop.engine || '';
  const prompt = loop.prompt || '';

  // Show a human-readable version of the cron expression when possible;
  // keep the raw form available on hover (and for power users / debugging).
  const humanSched = schedule ? humanizeCron(schedule) : '—';
  const schedTitle = schedule && humanSched !== schedule ? ` title="${esc(schedule)}"` : '';

  return `
    <div class="row loop-row">
      <div class="loop-head">
        <code class="loop-name">${esc(loop.name)}</code>
        ${enabledTag}
        ${stale ? `<span class="tag tag-failed">${ICONS.warning}stale ${esc(loop.consecutive_errors)}</span>` : ''}
        <span class="loop-actions">
          ${enabled
            ? `<button class="secondary pause-btn" data-name="${esc(loop.name)}">Pause</button>`
            : `<button class="secondary resume-btn" data-name="${esc(loop.name)}">Resume</button>`}
          <button class="danger delete-btn" data-name="${esc(loop.name)}">Delete</button>
        </span>
      </div>
      <div class="loop-spec">
        <span class="loop-when"${schedTitle}>${esc(humanSched)}</span>
        · <code>${esc(workspace)}</code>
        ${engine ? ` · <span class="muted">${esc(engine)}</span>` : ''}
      </div>
      ${prompt ? `<div class="loop-prompt">▸ ${esc(prompt)}</div>` : ''}
      <div class="loop-stats">
        <span title="${esc(lastAbs)}">last ${esc(lastRel)}</span>
        · runs ${esc(loop.total_runs || 0)}
        · exit ${esc(last_exit)}
      </div>
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
        // engine is bound to the workspace — backend reads from workspaces.json
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
