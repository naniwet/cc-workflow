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

import {
  foldToolResult,
  nextRunLabel,
  parseStreamLinesToEvents,
  roundtablePersonaAvatarsHtml,
  workspaceAutoScrollState,
  workspaceTurnExpansion,
} from './ui_contract.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// Minimal markdown renderer — covers what Claude actually emits ~95% of
// the time: **bold**, *italic*, ## headings, - bullets, ``` fenced code,
// `inline code`. Deliberately NOT a full spec (no links / images / tables /
// blockquotes / ordered lists) — keeps the implementation under 40 lines
// of regex without the corner-case zoo that a real parser inherits. When
// something real breaks, add the specific pattern; don't reach for marked.js.
//
// Strategy: pull code blocks out first (so their contents don't trigger
// inline patterns), then esc the rest, then walk the inline / block
// patterns in dependency order (code before bold before italic; lists
// before paragraphs).
function renderMarkdown(s) {
  if (!s) return '';
  const blocks = [];
  let h = String(s).replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code);
    return `\x00CB${blocks.length - 1}\x00`;
  });
  h = esc(h);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bullet groups: run of `- foo` lines → one <ul>.
  h = h.replace(/(?:^[*-] .+\n?)+/gm, (block) => {
    const items = block.split('\n').filter(l => /^[*-] /.test(l));
    return '<ul>' + items.map(l => `<li>${l.slice(2)}</li>`).join('') + '</ul>\n';
  });
  // Restore fenced code blocks BEFORE paragraph-wrapping, so the wrap
  // step sees a real <pre> at the line start and skips it (vs. wrapping
  // the sentinel placeholder in <p>, which would produce <p><pre>...</pre></p>).
  h = h.replace(/\x00CB(\d+)\x00/g, (_, i) =>
    `<pre class="md-code"><code>${esc(blocks[i])}</code></pre>`);
  // Paragraph wrap. Split on blank lines; wrap non-block parts in <p>.
  h = h.split(/\n{2,}/).map(part => {
    const t = part.trim();
    if (!t) return '';
    if (/^<(h\d|ul|ol|pre|blockquote|p)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean).join('\n');
  return h;
}

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
  // Refresh / sync — used by the per-workspace "Sync skills" button so
  // the user can re-scan ~/.claude/commands + workspace skills after
  // installing a new plugin or editing a command file.
  refresh: `<svg ${_S}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  // Trash with an arc — "reset session" (forget the conversation history
  // for this workspace's PWA session). Distinct visual from refresh so
  // users don't confuse "sync skills" with "wipe history".
  rewind:  `<svg ${_S}><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  // Down-arrow with a horizontal lip — "git pull latest". Visually
  // distinct from refresh (which is a circular arrow) so the menu's
  // two "fetch something" actions don't blur together.
  download: `<svg ${_S}><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><line x1="5" y1="20" x2="19" y2="20"/></svg>`,
  // Trash can — "hard delete this workspace" (rm -rf + clean configs).
  // Distinct from rewind: rewind = "wipe history, keep ws"; trash =
  // "everything goes". Red on hover (see style.css).
  trash:   `<svg ${_S}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`,
  // Three-dot "more" — opens the mobile actions dropdown (trust /
  // sync / reset / delete + provider switch, all collapsed because
  // 6 icons inline are too cramped on phone screens).
  more:    `<svg ${_S}><circle cx="12" cy="12" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg>`,
  settings: `<svg ${_S}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

// Tag helper — status string → <span class="tag tag-X"> with icon prefix.
function statusTag(status) {
  return `<span class="tag tag-${esc(status)}">${ICONS[status] || ''}${esc(status)}</span>`;
}

// Minimal status indicator — 只显示 icon,无 "done" 文字、无 chip 背景。
// 给 mobile turn-head 的 meta 区用,空间紧凑只要一眼看到状态。
function statusIcon(status) {
  return `<span class="status-icon status-icon-${esc(status)}" aria-label="${esc(status)}">${ICONS[status] || ''}</span>`;
}

function _globalPendingCount() {
  return (lastData.pendingApprovals || []).length;
}

function _updateTopbarStatus() {
  const status = $('status');
  if (!status) return;
  const pending = _globalPendingCount();
  status.innerHTML = `
    ${pending > 0
      ? `<button type="button" class="pending-badge" id="pending-global-badge"
                 title="${esc(pending)} 待审批">${ICONS.warning}<span>${esc(pending)}</span></button>`
      : ''}
    <span class="status-online"><span class="status-dot"></span>在线</span>
    <span class="status-time">· ${esc(new Date().toLocaleTimeString())}</span>
  `;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#pending-global-badge');
  if (!btn) return;
  const first = (lastData.pendingApprovals || [])[0];
  if (first?.workspace) location.hash = `#workspaces/${encodeURIComponent(first.workspace)}`;
});

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

function _runPreviewLine(run) {
  if (!run || run.status !== 'running') return '';
  const out = (run.output_preview || '').trim();
  if (out) return out.split('\n').find(Boolean)?.slice(0, 80) || '';
  const prompt = (run.prompt || '').trim();
  if (prompt) return `处理: ${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`;
  return 'Claude 正在处理…';
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
// One-shot guard so 7 parallel refreshAll() fetches all hitting 401 don't
// each schedule a separate navigation (last-write-wins technically, but
// some mobile browsers debounce / coalesce rapid location changes in
// surprising ways). Single navigation, single history entry.
let _redirectingToLogin = false;

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  // Session expired or never logged in → jump to login. We preserve the
  // current location in ?next= so the form sends the user back here on
  // success.
  if (r.status === 401 && !path.startsWith('/auth/')) {
    if (!_redirectingToLogin) {
      _redirectingToLogin = true;
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      // replace (not assign) so the 401-bearing URL doesn't sit in
      // history — a back-button tap from the login page should leave
      // the PWA, not loop back to "fetch failed".
      location.replace(`/pwa/login.html?next=${next}`);
    }
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
        else if (typeof d.msg === 'string') detail = d.msg;    // human-readable explanation (preferred)
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
  providers: [],                        // claude profiles (providers.json#profiles)
  wsSettings: {},                       // name → {provider?, engine?, trust?}
  globalProvider: '',                   // config.toml's provider field
  roundtables: [],                      // list summaries from GET /roundtables
};

// Module-level hash of the last rendered lastData. Skip render() when
// the structural snapshot is unchanged — `elapsed_s` of running runs
// ticks every 3s but isn't a real state event (the "Xs ago" indicator
// in Live output already conveys liveness), so we strip it from the
// hash. Real events (new run, status flip, new pending approval, new
// cron loop, etc.) all show up as non-trivial diffs and DO trigger
// render. Net effect: full-view innerHTML rewrites are now event-
// driven, not 3-second-periodic. Navigation paints the new view via
// the hashchange → render listener (no hash reset needed: lastData
// is unchanged at the navigation moment, so subsequent polls also
// skip — the new view stays painted as drawn).
let _lastDataHash = '';

async function refreshAll() {
  try {
    const [ws, sess, lp, providers, cfg, approvals, roundtables] = await Promise.all([
      api('/workspaces'),
      api('/sessions'),
      api('/loops'),
      api('/providers'),
      api('/config'),
      api('/approvals/pending').catch(() => []),   // graceful: backend may not have it yet
      // /roundtables = list summaries for the 3rd tab. Cheap (no per-turn
      // body, just counts). .catch keeps older backends working.
      api('/roundtables').catch(() => []),
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
      roundtables: Array.isArray(roundtables) ? roundtables : [],
    };
    clearError();
    _updateTopbarStatus();
    // Skip re-render when nothing meaningful changed. `elapsed_s` is
    // replaced with 0 so the running-run timer alone doesn't trip the
    // diff — see _lastDataHash comment above. JSON.stringify with a
    // replacer is O(n) on lastData (≈10 small objects in practice);
    // measured negligible vs. the full render() pass we're skipping.
    const hash = JSON.stringify(lastData, (k, v) =>
      k === 'elapsed_s' ? 0 : v,
    );
    if (hash === _lastDataHash) return;
    _lastDataHash = hash;
    render();
  } catch (e) {
    // Swallow the "not authenticated; redirecting…" toast — the user is
    // already being redirected to login.html, the toast would just be
    // a confusing red flash in the half-second before navigation.
    if (_redirectingToLogin) return;
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
const ROUTES = {
  workspaces:  renderWorkspacesView,
  tasks:       renderTasksView,
  roundtables: renderRoundtablesView,
};
function parseRoute() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('runs/')) return { name: 'runs', id: h.slice(5) };
  if (h.startsWith('workspaces/')) return { name: 'workspace-detail', id: decodeURIComponent(h.slice(11)) };
  if (h.startsWith('roundtables/')) return { name: 'roundtable-detail', id: decodeURIComponent(h.slice(12)) };
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
const workspaceSessionScroll = {};                  // key: ws name → {scrollTop, atBottom}
const workspaceStreamState = {};                     // key: ws name → {eventCount,newEvents,atBottom}
const workspaceTurnOverrides = {};                   // key: run id → expanded bool

// 全局事件过滤:默认只显示 user / reply / result(thinking + tool_use +
// tool_result 隐藏)。tool_result 出错时无视开关一律显示 —— 错误不能
// 默默吞掉。localStorage 持久化(每台设备各自记)。
function eventFilterShowAll() {
  try { return localStorage.getItem('cc.eventFilter.showAll') === '1'; }
  catch { return false; }
}
function setEventFilterShowAll(on) {
  try { localStorage.setItem('cc.eventFilter.showAll', on ? '1' : '0'); } catch {}
}
// (Mobile carousel + IntersectionObserver were removed 2026-05-15;
// replaced by explicit header [‹][›] arrow navigation. See
// renderMobileWorkspaceDetail.)

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
  for (const s of document.querySelectorAll('.workspace-session-stream[data-ws]')) {
    const atBottom = Math.abs(s.scrollHeight - s.clientHeight - s.scrollTop) < 80;
    workspaceSessionScroll[s.dataset.ws] = { scrollTop: s.scrollTop, atBottom };
    workspaceStreamState[s.dataset.ws] = workspaceAutoScrollState(
      workspaceStreamState[s.dataset.ws],
      { eventCount: Number(s.dataset.eventCount || 0), atBottom },
    );
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
  for (const s of document.querySelectorAll('.workspace-session-stream[data-ws]')) {
    const state = workspaceStreamState[s.dataset.ws];
    const saved = workspaceSessionScroll[s.dataset.ws];
    if (!saved || state?.atBottom !== false) {
      s.scrollTop = s.scrollHeight;
    } else {
      s.scrollTop = saved.scrollTop;
    }
    _syncWorkspaceNewEventsButton(s.dataset.ws);
  }
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
  } else if (route.name === 'roundtable-detail' && route.id) {
    setActiveTab('roundtables');
    renderRoundtableDetailView(route.id, { isFreshNav });
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

  // Provider picker — uses the unified form-picker component so dark
  // theming matches the workspace ⋯ menu / roundtable model picker.
  const newWsProviderPicker = _newWsProviderPickerHtml();

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

  // Patch path: if .ws-layout is already in DOM AND the set of rendered
  // workspace names matches the set we want to render, skip the full
  // innerHTML rewrite and just diff-update each column's timeline.
  // The set-match check catches "no workspaces added/removed/hidden
  // since last render"; reordering inside the layout is fine because
  // _patchWorkspaceCard finds columns by data-ws, not by position.
  const view = $('view');
  // _patchWorkspaceCard 的 diff 算法只认 .run-row,PC overview 现在也走
  // turn-streaming(see workspaceColHtml 的注释),容器变了它就 stale 了。
  // 改全量重画 —— refreshAll 已经做了数据 hash 去重(elapsed_s 被 mask),
  // 一组卡片同时全量重画 4-8 张的成本可控,跟 PC detail / mobile 一致。

  view.innerHTML = `
    <h1>Workspaces</h1>
    <details class="add-form" data-details-id="add-ws">
      <summary>New workspace</summary>
      <form data-form-id="new-ws">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="repo-name (alphanum / . _ -)" required></label>
        <label>provider ${newWsProviderPicker}</label>
        <!-- engine 字段固定为 claude(codex 已下线 2026-05-14;原因见 README "engine 现状")。
             保留 hidden input 是为了后端 NewWorkspaceRequest 的 engine 字段满足 Pydantic
             Literal["claude"] 验证。 -->
        <input type="hidden" name="engine" value="claude">
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

// Build the HTML for one workspace card on the mobile overview list.
// Extracted from renderMobileOverview so the patch path can call it
// per-card to diff against the cached last-rendered HTML.
function _mobileWsCardHtml(name, data) {
  const all = [
    ...(data.active || []),
    ...(data.queued || []),
    ...(data.recent || []),
  ];
  all.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));   // newest first
  const last = all[0];
  const wsProvider =
    lastData.wsSettings[name]?.provider || lastData.globalProvider || '';
  const wsEngine = lastData.wsSettings[name]?.engine || 'claude';
  const trusted = effectiveTrust(name);
  const trustBadge = trusted ? `<span class="ws-card-trust" title="Auto-approves tools">${ICONS.unlock}</span>` : '';
  const pendingCount = pendingApprovalsForWorkspace(name).length;
  const pendingBadge = pendingCount > 0
    ? `<span class="ws-card-pending" title="${pendingCount} pending approval${pendingCount > 1 ? 's' : ''}">${ICONS.warning}${pendingCount} 待审批</span>`
    : '';
  const promptSnippet = last?.prompt ? last.prompt.slice(0, 50) : '';
  const promptOverflow = last?.prompt && last.prompt.length > 50 ? '…' : '';
  const status = last?.status || '';
  const cardClass = [
    'ws-card',
    status === 'running' ? 'running' : '',
    status === 'failed' ? 'failed' : '',
  ].filter(Boolean).join(' ');
  const preview = _runPreviewLine(last);
  const shortRunId = last?.id ? `#${String(last.id).slice(0, 3)}` : '';
  // PC: overview cards are read-only summary tiles. Mobile: card IS the
  // entry point to the carousel detail view, keep as <a>.
  const tag = _isMobileViewport ? 'a' : 'div';
  const href = _isMobileViewport
    ? ` href="#workspaces/${encodeURIComponent(name)}"`
    : '';
  return `
    <${tag} class="${cardClass}" data-card-name="${esc(name)}"${href}>
      <div class="ws-card-head">
        <h3>${esc(name)}</h3>
        <span class="ws-card-provider">
          ${wsProvider ? `<span class="ws-card-provider-name">${esc(wsProvider)}</span>` : '<span class="muted">—</span>'}
          <span class="ws-engine" data-engine="${esc(wsEngine)}">${esc(wsEngine)}</span>${trustBadge}
        </span>
      </div>
      ${last
        ? `<div class="ws-card-meta">
             ${statusTag(last.status || '?')}
             ${shortRunId ? `<span class="run-id">${esc(shortRunId)}</span>` : ''}
             <span class="muted">
               ${last.elapsed_s != null ? `· ${esc(last.elapsed_s)}s` : ''}
               ${last.source ? `· ${esc(last.source)}` : ''}
               ${last.started_at ? `· ${esc(timeAgo(last.started_at))}` : ''}
             </span>
             ${pendingBadge || ''}
           </div>`
        : '<div class="ws-card-meta ws-empty">还没跑过 · 点击开始</div>'}
      ${preview
        ? `<div class="ws-preview"><span class="pulse"></span><span>${esc(preview)}</span></div>`
        : ''}
      ${promptSnippet
        ? `<div class="ws-card-prompt">▸ ${esc(promptSnippet)}${promptOverflow}</div>`
        : ''}
    </${tag}>
  `;
}

// Per-card HTML cache so renderMobileOverview's patch path can detect
// "this card didn't change" and skip the DOM write entirely.
const _mobileCardCache = new Map();

// Mobile overview = compact card list. Each card is a hyperlink that
// drills into the carousel detail view via #workspaces/<name>. The "+ New
// workspace" form stays available at the top of the list, same form as PC.
function renderMobileOverview() {
  const groups = groupByWorkspace(lastData.workspaces, lastData.sessions);
  const sortedNames = Object.keys(groups).sort();
  const view = $('view');
  const existingList = view.querySelector('.ws-list');

  // Patch path: .ws-list already in DOM → diff cards
  if (existingList) {
    const existing = new Map();
    for (const card of existingList.querySelectorAll('.ws-card[data-card-name]')) {
      existing.set(card.dataset.cardName, card);
    }
    const wantedSet = new Set(sortedNames);
    // Remove cards that disappeared (workspace deleted).
    for (const [n, card] of existing) {
      if (!wantedSet.has(n)) {
        card.remove();
        _mobileCardCache.delete(n);
      }
    }
    // For each wanted name: build new HTML, compare to cached, swap if changed.
    for (const name of sortedNames) {
      const data = groups[name] || { active: [], queued: [], recent: [] };
      const newHtml = _mobileWsCardHtml(name, data);
      const cached = _mobileCardCache.get(name);
      const existingCard = existing.get(name);
      if (existingCard) {
        if (cached === newHtml) continue;     // identical → skip DOM
        const tmp = document.createElement('div');
        tmp.innerHTML = newHtml.trim();
        existingCard.replaceWith(tmp.firstElementChild);
        _mobileCardCache.set(name, newHtml);
      } else {
        // New workspace appeared → append at end. The full-rewrite path
        // sorts alphabetically; the patch path appends and accepts that
        // sort order may drift after add. Rare (you don't make new ws
        // every poll). If it matters, refresh the page.
        existingList.insertAdjacentHTML('beforeend', newHtml);
        _mobileCardCache.set(name, newHtml);
      }
    }
    return;
  }

  // Full rewrite path: building the initial DOM for this view.
  const cards = sortedNames.map((name) => {
    const data = groups[name] || { active: [], queued: [], recent: [] };
    const html = _mobileWsCardHtml(name, data);
    _mobileCardCache.set(name, html);
    return html;
  }).join('');

  // Same picker component as the PC overview variant uses.
  const newWsProviderPicker = _newWsProviderPickerHtml();

  view.innerHTML = `
    <h1>Workspaces</h1>
    <details class="add-form" data-details-id="add-ws">
      <summary>New workspace</summary>
      <form data-form-id="new-ws">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="repo-name (alphanum / . _ -)" required></label>
        <label>provider ${newWsProviderPicker}</label>
        <!-- engine 字段固定为 claude(codex 已下线 2026-05-14;原因见 README "engine 现状")。
             保留 hidden input 是为了后端 NewWorkspaceRequest 的 engine 字段满足 Pydantic
             Literal["claude"] 验证。 -->
        <input type="hidden" name="engine" value="claude">
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

  const newWsForm = view.querySelector('form[data-form-id="new-ws"]');
  newWsForm?.addEventListener('submit', onAddWorkspace);
}

// Bind handlers that exist on every .ws-col-rendering view (PC overview,
// PC single-ws detail, mobile carousel detail). Approval buttons in
// particular live INSIDE the timeline so they're re-emitted whenever
// workspaceColHtml runs — without this binder, they were dead on the
// mobile carousel + PC detail views (only PC overview was wired up).
// Detect mobile once at module load — viewport width never changes mid-session
// for a chat-style PWA (no responsive flip mid-typing). Used by Enter-to-send
// and to skip the slash popup on mobile (virtual keyboards make positioned
// menus glitchy).
const _isMobileViewport = window.matchMedia('(max-width: 768px)').matches;

// ============================================================================
// Slash-command autocomplete
// ============================================================================
// Why this lives in the PWA rather than a backend feature:
//   `claude -p "/foo args"` already resolves slash commands (verified
//   2026-05-13 via canary test — see commit log). So we DON'T need to
//   expand the .md body ourselves; we just need to surface "what skills
//   are available" so the user knows what to type.
//
// Strategy:
//   1. Per-workspace cache in localStorage (key cc_skills_<ws>).
//      Backend GET /skills?workspace=X scans disk; we cache the result
//      so typing-time filtering is fully client-side.
//   2. Sync button in each ws column header fetches fresh + writes cache.
//   3. On `/` typed in a trigger-form textarea, open a popup anchored to
//      the textarea. Filter as user types more chars after the slash.
//      Tab/Enter or click selects; Esc/blur dismisses.
//
// Skipped on mobile: virtual keyboards push the textarea up and an
// absolutely-positioned menu either falls off-screen or fights the IME
// candidate strip. PC users get the full experience.

// Match a trailing "/foo" at end of substring, where the "/" is at start
// of string or right after whitespace. Avoids triggering on paths like
// `src/utils/x.ts`. The query (chars after /) is capture group 1.
const _SLASH_TRIGGER_RE = /(?:^|\s)\/(\S*)$/;

// One popup element for the whole PWA, lazily created on first need.
let _slashPopupEl = null;
let _slashState = null;        // { textarea, workspace, items, filtered, idx, queryStart }

function _ensureSlashPopup() {
  if (_slashPopupEl) return _slashPopupEl;
  const el = document.createElement('div');
  el.id = 'slash-popup';
  el.className = 'slash-popup';
  el.hidden = true;
  el.addEventListener('mousedown', (e) => {
    // Prevent the textarea from losing focus when the user clicks an item.
    // Without this, blur fires first and we lose the cursor position before
    // the click handler runs.
    e.preventDefault();
  });
  document.body.appendChild(el);
  _slashPopupEl = el;
  return el;
}

function _slashCacheKey(workspace) { return `cc_skills_${workspace}`; }

function _loadSkillsCache(workspace) {
  try {
    const raw = localStorage.getItem(_slashCacheKey(workspace));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function _saveSkillsCache(workspace, items) {
  try {
    localStorage.setItem(_slashCacheKey(workspace), JSON.stringify(items));
  } catch {}
}

async function syncSkillsFor(workspace) {
  try {
    const items = await api(`/skills?workspace=${encodeURIComponent(workspace)}`);
    _saveSkillsCache(workspace, Array.isArray(items) ? items : []);
    return items;
  } catch (e) {
    showError(`sync skills failed: ${e.message}`);
    return null;
  }
}

// Called when user presses a key in a trigger-form textarea — *before* the
// Enter-to-send check, so the slash popup gets first crack at handling
// Tab/Enter/Esc/Arrow events.
function _onPromptInput(e) {
  const ta = e.currentTarget;
  // Slash autocomplete works on mobile too (was gated off here for fear of
  // keyboard overlap, but in practice the popup positions above the textarea
  // and stays above the soft keyboard fine).
  const cursor = ta.selectionStart;
  const before = ta.value.substring(0, cursor);
  const m = before.match(_SLASH_TRIGGER_RE);
  if (!m) { _closeSlashPopup(); return; }
  const ws = ta.closest('form')?.dataset.workspace;
  if (!ws) return;
  const query = m[1] || '';
  const queryStart = cursor - query.length - 1;    // index of the "/"
  _openOrUpdateSlashPopup(ta, ws, query, queryStart);
}

function _openOrUpdateSlashPopup(textarea, workspace, query, queryStart) {
  const all = _loadSkillsCache(workspace);
  const ql = query.toLowerCase();
  const filtered = all.filter((s) =>
    s.name.toLowerCase().includes(ql)
    || (s.description || '').toLowerCase().includes(ql),
  );
  // If we have no cache yet and no items, show a hint to sync.
  if (all.length === 0 && filtered.length === 0) {
    _renderSlashPopupEmpty(textarea, workspace);
    _slashState = { textarea, workspace, items: [], filtered: [], idx: -1, queryStart };
    return;
  }
  if (filtered.length === 0) {
    _closeSlashPopup();
    return;
  }
  // Preserve idx if still valid, else reset to 0.
  let idx = 0;
  if (_slashState && _slashState.textarea === textarea) {
    idx = Math.min(_slashState.idx, filtered.length - 1);
    if (idx < 0) idx = 0;
  }
  _slashState = { textarea, workspace, items: all, filtered, idx, queryStart };
  _renderSlashPopup();
}

function _renderSlashPopupEmpty(textarea, workspace) {
  const el = _ensureSlashPopup();
  el.innerHTML = `
    <div class="slash-popup-empty">
      <div>暂无 skills 数据。</div>
      <div class="muted" style="font-size:11px;margin-top:4px">
        点 workspace 列头的 🔄 Sync skills 按钮拉一次。
      </div>
    </div>
  `;
  _positionSlashPopup(textarea);
  el.hidden = false;
}

function _renderSlashPopup() {
  const el = _ensureSlashPopup();
  const { filtered, idx } = _slashState;
  el.innerHTML = filtered.map((s, i) => `
    <div class="slash-item${i === idx ? ' selected' : ''}" data-i="${i}">
      <div class="slash-item-row">
        <code class="slash-item-name">/${esc(s.name)}</code>
        <span class="slash-item-source">${esc(s.source)}</span>
      </div>
      ${s.description ? `<div class="slash-item-desc">${esc(s.description)}</div>` : ''}
    </div>
  `).join('');
  for (const item of el.querySelectorAll('.slash-item')) {
    item.addEventListener('click', (e) => {
      const i = Number(e.currentTarget.dataset.i);
      if (Number.isFinite(i)) _commitSlashSelection(i);
    });
  }
  _positionSlashPopup(_slashState.textarea);
  el.hidden = false;
}

function _positionSlashPopup(textarea) {
  const el = _ensureSlashPopup();
  const r = textarea.getBoundingClientRect();
  // Default: open above the textarea (most prompt boxes sit at the bottom
  // of the column, so "below" would clip). If we'd run off the top of the
  // viewport, fall back to below.
  el.style.left = `${Math.round(r.left + window.scrollX)}px`;
  el.style.minWidth = `${Math.round(r.width)}px`;
  // Render first to measure height
  el.style.bottom = 'auto';
  el.style.top = '-9999px';
  el.hidden = false;
  const h = el.offsetHeight || 200;
  const topIfAbove = r.top + window.scrollY - h - 4;
  if (topIfAbove >= 0) {
    el.style.top = `${topIfAbove}px`;
  } else {
    el.style.top = `${r.bottom + window.scrollY + 4}px`;
  }
}

function _closeSlashPopup() {
  if (_slashPopupEl) _slashPopupEl.hidden = true;
  _slashState = null;
}

function _commitSlashSelection(i) {
  if (!_slashState) return;
  const skill = _slashState.filtered[i];
  if (!skill) return;
  const ta = _slashState.textarea;
  const insertText = `/${skill.name}${skill.has_args ? ' ' : ''}`;
  const before = ta.value.substring(0, _slashState.queryStart);
  const after = ta.value.substring(ta.selectionStart);
  ta.value = before + insertText + after;
  const newCursor = before.length + insertText.length;
  ta.setSelectionRange(newCursor, newCursor);
  ta.focus();
  _closeSlashPopup();
}

function _onPromptKeydown(e) {
  // IME composing (Chinese pinyin / Japanese / Korean): the user is mid-
  // composition, Enter belongs to the IME for candidate selection.
  // isComposing is the canonical signal; keyCode 229 is the legacy fallback
  // some IMEs send instead of setting isComposing properly.
  if (e.isComposing || e.keyCode === 229) return;

  // Slash popup keyboard nav (takes priority over Enter-to-send when open):
  //   ↑ / ↓     navigate
  //   Tab / Enter   select
  //   Esc       dismiss
  if (_slashState && !_slashPopupEl?.hidden && _slashState.filtered.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _slashState.idx = (_slashState.idx + 1) % _slashState.filtered.length;
      _renderSlashPopup();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _slashState.idx = (_slashState.idx - 1 + _slashState.filtered.length) % _slashState.filtered.length;
      _renderSlashPopup();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      _commitSlashSelection(_slashState.idx);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _closeSlashPopup();
      return;
    }
  }

  if (e.key !== 'Enter') return;
  // Cmd/Ctrl+Enter: universal "send" shortcut, works on PC + mobile.
  // Plain Enter: send on PC only (mobile keyboards have no Shift+Enter,
  // so plain-Enter-as-send would lock users out of multi-line prompts).
  const modSend = e.metaKey || e.ctrlKey;
  const plainSend = !_isMobileViewport && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
  if (!modSend && !plainSend) return;
  e.preventDefault();
  // Find the enclosing form and ask it to submit through the normal
  // event path (so onTriggerSubmit runs with e.preventDefault + validity
  // checks). requestSubmit triggers the submit handler + native validation.
  const form = e.currentTarget.closest('form');
  if (form && form.checkValidity()) form.requestSubmit();
  else if (form) form.reportValidity();
}

function bindWorkspaceColHandlers(root) {
  for (const f of root.querySelectorAll('.trigger-form')) {
    f.addEventListener('submit', onTriggerSubmit);
    const ta = f.querySelector('textarea[name="prompt"]');
    if (ta) {
      // Enter-to-send on PC, slash popup nav — both live in _onPromptKeydown.
      ta.addEventListener('keydown', _onPromptKeydown);
      // input fires after every value change (typing, paste, IME commit) —
      // use it to detect "user just typed / or extended the slash query".
      ta.addEventListener('input', _onPromptInput);
      // Closing the popup on blur would race the click handler on items
      // (blur fires before click). We pre-prevent the click's default to
      // keep focus, so blur shouldn't fire for clicks. Bind anyway for
      // outside-click via document below.
      ta.addEventListener('blur', () => setTimeout(_closeSlashPopup, 150));
    }
  }
  // Sync skills button per column header. Calls /skills?workspace=X and
  // refreshes localStorage. No re-render needed afterwards — the next
  // _onPromptInput will pick up the new cache.
  for (const btn of root.querySelectorAll('.ws-pull-latest')) {
    btn.addEventListener('click', _onPullLatestClick);
  }
  for (const btn of root.querySelectorAll('.ws-sync-skills')) {
    btn.addEventListener('click', _onSyncSkillsClick);
  }
  // Reset session button — destructive, confirm first. Clears
  // claude session_id so the next run starts a fresh conversation.
  for (const btn of root.querySelectorAll('.ws-reset-session')) {
    btn.addEventListener('click', _onResetSessionClick);
  }
  // Merge session branch → main + push。PWA session 默认隔离在
  // cc/<ws>-pwa-<ws> 分支(agent-run.sh:354,session_key 非 default 时
  // worktree 隔离),这个按钮一键 rebase + ff-merge + push。
  for (const btn of root.querySelectorAll('.ws-merge-to-main')) {
    btn.addEventListener('click', _onMergeToMainClick);
    _addTapFallback(btn, _onMergeToMainClick);
  }
  // Delete workspace button — extra destructive. Removes the entire
  // ~/workspaces/<name>/ directory + per-ws settings + session.
  for (const btn of root.querySelectorAll('.ws-delete-workspace')) {
    btn.addEventListener('click', _onDeleteWorkspaceClick);
  }
  // Any leftover .provider-inline <select>s (none in tree today after the
  // form-picker unification, but the binding stays as cheap defense in
  // depth if some future surface re-introduces a native select).
  for (const sel of root.querySelectorAll('.provider-inline')) {
    sel.addEventListener('change', onProviderInlineChange);
  }
  // In-menu radio-style provider switcher (per-ws ⋯ dropdown).
  for (const btn of root.querySelectorAll('.ws-menu-radio')) {
    btn.addEventListener('click', _onProviderRadioClick);
  }
  for (const b of root.querySelectorAll('.ws-trust-toggle')) {
    b.addEventListener('click', onTrustToggleClick);
    // Mobile fallback. See _addTapFallback comment — same reliability
    // work the approval buttons needed.
    _addTapFallback(b, onTrustToggleClick);
  }
  for (const b of root.querySelectorAll('.event-filter-toggle')) {
    b.addEventListener('click', _onEventFilterToggle);
    _addTapFallback(b, _onEventFilterToggle);
  }
  const approvalBtns = root.querySelectorAll('.approval-approve, .approval-deny');
  console.log('[cc-debug] bindWorkspaceColHandlers: approval buttons found =', approvalBtns.length);
  for (const b of approvalBtns) {
    b.addEventListener('click', onApprovalClick);
    // Mobile fallback. See _addTapFallback comment.
    _addTapFallback(b, onApprovalClick);
  }

  // PC overview + detail 现在都走 turn-streaming(workspaceColHtml 渲染
  // .turn 而不是 .run-row),所以这里把 turn-toggle / tool-result-fold
  // 一起连上,跟 mobile 版 _bindWorkspaceSessionHandlers 行为一致。
  // 先停所有正在跑的 turn-events poll —— 整页重画后老 timer 都失效了。
  // 无条件停:overview / detail 任一种重画都得 reset 旧 timer。
  _stopAllTurnEventsPolls();
  for (const btn of root.querySelectorAll('.turn-toggle')) {
    btn.addEventListener('click', _onWorkspaceTurnToggle);
    _addTapFallback(btn, _onWorkspaceTurnToggle);
  }
  for (const btn of root.querySelectorAll('.tool-result-fold')) {
    btn.addEventListener('click', _onToolResultExpand);
    _addTapFallback(btn, _onToolResultExpand);
  }
  // Bootstrap event load for initially-expanded turns(运行中 + 最近完成)。
  for (const turn of root.querySelectorAll('.turn.turn-expanded')) {
    const runId = turn.dataset.runId;
    if (runId) _loadTurnEvents(runId);
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
  const newWsForm = $('view').querySelector('form[data-form-id="new-ws"]');
  newWsForm?.addEventListener('submit', onAddWorkspace);
  bindWorkspaceColHandlers($('view'));
  setupDragReorder();
}

// Build the provider <option> list for the new-workspace form +
// per-workspace column header dropdown. Always reads from
// providers.json#profiles (the only supported engine since codex was
// removed 2026-05-14).
function _providerOptionsHtml(selected, includeDefault) {
  // Legacy native-<option> builder. Kept for any code path that still
  // wants native <select> behavior — the form-facing surfaces now use
  // _renderFormPicker (collapsible + radio-list, dark-theme consistent
  // with the workspace ⋯ menu).
  const list = lastData.providers || [];
  const opts = [];
  if (includeDefault) {
    const label = lastData.globalProvider ? `default · ${esc(lastData.globalProvider)}` : 'default';
    opts.push(`<option value=""${selected ? '' : ' selected'}>${label}</option>`);
  }
  for (const p of list) {
    opts.push(`<option value="${esc(p)}"${p === selected ? ' selected' : ''}>${esc(p)}</option>`);
  }
  return opts.join('');
}

// New-workspace form: provider picker HTML. Wrapper around _renderFormPicker
// so both the desktop (line ~651) and mobile (line ~780) render paths
// stay tidy and stay in sync if the option list ever needs special handling.
function _newWsProviderPickerHtml() {
  const list = lastData.providers || [];
  const defaultLabel = lastData.globalProvider
    ? `default · ${lastData.globalProvider}`
    : 'default';
  const options = [{ value: '', label: defaultLabel }];
  for (const p of list) options.push({ value: p, label: p });
  return _renderFormPicker({ name: 'provider', options, value: '' });
}

// Reusable form picker — drop-in replacement for <select> inside forms.
// Renders as a collapsible <details> + radio list, visually matching the
// workspace ⋯ menu's provider picker and roundtable's role-model picker
// (one dark-theme component, three usage sites). A hidden <input> holds
// the value so FormData / standard form submit keep working unchanged.
//
//   _renderFormPicker({
//     name: 'workspace',
//     options: [{value:'foo', label:'foo'}, {value:'bar', label:'bar'}],
//     value: 'foo',
//     detailsId: 'optional-id-for-snapshot/restore',
//   })
//
// Event handling is via document-level delegation (bound once at module
// init below), so callers don't need to bind anything after rendering.
function _renderFormPicker({ name, options, value, detailsId }) {
  const safeOpts = options.length > 0 ? options : [{ value: '', label: '(none)' }];
  const current = safeOpts.find((o) => o.value === value) || safeOpts[0];
  const dIdAttr = detailsId ? ` data-details-id="${esc(detailsId)}"` : '';
  const rows = safeOpts.map((o) => {
    const isSel = o.value === current.value;
    const rowClass = isSel
      ? 'ws-menu-radio form-picker-radio is-selected'
      : 'ws-menu-radio form-picker-radio';
    const dotClass = isSel ? 'ws-radio-dot is-selected' : 'ws-radio-dot';
    return `
      <button type="button" class="${rowClass}"
              data-field="${esc(name)}" data-value="${esc(o.value)}">
        <span class="${dotClass}"></span>
        <span class="ws-radio-label">${esc(o.label)}</span>
      </button>
    `;
  }).join('');
  return `
    <details class="form-picker"${dIdAttr}>
      <summary class="form-picker-summary">
        <span class="form-picker-current">${esc(current.label)}</span>
      </summary>
      <div class="form-picker-list">${rows}</div>
      <input type="hidden" name="${esc(name)}" value="${esc(current.value)}">
    </details>
  `;
}

function _onFormPickerClick(e) {
  const btn = e.target.closest('.form-picker-radio');
  if (!btn) return;
  const picker = btn.closest('details.form-picker');
  if (!picker) return;
  const fieldName = btn.dataset.field;
  const value = btn.dataset.value;
  // 1. Update hidden input → form.submit / FormData see the new value
  const hidden = picker.querySelector(`input[type="hidden"][name="${fieldName}"]`);
  if (hidden) hidden.value = value;
  // 2. Repaint summary text
  const newLabel = btn.querySelector('.ws-radio-label')?.textContent || value;
  const summary = picker.querySelector('.form-picker-current');
  if (summary) summary.textContent = newLabel;
  // 3. Repaint is-selected state on every row in this picker
  for (const r of picker.querySelectorAll('.form-picker-radio')) {
    const isSel = r === btn;
    r.classList.toggle('is-selected', isSel);
    r.querySelector('.ws-radio-dot')?.classList.toggle('is-selected', isSel);
  }
  // 4. Click-to-pick-and-close (matches workspace ⋯ menu UX)
  picker.open = false;
}

// Document-level click delegation — bound once at module load. Lets every
// form-picker work without renderXxx needing to wire its own handlers.
document.addEventListener('click', _onFormPickerClick);

// Cancel button on long-running rows. Delegated rather than bound per
// row because rows are re-rendered on every poll; binding individually
// would either leak or require a binding pass in every renderXxx.
//
// The button sits inside the <a class="run-link">, so we must preventDefault
// AND stopPropagation — otherwise the anchor navigates to run-detail
// while the cancel API call is in flight, which is confusing UX.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.run-cancel-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const runId = btn.dataset.runId;
  if (!runId) return;
  const short = runId.slice(0, 8);
  if (!confirm(
    `取消 run ${short}?\n` +
    `\n` +
    `会向该 run 的 agent-run 进程组发 SIGTERM,包括内部 claude + tool 子进程。` +
    `slot 释放后,该 workspace 可以马上发新 run。`,
  )) return;
  btn.disabled = true;
  try {
    await api(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    showToast('success', `已 cancel run ${short}`, { ttl: 2200 });
    refreshAll();
  } catch (err) {
    showError(`cancel failed: ${err.message}`);
    btn.disabled = false;
  }
});

// In-menu provider picker: render as a vertical radio-list instead of a
// native <select>. Native <select> popups are OS-styled (white-on-black
// looks bad in our dark theme + nested inside a <details> menu is ugly).
// One click = switch (vs select's 2-click open-then-pick).
function _providerRadioListHtml(name, wsProvider) {
  const list = lastData.providers || [];
  const globalDefault = lastData.globalProvider;
  const defaultLabel = globalDefault
    ? `Default · ${esc(globalDefault)}`
    : 'Default';
  const rows = [];
  // The "" value means "no per-ws override; use config.toml default".
  rows.push(_providerRadioRowHtml(name, '', defaultLabel, !wsProvider));
  for (const p of list) {
    // Skip the row that's identical to the Default option in behavior.
    // Picking "Default" with globalProvider=deepseek vs. picking "deepseek"
    // explicitly produces the exact same wire effect — listing both is
    // confusing visual noise. Exception: when THIS workspace is explicitly
    // pinned to globalDefault (the "I want to lock to this provider even
    // if I change my global default later" path), we still surface the
    // row so the user can see the pin and unpin it via the Default row.
    if (p === globalDefault && p !== wsProvider) continue;
    rows.push(_providerRadioRowHtml(name, p, esc(p), p === wsProvider));
  }
  return rows.join('');
}

function _providerRadioRowHtml(name, value, label, selected) {
  const dotClass = selected ? 'ws-radio-dot is-selected' : 'ws-radio-dot';
  const rowClass = selected ? 'ws-menu-radio is-selected' : 'ws-menu-radio';
  return `<button class="${rowClass}" type="button"
                  data-ws="${esc(name)}" data-value="${esc(value)}"
                  aria-label="Use provider ${esc(value || 'default')}">
    <span class="${dotClass}"></span>
    <span class="ws-radio-label">${label}</span>
  </button>`;
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
  // Bind from #view directly — PC overview puts .ws-col under
  // .ws-layout > .ws-row. (Mobile single-ws detail also has a .ws-col
  // but inside .ws-mobile-body, where drag is irrelevant because
  // there's only one card; the .ws-drag-handle is emitted only in
  // non-detail mode, so handle binding naturally skips it.)
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

// setupCarousel() + _carouselObserver removed 2026-05-15 alongside the
// mobile carousel itself. Replaced by explicit [‹][›] arrows in
// renderMobileWorkspaceDetail. If the carousel ever comes back, git
// history has the previous implementation.

// Effective per-workspace trust (mirrors backend ws_settings.trust_for):
//   explicit setting > config.toml default_trust > false
function effectiveTrust(name) {
  const s = lastData.wsSettings[name];
  if (s && typeof s.trust === 'boolean') return s.trust;
  return !!lastData.globalDefaultTrust;
}

// trustToggleHtml() removed 2026-05-14 — the trust toggle now lives
// inside the per-workspace ⋯ menu as a wide text-labeled button rendered
// inline in workspaceColHtml. If you ever want an inline icon-only toggle
// again, the original lived here; the .ws-trust-toggle CSS rules still
// apply (just need the button element).

// "Pull latest (git pull)" inside the ⋯ menu — runs `git -C ~/workspaces/<name>
// pull --ff-only` server-side and surfaces the output (or the failure
// reason) via toast. fast-forward-only so we never quietly create merge
// commits without user knowledge.
async function _onPullLatestClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  btn.disabled = true;
  try {
    const r = await api(`/workspaces/${encodeURIComponent(ws)}/pull`, { method: 'POST' });
    const summary = r?.summary || 'pulled';
    showToast('success', `${ws}: ${summary}`, { ttl: 3500 });
  } catch (err) {
    showError(`pull failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function _onSyncSkillsClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  btn.disabled = true;
  btn.classList.add('is-syncing');
  try {
    const items = await syncSkillsFor(ws);
    if (items !== null) {
      showToast('success', `${ws}: ${items.length} skills 同步成功`, { ttl: 2200 });
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-syncing');
  }
}

// Close the nearest ancestor <details class="ws-actions-menu"> if any.
// Called after destructive actions (sync/reset/delete) inside the
// menu so it doesn't stay open over the toast.
//
// Also clears the snapshot entry — without this, restoreDrafts() would
// re-open the menu on the very next polling refresh because the snapshot
// captured `open=true` before this close happened.
function _closeAncestorMenu(el) {
  const det = el?.closest?.('details.ws-actions-menu');
  if (!det) return;
  det.open = false;
  if (det.dataset.detailsId) delete detailsOpen[det.dataset.detailsId];
}

// Native <details> doesn't close on outside-click — once you open it,
// it stays open until you click <summary> again. For dropdown-menu UX
// users expect "click anywhere else to dismiss" (and it doubles as a
// way to switch between two open menus on PC). Bound once at module
// load; click bubbles from any user click on the page.
document.addEventListener('click', (e) => {
  for (const det of document.querySelectorAll('details.ws-actions-menu[open]')) {
    if (!det.contains(e.target)) {
      det.open = false;
      if (det.dataset.detailsId) delete detailsOpen[det.dataset.detailsId];
    }
  }
});

async function _onDeleteWorkspaceClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  if (!confirm(
    `永久删除 workspace "${ws}"?\n\n` +
    `会清掉:\n` +
    `  • ~/workspaces/${ws}/ 整个目录(代码 + git 历史)\n` +
    `  • workspaces.json 里的 provider / engine / trust 配置\n` +
    `  • sessions.json 里的对话 session\n\n` +
    `cron loops 引用 "${ws}" 的话会开始报错,要单独删 loop。\n` +
    `此操作不可恢复。`
  )) return;
  btn.disabled = true;
  try {
    const result = await api(`/workspaces/${encodeURIComponent(ws)}`, { method: 'DELETE' });
    const cleaned = result?.cleaned || [];
    if (cleaned.length > 0) {
      showToast('success', `${ws}: deleted — ${cleaned.join(' + ')}`, { ttl: 3000 });
    } else {
      // Card was stale — dir + configs already gone elsewhere
      // (manual cleanup, parallel session, etc.). Still a successful
      // outcome from the user's POV.
      showToast('info', `${ws}: 已经不存在(目录和配置都没了),卡片刷掉`, { ttl: 3000 });
    }
    // If user is currently viewing this workspace's detail page,
    // navigate back to the overview before refreshAll repaints — else
    // they'll see a 404 detail view for a workspace that no longer exists.
    const route = parseRoute();
    if (route.name === 'workspace-detail' && route.id === ws) {
      location.hash = '#workspaces';
    }
    refreshAll();
  } catch (err) {
    showError(`delete failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function _onResetSessionClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  if (!confirm(
    `开启 "${ws}" 的新对话?\n\n` +
    `下一次 PWA prompt 会从一张白纸开始,Claude 不再记得之前聊过什么。\n\n` +
    `(cron loops 和飞书的会话不受影响,只重置 PWA 这条线。)`
  )) return;
  btn.disabled = true;
  try {
    const result = await api(`/workspaces/${encodeURIComponent(ws)}/session`, { method: 'DELETE' });
    const what = (result?.cleared || []).join(' + ') || '(nothing cleared)';
    workspaceStreamState[ws] = { eventCount: 0, newEvents: 0, atBottom: true };
    workspaceSessionScroll[ws] = { scrollTop: 0, atBottom: true };
    showToast('success', `${ws}: new chat — ${what}`, { ttl: 2500 });
    refreshAll();
  } catch (err) {
    showError(`reset session failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// "Merge session → main + push" 按钮:rebase cc/<ws>-pwa-<ws> 到 main +
// ff-merge + push origin main。后端走 POST /workspaces/{ws}/merge-session-branch,
// 完整流程见那里的 docstring。
//
// 三种回包形状要分开 toast:
//   ok=true, push_ok=true  → success "Merged + pushed"
//   ok=true, push_ok=false → warning "Merged locally, push failed: ..."
//   ok=false (HTTPException) → error "Merge failed: ..."
async function _onMergeToMainClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  if (!confirm(
    `把 "${ws}" 当前 PWA session 的 cc/* 分支合并到 main 并推送?\n\n` +
    `流程:rebase cc/${ws}-pwa-${ws} 到 main → fast-forward merge → git push origin main\n\n` +
    `cc/* 分支保留,下一轮 PWA 对话继续在它上面 append commit。\n\n` +
    `如果有冲突或 main worktree 不干净,操作会安全中止并提示。`
  )) return;
  btn.disabled = true;
  const originalText = btn.querySelector('span')?.textContent || '';
  if (originalText) btn.querySelector('span').textContent = 'Merging…';
  try {
    const result = await api(`/workspaces/${encodeURIComponent(ws)}/merge-session-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (result?.push_ok) {
      showToast('success', `${ws}: merged ${result.branch} → ${result.main_branch} + pushed`, { ttl: 3000 });
    } else {
      showToast('warning',
        `${ws}: merged to ${result.main_branch} locally, push failed — ${result.push_msg || '(no detail)'}`,
        { ttl: 5000 });
    }
    refreshAll();
  } catch (err) {
    // backend HTTPException 抛过来的 detail 里有 error + msg,api() 包装了
    // err.message 已经包含;直接 surface。
    showError(`merge failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    if (originalText) btn.querySelector('span').textContent = originalText;
  }
}

// 全局事件过滤 toggle:翻 localStorage flag,清掉所有 turn-events 的
// "已渲染行数"标记,然后调 render() 重画整页 —— 因为已渲染的 events
// 已经过期(filter 状态变了,要重新过滤一遍)。
function _onEventFilterToggle(e) {
  const btn = e.currentTarget;
  const next = btn.dataset.showAll !== '1';
  setEventFilterShowAll(next);
  // Reset 渲染计数 → 下次 _loadTurnEvents 会拉完整 tail 重新走 _renderTurnEvent
  for (const tev of document.querySelectorAll('.turn-events[data-run-id]')) {
    tev.dataset.renderedLines = '0';
    tev.innerHTML = '';
  }
  showToast('info', `Events: ${next ? 'showing all' : 'reply + result only'}`, { ttl: 1800 });
  render();
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

async function _onProviderRadioClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  if (!name) return;
  // Already-selected row — no-op, but still close menu so user feels the click.
  if (btn.classList.contains('is-selected')) {
    _closeAncestorMenu(btn);
    return;
  }
  const provider = btn.dataset.value || null;    // "" → null = clear override
  btn.disabled = true;
  try {
    await api(`/workspaces/${encodeURIComponent(name)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    // Close menu so the freshly-saved state is visible (refreshAll re-renders
    // the column header below, including the read-only provider label).
    _closeAncestorMenu(btn);
    showToast('success', `${name}: provider → ${provider || 'default'}`, { ttl: 1800 });
    refreshAll();
  } catch (err) {
    showError(`save provider failed: ${err.message}`);
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
  // Start from filesystem-backed workspace names (what /workspaces returns).
  // Old behavior `??=` auto-created entries for any r.workspace seen in
  // sessions — that meant deleted workspaces kept showing as phantom
  // cards because runs.db still has their history. Now we DROP orphan
  // runs from the UI; the workspace list (filesystem) is the source of truth.
  const valid = new Set(workspaces);
  const g = {};
  for (const w of workspaces) g[w] = { active: [], recent: [] };
  for (const r of sessions.active || []) {
    if (valid.has(r.workspace)) g[r.workspace].active.push(r);
  }
  for (const r of sessions.recent || []) {
    if (valid.has(r.workspace)) g[r.workspace].recent.push(r);
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

  // Detail + Overview 都用同一套 turn-streaming UI(设计图 §3.2 + §4)。
  //   Detail  :expandAll=true,所有 turn 默认展开看完整 event timeline
  //   Overview:expandAll=false,默认只有 running + 最近 1 个 completed
  //              展开(per design 3.2),其余收起单行 summary。用户在
  //              overview 直接点 turn 展开后能在小卡片内看 event 详情;
  //              也可以点 workspace name 跳到 detail 看完整版。
  // 渲染走同一个 _workspaceTurnHtml,handler / CSS 都共用。
  let timelineHtml;
  const turns = _workspaceSessionTurns(data);
  const turnsToShow = detail ? turns : turns.slice(-maxRows);
  const expandedTurns = workspaceTurnExpansion(
    turnsToShow,
    workspaceTurnOverrides,
    { expandAll: detail },
  );
  timelineHtml = expandedTurns.length
    ? expandedTurns.map(_workspaceTurnHtml).join('')
    : '<p class="muted" style="margin:8px 0">(no runs yet — type a prompt below and hit Run)</p>';

  const wsProvider = lastData.wsSettings[name]?.provider || '';
  const wsEngine = lastData.wsSettings[name]?.engine || 'claude';
  // Per-workspace dropdown — includes the empty "default" option so users
  // can clear the per-ws override.
  const providerOptions = _providerOptionsHtml(wsProvider, true);

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

  // Provider+engine: read-only state label (mobile) vs interactive
  // dropdown row (PC). Mobile collapses the 4 action buttons into a
  // <details> dropdown — 6 icons in a phone-width column was a wall.
  const providerLabel = wsProvider
    ? `<span class="ws-meta-provider">${esc(wsProvider)}</span>`
    : `<span class="ws-meta-provider muted">(default${lastData.globalProvider ? `: ${esc(lastData.globalProvider)}` : ''})</span>`;
  const engineChip = `<span class="ws-engine" data-engine="${esc(wsEngine)}" title="Engine (immutable post-create)">${esc(wsEngine)}</span>`;

  // Universal layout (PC + mobile share this — PC's earlier inline row
  // also wrapped when the column is narrow + the global-default placeholder
  // is verbose). Layout:
  //   [provider read-only label]  [engine chip]               [⋯ trigger]
  //                                                            └─ menu body:
  //                                                               Provider <select>
  //                                                               🔓 Trust: on/off
  //                                                               🔄 Sync skills
  //                                                               ⏪ Reset conversation
  //                                                               🗑 Delete workspace
  // The 4 destructive/setting actions all live inside ⋯; the surface
  // shows only state. Trust is in the menu (was inline on PC before) —
  // that's a 1-extra-click regression accepted in exchange for a clean
  // header that doesn't wrap.
  const providerEngineBlock = `
    <div class="ws-meta-mobile">
      ${providerLabel}
      ${engineChip}
      <details class="ws-actions-menu" data-details-id="ws-menu-${esc(name)}">
        <summary class="ws-actions-trigger" aria-label="More actions">${ICONS.more}</summary>
        <div class="ws-actions-menu-body">
          <div class="ws-menu-section">
            <span class="ws-menu-section-label">Provider</span>
            ${_providerRadioListHtml(name, wsProvider)}
          </div>
          <button class="ws-trust-toggle ws-menu-item" type="button"
                  data-ws="${esc(name)}" data-trusted="${effectiveTrust(name) ? '1' : '0'}"
                  aria-label="Toggle trust">
            ${effectiveTrust(name) ? ICONS.unlock : ICONS.lock}
            <span>Trust: ${effectiveTrust(name) ? '<strong>on</strong> · auto-approve' : '<strong>off</strong> · ask first'}</span>
          </button>
          <button class="ws-pull-latest ws-menu-item" type="button" data-ws="${esc(name)}">
            ${ICONS.download} <span>Pull latest (git pull)</span>
          </button>
          <button class="ws-sync-skills ws-menu-item" type="button" data-ws="${esc(name)}">
            ${ICONS.refresh} <span>Sync skills</span>
          </button>
          <button class="ws-merge-to-main ws-menu-item" type="button" data-ws="${esc(name)}">
            ${ICONS.download} <span>Merge session → main + push</span>
          </button>
          <button class="ws-reset-session ws-menu-item" type="button" data-ws="${esc(name)}">
            ${ICONS.rewind} <span>Reset conversation</span>
          </button>
          <button class="ws-delete-workspace ws-menu-item ws-menu-item-danger" type="button" data-ws="${esc(name)}">
            ${ICONS.trash} <span>Delete workspace</span>
          </button>
        </div>
      </details>
    </div>
  `;

  return `
    <div class="ws-col ${extraClass}" data-ws="${esc(name)}">
      <div class="ws-head">
        <div class="ws-head-row">
          ${dragHandle}
          ${headerTitle}
          ${hideBtn}
        </div>
        ${providerEngineBlock}
      </div>
      <div class="ws-timeline" data-ws="${esc(name)}">${timelineHtml}</div>
      <form class="trigger-form" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <textarea name="prompt" placeholder="reply with only OK · Enter to send, Shift+Enter for newline" required></textarea>
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
  //
  // Cancel button used to live here (right edge of row-head, on rows
  // running > 5 min). Moved to the run-detail page 2026-05-15 — the
  // timeline list is an "information view" that the user scrolls through
  // by feel; tapping a destructive ✕ in there is too easy by accident
  // on mobile. Cancel now requires "tap row → land on detail → tap
  // the prominent red button", which makes the destructive intent
  // explicit.
  const prompt = r.prompt || '';
  const output = r.output_preview || '';
  // Relative "Nm ago" with absolute timestamp on hover — matches the
  // pattern used in loopRowHtml ("last 2m ago" + title=absolute).
  const startedRel = r.started_at ? timeAgo(r.started_at) : '';
  const startedAbs = r.started_at
    ? new Date(r.started_at * 1000).toLocaleString()
    : '';

  // data-run-id + data-status: used by _patchWorkspaceCard's diff loop
  // to find existing rows and decide whether to swap (status changed)
  // or leave alone. Without these, the diff layer falls back to full
  // re-render.
  return `
    <a class="row run-link" href="#runs/${esc(r.id || '')}"
       data-run-id="${esc(r.id || '')}"
       data-status="${esc(status)}">
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
    // Blur the textarea before kicking off the refresh — render() has a
    // guard that bails when an INPUT/TEXTAREA is focused (to avoid tearing
    // DOM out from under a typist), and submit doesn't clear focus on its
    // own. Without this blur, the refresh that follows form submit
    // wouldn't repaint the timeline → new run wouldn't appear until the
    // user clicked away from the textarea.
    form.querySelector('textarea')?.blur();
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
//   Mobile  : header arrow bar [‹] <name> [›] + the same single .ws-col
//             below. Arrows replaceState to the prev/next workspace (no
//             history pollution). Replaced the earlier swipe-carousel
//             on 2026-05-15.
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
  if (sortedNames.length === 0) {
    $('view').innerHTML = `
      <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
      <p class="muted">No workspaces.</p>
    `;
    return;
  }

  const currentIdx = Math.max(0, sortedNames.indexOf(startName));
  const currentName = sortedNames[currentIdx];
  const data = groups[currentName] || { active: [], queued: [], recent: [] };
  const turns = _workspaceSessionTurns(data);
  const expandedTurns = workspaceTurnExpansion(turns, workspaceTurnOverrides);
  const eventCount = expandedTurns.length + pendingApprovalsForWorkspace(currentName).length;
  workspaceStreamState[currentName] = workspaceAutoScrollState(workspaceStreamState[currentName], {
    eventCount,
    atBottom: workspaceStreamState[currentName]?.atBottom !== false,
  });
  const isRunning = turns.some((t) => t.status === 'running' || t.status === 'queued');

  const view = $('view');
  view.innerHTML = _workspaceSessionDetailHtml(currentName, expandedTurns, { eventCount, isRunning });
  bindWorkspaceColHandlers(view);
  _bindWorkspaceSessionHandlers(view, currentName);
}

function _workspaceSessionTurns(data) {
  const byId = new Map();
  for (const r of [...(data.recent || []), ...(data.queued || []), ...(data.active || [])]) {
    const id = r.id || `${r.workspace || 'run'}-${r.started_at || byId.size}`;
    byId.set(id, { ...r, id });
  }
  return [...byId.values()].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
}

function _workspaceSessionDetailHtml(name, turns, { eventCount, isRunning }) {
  const state = workspaceStreamState[name] || {};
  const wsProvider = lastData.wsSettings[name]?.provider || '';
  const wsEngine = lastData.wsSettings[name]?.engine || 'claude';
  const trustOn = effectiveTrust(name);
  const providerRows = isRunning
    ? _providerRadioListHtml(name, wsProvider).replace(/<button /g, '<button disabled ')
    : _providerRadioListHtml(name, wsProvider);
  const disabledAttr = isRunning ? 'disabled' : '';
  const turnsHtml = turns.length
    ? turns.map(_workspaceTurnHtml).join('')
    : `<div class="workspace-empty">
         <div class="workspace-empty-title">New chat</div>
         <p class="muted">Send the first prompt to start this workspace session.</p>
       </div>`;

  return `
    <div class="workspace-session" data-workspace="${esc(name)}">
      <div class="workspace-topbar">
        <a class="workspace-back" href="#workspaces" aria-label="Back to workspaces">←</a>
        <div class="workspace-title">
          <strong>${esc(name)}</strong>
          <span>${esc(wsProvider || lastData.globalProvider || 'default')} · ${esc(wsEngine)}</span>
        </div>
        <details class="workspace-gear ws-actions-menu" data-details-id="ws-detail-menu-${esc(name)}">
          <summary class="workspace-gear-trigger ws-actions-trigger" aria-label="Workspace settings">${ICONS.settings}</summary>
          <div class="workspace-menu ws-actions-menu-body">
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Provider</span>
              ${providerRows}
            </div>
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Workspace</span>
              <button class="ws-trust-toggle ws-menu-item" type="button"
                      data-ws="${esc(name)}" data-trusted="${trustOn ? '1' : '0'}">
                ${trustOn ? ICONS.unlock : ICONS.lock}
                <span>Trust workspace <strong>${trustOn ? 'ON' : 'OFF'}</strong></span>
              </button>
              <button class="ws-pull-latest ws-menu-item" type="button" data-ws="${esc(name)}" ${disabledAttr}>
                ${ICONS.download} <span>Pull latest</span>
              </button>
              <button class="ws-sync-skills ws-menu-item" type="button" data-ws="${esc(name)}">
                ${ICONS.refresh} <span>Sync skills</span>
              </button>
            </div>
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Display</span>
              <button class="event-filter-toggle ws-menu-item" type="button"
                      data-show-all="${eventFilterShowAll() ? '1' : '0'}">
                ${ICONS.refresh} <span>Show all events <strong>${eventFilterShowAll() ? 'ON' : 'OFF'}</strong></span>
              </button>
            </div>
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Session</span>
              <button class="ws-merge-to-main ws-menu-item" type="button" data-ws="${esc(name)}" ${disabledAttr}>
                ${ICONS.download} <span>Merge to main + push</span>
              </button>
              <button class="ws-reset-session ws-menu-item" type="button" data-ws="${esc(name)}" ${disabledAttr}>
                ${ICONS.rewind} <span>New chat</span>
              </button>
            </div>
            <button class="ws-delete-workspace ws-menu-item ws-menu-item-danger" type="button" data-ws="${esc(name)}">
              ${ICONS.trash} <span>Delete workspace</span>
            </button>
          </div>
        </details>
      </div>
      <div class="workspace-session-stream" data-ws="${esc(name)}" data-event-count="${esc(eventCount)}">
        ${turnsHtml}
      </div>
      <button class="workspace-new-events" type="button" data-ws="${esc(name)}" ${state.newEvents ? '' : 'hidden'}>
        ↓ ${esc(state.newEvents || 0)} new
      </button>
      <form class="trigger-form workspace-input" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <textarea name="prompt" placeholder="reply with only OK · Enter to send, Shift+Enter for newline" required></textarea>
        <button class="run-btn" type="submit" ${isRunning ? 'disabled' : ''}>Run</button>
      </form>
    </div>
  `;
}

function _workspaceTurnHtml(turn) {
  const status = turn.status || '?';
  const prompt = turn.prompt || '';
  const expanded = !!turn.expanded;
  // Collapsed-head 单行展示:caret + prompt 首行 + 状态 icon + 用时 + 起始时间。
  // 设计图 §3.2 要求收起态固定一行,所有 turn 等高。
  const summary = (prompt.split(/\r?\n/).find(Boolean) || '(empty prompt)').slice(0, 200);
  const cancelBtn = status === 'running' && turn.id
    ? `<button class="run-cancel-btn turn-cancel" type="button" data-run-id="${esc(turn.id)}">✕ Cancel</button>`
    : '';
  const approvals = pendingApprovalsFor(turn.id || '').map(approvalBlockHtml).join('');
  const startedRel = turn.started_at ? timeAgo(turn.started_at) : '';
  const startedAbs = turn.started_at ? new Date(turn.started_at * 1000).toLocaleString() : '';
  // USER 事件:始终是 expanded body 的第一条,展示完整 prompt。
  // 起始时间已挪到 head meta,这里不再重复显示。
  const userHeaderHtml = `
    <div class="event event-user">
      <div class="event-label">User</div>
      <div class="event-body">
        <div class="event-text-block">${esc(prompt)}</div>
      </div>
    </div>`;
  // turn-events 容器:expanded 时 _bindWorkspaceSessionHandlers 会触发
  // 一次 _loadTurnEvents 把 /runs/{id}/tail 的 stream-jsonl 解析渲染进来。
  // 同一 runId 二次 mount 时(主 poll 触发的 view rerender),容器会被
  // 重建为空状态,loader 据此判断要不要重新拉取。
  const eventsHtml = expanded
    ? `<div class="turn-events" data-run-id="${esc(turn.id || '')}" data-status="${esc(status)}">
         <div class="muted turn-events-loading">Loading events…</div>
       </div>`
    : `<div class="turn-events" data-run-id="${esc(turn.id || '')}" data-status="${esc(status)}"></div>`;

  return `
    <article class="turn turn-${expanded ? 'expanded' : 'collapsed'} turn-status-${esc(status)}"
             data-run-id="${esc(turn.id || '')}" data-status="${esc(status)}">
      <button class="turn-head turn-toggle" type="button"
              data-run-id="${esc(turn.id || '')}" data-expanded="${expanded ? '1' : '0'}">
        <span class="turn-caret">${expanded ? '▼' : '▶'}</span>
        <span class="turn-summary">${esc(summary)}</span>
        <span class="turn-meta">
          ${statusIcon(status)}
          ${turn.elapsed_s != null ? `<span class="turn-elapsed">${esc(turn.elapsed_s)}s</span>` : ''}
          ${startedRel ? `<span class="turn-started" title="${esc(startedAbs)}">${esc(startedRel)}</span>` : ''}
        </span>
      </button>
      ${cancelBtn}
      <div class="turn-body">
        ${userHeaderHtml}
        ${approvals}
        ${eventsHtml}
      </div>
    </article>
  `;
}

// ─────────────────────────────────────────────────────────────────────────
// expanded turn → /runs/{id}/tail 流式 event 渲染
//
// 设计图 §3.2 + §4:展开的 turn 显示完整 event timeline(thinking /
// tool_use / tool_result / text / result),tool_result > 5 行折叠为
// "↓ Expand N lines" 按钮。
//
// 主进度循环 setInterval(refreshAll, 3000) 会在数据变化时重建整个
// .workspace-session 的 DOM,所以这里的"已渲染行数"必须 keyed by
// (runId, container 实例),而不是单纯 runId —— rerender 后容器是新的,
// 老的 lineCount 失效。用 dataset.renderedLines 把状态直接存在 DOM 上,
// container 没了状态也没了,逻辑自洽。
//
// 轮询策略:turn 状态是 running/queued 时,2.5s 一拉(对齐
// _liveTailTimer 的节奏);done/failed 时一次性拉完即停。
// ─────────────────────────────────────────────────────────────────────────

// 活跃 poll 计时器:runId → timeoutId。卸载时调用 _stopTurnEventsPoll 清掉。
const _turnEventsTimers = {};

function _stopTurnEventsPoll(runId) {
  const t = _turnEventsTimers[runId];
  if (t) { clearTimeout(t); delete _turnEventsTimers[runId]; }
}

function _stopAllTurnEventsPolls() {
  for (const id of Object.keys(_turnEventsTimers)) _stopTurnEventsPoll(id);
}

async function _loadTurnEvents(runId) {
  if (!runId) return;
  const container = $('view')?.querySelector(`.turn-events[data-run-id="${cssQuoteEsc(runId)}"]`);
  if (!container) return;

  const status = container.dataset.status || '';
  const isRunning = status === 'running' || status === 'queued';
  const already = Number(container.dataset.renderedLines || 0);

  let data;
  try {
    data = await api(`/runs/${encodeURIComponent(runId)}/tail?lines=5000`);
  } catch (err) {
    // 失败时换占位文案,但不停止 polling — 网络抖动一下就好。仅在第一次
    // 加载失败时显示错误,避免覆盖已渲染的好数据。
    if (already === 0) {
      container.innerHTML = `<div class="muted">Failed to load events: ${esc(err.message || err)}</div>`;
    }
    if (isRunning) _turnEventsTimers[runId] = setTimeout(() => _loadTurnEvents(runId), 2500);
    return;
  }

  if (!data.exists) {
    if (already === 0) {
      container.innerHTML = '<div class="muted">No event stream yet — run may not have emitted any events.</div>';
    }
    if (isRunning) _turnEventsTimers[runId] = setTimeout(() => _loadTurnEvents(runId), 2500);
    return;
  }

  const allLines = data.lines || [];
  if (allLines.length > already) {
    // 关键:在 append 前记录 stream 当前是不是在底部。append 完如果之前
    // 在底部就把 scrollTop 重新设到 scrollHeight 拉回去 —— 否则新 events
    // 长出来后,scrollTop 没动,最新内容跑到视口外,看着就像"被输入框遮住"。
    // 用户反馈的"自动滚到最下面漏了输入框这部分"就是这个根因。
    // Chrome 桌面有 overflow-anchor:auto 自动帮忙,但 iOS Safari 对它支持
    // 弱,所以这里显式管 —— 主要照顾 mobile workspace-session-stream,
    // PC .ws-timeline 也保持同样语义(用户在底就跟到底)。
    const stream = container.closest('.workspace-session-stream, .ws-timeline');
    const wasAtBottom = stream
      ? (stream.scrollHeight - stream.clientHeight - stream.scrollTop) < 80
      : false;

    const newLines = allLines.slice(already);
    const newEvents = parseStreamLinesToEvents(newLines);
    const html = newEvents.map(_renderTurnEvent).join('');
    const loading = container.querySelector('.turn-events-loading');
    if (loading) loading.remove();
    if (html) container.insertAdjacentHTML('beforeend', html);
    container.dataset.renderedLines = String(allLines.length);
    // Bind fold buttons for tool_result 长输出(只 bind 新增的)。
    for (const btn of container.querySelectorAll('.tool-result-fold:not([data-bound])')) {
      btn.addEventListener('click', _onToolResultExpand);
      _addTapFallback(btn, _onToolResultExpand);
      btn.dataset.bound = '1';
    }

    // 重 scroll 到底,如果之前就在底。requestAnimationFrame 等浏览器
    // layout 完新 DOM 才量 scrollHeight,否则量的是 append 前的旧值。
    if (wasAtBottom && stream) {
      requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
    }
  } else if (already === 0 && allLines.length === 0) {
    // tail 文件存在但还没行 — 比"no event stream yet"更精确。
    const loading = container.querySelector('.turn-events-loading');
    if (loading) loading.textContent = 'Waiting for first event…';
  }

  if (isRunning) {
    _turnEventsTimers[runId] = setTimeout(() => _loadTurnEvents(runId), 2500);
  }
  // 不 running 的 turn:渲染完一次性结束,不留 timer。
}

// CSS 选择器里的 runId 可能带 - / : 等,esc() 用于 HTML 转义不够,
// 单独写一个 CSS attribute selector 用的转义。运行时 run_id 都是
// `<workspace>-<unix_ts>-<uuid8>` 形状,只有 ASCII + `-`,所以这里
// 是防御性的简单实现 — 真有更复杂字符再换 CSS.escape()。
function cssQuoteEsc(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

// 长 prose 折叠:5 行以内直接展示;超过 5 行先显示前 5 行 + "↓ Expand N
// lines" 按钮。复用 .tool-result-wrap / .tool-result-preview /
// .tool-result-full / .tool-result-fold 4 个 class —— 这样
// _onToolResultExpand 现有 handler 自动 work,不写新的展开逻辑。
// 跟 _workspaceOutputHtml 的区别:这里输出 div.event-text-block(flow
// 文本),不是 <pre>(monospace 块)—— thinking / text 是英文 prose,
// 用 pre 会看着像代码。
function _foldedTextHtml(text) {
  const folded = foldToolResult(text || '', 5);
  if (!folded.truncated) {
    return `<div class="event-text-block">${esc(folded.preview)}</div>`;
  }
  return `
    <div class="tool-result-wrap">
      <div class="event-text-block tool-result-preview">${esc(folded.preview)}</div>
      <div class="event-text-block tool-result-full" hidden>${esc(text || '')}</div>
      <button class="tool-result-fold" type="button">↓ Expand ${esc(folded.hiddenLineCount)} lines</button>
    </div>`;
}

function _renderTurnEvent(ev) {
  // 全局过滤:默认只显示 reply / result(text / result kind),用户在 ⚙
  // 打开 "Show all events" 时再展示 thinking / tool_use / tool_result。
  // 例外:tool_result.isError 一律显示 —— 错误不能在 default 模式被静默
  // 吞掉,否则 debug 看不见。
  const showAll = eventFilterShowAll();
  if (!showAll) {
    if (ev.kind === 'thinking' || ev.kind === 'tool_use') return '';
    if (ev.kind === 'tool_result' && !ev.isError) return '';
  }

  if (ev.kind === 'thinking') {
    // thinking 经常一段几百字(用户反馈的 bug:折叠提交说明刷屏 1 屏多)。
    // 默认折叠到 5 行,长内容点 Expand 才展开。
    return `
      <div class="event event-thinking">
        <div class="event-label">Thinking</div>
        <div class="event-body">${_foldedTextHtml(ev.text)}</div>
      </div>`;
  }
  if (ev.kind === 'text') {
    // assistant 文本回复:跟 thinking 同样的折叠规则,保持一致。
    return `
      <div class="event event-text">
        <div class="event-label">Reply</div>
        <div class="event-body">${_foldedTextHtml(ev.text)}</div>
      </div>`;
  }
  if (ev.kind === 'tool_use') {
    let preview = '';
    try { preview = JSON.stringify(ev.input || {}); } catch { preview = '<unserializable>'; }
    if (preview.length > 220) preview = preview.slice(0, 220) + '…';
    return `
      <div class="event event-tool">
        <div class="event-label">Tool</div>
        <div class="event-body">
          <code class="tool-call"><span class="tool-name">${esc(ev.name)}</span><span class="tool-args">${esc(preview)}</span></code>
        </div>
      </div>`;
  }
  if (ev.kind === 'tool_result') {
    const cls = ev.isError ? 'event-tool-result event-tool-result-error' : 'event-tool-result';
    return `
      <div class="event ${cls}">
        <div class="event-label">${ev.isError ? 'Error' : 'Result'}</div>
        <div class="event-body">${_workspaceOutputHtml(ev.text || '')}</div>
      </div>`;
  }
  if (ev.kind === 'result') {
    const usage = `${ev.subtype || ''} · ${ev.inTokens} in · ${ev.outTokens} out`;
    return `
      <div class="event event-final">
        <div class="event-label">Done</div>
        <div class="event-body">
          <div class="event-meta">${esc(usage)}</div>
          ${ev.text ? `<div class="event-text-block">${esc(ev.text)}</div>` : ''}
        </div>
      </div>`;
  }
  return '';
}

function _workspaceOutputHtml(output) {
  const folded = foldToolResult(output, 5);
  if (!folded.truncated) {
    return `<pre class="tool-result">${esc(folded.preview)}</pre>`;
  }
  return `
    <div class="tool-result-wrap">
      <pre class="tool-result tool-result-preview">${esc(folded.preview)}</pre>
      <pre class="tool-result tool-result-full" hidden>${esc(output)}</pre>
      <button class="tool-result-fold" type="button">↓ Expand ${esc(folded.hiddenLineCount)} lines</button>
    </div>
  `;
}

function _bindWorkspaceSessionHandlers(root, name) {
  // 整页 rerender 会重建 .turn-events 容器,所有正在跑的 poll 计时器
  // 都指向"老 DOM 实例"了 —— 先全清,避免幽灵 timer 往不存在的容器里
  // append。新 DOM 里的 expanded turn 会在下面重新触发一次 _loadTurnEvents。
  _stopAllTurnEventsPolls();

  const stream = root.querySelector('.workspace-session-stream[data-ws]');
  if (stream) {
    stream.addEventListener('scroll', () => {
      const atBottom = Math.abs(stream.scrollHeight - stream.clientHeight - stream.scrollTop) < 80;
      workspaceSessionScroll[name] = { scrollTop: stream.scrollTop, atBottom };
      workspaceStreamState[name] = workspaceAutoScrollState(workspaceStreamState[name], {
        eventCount: Number(stream.dataset.eventCount || 0),
        atBottom,
      });
      _syncWorkspaceNewEventsButton(name);
    }, { passive: true });
  }
  for (const btn of root.querySelectorAll('.turn-toggle')) {
    btn.addEventListener('click', _onWorkspaceTurnToggle);
    _addTapFallback(btn, _onWorkspaceTurnToggle);
  }
  for (const btn of root.querySelectorAll('.tool-result-fold')) {
    btn.addEventListener('click', _onToolResultExpand);
    _addTapFallback(btn, _onToolResultExpand);
  }
  const newEvents = root.querySelector('.workspace-new-events');
  if (newEvents) {
    newEvents.addEventListener('click', _onWorkspaceNewEventsClick);
    _addTapFallback(newEvents, _onWorkspaceNewEventsClick);
  }
  // Bootstrap event load for turns that mount in expanded state(运行中
  // turn + 最近完成 turn,见 workspaceTurnExpansion)。
  for (const turn of root.querySelectorAll('.turn.turn-expanded')) {
    const runId = turn.dataset.runId;
    if (runId) _loadTurnEvents(runId);
  }
}

function _syncWorkspaceNewEventsButton(name) {
  const btn = $('view').querySelector('.workspace-new-events[data-ws]');
  if (!btn) return;
  const count = workspaceStreamState[name]?.newEvents || 0;
  btn.hidden = count <= 0;
  btn.textContent = `↓ ${count} new`;
}

function _onWorkspaceTurnToggle(e) {
  const btn = e.currentTarget;
  const runId = btn.dataset.runId;
  if (!runId) return;
  const turn = btn.closest('.turn');
  const next = btn.dataset.expanded !== '1';
  workspaceTurnOverrides[runId] = next;
  btn.dataset.expanded = next ? '1' : '0';
  btn.querySelector('.turn-caret').textContent = next ? '▼' : '▶';
  // 用 class 控制 body 可见性,不用 [hidden] —— author 的
  // `.turn-body { display: flex }` 特异性盖过 UA 的 [hidden] {
  // display: none },attribute 视觉无效。CSS 里的
  // `.turn-collapsed .turn-body { display: none }` 才真生效。
  turn?.classList.toggle('turn-expanded', next);
  turn?.classList.toggle('turn-collapsed', !next);

  if (next) {
    // 展开:把 events 容器塞回 loading 占位 + 触发拉取。如果该 runId
    // 已经在跑 poll(理论上不应该,_stopAllTurnEventsPolls 已清),
    // 这里也会被 _loadTurnEvents 内部覆盖掉。
    const events = turn?.querySelector('.turn-events');
    if (events && !events.querySelector('.event')) {
      events.innerHTML = '<div class="muted turn-events-loading">Loading events…</div>';
      events.dataset.renderedLines = '0';
    }
    _loadTurnEvents(runId);
  } else {
    _stopTurnEventsPoll(runId);
  }
}

function _onToolResultExpand(e) {
  const btn = e.currentTarget;
  const wrap = btn.closest('.tool-result-wrap');
  const preview = wrap?.querySelector('.tool-result-preview');
  const full = wrap?.querySelector('.tool-result-full');
  if (!wrap || !preview || !full) return;
  preview.hidden = true;
  full.hidden = false;
  btn.hidden = true;
}

function _onWorkspaceNewEventsClick(e) {
  const ws = e.currentTarget.dataset.ws;
  const stream = $('view').querySelector('.workspace-session-stream[data-ws]');
  if (!stream) return;
  stream.scrollTop = stream.scrollHeight;
  workspaceStreamState[ws] = workspaceAutoScrollState(workspaceStreamState[ws], {
    eventCount: Number(stream.dataset.eventCount || 0),
    atBottom: true,
  });
  _syncWorkspaceNewEventsButton(ws);
}

// Diff-update the timeline inside a mobile single-ws view.
// Inputs: workspace name (must match .ws-timeline[data-ws=...] already
// in DOM) + the same `data` shape workspaceColHtml takes.
// Strategy per row:
//   exists + same status → no DOM write
//   exists + status flipped (running → done etc) → outerHTML swap
//   new (not in DOM)     → insertAdjacentHTML 'beforeend'
//   missing from new set → remove
// Doesn't touch the header / form / approval-pending row — those
// rarely change and a full path is taken on isFreshNav anyway.
function _patchWorkspaceCard(name, data, opts = {}) {
  const view = $('view');
  const timeline = view.querySelector(`.ws-timeline[data-ws="${esc(name)}"]`);
  if (!timeline) return;     // unexpected; let the next poll fall through to full rewrite

  // maxRows must match the value workspaceColHtml used when first
  // rendering this view (otherwise the diff loop's visible-window
  // would mismatch the rows the user actually sees). PC overview
  // uses 10, PC single-ws detail uses 30, mobile detail uses 10.
  const maxRows = opts.maxRows ?? 10;

  const all = [
    ...(data.active || []),
    ...(data.queued || []),
    ...(data.recent || []),
  ];
  all.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
  const visible = all.slice(-maxRows);
  const visibleIds = new Set(visible.map((r) => r.id || ''));

  // Index of existing DOM rows by run id.
  const existingRows = new Map();
  for (const row of timeline.querySelectorAll('a.run-link[data-run-id]')) {
    existingRows.set(row.dataset.runId, row);
  }

  // First-time transition: if timeline was showing the "(no runs yet)"
  // placeholder and we now have rows, clear the placeholder so the
  // diff loop has a clean slate to append into.
  if (visible.length > 0 && existingRows.size === 0) {
    const placeholder = timeline.querySelector('p.muted');
    if (placeholder) placeholder.remove();
  }

  for (const r of visible) {
    const rid = r.id || '';
    const newStatus = r.status || '?';
    const existing = existingRows.get(rid);
    if (existing) {
      // Skip when status hasn't flipped — accept elapsed_s ticking as
      // "not worth a repaint" (the hint inside Live output already
      // conveys liveness, and the row's own elapsed_s is stale-by-1-poll
      // worst case).
      if (existing.dataset.status === newStatus) continue;
      // Status flipped — replace row + its approval block as one unit.
      const replacementHtml = runRowHtml(r) + pendingApprovalsFor(rid).map(approvalBlockHtml).join('');
      const tmp = document.createElement('div');
      tmp.innerHTML = replacementHtml;
      const fresh = [...tmp.children];
      // existing is the <a class="run-link">; the approval blocks
      // (if any) are its NEXT siblings until the next .run-link. Remove
      // them, then insert the new bundle in place.
      let cursor = existing.nextElementSibling;
      while (cursor && cursor.classList.contains('approval-pending')) {
        const next = cursor.nextElementSibling;
        cursor.remove();
        cursor = next;
      }
      // Replace the row itself; insertBefore the new bundle.
      existing.replaceWith(...fresh);
    } else {
      // New row — append at end + its approval blocks.
      timeline.insertAdjacentHTML(
        'beforeend',
        runRowHtml(r) + pendingApprovalsFor(rid).map(approvalBlockHtml).join(''),
      );
    }
  }

  // Drop rows whose run id is no longer in the visible set (e.g.
  // backend rotated them out past the recent-10 window).
  for (const [rid, row] of existingRows) {
    if (visibleIds.has(rid)) continue;
    // Remove row + any approval blocks below it.
    let cursor = row.nextElementSibling;
    while (cursor && cursor.classList.contains('approval-pending')) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
    row.remove();
  }

  // Transition to empty state: if every row got removed (rare —
  // would require recent runs to age out faster than new ones
  // arrive) put the "(no runs yet)" placeholder back.
  if (visible.length === 0 && !timeline.querySelector('p.muted')) {
    timeline.innerHTML = '<p class="muted" style="margin:8px 0">(no runs yet — type a prompt below and hit Run)</p>';
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
  const view = $('view');

  // PC detail 现在用 turn-streaming UI(详见 workspaceColHtml 的 detail
  // 分支),内部容器是 .turn 而不是 .run-row,_patchWorkspaceCard 的
  // diff 算法不再适用。每次主 poll 触发的 render() 全量重画 —— refreshAll
  // 已经做了数据 hash 去重(elapsed_s 被 mask),空跑成本可控。
  // mobile 路径(renderMobileWorkspaceDetail)同样是全量重画,体验一致。
  view.innerHTML = `
    <p><a href="#workspaces" class="back-link">← Workspaces</a></p>
    ${workspaceColHtml(name, data, { maxRows: 30, detail: true, extraClass: 'ws-col-detail' })}
  `;

  bindWorkspaceColHandlers(view);
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

// Track the last status we painted for each run, so we can decide on
// each refreshAll tick whether to do a full repaint or skip entirely.
// Skipping is safe for RUNNING runs because the dynamic panels each
// have their own internal poll:
//   - Live output  → _pollLiveTail (2.5s)
//   - Approvals    → _loadRunApprovals (called from _pollLiveTail)
//   - Transcript   → lazy, only on user expand
// The static parts (Prompt, the run's metadata header) don't change
// while running, so re-rendering them every 3s just causes flicker.
const _lastPaintedStatus = {};

function paintRunDetail(id, row) {
  const status = row.status || '?';
  const view = $('view');
  // Running + already painted with same status → skip the innerHTML
  // rewrite entirely. Internal polls keep Live output / Approvals
  // fresh; the user sees zero flash. Switching status (running →
  // done/failed, or first paint) falls through to the full paint
  // below so Output / cancel-button state get refreshed.
  const alreadyPainted = view.querySelector(`.run-meta[data-run-id="${esc(id)}"]`);
  if (alreadyPainted && status === 'running' && _lastPaintedStatus[id] === 'running') {
    return;
  }
  _lastPaintedStatus[id] = status;

  const startedAt = row.started_at
    ? new Date(row.started_at * 1000).toLocaleString()
    : '';
  // Back link → overview. On PC the overview is the multi-column "see
  // everything at once" surface, which is more useful than dropping back
  // into a single workspace detail. (On mobile this link is hidden by
  // CSS anyway — see .back-link media query.)
  // Cancel button — only when this run is actually running (and we
  // know its id). Placed in a dedicated .run-actions row below the
  // meta line so it has visual weight + a clear hit target on mobile.
  const cancelBtn = status === 'running' && id
    ? `<button class="run-cancel-btn" type="button" data-run-id="${esc(id)}">
         ✕  Cancel this run
       </button>`
    : '';

  // Live output panel — only on running runs. Empty container; the
  // polling loop below fills it. Showing the live stream tail tells the
  // user whether claude is actually working (new jsonl lines appearing
  // every few seconds) or stuck (no activity for 30s+).
  const liveBlock = status === 'running' && id ? `
    <h3>Live output <span class="run-live-hint muted" id="run-live-hint">(loading…)</span></h3>
    <pre class="run-live-tail" id="run-live-tail">(waiting for first chunk)</pre>
  ` : '';

  // Back link target: the workspace this run belongs to (not the
  // generic Workspaces overview). Predictable: tap a run row, then
  // back → exactly where you came from. We don't lean on history.back()
  // because fullscreen-mode PWAs have no browser chrome / back gesture
  // — this in-app button is the only reliable return path.
  // `.run-back-link` overrides the global mobile .back-link hide.
  const backHref = row.workspace
    ? `#workspaces/${encodeURIComponent(row.workspace)}`
    : '#workspaces';
  const backLabel = row.workspace ? esc(row.workspace) : 'Workspaces';
  $('view').innerHTML = `
    <p><a href="${backHref}" class="back-link run-back-link">← ${backLabel}</a></p>
    <h1>Run <code>${esc(id.slice(0, 8))}</code></h1>
    <div class="run-meta" data-run-id="${esc(id)}">
      ${statusTag(status)}
      ${row.workspace ? ` <code>${esc(row.workspace)}</code>` : ''}
      ${row.engine ? ` · ${esc(row.engine)}` : ''}
      ${row.elapsed_s != null ? ` · ${esc(row.elapsed_s)}s` : ''}
      ${row.exit_code != null ? ` · exit ${esc(row.exit_code)}` : ''}
      ${row.source ? ` · ${esc(row.source)}` : ''}
      ${startedAt ? ` · ${esc(startedAt)}` : ''}
    </div>
    ${cancelBtn ? `<div class="run-actions">${cancelBtn}</div>` : ''}
    <h3>Prompt</h3>
    <pre>${esc(row.prompt || '')}</pre>
    <h3>Output</h3>
    <div class="md-output">${row.output ? renderMarkdown(row.output) : '<p class="muted">(empty)</p>'}</div>
    <details class="run-approvals" id="run-approvals">
      <summary>Tool approvals <span class="muted" id="run-approvals-count">(loading…)</span></summary>
      <div class="run-approvals-list" id="run-approvals-list"></div>
    </details>
    <details class="run-transcript" id="run-transcript">
      <summary>Transcript <span class="muted" id="run-transcript-hint">(click to load)</span></summary>
      <pre class="run-transcript-body" id="run-transcript-body">(not loaded)</pre>
    </details>
    ${liveBlock}
  `;
  // Always populate the approvals audit panel — even for terminal runs,
  // since under trust=on the user wants to see what tool calls fired
  // (they were auto-approved without a prompt). For running runs the
  // live poll re-fetches so newly-fired hooks appear during the run.
  _loadRunApprovals(id);
  // Transcript: lazy-loaded on first expand. Loading eagerly would
  // double the network traffic of every run-detail navigation, and 90%
  // of the time the user only wants to see the final Output (which is
  // already painted above). Wire the lazy load here.
  const transcriptEl = $('view').querySelector('#run-transcript');
  if (transcriptEl) {
    transcriptEl.addEventListener('toggle', () => {
      if (transcriptEl.open) {
        _loadRunTranscript(id);
      } else {
        // User collapsed — stop the polling timer to save bandwidth.
        // State is preserved in _transcriptLineCount[id], so re-expand
        // resumes from where we left off (no re-render of past lines).
        _stopTranscriptPoll();
      }
    });
  }
  if (status === 'running' && id) _startLiveTailPoll(id);
  else _stopLiveTailPoll();
}

// Transcript panel: initial load on user expand, then poll-and-append
// while the <details> stays open. Each poll fetches the full tail (up
// to 5000 lines), compares against the count we've already rendered,
// and only appends the NEW suffix — no full rebuild, no flicker.
//
// State per run id:
//   _transcriptLineCount[runId] = how many lines we've already shown
// Plus one global poll timer (only one transcript is open at a time —
// the user is on a single run-detail page).
const _transcriptLineCount = {};
let _transcriptPollTimer = null;
let _transcriptPollRunId = null;

function _stopTranscriptPoll() {
  if (_transcriptPollTimer) { clearInterval(_transcriptPollTimer); _transcriptPollTimer = null; }
  _transcriptPollRunId = null;
}

function _startTranscriptPoll(runId) {
  _stopTranscriptPoll();
  _transcriptPollRunId = runId;
  // 5s feels right — Transcript is "settled history", not realtime tail.
  // Live output already polls every 2.5s for the firehose view.
  _transcriptPollTimer = setInterval(() => _pollRunTranscript(runId), 5000);
}

async function _loadRunTranscript(runId) {
  // Reset state for this run if we haven't seen it before.
  if (!(runId in _transcriptLineCount)) {
    _transcriptLineCount[runId] = 0;
    const body = $('view').querySelector('#run-transcript-body');
    if (body) body.textContent = '';   // clear "(not loaded)" placeholder
  }
  await _pollRunTranscript(runId);
  // After the first load, start the auto-refresh loop. It bails on its
  // own when the <details> is collapsed (see _pollRunTranscript).
  _startTranscriptPoll(runId);
}

async function _pollRunTranscript(runId) {
  // Bail if user collapsed the panel or navigated away.
  const details = $('view').querySelector('#run-transcript');
  if (!details || !details.open || location.hash !== `#runs/${runId}`) {
    _stopTranscriptPoll();
    return;
  }
  const body = $('view').querySelector('#run-transcript-body');
  const hint = $('view').querySelector('#run-transcript-hint');
  if (!body || !hint) return;

  if (_transcriptLineCount[runId] === 0) hint.textContent = '(loading…)';

  let data;
  try {
    data = await api(`/runs/${encodeURIComponent(runId)}/tail?lines=5000`);
  } catch (err) {
    if (_transcriptLineCount[runId] === 0) {
      hint.textContent = `(load failed: ${err.message})`;
    }
    return;
  }
  if (!data.exists) {
    if (_transcriptLineCount[runId] === 0) {
      body.textContent = '(no stream file — run may pre-date the stream-jsonl change, or failed before claude started)';
      hint.textContent = '(empty)';
    }
    return;
  }

  const totalLines = (data.lines || []).length;
  const already = _transcriptLineCount[runId] || 0;
  if (totalLines <= already) {
    // No new lines — only refresh the hint counters.
    hint.textContent = `(${totalLines} events · ${data.size} bytes)`;
    return;
  }

  // Append only the NEW lines. _formatStreamLine drops null (init
  // metadata etc) so we don't render those.
  const newLines = data.lines.slice(already);
  const formatted = newLines
    .map(_formatStreamLine)
    .filter((s) => s !== null)
    .join('\n\n');
  if (formatted) {
    // Append as text node — preserves existing rendered text + the
    // user's scroll position inside the <pre>. Prepend a separator
    // newline if there's already content above.
    const sep = body.textContent && !body.textContent.endsWith('\n\n') ? '\n\n' : '';
    body.appendChild(document.createTextNode(sep + formatted));
  }
  _transcriptLineCount[runId] = totalLines;
  hint.textContent = `(${totalLines} events · ${data.size} bytes)`;
}

// Fetch + render the run's audit trail. Append-style update:
//   - Existing entry, status unchanged → DO NOTHING (no DOM write)
//   - Existing entry, status changed (pending → approved etc) →
//     swap that one row in place
//   - New entry → insertAdjacentHTML('beforeend')
//   - Removed entries → not handled (audit ring buffer is grow-only
//     up to 500 items, and bounded by the run's lifetime)
// Result: incremental UI updates, no flash, no rebuild of unchanged rows.
async function _loadRunApprovals(runId) {
  let entries;
  try {
    entries = await api(`/runs/${encodeURIComponent(runId)}/approvals`);
  } catch (err) {
    // Detail page may have been replaced — bail silently.
    return;
  }
  const list = $('view').querySelector('#run-approvals-list');
  const count = $('view').querySelector('#run-approvals-count');
  if (!list || !count) return;

  const empty = !entries || entries.length === 0;
  if (empty) {
    // Show empty state only if it isn't already there — avoid touching
    // DOM on every poll just to re-set the same placeholder text.
    if (!list.querySelector('p.empty-placeholder')) {
      list.innerHTML = '<p class="muted empty-placeholder">No tool calls intercepted yet.</p>';
    }
    count.textContent = '(0)';
    return;
  }

  // Clear the empty placeholder if present (first entry arriving).
  const placeholder = list.querySelector('p.empty-placeholder');
  if (placeholder) placeholder.remove();

  // Diff loop: for each entry, find by data-approval-id.
  for (const entry of entries) {
    const sel = `[data-approval-id="${entry.approval_id}"]`;
    const existing = list.querySelector(sel);
    if (existing) {
      // Status flip (pending → approved/denied/expired): replace that
      // one row. Everything else stays untouched.
      if (existing.dataset.status !== entry.status) {
        existing.outerHTML = _renderApprovalEntry(entry);
      }
      // No change → leave DOM alone.
    } else {
      // New entry → append at the bottom. Backend returns oldest-first
      // (list_audit_for_run), so chronological order is preserved.
      list.insertAdjacentHTML('beforeend', _renderApprovalEntry(entry));
    }
  }

  count.textContent = `(${entries.length})`;
}

// Render one Approval audit entry into a single line. Status icons:
//   ✓ approved / auto_approved  — green
//   ✗ denied                     — red
//   ⌛ expired                    — amber
//   ⏳ pending                    — amber (still in-flight)
function _renderApprovalEntry(a) {
  const ICON = {
    approved:      ['✓', 'a-ok'],
    auto_approved: ['✓', 'a-auto'],
    denied:        ['✗', 'a-deny'],
    expired:       ['⌛', 'a-warn'],
    pending:       ['⏳', 'a-warn'],
  };
  const [icon, cls] = ICON[a.status] || ['•', 'a-unknown'];
  const ts = a.decided_at || a.created_at;
  const when = ts ? new Date(ts * 1000).toLocaleTimeString() : '';
  const label = a.status === 'auto_approved' ? 'auto-approved' : a.status;
  const summary = _approvalToolSummary(a.tool_name, a.tool_input || {});
  // data-approval-id + data-status: used by _loadRunApprovals to
  // diff-update incrementally (find existing row by id, swap only if
  // status changed). Without these, the diff layer has no way to
  // match incoming entries back to live DOM nodes.
  return `
    <div class="a-row ${cls}"
         data-approval-id="${esc(a.approval_id)}"
         data-status="${esc(a.status)}">
      <span class="a-icon">${icon}</span>
      <span class="a-label">${esc(label)}</span>
      <code class="a-tool">${esc(a.tool_name)}(${esc(summary)})</code>
      <span class="a-time muted">${esc(when)}</span>
    </div>
  `;
}

// Pull the "key" arg out of tool_input so the audit row reads like
// "Bash(npx vitest run)" instead of dumping the whole JSON. Falls back
// to a stringified preview for unknown tools.
function _approvalToolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  // Hand-picked priority: each tool has one or two args that capture
  // intent. Order matters — Bash.description before Bash.command would
  // give a less useful preview.
  const FIELD = {
    Bash: 'command',
    BashOutput: 'bash_id',
    KillShell: 'shell_id',
    Read: 'file_path',
    Edit: 'file_path',
    Write: 'file_path',
    NotebookEdit: 'notebook_path',
    Glob: 'pattern',
    Grep: 'pattern',
    WebFetch: 'url',
    WebSearch: 'query',
    SlashCommand: 'command',
    Task: 'description',
  };
  const key = FIELD[name];
  let v = key && input[key];
  if (v == null) {
    // Unknown tool — pick the first string-ish field.
    const first = Object.values(input).find((x) => typeof x === 'string');
    v = first || '';
  }
  v = String(v);
  // Tool inputs can be paragraph-long (Task descriptions, multi-line
  // bash). Trim aggressively for the audit row — full payload is
  // recoverable from the backend log if needed.
  if (v.length > 80) v = v.slice(0, 77) + '…';
  return v.replace(/\s+/g, ' ');
}

// Live output polling — runs only on the detail page of a 'running' run.
// Cancelled when navigating away or when the run flips to terminal.
let _liveTailTimer = null;
let _liveTailRunId = null;
// Cache the last-rendered Live-output text so the 2.5s poll skips
// DOM writes when content is identical. _loadRunApprovals doesn't
// need an equivalent — its diff-loop already does per-row identity
// matching via data-approval-id, no string compare needed.
let _lastTailRender = '';

function _stopLiveTailPoll() {
  if (_liveTailTimer) { clearInterval(_liveTailTimer); _liveTailTimer = null; }
  // Also clear the painted-status cache for the run we were watching —
  // if the user comes back to the same id, we want the first paint to
  // happen unconditionally.
  if (_liveTailRunId) delete _lastPaintedStatus[_liveTailRunId];
  _liveTailRunId = null;
  _lastTailRender = '';
}

function _startLiveTailPoll(runId) {
  _stopLiveTailPoll();
  _liveTailRunId = runId;
  // Kick once immediately so the panel populates before the first tick.
  _pollLiveTail(runId);
  _liveTailTimer = setInterval(() => _pollLiveTail(runId), 2500);
}

async function _pollLiveTail(runId) {
  // Bail if user navigated away — the polling timer outlives the page
  // unless we explicitly stop it elsewhere.
  if (location.hash !== `#runs/${runId}` || _liveTailRunId !== runId) {
    _stopLiveTailPoll();
    return;
  }
  let data;
  try {
    data = await api(`/runs/${encodeURIComponent(runId)}/tail?lines=40`);
  } catch (err) {
    // Stop on permanent failures (404 = run unknown, e.g. deleted)
    if (String(err.message).includes('404')) _stopLiveTailPoll();
    return;
  }
  const tail = $('view').querySelector('#run-live-tail');
  const hint = $('view').querySelector('#run-live-hint');
  if (!tail || !hint) return;
  if (!data.exists || !data.lines || data.lines.length === 0) {
    tail.textContent = '(no stream yet — claude may be initializing)';
    hint.textContent = '(no data)';
    return;
  }
  // Format each stream-json line into something readable. Raw dump (which
  // the previous code did) buries the actual narrative in 70+KB of
  // init metadata (tools list, MCP inventory, slash command names, ...).
  // The user wants to see "what's claude doing right now", not the
  // session preamble.
  const rendered = data.lines
    .map(_formatStreamLine)
    .filter((s) => s !== null)
    .join('\n\n');
  const final = rendered || '(stream has only init metadata so far — claude warming up)';
  // Skip the DOM write if the content is byte-identical to last tick —
  // otherwise the textContent assignment forces a repaint and the panel
  // visibly flickers every 2.5s even on an idle stream.
  if (final !== _lastTailRender) {
    // Auto-scroll to bottom IFF the user was already near the bottom
    // before the update — that way new chunks "follow" the user when
    // they're watching live, but won't yank them down if they've
    // scrolled up to read earlier output. 80px tolerance covers half-
    // line cases on long-running tasks. Page-level scroll because
    // we removed the .run-live-tail inner scrollbar (moved to bottom).
    const wasNearBottom =
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 80;
    tail.textContent = final;
    _lastTailRender = final;
    if (wasNearBottom) {
      // No smooth scrolling — instant snap-to-bottom feels less
      // distracting on rapidly-updating streams (each smooth scroll
      // would queue an animation that overlaps the next poll).
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
  }
  // "Xs ago" with color hint: <5s green, <30s normal, >30s warning.
  const since = Math.round(data.seconds_since_update || 0);
  let color = 'var(--text-tertiary)';
  if (since < 5) color = 'var(--accent-green)';
  else if (since > 30) color = 'var(--accent-amber)';
  hint.style.color = color;
  hint.textContent = `· last update ${since}s ago · ${data.size} bytes`;
  // Audit trail refresh — new tool-calls fire continuously during a
  // running run. Cheap (in-memory ring buffer, returns ≤100 entries).
  _loadRunApprovals(runId);
}

// Turn one raw stream-json line into a human-readable string. Returns
// null for lines that aren't worth showing (system init metadata, etc.)
// so the caller can filter them out.
//
// claude stream-json event types we see:
//   system / init           — tools/mcp/slash-command inventory, drop
//   assistant               — claude's reply: either text or tool call
//   user                    — wrapper around tool execution result
//   result                  — terminal summary (success/error + usage)
function _formatStreamLine(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return raw.slice(0, 200); }
  const t = obj.type;

  if (t === 'system') return null;    // drop init / preflight noise

  if (t === 'assistant') {
    const content = obj.message?.content || [];
    const parts = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        parts.push(`🤖  ${c.text}`);
      } else if (c.type === 'tool_use') {
        // Compact tool-input preview — full payload would dwarf the panel
        // (e.g. file contents inside Write). 120 chars is enough to see
        // "what tool was called with what intent".
        let inputPreview = '';
        try {
          inputPreview = JSON.stringify(c.input || {});
        } catch { inputPreview = '<unserializable>'; }
        if (inputPreview.length > 140) inputPreview = inputPreview.slice(0, 140) + '…';
        parts.push(`🔧  ${c.name}(${inputPreview})`);
      } else if (c.type === 'thinking' && c.thinking) {
        // Extended thinking — usually verbose but interesting. Trim
        // hard so it doesn't dominate the panel.
        const trimmed = c.thinking.length > 200
          ? c.thinking.slice(0, 200) + '…'
          : c.thinking;
        parts.push(`💭  ${trimmed}`);
      }
    }
    return parts.length ? parts.join('\n') : null;
  }

  if (t === 'user') {
    const content = obj.message?.content || [];
    for (const c of content) {
      if (c.type === 'tool_result') {
        let body = c.content;
        if (Array.isArray(body)) {
          // tool_result.content can be an array of {type:'text', text:'...'} chunks
          body = body
            .map((x) => (typeof x === 'string' ? x : (x?.text || JSON.stringify(x))))
            .join('\n');
        } else if (typeof body !== 'string') {
          body = JSON.stringify(body);
        }
        const trimmed = body.length > 300 ? body.slice(0, 300) + '…' : body;
        return `↳  ${trimmed}`;
      }
    }
    return null;
  }

  if (t === 'result') {
    const subtype = obj.subtype || '?';
    const usage = obj.usage || {};
    const tokenSummary = `${usage.input_tokens || 0} in · ${usage.output_tokens || 0} out`;
    const resultText = obj.result || '';
    return `✓  done (${subtype}, ${tokenSummary})\n${resultText}`;
  }

  // Unknown event type — drop rather than dump JSON. If something useful
  // is ever missed here, the raw stream is still on disk at
  // ~/.cc-state/logs/run-<id>.stream.jsonl for full-fidelity debugging.
  return null;
}

// ---------- Tasks view ----------
// Per-loop HTML cache so the patch path in renderTasksView can detect
// "this row didn't change" and skip the DOM write.
const _loopRowCache = new Map();

function renderTasksView() {
  const loops = lastData.loops || [];
  const workspaces = lastData.workspaces || [];
  const view = $('view');
  const existingList = view.querySelector('.task-list');

  // Patch path: .task-list already rendered → diff loops by name.
  if (existingList && loops.length > 0) {
    const existing = new Map();
    for (const row of existingList.querySelectorAll('.loop-row[data-loop-name]')) {
      existing.set(row.dataset.loopName, row);
    }
    const wantedSet = new Set(loops.map((l) => l.name));
    // Remove rows for loops that got deleted.
    for (const [n, row] of existing) {
      if (!wantedSet.has(n)) {
        row.remove();
        _loopRowCache.delete(n);
      }
    }
    // For each loop: build new HTML, compare to cached, swap if different.
    // Same shape as renderMobileOverview's per-card diff.
    for (const loop of loops) {
      const name = loop.name;
      const newHtml = loopRowHtml(loop);
      const cached = _loopRowCache.get(name);
      const existingRow = existing.get(name);
      if (existingRow) {
        if (cached === newHtml) continue;
        const tmp = document.createElement('div');
        tmp.innerHTML = newHtml.trim();
        const fresh = tmp.firstElementChild;
        existingRow.replaceWith(fresh);
        _loopRowCache.set(name, newHtml);
        // Re-bind handlers on the freshly-swapped row.
        for (const b of fresh.querySelectorAll('.run-now-btn, .pause-btn, .resume-btn, .delete-btn')) {
          b.addEventListener('click', onLoopAction);
        }
      } else {
        existingList.insertAdjacentHTML('beforeend', newHtml);
        _loopRowCache.set(name, newHtml);
        // Bind the new row's handlers.
        const fresh = existingList.querySelector(`.loop-row[data-loop-name="${esc(name)}"]`);
        if (fresh) {
          for (const b of fresh.querySelectorAll('.run-now-btn, .pause-btn, .resume-btn, .delete-btn')) {
            b.addEventListener('click', onLoopAction);
          }
        }
      }
    }
    return;
  }

  // Full rewrite path (initial render OR transition from empty to populated).
  const rows = loops.length
    ? loops.map((loop) => {
        const html = loopRowHtml(loop);
        _loopRowCache.set(loop.name, html);
        return html;
      }).join('')
    : '<p class="muted">No cron loops yet. Use the form above.</p>';
  view.innerHTML = `
    <h1>Tasks (cron)</h1>
    <details class="add-form" data-details-id="add-loop">
      <summary>New cron loop</summary>
      <form data-form-id="new-loop">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="daily-digest" required></label>
        <label>workspace
          ${_renderFormPicker({
            name: 'workspace',
            options: workspaces.map((w) => ({ value: w, label: w })),
            value: workspaces[0] || '',
          })}
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
        <button type="submit">Add</button>
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
  for (const b of $('view').querySelectorAll('.run-now-btn, .pause-btn, .resume-btn, .delete-btn')) {
    b.addEventListener('click', onLoopAction);
  }
}

// Render the cron job's "recent runs" foldout. Hidden when there's
// 0 or 1 entries (nothing useful to fold). Default collapsed — the
// most-recent run is already linked from the stats row's "→ open".
// Expanding shows ALL recent runs (newest first, latest tagged) so
// the user can pick the right one when several have fired since
// they last looked.
//
// Uses data-details-id so polling re-renders preserve the open
// state (snapshotDrafts/restoreDrafts pair, see "details state
// preservation" elsewhere in this file).
function loopHistoryHtml(loop) {
  const runs = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
  if (runs.length <= 1) return '';
  const detailsId = `loop-hist-${loop.name}`;
  const items = runs.map((r, i) => {
    const status = r.status || (r.finished_at != null
      ? (r.exit_code === 0 ? 'done' : 'failed')
      : 'running');
    const shortId = (r.id || '').slice(0, 8);
    const when = r.finished_at || r.started_at;
    const rel = when ? timeAgo(when) : '';
    const abs = when ? new Date(when * 1000).toLocaleString() : '';
    const exitBadge = r.exit_code != null && r.exit_code !== 0
      ? ` · exit ${esc(r.exit_code)}`
      : '';
    const latestTag = i === 0 ? ' <span class="muted">[latest]</span>' : '';
    return `
      <a class="loop-hist-row" href="#runs/${encodeURIComponent(r.id || '')}">
        ${statusTag(status)}
        <code>${esc(shortId)}</code>${latestTag}
        ${rel ? `· <span title="${esc(abs)}">${esc(rel)}</span>` : ''}
        ${exitBadge}
      </a>
    `;
  }).join('');
  return `
    <details class="loop-history" data-details-id="${esc(detailsId)}">
      <summary>history (${runs.length} runs)</summary>
      <div class="loop-hist-list">${items}</div>
    </details>
  `;
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
  const recentRuns = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
  const latestRun = recentRuns[0] || null;
  const latestRunning = latestRun && (latestRun.status === 'queued' || latestRun.status === 'running');
  const loopStatus = !enabled ? 'paused'
    : latestRunning ? 'running'
    : stale || (loop.last_exit != null && loop.last_exit !== 0) ? 'failed'
    : 'done';

  // Show a human-readable version of the cron expression when possible;
  // keep the raw form available on hover (and for power users / debugging).
  const humanSched = schedule ? humanizeCron(schedule) : '—';
  const nextLabel = enabled ? nextRunLabel(schedule) : '';
  const schedTitle = schedule && humanSched !== schedule ? ` title="${esc(schedule)}"` : '';
  const stateHtml = loopStatus === 'running'
    ? `<div class="task-state task-state-running">running<br><span>${esc(latestRun?.started_at ? timeAgo(latestRun.started_at) : 'queued')}</span></div>`
    : loopStatus === 'failed'
      ? `<div class="task-state task-state-failed">failed×${esc(loop.consecutive_errors || 1)}<br><span>retry</span></div>`
      : loopStatus === 'paused'
        ? `<div class="task-state">paused</div>`
        : `<div class="task-state">done<br><span>${esc(lastRel)}</span></div>`;

  return `
    <div class="row loop-row ${loopStatus}" data-loop-name="${esc(loop.name)}">
      <div class="loop-head">
        <span class="task-dot ${esc(loopStatus)}"></span>
        <code class="loop-name">${esc(loop.name)}</code>
        ${enabledTag}
        ${stale ? `<span class="tag tag-failed">${ICONS.warning}stale ${esc(loop.consecutive_errors)}</span>` : ''}
        <span class="loop-actions">
          <button class="primary run-now-btn" data-name="${esc(loop.name)}" title="Fire one run now (out of band; doesn't change the schedule)">Run now</button>
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
        ${nextLabel ? ` · <span class="task-next">${esc(nextLabel)}</span>` : ''}
      </div>
      ${stateHtml}
      ${prompt ? `<div class="loop-prompt">▸ ${esc(prompt)}</div>` : ''}
      <div class="loop-stats">
        <span title="${esc(lastAbs)}">last ${esc(lastRel)}</span>
        · runs ${esc(loop.total_runs || 0)}
        · exit ${esc(last_exit)}
        ${loop.last_run_id
          ? ` · <a href="#runs/${encodeURIComponent(loop.last_run_id)}" class="loop-run-link" title="Open last run-detail (full output + transcript + tool approvals)">→ open</a>`
          : ''}
      </div>
      ${latestRunning
        ? `<div class="loop-last-output" title="A fresh run is in progress; open it for live output">↳ 当前 run ${esc(latestRun.status)} · 打开详情看实时输出</div>`
        : loop.last_output_summary
        ? `<div class="loop-last-output" title="Last output preview (truncated; full output on the run-detail page)">↳ ${esc(loop.last_output_summary)}</div>`
        : ''}
      ${loopHistoryHtml(loop)}
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
  let endpoint, method, kind;
  if (btn.classList.contains('run-now-btn')) {
    endpoint = `/loops/${encodeURIComponent(name)}/run`; method = 'POST'; kind = 'run';
  } else if (btn.classList.contains('pause-btn')) {
    endpoint = `/loops/${encodeURIComponent(name)}/pause`; method = 'POST'; kind = 'pause';
  } else if (btn.classList.contains('resume-btn')) {
    endpoint = `/loops/${encodeURIComponent(name)}/resume`; method = 'POST'; kind = 'resume';
  } else if (btn.classList.contains('delete-btn')) {
    if (!confirm(`Delete cron loop "${name}"?\nRemoves /etc/cron.d/cc-loops entry + jobs/${name}.json.`)) return;
    endpoint = `/loops/${encodeURIComponent(name)}`; method = 'DELETE'; kind = 'delete';
  } else return;
  btn.disabled = true;
  try {
    const resp = await api(endpoint, { method });
    if (kind === 'run') {
      showToast('success', `${name}: run queued`, { ttl: 2000 });
      if (resp?.task_id) {
        location.hash = `#runs/${encodeURIComponent(resp.task_id)}`;
      }
    }
    refreshAll();
  } catch (err) {
    showError(`${method} ${name} failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ============================================================================
// Roundtable (third tab — multi-agent debate)
// ============================================================================
// Backend has /roundtables (list) + /roundtables/{id} (detail) + DELETE.
// 9 sequential LLM calls per session takes 45-135s, so detail view polls
// while status != 'done' / 'error'. List rows live in lastData.roundtables
// (refreshed on every refreshAll cycle).

const roundtableDetailCache = {};     // id → full detail row (cached when done/error)

// Model registry cache. Backend GET /roundtables/models returns the static
// MODEL_ENDPOINTS table + the role defaults from roles.py. Both change only
// on backend deploy, so we cache for the lifetime of the page load — no
// invalidation logic needed.
let _rtModelsCache = null;

// Per-role model overrides remembered across sessions. Stored as a flat
// {role_name → model_name} dict, ONLY containing roles where the user
// picked something other than the default (so flipping back to default =
// remove the key, not write "default" as a value). New users get {}.
function _loadRtRoleModels() {
  try { return JSON.parse(localStorage.getItem('cc_rt_role_models') || '{}') || {}; }
  catch { return {}; }
}
function _saveRtRoleModels(m) {
  try { localStorage.setItem('cc_rt_role_models', JSON.stringify(m)); } catch {}
}

async function ensureRoundtableModels() {
  if (_rtModelsCache) return _rtModelsCache;
  try {
    _rtModelsCache = await api('/roundtables/models');
    return _rtModelsCache;
  } catch {
    return null;    // older backend / fetch failure — UI degrades gracefully
  }
}

// Render the 5 role rows inside the <details> model-config block. Reads
// from _rtModelsCache + localStorage. Called twice in the lifecycle: once
// optimistically if cache is hot, once after async fetch otherwise. Both
// paths bind the click handler — idempotent.
//
// Visual design: shared with the workspace ⋯ menu's provider picker —
// reuses .ws-menu-radio / .ws-radio-dot / .ws-radio-label classes verbatim
// so dark-theme consistency is structural, not a per-feature CSS pass.
// Each role is wrapped in its own <details> so we don't dump 25 radios
// (5 roles × 5 models) into the form at once — collapsed-by-default, the
// summary row shows the current pick, click to expand for the radio list.
function _populateRtModelConfig() {
  const slot = document.getElementById('rt-model-config-slot');
  if (!slot) return;
  if (!_rtModelsCache) {
    slot.innerHTML = '<p class="muted" style="font-size:11px;margin:0">(模型列表加载失败)</p>';
    return;
  }
  const { models, roles } = _rtModelsCache;
  const saved = _loadRtRoleModels();
  slot.innerHTML = roles.map((r) => _renderRoleModelPicker(r, models, saved)).join('') + `
    <button type="button" class="rt-model-reset-all">↩ 全部恢复默认</button>
  `;
  for (const btn of slot.querySelectorAll('.rt-role-radio')) {
    btn.addEventListener('click', _onRtModelRadioClick);
  }
  slot.querySelector('.rt-model-reset-all')?.addEventListener('click', _onRtModelResetAll);
}

function _renderRoleModelPicker(role, models, savedOverrides) {
  const current = savedOverrides[role.name] || role.default_model;
  const currentEndpoint = (models.find((m) => m.name === current) || {}).endpoint || '';
  const kindHint = role.kind === 'synthesizer'
    ? '<span class="muted rt-role-kind">(整理员)</span>'
    : '';
  const isOverride = current !== role.default_model;
  const radios = models.map((m) => {
    const selected = m.name === current;
    const rowClass = selected ? 'ws-menu-radio rt-role-radio is-selected' : 'ws-menu-radio rt-role-radio';
    const dotClass = selected ? 'ws-radio-dot is-selected' : 'ws-radio-dot';
    return `
      <button type="button" class="${rowClass}"
              data-role="${esc(role.name)}"
              data-value="${esc(m.name)}"
              data-default="${esc(role.default_model)}">
        <span class="${dotClass}"></span>
        <span class="ws-radio-label">${esc(m.name)}  ·  ${esc(m.endpoint)}</span>
      </button>
    `;
  }).join('');
  return `
    <details class="rt-role-picker">
      <summary class="rt-role-summary">
        <span class="rt-role-name">${esc(role.name)} ${kindHint}</span>
        <span class="rt-role-current ${isOverride ? 'is-override' : ''}">
          ${esc(current)} · ${esc(currentEndpoint)}
        </span>
      </summary>
      <div class="rt-role-radio-list">${radios}</div>
    </details>
  `;
}

function _onRtModelRadioClick(e) {
  const btn = e.currentTarget;
  const role = btn.dataset.role;
  const val = btn.dataset.value;
  const dflt = btn.dataset.default;
  const saved = _loadRtRoleModels();
  if (val === dflt) delete saved[role];   // back to default = remove override
  else saved[role] = val;
  _saveRtRoleModels(saved);
  // Full re-render so:
  //   - the picked role's <details> snaps back to collapsed (the new DOM
  //     defaults to closed) and shows the new pick in the summary row
  //   - the selected dot is repainted on the right radio
  _populateRtModelConfig();
}

function _onRtModelResetAll() {
  _saveRtRoleModels({});
  _populateRtModelConfig();
  showToast('info', '已恢复全部默认', { ttl: 1200 });
}

// Per-row HTML cache so renderRoundtablesView's patch path can diff
// roundtable entries by id and skip unchanged ones (same shape as
// _loopRowCache / _mobileCardCache).
const _rtRowCache = new Map();

function renderRoundtablesView() {
  const rows = lastData.roundtables || [];
  const view = $('view');
  const existingList = view.querySelector('.rt-list');

  // Patch path: rt-list already in DOM AND we still have rows → diff.
  if (existingList && rows.length > 0) {
    const existing = new Map();
    for (const row of existingList.querySelectorAll('.rt-row[data-rt-id]')) {
      existing.set(row.dataset.rtId, row);
    }
    const wantedSet = new Set(rows.map((r) => r.id));
    // Remove rows for sessions that got deleted.
    for (const [id, row] of existing) {
      if (!wantedSet.has(id)) {
        row.remove();
        _rtRowCache.delete(id);
      }
    }
    // Diff each wanted row.
    for (const r of rows) {
      const newHtml = _roundtableListRow(r);
      const cached = _rtRowCache.get(r.id);
      const existingRow = existing.get(r.id);
      if (existingRow) {
        if (cached === newHtml) continue;
        const tmp = document.createElement('div');
        tmp.innerHTML = newHtml.trim();
        const fresh = tmp.firstElementChild;
        existingRow.replaceWith(fresh);
        _rtRowCache.set(r.id, newHtml);
        fresh.querySelector('.rt-delete')?.addEventListener('click', onDeleteRoundtable);
      } else {
        // New session appeared (created via PWA form or Feishu /rt)
        existingList.insertAdjacentHTML('beforeend', newHtml);
        _rtRowCache.set(r.id, newHtml);
        const fresh = existingList.querySelector(`.rt-row[data-rt-id="${esc(r.id)}"]`);
        fresh?.querySelector('.rt-delete')?.addEventListener('click', onDeleteRoundtable);
      }
    }
    return;
  }

  // Full rewrite path.
  const list = rows.length
    ? rows.map((r) => {
        const html = _roundtableListRow(r);
        _rtRowCache.set(r.id, html);
        return html;
      }).join('')
    : '<p class="muted">还没有圆桌会议。先写一个问题,4 个角色 + 1 个整理员会替你辩论 3 轮。</p>';
  // Form is open by default ONLY when the list is empty — otherwise the
  // existing sessions are what the user wants to see first. They can
  // click the summary to expand the form when starting a new one.
  const formOpen = rows.length === 0 ? 'open' : '';
  // The blurb is informational; on mobile it takes a lot of vertical
  // space above the list — hide it once the user has at least one
  // session (they already know what the tab does by then).
  const blurb = rows.length === 0 ? `
    <p class="muted" style="margin-top:-8px">
      4 个固定角色(<strong>极简派 / 场景派 / 借鉴派 / 悲观派</strong>)对一个决策问题各抒己见,
      <strong>整理员</strong>把分歧整理成 <em>共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动</em>。
      不替你拍板,但给出条件化决策路径。
    </p>` : '';
  view.innerHTML = `
    <h1>Roundtable</h1>
    ${blurb}
    <details class="add-form" data-details-id="add-roundtable" ${formOpen}>
      <summary>新开一场</summary>
      <form data-form-id="new-roundtable">
        <label>问题(决策级,不是事实问题)
          <textarea name="question" required rows="3"
            placeholder="例:个人 side project 一开始就上严格 TDD,还是先 spike?"></textarea>
        </label>
        <div class="rt-rounds-row">
          <label class="rt-rounds-label">辩论轮数</label>
          ${_renderFormPicker({
            name: 'critique_rounds',
            options: [
              { value: '1', label: '1 轮(默认 · 9 调用 · ~90s)' },
              { value: '2', label: '2 轮(深挖 · 13 调用 · ~2min)' },
            ],
            value: '1',
          })}
        </div>
        <details class="rt-model-config" data-details-id="rt-model-config">
          <summary>🎛 模型配置(默认即可)</summary>
          <div class="rt-model-config-body" id="rt-model-config-slot">
            <p class="muted" style="font-size:11px;margin:0">(加载模型列表中…)</p>
          </div>
        </details>
        <p class="muted" style="font-size:11px;margin:0">
          结果落在 <code>~/.cc-state/roundtables/</code>;完成后 R3 推送回原聊天(飞书发起时)。
        </p>
        <button type="submit">开始辩论</button>
      </form>
    </details>
    <div class="rt-list">${list}</div>
  `;
  $('view').querySelector('form[data-form-id="new-roundtable"]')
    ?.addEventListener('submit', onCreateRoundtable);
  for (const b of $('view').querySelectorAll('.rt-delete')) {
    b.addEventListener('click', onDeleteRoundtable);
  }
  // Populate the model config block. Cache-hot path is synchronous; cold
  // path fetches once, then patches the slot only (textarea / open state
  // stay intact thanks to the existing snapshot/restore + draft system).
  if (_rtModelsCache) {
    _populateRtModelConfig();
  } else {
    ensureRoundtableModels().then(_populateRtModelConfig);
  }
}

function _roundtableListRow(r) {
  const status = r.status || 'queued';
  const when = r.started_at
    ? new Date(r.started_at * 1000).toLocaleString()
    : '';
  // turns_expected: 9 for critique_rounds=1, 13 for critique_rounds=2.
  // Old sessions without the field in their meta fall back to 9 via backend.
  const expected = r.turns_expected || 9;
  const progress = status === 'done'
    ? '✓ 完成'
    : status === 'error'
      ? '✗ 出错'
      : `${r.turns_done || 0} / ${expected} 轮`;
  const rowClass = status === 'error'
    ? 'rt-row failed'
    : status === 'done'
      ? 'rt-row'
      : 'rt-row active';
  const statusText = status === 'done'
    ? '✓ 完成'
    : status === 'error'
      ? '◯ 失败'
      : `● round ${esc(r.turns_done || 0)}/${esc(expected)}`;
  return `
    <div class="${rowClass}" data-rt-id="${esc(r.id)}">
      <a class="rt-row-link" href="#roundtables/${encodeURIComponent(r.id)}">
        <div class="rt-row-q">${esc(r.question || '(无标题)')}</div>
        <div class="rt-row-meta">
          <span class="rt-status ${status === 'error' ? 'failed' : status === 'done' ? 'done' : 'active'}">${statusText}</span>
          ${status !== 'error' ? roundtablePersonaAvatarsHtml(esc) : ''}
          <span class="muted">· ${esc(progress)}</span>
          ${when ? `<span class="muted">· ${esc(when)}</span>` : ''}
        </div>
      </a>
      <button class="danger rt-delete" type="button" data-id="${esc(r.id)}"
              title="删除这场会议">×</button>
    </div>
  `;
}

async function onCreateRoundtable(e) {
  e.preventDefault();
  const form = e.target;
  const fd = Object.fromEntries(new FormData(form).entries());

  // Per-role model overrides live in localStorage (only non-default values
  // are stored — flipping back to default deletes the key). So _loadRtRoleModels
  // is already the wire shape: an object with ONLY the roles whose pick
  // differs from roles.py's preferred_model. Backend treats absent roles
  // as "use default", so the default path produces the same payload as
  // the pre-feature traffic.
  const overrides = _loadRtRoleModels();

  // Critique rounds: only send when non-default (= 2). Backend defaults
  // to 1 if the field is absent, keeping the wire payload minimal and
  // pre-feature traffic byte-identical.
  const rounds = parseInt(fd.critique_rounds || '1', 10);

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = '开始中…';
  try {
    const body = { question: fd.question };
    if (Object.keys(overrides).length > 0) body.role_models = overrides;
    if (rounds === 2) body.critique_rounds = 2;
    const r = await api('/roundtables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    form.reset();
    showToast('success', `圆桌已开:${r.id}`, { ttl: 2000 });
    // Jump into detail view so user sees turns appear live.
    location.hash = `#roundtables/${encodeURIComponent(r.id)}`;
  } catch (err) {
    showError(`创建失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '开始辩论';
  }
}

async function onDeleteRoundtable(e) {
  const btn = e.currentTarget;
  const id = btn.dataset.id;
  if (!id) return;
  if (!confirm(`删除圆桌 "${id}"?\n.jsonl 文件会被删,无法恢复。`)) return;
  btn.disabled = true;
  try {
    await api(`/roundtables/${encodeURIComponent(id)}`, { method: 'DELETE' });
    delete roundtableDetailCache[id];
    refreshAll();
  } catch (err) {
    showError(`删除失败: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// Detail view — async like renderRunDetailView. Cache terminal-state
// rows so the 3s polling cycle doesn't re-fetch them indefinitely.
async function renderRoundtableDetailView(id, opts = {}) {
  const cached = roundtableDetailCache[id];
  if (cached && (cached.status === 'done' || cached.status === 'error')) {
    if (!$('view').querySelector('.rt-detail')) paintRoundtableDetail(id, cached);
    return;
  }
  let row;
  try {
    row = await api(`/roundtables/${encodeURIComponent(id)}`);
  } catch (err) {
    $('view').innerHTML = `
      <p><a href="#roundtables" class="back-link">← Roundtable</a></p>
      <h1>Roundtable <code>${esc(id)}</code></h1>
      <p class="muted">加载失败: ${esc(err.message)}</p>
    `;
    return;
  }
  if (row.status === 'done' || row.status === 'error') {
    roundtableDetailCache[id] = row;
  }
  // User may have navigated away while we awaited.
  const route = parseRoute();
  if (route.name !== 'roundtable-detail' || route.id !== id) return;
  paintRoundtableDetail(id, row);
}

const _ROLE_ORDER = ['极简派', '场景派', '借鉴派', '悲观派'];

// Round labels — kept in sync with synth.py's _ROUND_LABELS by convention.
// Adding a 4th critique round here is purely cosmetic; the orchestration
// caps at 2 today.
const _RT_ROUND_LABELS = {
  1: 'Round 1 — 初次回答',
  2: 'Round 2 — Steel-man + Attack',
  3: 'Round 3 — 深挖 / 收回 / 回应',
};

// Sigskip for paintRoundtableDetail — same idea as _lastPaintedStatus
// for paintRunDetail. Signature combines status + turn count + r3
// presence, which captures every change worth re-rendering for. Pure
// timer ticks don't show up (we don't include `elapsed` anywhere in the
// roundtable detail view), so the most common no-op poll (running run,
// no new turn yet) skips entirely.
const _lastRtPainted = {};

function paintRoundtableDetail(id, row) {
  const status = row.status || 'queued';
  const turnsDone = row.turns?.length || 0;
  const hasR3 = !!row.r3;
  const errorKey = row.error || '';
  const sig = `${status}:${turnsDone}:${hasR3 ? '1' : '0'}:${errorKey}`;

  const view = $('view');
  const alreadyPainted = view.querySelector(`.rt-detail[data-rt-id="${esc(id)}"]`);
  if (alreadyPainted && _lastRtPainted[id] === sig) {
    return;
  }
  _lastRtPainted[id] = sig;

  // Group every non-synth turn by round. We don't hardcode {1,2} anymore —
  // critique_rounds=2 sessions have R3 critique turns (round=3, type=critique)
  // that need their own grid block.
  const critiqueRounds = row.critique_rounds || 1;
  const turnsByRound = {};
  for (let r = 1; r <= critiqueRounds + 1; r++) turnsByRound[r] = {};
  for (const t of row.turns || []) {
    if (t.type === 'synth') continue;    // synth is handled by row.r3 below
    if (turnsByRound[t.round]) {
      turnsByRound[t.round][t.role] = t.content;
    }
  }

  const r3 = row.r3;
  const when = row.started_at
    ? new Date(row.started_at * 1000).toLocaleString()
    : '';
  const expected = row.turns_expected || 9;

  const errorBlock = row.error
    ? `<div class="rt-error">⚠ ${esc(row.error)}</div>`
    : '';

  // 整理员 综合 first (the decision-grade output); critique rounds below.
  const synthBlock = r3 ? `
    <section class="rt-r3">
      <h2>整理员综合</h2>
      ${_rtSection('共识点', r3.parsed['共识点'])}
      ${_rtSection('分歧轴', r3.parsed['分歧轴'])}
      ${_rtSection('关键判断', r3.parsed['关键判断'], { yesno: true })}
      ${_rtSection('条件性结论', r3.parsed['条件性结论'])}
      ${_rtSection('下一步行动', r3.parsed['下一步行动'])}
      <details class="rt-r3-raw">
        <summary>原始 markdown</summary>
        <pre>${esc(r3.raw)}</pre>
      </details>
    </section>
  ` : (status === 'error' ? '' : `
    <section class="rt-r3 rt-r3-pending">
      <h2>整理员综合</h2>
      <p class="muted">共 ${esc(expected)} 轮跑完后,整理员会给你 <strong>共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动</strong>。当前 ${esc(turnsDone)} / ${esc(expected)} 轮。</p>
    </section>
  `);

  // Render one block per round that has any content (so partial sessions
  // show what's done so far). Loops R1 → R(critiqueRounds+1).
  const roundBlocks = [];
  for (let r = 1; r <= critiqueRounds + 1; r++) {
    const cells = _ROLE_ORDER.map((name) => _rtCell(name, turnsByRound[r][name])).join('');
    const label = _RT_ROUND_LABELS[r] || `Round ${r}`;
    roundBlocks.push(_rtRoundBlock(label, cells));
  }

  $('view').innerHTML = `
    <p><a href="#roundtables" class="back-link">← Roundtable</a></p>
    <h1 class="rt-question">${esc(row.question || '(无题)')}</h1>
    <div class="rt-meta">
      ${statusTag(status === 'done' ? 'done' : status === 'error' ? 'failed' : 'running')}
      ${when ? `<span class="muted">· ${esc(when)}</span>` : ''}
      <span class="muted">· ${esc(turnsDone)} / ${esc(expected)} 轮</span>
    </div>
    ${errorBlock}
    <div class="rt-detail" data-rt-id="${esc(id)}">
      ${synthBlock}
      ${roundBlocks.join('')}
    </div>
  `;
}

// R1/R2 sections — R3 is the product value (consensus / disagreement
// axes / judgment questions), R1/R2 are 4 long cells each that justify
// the synthesis. On a phone, 8 stacked cells is a wall of scroll; on a
// PC the 4-col grid fits beside R3 and there's no scroll cost.
// → mobile: collapsed by default, summary tappable to expand
// → PC: always open (no <details> wrapper, just plain section)
function _rtRoundBlock(title, cellsHtml) {
  if (_isMobileViewport) {
    return `
      <details class="rt-round rt-round-collapsible">
        <summary><h3>${esc(title)}</h3></summary>
        <div class="rt-grid">${cellsHtml}</div>
      </details>
    `;
  }
  return `
    <section class="rt-round">
      <h3>${esc(title)}</h3>
      <div class="rt-grid">${cellsHtml}</div>
    </section>
  `;
}

function _rtCell(role, content) {
  if (!content) {
    return `
      <div class="rt-cell rt-cell-${_roleSlug(role)} rt-cell-empty">
        <h4>${esc(role)}</h4>
        <p class="muted">…等待中</p>
      </div>
    `;
  }
  return `
    <div class="rt-cell rt-cell-${_roleSlug(role)}">
      <h4>${esc(role)}</h4>
      <div class="rt-content">${_renderInlineMd(content)}</div>
    </div>
  `;
}

function _rtSection(title, bullets, opts = {}) {
  if (!bullets || bullets.length === 0) {
    return `<div class="rt-r3-section"><h3>${esc(title)}</h3><p class="muted">(整理员没列任何条目)</p></div>`;
  }
  const items = bullets.map((b) => {
    if (opts.yesno) {
      return `<li class="rt-yesno"><label><input type="checkbox"> ${_renderInlineMd(b)}</label></li>`;
    }
    return `<li>${_renderInlineMd(b)}</li>`;
  }).join('');
  return `
    <div class="rt-r3-section">
      <h3>${esc(title)}</h3>
      <ul>${items}</ul>
    </div>
  `;
}

// Tiny inline-markdown: bold + code only. We deliberately avoid bringing
// in a full markdown parser (no new dep) — the personas use **bold** and
// `code` heavily; everything else is just paragraphs.
function _renderInlineMd(text) {
  let out = esc(text);
  out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+?)`/g, '<code>$1</code>');
  return out.replace(/\n/g, '<br>');
}

function _roleSlug(name) {
  // Stable CSS class per role. Hardcoded mapping so the colored chip
  // doesn't depend on the 8-byte Chinese name surviving CSS escaping.
  return ({
    '极简派': 'minimalist',
    '场景派': 'scenario',
    '借鉴派': 'precedent',
    '悲观派': 'pessimist',
  })[name] || 'unknown';
}

// ---------- boot ----------
render();
refreshAll();
setInterval(refreshAll, 3000);
