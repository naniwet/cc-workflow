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
  // Git branch — 给 worktree 隔离 toggle 用(2026-05-25 加)。
  // Lucide 风格:两个节点 + 一条线 + 弧线表示 branch off。
  branch:  `<svg ${_S}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
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
  // 30s 兜底 timeout — backend 任何路径 hang(2026-05-25 排查过一次 systemd
  // 状态错配导致前端 button 永远 disabled 的情况),fetch 不 abort 的话 PWA
  // 没 error 没 success 没 finally 重置,看起来就是"卡住"。30s 之后 abort
  // 抛 AbortError,走下面的 catch / showError 路径,至少前端能恢复。
  // 调 api 时如果想关掉(比如 SSE / long-poll),传 opts.signal = null 显式覆盖。
  let timeoutId;
  if (opts.signal === undefined) {
    const ctrl = new AbortController();
    timeoutId = setTimeout(() => ctrl.abort(), 30_000);
    opts = { ...opts, signal: ctrl.signal };
  }
  let r;
  try {
    r = await fetch(path, { credentials: 'same-origin', ...opts });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
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
    let detailObj = null;     // 完整 detail dict — showError 用它抽 hint / fixUrl / raw
    try {
      const body = await r.json();
      const d = body?.detail;
      if (typeof d === 'string') {
        detail = d;
      } else if (d && typeof d === 'object') {
        detailObj = d;
        if (d.raw_reply) detail = `${d.error || 'error'} · LLM said: ${String(d.raw_reply).slice(0, 200)}`;
        else if (typeof d.msg === 'string') detail = d.msg;    // human-readable explanation (preferred)
        else if (typeof d.detail === 'string') detail = d.detail;
        else if (d.error) detail = d.error;
        else detail = JSON.stringify(d);
      } else if (body?.error) {
        detail = body.error;
      }
    } catch { /* body not JSON; ignore */ }
    const err = new Error(`${r.status} ${path}${detail ? ' — ' + detail : ''}`);
    err.status = r.status;
    err.detail = detailObj;
    throw err;
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
  // opts 可选字段(都有就完整渲染,都没就退化成原版 minimal layout):
  //   hint:     一行"可能原因 + 下一步"灰字
  //   fixUrl:   "Fix" 按钮的目标 link(支持 #settings/... 这种 SPA 路由)
  //   fixLabel: 按钮文字(默认 "Fix")
  //   raw:      原始错误 dict/string,折叠在 <details> 里
  //   ttl:      毫秒;0 = 永久(error 默认 8s 比 info/success 长,让用户看 hint)
  const hintHtml = opts.hint ? `<div class="toast-hint">${esc(opts.hint)}</div>` : '';
  const actionHtml = opts.fixUrl
    ? `<a class="toast-action" href="${esc(opts.fixUrl)}">${esc(opts.fixLabel || 'Fix')}</a>`
    : '';
  let rawHtml = '';
  if (opts.raw) {
    const rawStr = typeof opts.raw === 'string' ? opts.raw : JSON.stringify(opts.raw);
    rawHtml = `<details class="toast-raw"><summary>详情</summary><pre>${esc(rawStr.slice(0, 800))}</pre></details>`;
  }
  el.innerHTML = `
    <span class="toast-icon">${ICONS[level] || ICONS.info}</span>
    <div class="toast-body">
      <div class="toast-message">${esc(message)}</div>
      ${hintHtml}
      ${actionHtml ? `<div class="toast-actions">${actionHtml}</div>` : ''}
      ${rawHtml}
    </div>
    <button class="toast-close" type="button" aria-label="Dismiss">×</button>
  `;
  el.querySelector('.toast-close').addEventListener('click', () => dismissToast(id));
  // Action click 先 dismiss toast,再让 <a href="#..."> 自然触发 hashchange
  el.querySelector('.toast-action')?.addEventListener('click', () => dismissToast(id));
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  // ttl=0 表示永久(给 raw 长的 error 用户充足时间看),其余按传入或默认 4s
  const defaultTtl = level === 'error' ? TOAST_TTL_MS * 2 : TOAST_TTL_MS;
  const ttl = opts.ttl ?? defaultTtl;
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
  return id;
}

function dismissToast(id) {
  const el = document.querySelector(`.toast[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('toast-show');
  el.classList.add('toast-hide');
  setTimeout(() => el.remove(), 200);                  // matches CSS exit transition
}

// showError 接受两种 call 形式:
//   showError("string")            → 原样 toast,无 hint(老用法,backward-compat)
//   showError(errObj, { prefix? }) → 从 err.detail.hint / fixUrl / raw 抽 action
// 后端 HTTPException 的 detail 现在带 hint / fixUrl 字段(B 改造),前端
// catch 时 `showError(err)` 自动渲染 "可能原因 + 一键 Fix" toast。
function showError(msg, opts = {}) {
  if (msg && typeof msg === 'object' && msg.message) {
    const err = msg;
    const d = err.detail || {};
    const prefix = opts.prefix ? `${opts.prefix}: ` : '';
    return showToast('error', `${prefix}${err.message}`, {
      hint: d.hint,
      fixUrl: d.fixUrl,
      fixLabel: d.fixLabel,
      raw: d.raw_reply || (typeof d === 'object' && Object.keys(d).length ? d : undefined),
    });
  }
  return showToast('error', String(msg), opts);
}
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
    if (hash === _lastDataHash) {
      // 数据没变但仍要尝试 dispatch:上一条 active 完成的时机,active
      // 列表变空 → 队列可以推 1 条。 dispatch 成功后 hash 才会改变,
      // 这一遍可能正赶在"刚变空、没新 run"的中间窗,所以无条件触发一次。
      _dispatchAllQueues();
      return;
    }
    _lastDataHash = hash;
    render();
    _dispatchAllQueues();
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
  settings:    renderSettingsView,
  search:      renderSearchView,
};
function parseRoute() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('runs/')) return { name: 'runs', id: h.slice(5) };
  if (h.startsWith('workspaces/')) return { name: 'workspace-detail', id: decodeURIComponent(h.slice(11)) };
  if (h.startsWith('tasks/')) return { name: 'task-detail', id: decodeURIComponent(h.slice(6)) };
  if (h.startsWith('roundtables/')) return { name: 'roundtable-detail', id: decodeURIComponent(h.slice(12)) };
  // #settings/<section>:目前只有 providers,以后加 secrets / workspaces 走同样
  // 模式。section 缺省时 renderSettingsView 显示 hub(section 列表 link)。
  if (h.startsWith('settings/')) return { name: 'settings-section', id: decodeURIComponent(h.slice(9)) };
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

// 追踪上次 render 时每个 turn 的 status,用来 detect "刚结束" 的 turn
// (running/queued → done/failed)。这种 turn 自动写一笔 override = true,
// 让 workspaceTurnExpansion 的"manual override 优先"规则生效保持展开,
// 不会因为默认规则把它突然 collapse(用户在看 live output,突然收起视觉跳)。
// 注意:不是改默认全展开(那样历史 turn 都打开太重),只精准 pin"刚结束"的。
const _lastSeenTurnStatuses = new Map();              // key: run id → 上次 render 时的 status

function _pinJustFinishedTurns(turns) {
  for (const t of (turns || [])) {
    if (!t || !t.id) continue;
    const prev = _lastSeenTurnStatuses.get(t.id);
    const wasRunning = prev === 'running' || prev === 'queued';
    const isRunningNow = t.status === 'running' || t.status === 'queued';
    if (wasRunning && !isRunningNow && !Object.prototype.hasOwnProperty.call(workspaceTurnOverrides, t.id)) {
      // 刚 finish — 自动 pin 成 expanded。仅在没 manual override 时写
      // (用户如果之前 collapse 过,保持 collapse,不要打他脸)。
      workspaceTurnOverrides[t.id] = true;
    }
    _lastSeenTurnStatuses.set(t.id, t.status);
  }
}

// 前端 prompt 队列:workspace 有 run 在跑时,用户继续发的 prompt 排队,
// 跑完一条自动 dispatch 下一条。后端 /run 在 workspace busy 时会 409
// (backend/main.py:231 active_in_workspace 检查),只能前端排队。
//
// 状态 in-memory,不持久化(localStorage 体验上不必要 —— 刷新页面 = 重
// 来一次,队列丢了符合用户预期)。
//
// 每条 { id: 'q-<seq>', prompt, queuedAt }。delete 按 id 移除。
// _dispatchAllQueues 在每次 refreshAll 后跑,检查每个有 queue 的 ws:
// 没 active run → 取队头发出去。后端拒绝(409 / 网络)→ 塞回队头。
const _promptQueue = {};
let _promptQueueSeq = 0;

// 用户选了文件但还没提交的本地 File 对象 — 每个 workspace 一个数组。
// 提交时:
//   非 busy 路径 → 立即 POST /uploads 拿绝对 paths,再调 /run 传 attachments
//   busy 路径    → File 对象直接塞进队列项的 attachments 字段,等出队时再上传
// in-memory,刷新 PWA 丢失(跟 _promptQueue 一致 — 队列本来就不持久化)。
const _pendingUploads = {};   // { [ws]: [{ tempId, name, size, file: File }] }
let _pendingUploadSeq = 0;
const _UPLOAD_MAX_BYTES = 10 * 1024 * 1024;   // 跟 nginx /uploads location 对齐
const _UPLOAD_MAX_FILES = 10;                 // 跟 RunRequest.attachments max_length 对齐

function _addPendingFile(ws, file) {
  if (!_pendingUploads[ws]) _pendingUploads[ws] = [];
  _pendingUploads[ws].push({
    tempId: `up-${++_pendingUploadSeq}`,
    name: file.name,
    size: file.size,
    file,
  });
}

function _removePendingFile(ws, tempId) {
  if (!_pendingUploads[ws]) return;
  _pendingUploads[ws] = _pendingUploads[ws].filter((u) => u.tempId !== tempId);
  if (_pendingUploads[ws].length === 0) delete _pendingUploads[ws];
}

function _clearPending(ws) {
  delete _pendingUploads[ws];
}

function _totalPendingBytes(ws) {
  return (_pendingUploads[ws] || []).reduce((sum, u) => sum + u.size, 0);
}

function _formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// 重画指定 ws 的所有 .attach-chips 容器(card grid + mobile detail 可能并存,
// 全部更新最稳)。空数组 → innerHTML='',容器本身保留(占位不跳)。
function _renderChips(ws) {
  const items = _pendingUploads[ws] || [];
  const html = items.map((u) => `
    <span class="attach-chip" data-tempid="${esc(u.tempId)}">
      <span class="chip-name">${esc(u.name)}</span>
      <span class="chip-size muted">${esc(_formatBytes(u.size))}</span>
      <button class="chip-remove" type="button"
              data-ws="${esc(ws)}" data-tempid="${esc(u.tempId)}"
              aria-label="Remove ${esc(u.name)}">×</button>
    </span>
  `).join('');
  for (const container of document.querySelectorAll(`.attach-chips[data-ws="${ws}"]`)) {
    container.innerHTML = html;
  }
}

// 把一组 File 对象走 multipart POST 上传,拿到服务器的绝对 paths 返回。
// 不用 api() — FormData 必须让浏览器自带 Content-Type: multipart/form-data;
// boundary=...,api() 默认塞 application/json 会破坏请求。
// fileObjs 可以是 [{ file, ... }] 形式或者裸 File 数组。
async function _uploadFiles(ws, fileObjs) {
  const files = fileObjs.map((x) => x.file || x);
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  const r = await fetch(`/uploads/${encodeURIComponent(ws)}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  });
  if (r.status === 401 || r.status === 403) {
    // session 过期 — 跳登录(跟 api() 同款行为)
    window.location.href = '/pwa/login.html?next=' + encodeURIComponent(window.location.href);
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    let msg = `upload failed (${r.status})`;
    try {
      const body = await r.json();
      msg = (body.detail && (body.detail.msg || body.detail.error)) || body.error || msg;
    } catch {}
    throw new Error(msg);
  }
  const data = await r.json();
  return data.paths || [];
}

// 第 3 参 attachments(可选)— File 对象数组(跟 _pendingUploads 同结构);
// 出队时 _dispatchAllQueues 拿 File 上传。不持久化:刷新 PWA 队列里的 File
// 引用丢失,跟 _promptQueue 现状一致。
function _enqueuePrompt(ws, prompt, attachments = []) {
  if (!_promptQueue[ws]) _promptQueue[ws] = [];
  _promptQueue[ws].push({
    id: `q-${++_promptQueueSeq}`,
    prompt,
    attachments,
    queuedAt: Math.floor(Date.now() / 1000),
  });
}

function _dequeuePrompt(ws, id) {
  if (!_promptQueue[ws]) return;
  _promptQueue[ws] = _promptQueue[ws].filter((m) => m.id !== id);
  if (_promptQueue[ws].length === 0) delete _promptQueue[ws];
}

function _hasActiveRun(ws) {
  const data = groupByWorkspace(lastData.workspaces, lastData.sessions)[ws];
  if (!data) return false;
  return (data.active || []).length > 0 || (data.queued || []).length > 0;
}

let _dispatching = new Set();   // 防 race:同一 ws 同时只能在 dispatch 一条

async function _dispatchAllQueues() {
  for (const ws of Object.keys(_promptQueue)) {
    if (_dispatching.has(ws)) continue;
    if (_hasActiveRun(ws)) continue;
    const queue = _promptQueue[ws];
    if (!queue || queue.length === 0) continue;
    const next = queue.shift();
    if (queue.length === 0) delete _promptQueue[ws];
    _dispatching.add(ws);
    try {
      // 出队时如果带附件,先 POST /uploads 拿绝对 paths,再调 /run。
      // 上传失败把 next 塞回队头让用户再试,跟 /run 失败一致。
      let attachmentPaths;
      if (next.attachments && next.attachments.length > 0) {
        try {
          attachmentPaths = await _uploadFiles(ws, next.attachments);
        } catch (uerr) {
          if (!_promptQueue[ws]) _promptQueue[ws] = [];
          _promptQueue[ws].unshift(next);
          showError(uerr, { prefix: '队列附件上传' });
          render();
          _dispatching.delete(ws);
          continue;
        }
      }
      await api('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace: ws,
          prompt: next.prompt,
          session_key: `pwa-${ws}`,
          source: 'pwa',
          ...(attachmentPaths ? { attachments: attachmentPaths } : {}),
        }),
      });
      // dispatch 后即刻 refresh + 重 render,让 UI 看到新 running turn
      // 跟队列项消失。auto-scroll-to-bottom 已经在 onTriggerSubmit 那边
      // 做过 atBottom=true 的设置;dispatch path 也应该跟着,模拟同一
      // "我按了 Run"的语义。
      workspaceSessionScroll[ws] = { scrollTop: Infinity, atBottom: true };
      workspaceStreamState[ws] = {
        ...(workspaceStreamState[ws] || {}),
        atBottom: true,
        newEvents: 0,
      };
      refreshAll();
    } catch (err) {
      // 后端拒绝(409 / 网络) → 塞回队头让用户看到 + toast
      if (!_promptQueue[ws]) _promptQueue[ws] = [];
      _promptQueue[ws].unshift(next);
      showError(`queued prompt failed: ${err.message}`);
      render();
    } finally {
      _dispatching.delete(ws);
    }
  }
}

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
  } else if (route.name === 'task-detail' && route.id) {
    setActiveTab('tasks');                          // Tasks tab stays highlighted
    renderTaskDetailView(route.id);
  } else if (route.name === 'roundtable-detail' && route.id) {
    setActiveTab('roundtables');
    renderRoundtableDetailView(route.id, { isFreshNav });
  } else if (route.name === 'settings-section' && route.id) {
    setActiveTab('settings');
    renderSettingsSectionView(route.id);
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

  // 顶部 toolbar:1 行装下 "+ New workspace" 按钮 + 隐藏 workspace pills。
  //   - h1 砍掉(topbar tab 高亮已经标明"Workspaces"段,h1 冗余)
  //   - "+ New" 不再展开成全宽 inline 表单,改弹 <dialog> modal
  //   - hidden strip 从底部挪上来跟 + New 同行(没有 hidden 时只剩 + New)
  // 总省 ~100px 永久竖直空间。
  view.innerHTML = `
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="ws-new-btn">
        + New workspace
      </button>
      ${hiddenHtml}
    </div>
    ${layoutHtml
      ? `<div class="ws-layout">${layoutHtml}</div>`
      : `<p class="muted">No workspaces yet. Click "+ New workspace" above,
         or create <code>~/workspaces/&lt;name&gt;/.git</code> on the server.</p>`}
    <dialog class="ws-new-dialog" id="ws-new-dialog">
      <form data-form-id="new-ws" class="ws-new-form">
        <h3>New workspace</h3>
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="repo-name (alphanum / . _ -)" required autofocus></label>
        <label>provider ${newWsProviderPicker}</label>
        <!-- engine 字段固定为 claude(codex 已下线 2026-05-14;原因见 README "engine 现状")。
             保留 hidden input 是为了后端 NewWorkspaceRequest 的 engine 字段满足 Pydantic
             Literal["claude"] 验证。 -->
        <input type="hidden" name="engine" value="claude">
        <label class="inline-check">
          <input type="checkbox" name="trust" ${lastData.globalDefaultTrust ? 'checked' : ''}>
          Auto-approve all tools (trust this workspace — Bash / git / WebFetch / etc. won't ask for permission)
        </label>
        <label class="inline-check">
          <input type="checkbox" name="worktree_mode_off">
          这个 workspace 不需要 worktree 隔离(笔记 / 文档仓库选这个)
        </label>
        <p class="muted" style="font-size:11px;margin:0">
          Creates <code>~/workspaces/&lt;name&gt;/</code> with <code>git init</code>
          + empty README + first commit. <strong>Engine is locked once created</strong>.
          Provider and trust can be flipped anytime via the column header (🔒/🔓).
        </p>
        <div class="ws-new-actions">
          <button type="button" class="ws-new-cancel">Cancel</button>
          <button type="submit">Create</button>
        </div>
      </form>
    </dialog>
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
  // Wire dialog open/close。原生 <dialog> 自带 backdrop / ESC,我们只
  // 管 open(showModal) + cancel(close) + submit-after-success(close)。
  const dlg = $('ws-new-dialog');
  const openBtn = $('ws-new-btn');
  if (dlg && openBtn) {
    openBtn.addEventListener('click', () => {
      // dialog.showModal 在已经 open 的状态再调一次会抛 InvalidStateError
      if (!dlg.open) dlg.showModal();
    });
    dlg.querySelector('.ws-new-cancel')?.addEventListener('click', () => dlg.close());
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
        <label class="inline-check">
          <input type="checkbox" name="worktree_mode_off">
          不需要 worktree 隔离(笔记 / 文档仓库)
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
    showError(e, { prefix: 'sync /commands' });
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
        点 workspace 列头的 🔄 Sync /commands 按钮拉一次。
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
  // 跳过 IME composition:中文/日文输入法的"按 Enter 确认候选词"会发
  // keydown(key='Enter', isComposing=true)。不能误判为提交,否则中文
  // 用户每选一个字都飞出去。
  if (e.isComposing || e.keyCode === 229) return;
  // Shift+Enter / Alt+Enter:换行,不发送。
  if (e.shiftKey || e.altKey) return;
  // 其余 Enter(plain / Cmd / Ctrl)= 发送。Mobile 跟 PC 一致 —— chat
  // app 的默认心智(ChatGPT / 飞书 都一样),要换行用 Shift+Enter。
  // 上一版 mobile gate 掉 plain Enter,用户反馈"回车发送的逻辑也不见了"。
  e.preventDefault();
  const form = e.currentTarget.closest('form');
  if (form) form.requestSubmit();
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
  for (const b of root.querySelectorAll('.ws-worktree-mode-toggle')) {
    b.addEventListener('click', onWorktreeModeToggleClick);
    _addTapFallback(b, onWorktreeModeToggleClick);
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

  // PC overview + detail + run-detail + cron 历史 turn 都走同一套
  // turn-streaming UI。先停所有正在跑的 turn-events poll(整页重画后
  // 老 timer 都失效),再 wire 新 DOM 的 turn 交互 + bootstrap 已展开
  // turn 的 event load。
  _stopAllTurnEventsPolls();
  _bindTurnInteractions(root);
  // 队列里的 × 按钮:点了从 _promptQueue 移除并重 render。
  for (const btn of root.querySelectorAll('.queue-remove')) {
    btn.addEventListener('click', _onQueueRemoveClick);
    _addTapFallback(btn, _onQueueRemoveClick);
  }
  // 📎 按钮:点了打开 file picker(同 form 内的隐藏 input)
  for (const btn of root.querySelectorAll('.attach-btn')) {
    btn.addEventListener('click', _onAttachBtnClick);
    _addTapFallback(btn, _onAttachBtnClick);
  }
  // file input change:用户选了文件 → 校验大小 / 数量 → 加进 _pendingUploads
  for (const input of root.querySelectorAll('.attach-input')) {
    input.addEventListener('change', _onAttachInputChange);
  }
  // chip 上的 × 按钮:从 _pendingUploads 移除
  for (const btn of root.querySelectorAll('.chip-remove')) {
    btn.addEventListener('click', _onChipRemoveClick);
    _addTapFallback(btn, _onChipRemoveClick);
  }
  // 进入卡片 / 详情时,如果该 ws 有 _pendingUploads,重画一次 chip(因为
  // 整页 re-render 后容器是空的,_pendingUploads 状态还在但 DOM 没显示)
  for (const container of root.querySelectorAll('.attach-chips[data-ws]')) {
    const ws = container.dataset.ws;
    if (ws && _pendingUploads[ws] && _pendingUploads[ws].length > 0) _renderChips(ws);
  }
}

function _onAttachBtnClick(e) {
  const btn = e.currentTarget;
  // 找同 form 内的 attach-input(隐藏的)→ trigger click 弹文件选择
  const form = btn.closest('form');
  const input = form?.querySelector('.attach-input');
  if (input) input.click();
}

function _onAttachInputChange(e) {
  const input = e.target;
  const ws = input.dataset.ws;
  if (!ws) return;
  const incoming = Array.from(input.files || []);
  for (const f of incoming) {
    const currentCount = (_pendingUploads[ws] || []).length;
    if (currentCount >= _UPLOAD_MAX_FILES) {
      showError(`最多 ${_UPLOAD_MAX_FILES} 个附件,已跳过剩余文件`);
      break;
    }
    if (_totalPendingBytes(ws) + f.size > _UPLOAD_MAX_BYTES) {
      showError(`附件总大小超过 ${_UPLOAD_MAX_BYTES / (1024 * 1024)} MB,已跳过 ${f.name}`);
      continue;
    }
    _addPendingFile(ws, f);
  }
  _renderChips(ws);
  // 清 input value,允许下次选同名文件(否则 change 不触发)
  input.value = '';
}

function _onChipRemoveClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  const tempId = btn.dataset.tempid;
  if (!ws || !tempId) return;
  _removePendingFile(ws, tempId);
  _renderChips(ws);
}

function _onQueueRemoveClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  const qid = btn.dataset.qid;
  if (!ws || !qid) return;
  _dequeuePrompt(ws, qid);
  render();
}

// Turn 交互的子绑定(turn-toggle / tool-result-fold + bootstrap)。
// 抽出来是因为 cron 的 patch path(只换一个 loop-row,不整页重画)也要
// rewire 新 row 里的 turn 元素,但不能跟着调 _stopAllTurnEventsPolls
// —— 那会把别的 loop-row 还活着的 poll 一起干掉。
function _bindTurnInteractions(root) {
  for (const btn of root.querySelectorAll('.turn-toggle')) {
    btn.addEventListener('click', _onWorkspaceTurnToggle);
    _addTapFallback(btn, _onWorkspaceTurnToggle);
  }
  for (const btn of root.querySelectorAll('.tool-result-fold')) {
    btn.addEventListener('click', _onToolResultExpand);
    _addTapFallback(btn, _onToolResultExpand);
  }
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
  // /providers 返回 list[dict] {name, base_url, ...},这里只用 .name
  const list = lastData.providers || [];
  const opts = [];
  if (includeDefault) {
    const label = lastData.globalProvider ? `default · ${esc(lastData.globalProvider)}` : 'default';
    opts.push(`<option value=""${selected ? '' : ' selected'}>${label}</option>`);
  }
  for (const p of list) {
    const n = p.name || p;   // 兼容老 list[str] 格式
    opts.push(`<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`);
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
  for (const p of list) {
    const n = p.name || p;   // 兼容老 list[str] 格式
    options.push({ value: n, label: n });
  }
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
    // /providers 现在返回 list[dict] {name, ...},兼容老 list[str]
    const pname = p.name || p;
    // Skip the row that's identical to the Default option in behavior.
    // Picking "Default" with globalProvider=deepseek vs. picking "deepseek"
    // explicitly produces the exact same wire effect — listing both is
    // confusing visual noise. Exception: when THIS workspace is explicitly
    // pinned to globalDefault (the "I want to lock to this provider even
    // if I change my global default later" path), we still surface the
    // row so the user can see the pin and unpin it via the Default row.
    if (pname === globalDefault && pname !== wsProvider) continue;
    rows.push(_providerRadioRowHtml(name, pname, esc(pname), pname === wsProvider));
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
    const main = r?.summary || 'pulled';
    const wt = r?.worktree_msg || '';
    // 3 种回包形状:
    //   ok=true, worktree_rebase_ok=true  → success "main: ... · session worktree: ..."
    //   ok=true, worktree_rebase_ok=false → warning(main 拉成功,worktree rebase 冲突)
    //   抛错(http 4xx)                   → error(main pull 自己挂了)
    if (r?.worktree_rebase_ok === false) {
      showToast('warning', `${ws}: ${main} · ${wt}`, { ttl: 6000 });
    } else {
      const msg = wt ? `${ws}: ${main} · ${wt}` : `${ws}: ${main}`;
      showToast('success', msg, { ttl: 3500 });
    }
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
    // 后端真删了 runs.db + log 文件,下一次 refreshAll 拉回来就是干净
    // 的新 session,前端不用做 cutoff 过滤(2025-05-16 之前一版用
    // localStorage hack 过滤,后端真删上线后撤掉)。
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

async function onWorktreeModeToggleClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  const wasOff = btn.dataset.mode === 'off';
  const next = wasOff ? 'auto' : 'off';
  btn.disabled = true;
  try {
    await api(`/workspaces/${encodeURIComponent(name)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktree_mode: next }),
    });
    showToast(
      'success',
      `${name}: worktree ${next === 'off' ? 'OFF (主目录)' : 'ON (隔离)'}`,
      { ttl: 2500 },
    );
    refreshAll();
  } catch (err) {
    showError(`save worktree_mode failed: ${err.message}`);
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
  // checkbox 勾上 = "off"(不要 worktree),不勾 = "auto"(当前行为)。
  const worktreeMode = form.elements.worktree_mode_off?.checked ? 'off' : 'auto';
  if (!name) return;
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await api('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, engine, trust, worktree_mode: worktreeMode }),
    });
    form.reset();
    clearDraft('new-ws');
    clearDetails('add-ws');
    // 新版 PC overview 把 new-ws 表单装进 <dialog> 弹窗,创建成功后
    // 关掉弹窗。mobile / 旧入口的 form 不在 dialog 里,closest 返回 null
    // 不影响逻辑。
    form.closest('dialog')?.close();
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
  _pinJustFinishedTurns(turnsToShow);
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
  // ⚙ 菜单 body 跟 mobile workspace detail 那个完全同步(Provider /
  // Workspace / Display / Session + 底部 Delete)。之前 PC / mobile 两
  // 边各写各的,section 分组、用词("Reset conversation" vs "New chat"、
  // "Pull latest (git pull)" vs "Pull latest")都漂移,Display 段(Show
  // all events toggle)也只 mobile 有。用户反馈"pc 端的菜单怎么跟移动
  // 端不一样 保持一致吧" —— 这里以 mobile 版为准重写 PC body。
  const trustOnPC = effectiveTrust(name);
  const worktreeOffPC = lastData.wsSettings[name]?.worktree_mode === 'off';
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
          <div class="ws-menu-section">
            <span class="ws-menu-section-label">Workspace</span>
            <button class="ws-trust-toggle ws-menu-item" type="button"
                    data-ws="${esc(name)}" data-trusted="${trustOnPC ? '1' : '0'}">
              ${trustOnPC ? ICONS.unlock : ICONS.lock}
              <span>Trust workspace <strong>${trustOnPC ? 'ON' : 'OFF'}</strong></span>
            </button>
            <button class="ws-worktree-mode-toggle ws-menu-item" type="button"
                    data-ws="${esc(name)}" data-mode="${worktreeOffPC ? 'off' : 'auto'}">
              ${ICONS.branch}
              <span>Worktree 隔离 <strong>${worktreeOffPC ? 'OFF' : 'ON'}</strong></span>
            </button>
            <button class="ws-pull-latest ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.download} <span>Pull latest</span>
            </button>
            <button class="ws-sync-skills ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.refresh} <span>Sync /commands</span>
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
            <button class="ws-merge-to-main ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.download} <span>Merge to main + push</span>
            </button>
            <button class="ws-reset-session ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.rewind} <span>New chat</span>
            </button>
          </div>
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
      ${_queueListHtml(name)}
      <form class="trigger-form" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <div class="attach-chips" data-ws="${esc(name)}"></div>
        <input type="file" class="attach-input" data-ws="${esc(name)}" multiple hidden>
        <button type="button" class="attach-btn" data-ws="${esc(name)}" aria-label="Attach files">📎</button>
        <textarea name="prompt"></textarea>
        <button type="submit">Run</button>
      </form>
    </div>
  `;
}

// Render queued prompts for a workspace(workspace 已有 run 在跑 + 用户
// 继续发的 prompt 会进这个队列;跑完一条自动 dispatch 下一条)。每条
// 一行 + ⏳ icon + 内容 + × 删除。空队列返回空字符串。
function _queueListHtml(ws) {
  const items = _promptQueue[ws] || [];
  if (items.length === 0) return '';
  const rows = items.map((m) => {
    const nAttach = (m.attachments && m.attachments.length) || 0;
    return `
      <div class="queue-item" data-ws="${esc(ws)}" data-qid="${esc(m.id)}">
        <span class="queue-icon">⏳</span>
        <span class="queue-prompt">${esc((m.prompt.split(/\r?\n/)[0] || '').slice(0, 200))}</span>
        ${nAttach ? `<span class="queue-attach" title="${nAttach} attachment(s)">📎 ${nAttach}</span>` : ''}
        <button class="queue-remove" type="button"
                data-ws="${esc(ws)}" data-qid="${esc(m.id)}" title="Remove from queue">×</button>
      </div>
    `;
  }).join('');
  return `
    <div class="queue-list" data-ws="${esc(ws)}">
      <div class="queue-header">已排队(${items.length}),等当前 run 完成后按顺序发出</div>
      ${rows}
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


async function onTriggerSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const ws = form.dataset.workspace;
  const prompt = form.elements.prompt.value.trim();
  if (!prompt) return;
  // 提交时拿当前 ws 的 pending 附件(File 对象),清掉 _pendingUploads[ws]
  // (无论走 busy / 立即提交,UI 上的 chip 都该消失)。
  const pending = [..._pendingUploads[ws] || []];
  // Workspace 已有 run 在跑 / 已有排队 → 这条进队列,不调 /run。后端会
  // 409 拒绝(workspace_busy),前端排队 + 上一条跑完自动 dispatch 才能
  // 顺畅串起来。
  const busy = _hasActiveRun(ws) || (_promptQueue[ws]?.length > 0);
  if (busy) {
    // File 对象塞进队列(不上传 — 等出队时 _dispatchAllQueues 再上传)
    _enqueuePrompt(ws, prompt, pending);
    _clearPending(ws);
    _renderChips(ws);
    form.reset();
    clearDraft(form.dataset.formId);
    form.querySelector('textarea')?.blur();
    const queueLen = (_promptQueue[ws] || []).length;
    showToast('info', `已排队(${queueLen} 条待发)`, { ttl: 1600 });
    render();
    return;
  }
  const btn = form.querySelector('button[type="submit"]') || form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    // 有附件 → 先上传拿绝对 paths。上传失败 → showError + 早退,
    // pending 留在 _pendingUploads(没清),用户可以删 chip 或重试。
    let attachmentPaths;
    if (pending.length > 0) {
      try {
        attachmentPaths = await _uploadFiles(ws, pending);
      } catch (uerr) {
        showError(uerr, { prefix: '附件上传' });
        btn.disabled = false;
        btn.textContent = 'Run';
        return;
      }
    }
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
        ...(attachmentPaths ? { attachments: attachmentPaths } : {}),
      }),
    });
    _clearPending(ws);
    _renderChips(ws);
    form.reset();
    clearDraft(form.dataset.formId);
    // Blur the textarea before kicking off the refresh — render() has a
    // guard that bails when an INPUT/TEXTAREA is focused (to avoid tearing
    // DOM out from under a typist), and submit doesn't clear focus on its
    // own. Without this blur, the refresh that follows form submit
    // wouldn't repaint the timeline → new run wouldn't appear until the
    // user clicked away from the textarea.
    form.querySelector('textarea')?.blur();
    // 用户按 Run = "我现在就在底,新 turn 是我的焦点"。强制 atBottom=true
    // 让下一次 render 走 scrollTop=scrollHeight 路径,不是恢复 saved
    // scrollTop(那个 saved 是用户先前展开 turn 时 scroll handler 存下的,
    // 会把视口拽回到那条展开的 turn —— 用户反馈的 bug 1 根因)。
    workspaceSessionScroll[ws] = { scrollTop: Infinity, atBottom: true };
    workspaceStreamState[ws] = {
      ...(workspaceStreamState[ws] || {}),
      atBottom: true,
      newEvents: 0,
    };
    refreshAll();
    // Mobile 软键盘收起动画期间 scrollHeight 不稳定 — render 立刻发生
    // 时还在动画中,scroll 到那时的 "bottom",等动画结束 layout settle
    // 后 "bottom" 位置又变了,视觉上就是"发完位置不准"。监听
    // visualViewport.resize(键盘收起触发) + setTimeout 兜底,在动画
    // 真正结束后再补一次 scroll-to-bottom。
    _rescrollAfterKeyboardSettles(ws);
  } catch (err) {
    showError(err);   // 自动从 err.detail 抽 hint / fixUrl(后端 /run workspace_busy 等)
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
  }
}

// Mobile only:用户提交 prompt 后键盘收起,layout 重新 settle,补一次
// scroll 把 stream 拉回底部。两条触发路径:
//   - visualViewport.resize:键盘动画结束时浏览器触发(iOS / Android 都支持)
//   - setTimeout 350ms 兜底:覆盖没有 visualViewport API 的浏览器,以及
//     resize 因为 race 没触发的情况
// 两个 race,谁先 fire 谁干活,另一个被 done 标志吞掉。
function _rescrollAfterKeyboardSettles(ws) {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    for (const s of document.querySelectorAll(`.workspace-session-stream[data-ws="${ws}"]`)) {
      s.scrollTop = s.scrollHeight;
    }
    for (const t of document.querySelectorAll(`.ws-timeline[data-ws="${ws}"]`)) {
      t.scrollTop = t.scrollHeight;
    }
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fire, { once: true });
  }
  setTimeout(fire, 350);
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
  _pinJustFinishedTurns(turns);
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
  const worktreeOff = lastData.wsSettings[name]?.worktree_mode === 'off';
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
              <button class="ws-worktree-mode-toggle ws-menu-item" type="button"
                      data-ws="${esc(name)}" data-mode="${worktreeOff ? 'off' : 'auto'}">
                ${ICONS.branch}
                <span>Worktree 隔离 <strong>${worktreeOff ? 'OFF' : 'ON'}</strong></span>
              </button>
              <button class="ws-pull-latest ws-menu-item" type="button" data-ws="${esc(name)}" ${disabledAttr}>
                ${ICONS.download} <span>Pull latest</span>
              </button>
              <button class="ws-sync-skills ws-menu-item" type="button" data-ws="${esc(name)}">
                ${ICONS.refresh} <span>Sync /commands</span>
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
      ${_queueListHtml(name)}
      <form class="trigger-form workspace-input" data-workspace="${esc(name)}" data-form-id="ws-${esc(name)}">
        <div class="attach-chips" data-ws="${esc(name)}"></div>
        <input type="file" class="attach-input" data-ws="${esc(name)}" multiple hidden>
        <button type="button" class="attach-btn" data-ws="${esc(name)}" aria-label="Attach files">📎</button>
        <textarea name="prompt"></textarea>
        <button class="run-btn" type="submit">Run</button>
      </form>
    </div>
  `;
  // ↑ Run 按钮不再 disabled-on-running:队列机制接管,用户随时可以提
  // prompt,后台串行 dispatch。
}

function _workspaceTurnHtml(turn) {
  const status = turn.status || '?';
  const prompt = turn.prompt || '';
  const expanded = !!turn.expanded;
  // Collapsed head 两行布局:
  //   ▶ prompt 首行 .................. ✓ 53s 36m ago
  //   ↳ reply preview ...
  // reply preview 来源 turn.output_preview(后端 db._RUN_SUMMARY_COLS 用
  // head+tail+elision 拼出的预览,长 reply 也能看到末尾结论)。没有
  // output_preview(running / queued / cron 没存)就退化为单行 prompt。
  // expanded 时 reply preview 被 CSS 隐藏(body 里全文 reply 已经看到)。
  const summary = (prompt.split(/\r?\n/).find(Boolean) || '(empty prompt)').slice(0, 200);
  const replyRaw = String(turn.output_preview || '').trim();
  // 把空行 / 单独 '…' 行剔掉,其余原换行保留 —— CSS 用 line-clamp:2 wrap,
  // 多行内容自然显示前两行可读。
  const replyPreview = replyRaw
    ? replyRaw.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && l !== '…')
        .join(' ')           // 用空格连接,让 2 行 clamp 自己按宽度 wrap
        .slice(0, 400)        // 兜底硬截一下,免得超长 reply 占内存
    : '';
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
        <span class="turn-main">
          <span class="turn-summary">${esc(summary)}</span>
          ${replyPreview
            ? `<span class="turn-reply-preview">↳ ${esc(replyPreview)}</span>`
            : ''}
        </span>
        <span class="turn-meta">
          ${statusIcon(status)}
          ${turn.elapsed_s != null ? `<span class="turn-elapsed">${esc(turn.elapsed_s)}s</span>` : ''}
          ${startedRel ? `<span class="turn-started" title="${esc(startedAbs)}">${esc(startedRel)}</span>` : ''}
        </span>
      </button>
      ${cancelBtn}
      <div class="turn-body">
        ${userHeaderHtml}
        ${eventsHtml}
        ${approvals}
        <button class="turn-collapse-foot turn-toggle" type="button"
                data-run-id="${esc(turn.id || '')}" data-expanded="1"
                title="Collapse this turn">
          <span class="turn-caret">▲</span> Collapse
        </button>
      </div>
    </article>
  `;
}
// ↑ collapse-foot 按钮:expanded turn body 最末尾加一个收起按钮 ——
//   reply / events 长起来后,用户不用再滚到最顶 chevron 才能收起。
//   class .turn-toggle 让现有 _onWorkspaceTurnToggle handler 自动绑上。
//   data-expanded=1 hardcode 因为它只在 .turn-expanded 时 CSS 可见,
//   点击必然是 "从展开切到收起"。CSS 用 .turn-collapsed .turn-collapse-foot
//   { display: none } 收起态隐藏自身。
// ↑ approvals 放在最后 —— bug:之前夹在 USER 和 events 之间,events 长出
//   来后 approval 被推到上方,auto-scroll-to-bottom 之后用户看不到 Approve
//   按钮。挪到 events 后面,turn 的最底部就是 [Approve][Deny],跟输入框
//   贴近,自然落在视口里。

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

  // 统一管 loading placeholder:容器里没渲染过任何 .event 时,显示一条
  // muted 文字。这样 "Loading… → Waiting… → 真 event" 三态切换不会
  // 导致 placeholder 被提前删掉(以前 bug:第一次 poll 拿到 system 行
  // 全被 parse 过滤,html 为空但 loading 已经 remove,容器变 0 高度,
  // 下次真 event 来又长回去 — 用户看到高度跳)。
  const _setLoadingText = (text) => {
    if (container.querySelector('.event')) return;  // 已经有 event,不动
    let el = container.querySelector('.turn-events-loading');
    if (!el) {
      // 之前用 innerHTML 写错误/空消息可能把 placeholder 替掉了,
      // 重新建一个。
      container.innerHTML = `<div class="muted turn-events-loading">${esc(text)}</div>`;
    } else {
      el.textContent = text;
    }
  };

  let data;
  try {
    data = await api(`/runs/${encodeURIComponent(runId)}/tail?lines=5000`);
  } catch (err) {
    _setLoadingText(`Failed to load events: ${err.message || err}`);
    // 失败不停 polling — 网络抖动一下就好
    if (isRunning) _turnEventsTimers[runId] = setTimeout(() => _loadTurnEvents(runId), 2500);
    return;
  }

  if (!data.exists) {
    _setLoadingText('Waiting for first event…');
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

    // 只有 html 真有内容才 remove loading + 插入。html 可能为空 ——
    // 比如 system init 行被 parser 过滤,或 thinking/tool 被 "Show all
    // events"=OFF filter 过滤。这种情况下保留 placeholder,等下一波。
    if (html) {
      const loading = container.querySelector('.turn-events-loading');
      if (loading) loading.remove();
      container.insertAdjacentHTML('beforeend', html);
      for (const btn of container.querySelectorAll('.tool-result-fold:not([data-bound])')) {
        btn.addEventListener('click', _onToolResultExpand);
        _addTapFallback(btn, _onToolResultExpand);
        btn.dataset.bound = '1';
      }
    } else {
      // 全过滤掉了,placeholder 文案 mark 一下,让用户知道流是动的
      // 但当前模式下没东西显示。
      _setLoadingText('Running… (no visible events; toggle "Show all events" to see thinking/tools)');
    }

    // 不管 html 空不空,renderedLines 都要 advance,否则下次 poll 同一行
    // 又 parse 一遍。
    container.dataset.renderedLines = String(allLines.length);

    // 重 scroll 到底,如果之前就在底。requestAnimationFrame 等浏览器
    // layout 完新 DOM 才量 scrollHeight,否则量的是 append 前的旧值。
    if (wasAtBottom && stream) {
      requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
    }
  } else if (already === 0 && allLines.length === 0) {
    // tail 文件存在但还没行
    _setLoadingText('Waiting for first event…');
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

// Mobile-only 加成绑定:scroll 监听 + workspace-new-events fab。
// turn-toggle / tool-result-fold / _loadTurnEvents bootstrap / 停 poll
// 这一套 bindWorkspaceColHandlers 已经做了(renderMobileWorkspaceDetail
// 调它在前),这里再绑一次会:
//   - turn-toggle 同一按钮挂两个 click handler,点 1 次跑 2 次 → 状态翻
//     2 次抵消,看着像"没反应"
//   - _loadTurnEvents 同一 runId 并发 2 次 fetch /tail,两个 async 都跑
//     to 渲染,大量 event duplicate(用户反馈"event 经常重复")
// 所以这里只留 mobile 特定的两个,避免跟 bindWorkspaceColHandlers 重叠。
function _bindWorkspaceSessionHandlers(root, name) {
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
  const newEvents = root.querySelector('.workspace-new-events');
  if (newEvents) {
    newEvents.addEventListener('click', _onWorkspaceNewEventsClick);
    _addTapFallback(newEvents, _onWorkspaceNewEventsClick);
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
  // 同步整个 turn 里所有 .turn-caret(head 的 ▶/▼ + foot 的 ▲ 之类):
  // 收起态都用 ▶,展开态都用 ▼。Foot 按钮的 ▲ 是装饰性的,被覆盖也无妨
  // —— foot 收起时整个 CSS 隐藏,文字看不到。head 是关键,必须同步。
  for (const caret of turn?.querySelectorAll('.turn-caret') || []) {
    caret.textContent = next ? '▼' : '▶';
  }
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
  // 重写为 turn-streaming 复用版(2026-05-16):整个 run-detail 现在
  // 就是一个 expanded turn —— USER 块装 prompt、.turn-events 装 thinking/
  // tool_use/tool_result/text/result 五种结构化 event,同 workspace
  // detail 完全一致。原来的 Prompt / Output / Approvals 折叠 / Transcript
  // 折叠 / Live output 5 段堆叠下线,设计图 §3.5 本来就说要砍。
  //
  // 调用入口:
  //   - 工作区 turn 列表里点 turn(其实没指向 #runs 了,turn-streaming
  //     原地展开),但 cron card 的"→ open"链接 + 飞书的"打开 PWA"
  //     卡片都还指向 #runs/<id>,所以这个 route + render 保留。
  //   - 看着像 workspace detail 的"剥离单个 turn"小视图。
  //
  // Terminal run 缓存:已 done/failed 的 run 数据不会再变,缓存命中
  // 时跳过 fetch + repaint —— 用户在 PWA 里翻历史 run 不会 1s 一次
  // 把同一条 run 重新拉一遍。
  const cached = runDetailCache[id];
  if (cached && (cached.status === 'done' || cached.status === 'failed')) {
    if (!$('view').querySelector('.turn[data-run-id]')) paintRunDetail(id, cached);
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
// Running runs:跳过 repaint —— turn-streaming 内部的 _loadTurnEvents
// 2.5s 自己 poll /tail,events 自动续,父级不用 rerender 添乱。
const _lastPaintedStatus = {};

function paintRunDetail(id, row) {
  const status = row.status || '?';
  const view = $('view');
  // Running + already painted with same status → skip the innerHTML
  // rewrite。turn-streaming 的 _loadTurnEvents 自己 poll,父级 rerender
  // 反而会清空 .turn-events 容器,触发 reload,白白浪费一次 /tail。
  const alreadyPainted = view.querySelector(`.turn[data-run-id="${esc(id)}"]`);
  if (alreadyPainted && status === 'running' && _lastPaintedStatus[id] === 'running') {
    return;
  }
  _lastPaintedStatus[id] = status;

  // Build turn data from /runs/{id} 返回值。直接给 turn.expanded = true,
  // 渲染就是一个展开的 turn —— USER 块 + .turn-events 容器,完全套用
  // workspace detail 那套 UI。
  const turn = {
    id: row.id || id,
    status,
    prompt: row.prompt || '',
    started_at: row.started_at,
    elapsed_s: row.elapsed_s,
    exit_code: row.exit_code,
    expanded: true,
  };

  // Back link → 这个 run 所属的 workspace,跟之前一致。
  const backHref = row.workspace
    ? `#workspaces/${encodeURIComponent(row.workspace)}`
    : '#workspaces';
  const backLabel = row.workspace ? esc(row.workspace) : 'Workspaces';
  view.innerHTML = `
    <p><a href="${backHref}" class="back-link run-back-link">← ${backLabel}</a></p>
    <div class="ws-col ws-col-detail">
      <div class="ws-timeline" data-ws="${esc(row.workspace || '')}">
        ${_workspaceTurnHtml(turn)}
      </div>
    </div>
  `;
  // 复用 workspace detail 的同一套 handler:绑 turn-toggle / tool-result-fold,
  // bootstrap _loadTurnEvents(已展开的 turn 会自动加载)。
  bindWorkspaceColHandlers(view);
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
        // 历史 run 现在渲染成 turn-collapsed,patch path 也要 rewire turn
        // 交互。用 _bindTurnInteractions(不停 poll)避免干掉别的 row 还
        // 活着的 timer。
        _bindTurnInteractions(fresh);
      } else {
        existingList.insertAdjacentHTML('beforeend', newHtml);
        _loopRowCache.set(name, newHtml);
        // Bind the new row's handlers.
        const fresh = existingList.querySelector(`.loop-row[data-loop-name="${esc(name)}"]`);
        if (fresh) {
          _bindTurnInteractions(fresh);
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
    : '<p class="muted">No cron loops yet. Click "+ New cron loop" above.</p>';
  // Toolbar(跟 Workspaces tab 一致):h1 砍掉(topbar tab 已标明),
  // + New 单独按钮 + 点击弹 dialog modal,创建表单平时不占空间。
  view.innerHTML = `
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="task-new-btn">+ New cron loop</button>
    </div>
    <div class="task-list">${rows}</div>
    <dialog class="ws-new-dialog" id="task-new-dialog">
      <form data-form-id="new-loop" class="ws-new-form">
        <h3>New cron loop</h3>
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+"
          placeholder="daily-digest" required autofocus></label>
        <label>workspace
          ${_renderFormPicker({
            name: 'workspace',
            options: workspaces.map((w) => ({ value: w, label: w })),
            value: workspaces[0] || '',
          })}
        </label>
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
        <p class="muted" style="font-size:11px;margin:0">
          Engine 跟 workspace 设置走。State 落在 <code>~/.cc-state/jobs/&lt;name&gt;.json</code>;cron 行写 <code>/etc/cron.d/cc-loops</code>。
        </p>
        <div class="ws-new-actions">
          <button type="button" class="ws-new-cancel">Cancel</button>
          <button type="submit">Add</button>
        </div>
      </form>
    </dialog>
  `;

  $('view').querySelector('form[data-form-id="new-loop"]')
    ?.addEventListener('submit', onAddLoop);
  $('view').querySelector('.parse-btn')
    ?.addEventListener('click', onParseNl);
  for (const b of $('view').querySelectorAll('.run-now-btn, .pause-btn, .resume-btn, .delete-btn')) {
    b.addEventListener('click', onLoopAction);
  }
  // loopHistoryHtml 现在每条历史 run 渲染成 turn-collapsed,需要 wire
  // turn-toggle / tool-result-fold + 停 poll + 启动已展开 turn 的 event
  // load。bindWorkspaceColHandlers 已经把这一套封装好了,直接复用。
  bindWorkspaceColHandlers($('view'));
  // Dialog open/close。原生 <dialog> 自带 backdrop / ESC,只 wire open
  // 按钮 + cancel。form submit 成功后 onAddLoop 里 form.closest('dialog')?
  // .close() 就关掉(下面把 onAddLoop 也改了)。
  const dlg = $('task-new-dialog');
  const openBtn = $('task-new-btn');
  if (dlg && openBtn) {
    openBtn.addEventListener('click', () => { if (!dlg.open) dlg.showModal(); });
    dlg.querySelector('.ws-new-cancel')?.addEventListener('click', () => dlg.close());
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

// 计算 loop 当前 "task-level" 状态:综合 enabled / latest run.status /
// stale 失败计数。跟 sparkline 当前格 + task-card border / 大字 state
// 公用一个语义。
function _loopComputedStatus(loop) {
  const enabled = !!loop.enabled;
  const stale = (loop.consecutive_errors || 0) >= 3;
  const recentRuns = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
  const latestRun = recentRuns[0] || null;
  const latestRunning = latestRun && (latestRun.status === 'queued' || latestRun.status === 'running');
  if (!enabled) return 'paused';
  if (latestRunning) return 'running';
  if (stale || (loop.last_exit != null && loop.last_exit !== 0)) return 'failed';
  return 'done';
}

// Sparkline:7 格小色块,看 cron 健康度(设计图 §3.2)。
//   ✓ green   = done(exit 0)
//   ✕ red     = failed(exit != 0 或 status=failed)
//   ● cyan    = running(只可能在最后一格)
//   空格 gray = 还没跑(< 7 次历史)
// 输入 recent_runs(newest first,最多 5 条历史 — 后端目前只存 5)+
// 当前 loop status。不足 7 格用 placeholder 补齐。
function _sparklineHtml(loop) {
  const recent = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
  // 设计图要 Last 7,recent 最多 5(后端 cron_state 限制),前端补齐就好。
  // 顺序:最老在左,最新在右。recent 是 newest-first → 反转后切尾 7 个。
  const reversed = [...recent].reverse();
  const slots = [];
  const padCount = Math.max(0, 7 - reversed.length);
  for (let i = 0; i < padCount; i++) {
    slots.push({ kind: 'empty' });
  }
  for (const r of reversed) {
    if (r.status === 'running' || r.status === 'queued') {
      slots.push({ kind: 'running' });
    } else if (r.status === 'failed' || (r.exit_code != null && r.exit_code !== 0)) {
      slots.push({ kind: 'failed' });
    } else {
      slots.push({ kind: 'done' });
    }
  }
  const okCount = slots.filter((s) => s.kind === 'done').length;
  const ranCount = slots.filter((s) => s.kind !== 'empty').length;
  const pct = ranCount > 0 ? Math.round((okCount / ranCount) * 100) : null;
  const cells = slots.map((s) => {
    if (s.kind === 'done') return '<span class="spark spark-done" title="ok">✓</span>';
    if (s.kind === 'failed') return '<span class="spark spark-failed" title="failed">✕</span>';
    if (s.kind === 'running') return '<span class="spark spark-running" title="running">●</span>';
    return '<span class="spark spark-empty" title="—">·</span>';
  }).join('');
  return `
    <span class="sparkline" title="Last ${slots.length} runs (success rate ${pct ?? '—'}%)">
      ${cells}
      ${pct != null ? `<span class="spark-pct muted">${pct}%</span>` : ''}
    </span>
  `;
}

// 紧凑 task list row:
//   行 1 meta:dot + name + state + sparkline + schedule + next-fire + workspace
//   行 2 prompt:▸ loop.prompt 首行(粗体)
//   行 3 reply preview:↳ latest run output_preview(2 行 clamp)
// 整张卡片可点 → #tasks/<name> detail。设计图 §3.2 列表紧凑,但用户反馈
// "光 name + state 不直观,看不出 cron 干啥的",所以加 prompt + reply
// 两行 —— 跟 workspace overview turn 的 2 行 layout 对齐,信息密度 vs
// 列表紧凑做折中。
function loopRowHtml(loop) {
  const loopStatus = _loopComputedStatus(loop);
  const schedule = loop.schedule || '';
  const humanSched = schedule ? humanizeCron(schedule) : '—';
  const nextLabel = loop.enabled ? nextRunLabel(schedule) : '';
  const schedTitle = schedule && humanSched !== schedule ? ` title="${esc(schedule)}"` : '';
  const stale = (loop.consecutive_errors || 0) >= 3;
  const recentRuns = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
  const latest = recentRuns[0];
  const promptSummary = (loop.prompt || '').split(/\r?\n/).find((l) => l.trim()) || '';
  const replyRaw = latest ? String(latest.output_preview || '').trim() : '';
  const replyPreview = replyRaw
    ? replyRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== '…').join(' ').slice(0, 400)
    : '';
  return `
    <a class="row loop-row loop-row-link ${loopStatus}"
       data-loop-name="${esc(loop.name)}"
       href="#tasks/${encodeURIComponent(loop.name)}">
      <div class="loop-row-meta">
        <span class="task-dot ${esc(loopStatus)}"></span>
        <code class="loop-name">${esc(loop.name)}</code>
        <span class="loop-row-state muted">${esc(loopStatus)}</span>
        ${_sparklineHtml(loop)}
        <span class="loop-row-spec muted">
          <span${schedTitle}>${esc(humanSched)}</span>
          ${nextLabel ? ` · ${esc(nextLabel)}` : ''}
          · <code>${esc(loop.workspace || '—')}</code>
          ${stale ? ` · <span class="tag-failed">stale ×${esc(loop.consecutive_errors)}</span>` : ''}
        </span>
      </div>
      ${promptSummary ? `<div class="loop-row-prompt">▸ ${esc(promptSummary)}</div>` : ''}
      ${replyPreview ? `<div class="loop-row-reply">↳ ${esc(replyPreview)}</div>` : ''}
    </a>
  `;
}

// ---------- Task detail view (#tasks/<name>) ----------
// 设计图 03 §1:cron 跑出来的内容跟 workspace turn 是同一种东西,详情页
// 主区域 = 最近一次 run 的 stream(turn-streaming),周边再加 task 级
// 信息(sparkline / schedule / prompt / 齿轮控制)。
function renderTaskDetailView(name) {
  const loops = Array.isArray(lastData.loops) ? lastData.loops : [];
  const loop = loops.find((l) => l.name === name);
  const view = $('view');
  if (!loop) {
    view.innerHTML = `
      <p><a href="#tasks" class="back-link">← Tasks</a></p>
      <p class="muted">Task <code>${esc(name)}</code> not found.</p>
    `;
    return;
  }

  const loopStatus = _loopComputedStatus(loop);
  const enabled = !!loop.enabled;
  const stale = (loop.consecutive_errors || 0) >= 3;
  const schedule = loop.schedule || '';
  const humanSched = schedule ? humanizeCron(schedule) : '—';
  const nextLabel = enabled ? nextRunLabel(schedule) : '';
  const schedTitle = schedule && humanSched !== schedule ? ` title="${esc(schedule)}"` : '';
  const recentRuns = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
  const latestRun = recentRuns[0] || null;
  const latestRunning = latestRun && (latestRun.status === 'queued' || latestRun.status === 'running');

  // Latest run → expanded turn(无内联 input,无 cancel-on-turn —— 设计
  // §3.4 cancel 在 task header 右下,本 phase 暂用 turn 自带 cancel)。
  const streamHtml = latestRun
    ? _workspaceTurnHtml({
        id: latestRun.id || '',
        status: latestRun.status || (latestRun.exit_code === 0 ? 'done' : 'failed'),
        prompt: loop.prompt || '(cron)',
        started_at: latestRun.started_at,
        elapsed_s: latestRun.elapsed_s,
        exit_code: latestRun.exit_code,
        output_preview: latestRun.output_preview || '',
        expanded: true,
      })
    : `<p class="muted task-empty">Not yet run. ${nextLabel ? `Will trigger ${esc(nextLabel)}.` : ''} Or tap ⚙ → Run now.</p>`;

  // 齿轮菜单(设计图 §3.5):SCHEDULE / RUN / 删除 三段,复用 ws-actions-menu
  // 的样式。Cron 行右侧显示表达式(常驻 ID-like 信息);Pause/Resume 文
  // 案根据 enabled 切换;Run now 在 running 时 disabled。
  // (Cron / Prompt edit 这次 phase 1 不做,纯展示,标 "edit in cron file"
  // 提示用户去 ssh 改 cron.d。)
  const gearMenuHtml = `
    <details class="workspace-gear ws-actions-menu" data-details-id="task-detail-menu-${esc(name)}">
      <summary class="workspace-gear-trigger ws-actions-trigger" aria-label="Task settings">${ICONS.settings}</summary>
      <div class="workspace-menu ws-actions-menu-body">
        <div class="ws-menu-section">
          <span class="ws-menu-section-label">Schedule</span>
          <div class="ws-menu-item ws-menu-readonly">
            <span>Cron</span>
            <code class="muted">${esc(schedule || '—')}</code>
          </div>
          <div class="ws-menu-item ws-menu-readonly">
            <span>Workspace</span>
            <code class="muted">${esc(loop.workspace || '—')}</code>
          </div>
        </div>
        <div class="ws-menu-section">
          <span class="ws-menu-section-label">Run</span>
          <button class="run-now-btn ws-menu-item" type="button" data-name="${esc(name)}" ${latestRunning ? 'disabled' : ''}>
            ${ICONS.running} <span>Run now ${latestRunning ? '(running…)' : ''}</span>
          </button>
          ${enabled
            ? `<button class="pause-btn ws-menu-item" type="button" data-name="${esc(name)}">
                 ${ICONS.paused} <span>Pause</span>
               </button>`
            : `<button class="resume-btn ws-menu-item" type="button" data-name="${esc(name)}">
                 ${ICONS.running} <span>Resume</span>
               </button>`}
        </div>
        <button class="delete-btn ws-menu-item ws-menu-item-danger" type="button" data-name="${esc(name)}">
          ${ICONS.trash} <span>Delete task</span>
        </button>
      </div>
    </details>
  `;

  view.innerHTML = `
    <div class="task-detail ${loopStatus}" data-task-name="${esc(name)}">
      <div class="task-topbar">
        <a class="workspace-back" href="#tasks" aria-label="Back to tasks">←</a>
        <div class="workspace-title">
          <strong>${esc(name)}</strong>
          <span>${esc(loopStatus)}${nextLabel ? ` · ${esc(nextLabel)}` : ''}</span>
        </div>
        ${gearMenuHtml}
      </div>
      <div class="task-spec">
        <span class="loop-when"${schedTitle}>${esc(humanSched)}</span>
        · <code>${esc(loop.workspace || '—')}</code>
        ${loop.engine ? ` · <span class="muted">${esc(loop.engine)}</span>` : ''}
        ${stale ? ` · <span class="tag tag-failed">${ICONS.warning}stale ${esc(loop.consecutive_errors)}</span>` : ''}
      </div>
      ${_sparklineHtml(loop)}
      ${loop.prompt
        ? `<div class="task-prompt">
             <div class="task-section-label">Prompt</div>
             <pre>${esc(loop.prompt)}</pre>
           </div>`
        : ''}
      <div class="task-stream">
        <div class="task-section-label">Latest run</div>
        ${streamHtml}
      </div>
    </div>
  `;

  // Wire 齿轮菜单内的 cron 动作 + turn 交互(reused workspace handler)。
  bindWorkspaceColHandlers(view);
  for (const b of view.querySelectorAll('.run-now-btn, .pause-btn, .resume-btn, .delete-btn')) {
    b.addEventListener('click', onLoopAction);
  }
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
    // PC 现在把 new-loop 表单装进 dialog,创建成功后关掉;mobile 入口
    // 不在 dialog 里 closest 返回 null,不影响。
    form.closest('dialog')?.close();
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
    showError(err);   // backend 把 hint + fixUrl 塞进 detail,自动渲染 action button
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
function _populateRtModelConfig(mode = 'roundtable') {
  const slot = document.getElementById('rt-model-config-slot');
  if (!slot) return;
  if (!_rtModelsCache) {
    slot.innerHTML = '<p class="muted" style="font-size:11px;margin:0">(模型列表加载失败)</p>';
    return;
  }
  const { models, roles } = _rtModelsCache;
  // 按 mode 过滤显示的角色:
  //  - roundtable: 4 派 persona + synthesizer + reviewer(不含 1v1 的 proponent)
  //  - oneonone: proponent(正方 / 反方)+ synthesizer(共用整理员)
  // 后端 /oneonone /roundtables 都各自只接受 mode 域的 role_models,
  // 这里 UI 提前过滤避免用户改了不被读的字段心智混乱。
  const visibleRoles = (mode === 'oneonone')
    ? roles.filter((r) => r.kind === 'proponent' || r.kind === 'synthesizer')
    : roles.filter((r) => r.kind !== 'proponent');
  const saved = _loadRtRoleModels();
  slot.innerHTML = visibleRoles.map((r) => _renderRoleModelPicker(r, models, saved)).join('') + `
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
  const kindHint = role.kind === 'synthesizer' ? '<span class="muted rt-role-kind">(整理员)</span>'
                  : role.kind === 'reviewer' ? '<span class="muted rt-role-kind">(审查员)</span>'
                  : role.kind === 'proponent' ? '<span class="muted rt-role-kind">(1v1 对抗)</span>'
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
    : '<p class="muted">还没有评议。先写一个问题,4 派评议(广)或 1v1 对抗(深)替你辩论。</p>';
  // Empty-state blurb:第一次用解释两种 mode,有 session 了就不显示。
  const blurb = rows.length === 0 ? `
    <p class="muted" style="margin-top:-8px">
      <strong>4 派评议</strong>:4 个角色(极简派 / 场景派 / 借鉴派 / 悲观派)对决策问题各抒己见,
      整理员综合 → <em>共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动</em>。
      <strong>1v1 对抗</strong>:把二值问题拆成正反两个立场死磕同一分歧轴(做 / 不做 / 用 / 不用)。
    </p>` : '';
  // toolbar + dialog 模式,跟 Workspaces / Tasks tab 一致。
  view.innerHTML = `
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="rt-new-btn">+ 新建</button>
      <a href="#settings/roles" class="ws-toolbar-link"
         style="margin-left:12px;font-size:13px;text-decoration:none;color:var(--accent)">
        ⚙ 角色配置
      </a>
    </div>
    ${blurb}
    <div class="rt-list">${list}</div>
    <dialog class="ws-new-dialog" id="rt-new-dialog">
      <form data-form-id="new-roundtable" class="ws-new-form">
        <h3>新建评议</h3>
        <div class="rt-mode-row" id="rt-mode-row">
          <label class="rt-mode-label">模式</label>
          ${_renderFormPicker({
            name: 'mode',
            options: [
              { value: 'roundtable', label: '4 派评议(广 · 9-13 调用)' },
              { value: 'oneonone', label: '1v1 对抗(深 · 5 调用)' },
            ],
            value: 'roundtable',
          })}
        </div>
        <p class="muted" id="rt-mode-blurb" style="font-size:11px;margin:0">
          4 个角色对决策各抒己见,整理员综合给条件性结论。
        </p>
        <label>问题(决策级,不是事实问题)
          <textarea name="question" required rows="3" autofocus
            id="rt-question-input"
            placeholder="例:个人 side project 一开始就上严格 TDD,还是先 spike?"></textarea>
        </label>
        <label class="rt-attach-row">
          <span>参考文件(可选,仅文本,合计 ≤ 100KB)</span>
          <input type="file" multiple accept="text/*"
                 id="rt-attach-input">
        </label>
        <div class="rt-rounds-row" id="rt-rounds-row">
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
        <div class="ws-new-actions">
          <button type="button" class="ws-new-cancel">Cancel</button>
          <button type="submit">开始辩论</button>
        </div>
      </form>
    </dialog>
  `;
  $('view').querySelector('form[data-form-id="new-roundtable"]')
    ?.addEventListener('submit', onCreateRoundtable);
  for (const b of $('view').querySelectorAll('.rt-delete')) {
    b.addEventListener('click', onDeleteRoundtable);
  }
  const dlg = $('rt-new-dialog');
  const openBtn = $('rt-new-btn');
  if (dlg && openBtn) {
    openBtn.addEventListener('click', () => { if (!dlg.open) dlg.showModal(); });
    dlg.querySelector('.ws-new-cancel')?.addEventListener('click', () => dlg.close());
  }
  // mode picker change → 切换 form 显示(隐藏轮数 / 改 blurb / 切换 model 列表)
  $('rt-mode-row')?.addEventListener('click', _onRtModeChange);
  // Populate the model config block. Cache-hot path is synchronous; cold
  // path fetches once, then patches the slot only (textarea / open state
  // stay intact thanks to the existing snapshot/restore + draft system).
  const currentMode = $('view').querySelector('input[name="mode"]')?.value || 'roundtable';
  if (_rtModelsCache) {
    _populateRtModelConfig(currentMode);
  } else {
    ensureRoundtableModels().then(() => _populateRtModelConfig(currentMode));
  }
}

// Mode picker 切换时 触发 form 重排:隐藏 / 显示轮数;改 blurb;切换 placeholder;
// 重新 populate model config(过滤 1v1 / roundtable 各自的角色)。
// 用 click delegation 而不是 change event,跟 _onFormPickerClick 同样的事件
// 序列 — 它会先把 hidden input 改完,再冒泡到这里。
function _onRtModeChange(e) {
  if (!e.target.closest('.form-picker-radio')) return;
  const mode = document.querySelector('input[name="mode"]')?.value || 'roundtable';
  const roundsRow = document.getElementById('rt-rounds-row');
  if (roundsRow) roundsRow.style.display = mode === 'oneonone' ? 'none' : '';
  const blurb = document.getElementById('rt-mode-blurb');
  if (blurb) blurb.textContent = mode === 'oneonone'
    ? '把二值问题拆成正反两个立场死磕同一分歧轴(做 / 不做 / 用 / 不用)。'
    : '4 个角色对决策各抒己见,整理员综合给条件性结论。';
  const ta = document.getElementById('rt-question-input');
  if (ta) ta.placeholder = mode === 'oneonone'
    ? '例:是否应该上严格 TDD?(必须是二值决策)'
    : '例:个人 side project 一开始就上严格 TDD,还是先 spike?';
  _populateRtModelConfig(mode);
}

function _roundtableListRow(r) {
  const status = r.status || 'queued';
  const when = r.started_at
    ? new Date(r.started_at * 1000).toLocaleString()
    : '';
  // turns_expected: 9 for critique_rounds=1, 13 for critique_rounds=2.
  // Old sessions without the field in their meta fall back to 9 via backend.
  const expected = r.turns_expected || 9;
  // status 已经在 .rt-status 显示(✓ 完成 / ◯ 失败 / ● round X/Y),
  // progress 字段补充 turn 计数,done/error 时不再重复 status 文字。
  const progress = status === 'done'
    ? `${expected} 轮`
    : status === 'error'
      ? `${r.turns_done || 0} / ${expected} 轮`
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
    // === 客户端附件处理(spec §3.3) ===
    const attachInput = form.querySelector('#rt-attach-input');
    const fileList = attachInput?.files || [];
    // 总字节预校验 — 100KB hard limit,与 backend _ROUNDTABLE_ATTACHMENT_MAX_BYTES 一致。
    // 避免上传大文件后才到 413(spec suggestion #6)。
    const totalBytes = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > 100 * 1024) {
      showError(`参考文件合计 ${(totalBytes / 1024).toFixed(1)}KB,超过 100KB 上限。拆小或只贴关键段。`);
      return;     // finally 段仍会执行,重置按钮
    }

    let attachments = [];
    if (fileList.length > 0) {
      const formData = new FormData();
      for (const f of fileList) formData.append('files', f);
      const upResp = await fetch('/roundtable-uploads', {
        method: 'POST', body: formData, credentials: 'same-origin',
      });
      if (!upResp.ok) {
        throw new Error(`upload 失败 (HTTP ${upResp.status}): ${await upResp.text()}`);
      }
      const upData = await upResp.json();
      attachments = upData.paths || [];
    }
    // === 附件处理结束 ===

    const mode = fd.mode || 'roundtable';
    // role_models 按 mode 过滤 — 4 派 不能误把 1v1 正方/反方 的 override 发给
    // /roundtables(后端会 400);1v1 同理。_populateRtModelConfig 已经只显示
    // 当前 mode 的角色,但 localStorage 里的老 override 可能还在,这里再过一遍。
    const roundtableRoles = new Set(['极简派', '场景派', '借鉴派', '悲观派', '整理员', '审查员']);
    const oneononeRoles = new Set(['正方', '反方', '整理员']);
    const allowedRoles = mode === 'oneonone' ? oneononeRoles : roundtableRoles;
    const filteredOverrides = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (allowedRoles.has(k)) filteredOverrides[k] = v;
    }

    const body = { question: fd.question };
    if (Object.keys(filteredOverrides).length > 0) body.role_models = filteredOverrides;
    if (attachments.length > 0) body.attachments = attachments;

    let endpoint;
    if (mode === 'oneonone') {
      endpoint = '/oneonone';
      // 1v1 不用 critique_rounds(backend 锁定 R1+R2 / max_auto_drills=0)
    } else {
      endpoint = '/roundtables';
      if (rounds === 2) body.critique_rounds = 2;
    }

    const r = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    form.reset();
    form.closest('dialog')?.close();
    const toastMsg = mode === 'oneonone'
      ? `1v1 已开:${r.stance_a} vs ${r.stance_b}`
      : `4 派评议已开:${r.id}`;
    showToast('success', toastMsg, { ttl: 3000 });
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
  if (!confirm(`删除评议 "${id}"?\n.jsonl 文件会被删,无法恢复。`)) return;
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

// Role 渲染顺序按 mode 分。4 派评议 = 4 个 persona 固定顺序;1v1 对抗 = 正反 2 个。
// `_getRoleOrder(mode)` 是 detail view 唯一入口,不直接 import 常量。
const _ROLE_ORDER_ROUNDTABLE = ['极简派', '场景派', '借鉴派', '悲观派'];
const _ROLE_ORDER_ONEONONE = ['正方', '反方'];
function _getRoleOrder(mode) {
  return mode === 'oneonone' ? _ROLE_ORDER_ONEONONE : _ROLE_ORDER_ROUNDTABLE;
}

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
  // reviewer 状态也纳入 sig:hit_max_drills 或 next_question 变化时强制重绘
  const reviewer = row.reviewer || null;
  const reviewerKey = reviewer
    ? `${reviewer.hit_max_drills ? '1' : '0'}:${reviewer.converged ? '1' : '0'}`
    : 'null';
  const sig = `${status}:${turnsDone}:${hasR3 ? '1' : '0'}:${errorKey}:${reviewerKey}`;

  const view = $('view');
  const alreadyPainted = view.querySelector(`.rt-detail[data-rt-id="${esc(id)}"]`);
  if (alreadyPainted && _lastRtPainted[id] === sig) {
    return;
  }
  _lastRtPainted[id] = sig;

  // Group every non-synth turn by round. We don't hardcode {1,2} anymore —
  // critique_rounds=2 sessions have R3 critique turns (round=3, type=critique)
  // that need their own grid block.
  // auto-drill / 续问 会产生 round >= synth_round+1 的 follow_up / review /
  // user_question turns,动态收集所有 round,不再 pre-allocate 固定上限。
  const critiqueRounds = row.critique_rounds || 1;
  const turnsByRound = {};
  for (const t of (row.turns || [])) {
    if (t.type === 'synth') continue;    // synth is handled by row.r3 below
    if (!turnsByRound[t.round]) turnsByRound[t.round] = {};
    turnsByRound[t.round][t.role] = t.content;
  }
  // 保底:round 1..critiqueRounds+1 总是存在(空 session 时也能渲染占位槽)
  for (let r = 1; r <= critiqueRounds + 1; r++) {
    if (!turnsByRound[r]) turnsByRound[r] = {};
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
  // show what's done so far). 遍历所有 discovered round(含 auto-drill 续问
  // 产生的 round >= critiqueRounds+2),按 round 升序排列。
  const roundBlocks = [];
  for (const rKey of Object.keys(turnsByRound).sort((a, b) => +a - +b)) {
    const r = +rKey;
    const cells = _getRoleOrder(row.mode).map((name) => _rtCell(name, turnsByRound[r][name])).join('');
    const label = _RT_ROUND_LABELS[r] || `续问 Round ${r}`;
    roundBlocks.push(_rtRoundBlock(label, cells));
  }

  // 审查员 banner:仅当 hit_max_drills 且有 next_question 时显示,提示用户
  // 继续追问(自动追问已到上限,需人工续问)。
  const bannerHtml = (reviewer && reviewer.hit_max_drills && reviewer.next_question) ? `
    <div class="rt-reviewer-banner">
      <p>⚠ 审查员认为还没收敛(已达自动追问上限)</p>
      <p><strong>建议继续追问:</strong> ${esc(reviewer.next_question)}</p>
      <button class="rt-continue-prefill" data-question="${esc(reviewer.next_question)}">
        一键续问
      </button>
    </div>` : '';

  // 续问输入框:session 已有至少一个 synth turn 时才显示(status=done 或
  // r3 存在)。进行中的 session 还没 synth,不显示。
  // 跟新建 form 同款 UX:textarea + 附件 + 右下提交按钮。Cmd/Ctrl+Enter
  // 提交,Enter 保持换行(textarea 标准行为)。
  const continueInputHtml = (r3 || status === 'done') ? `
    <div class="rt-continue-input">
      <textarea data-rt-followup placeholder="继续问...(Cmd/Ctrl+Enter 提交)" rows="3"></textarea>
      <div class="rt-continue-row">
        <label class="rt-continue-attach">
          <span>📎 附件(可选,文本 ≤ 100KB)</span>
          <input type="file" multiple accept="text/*" data-rt-continue-attach>
        </label>
        <button class="rt-continue-submit" data-session-id="${esc(id)}">继续问</button>
      </div>
    </div>` : '';

  $('view').innerHTML = `
    <p><a href="#roundtables" class="back-link">← Roundtable</a></p>
    <h1 class="rt-question">${esc(row.question || '(无题)')}</h1>
    <div class="rt-meta">
      ${statusTag(status === 'done' ? 'done' : status === 'error' ? 'failed' : 'running')}
      <span class="rt-mode-chip">${row.mode === 'oneonone' ? '1v1 对抗' : '4 派评议'}</span>
      ${when ? `<span class="muted">· ${esc(when)}</span>` : ''}
      <span class="muted">· ${esc(turnsDone)} / ${esc(expected)} 轮</span>
    </div>
    ${errorBlock}
    <div class="rt-detail" data-rt-id="${esc(id)}">
      ${synthBlock}
      ${roundBlocks.join('')}
      ${bannerHtml}
      ${continueInputHtml}
    </div>
  `;

  // 事件绑定:每次 innerHTML 重建后重新绑(polling 触发重绘时也会执行)。

  // 一键续问:把 banner 里的 next_question 填进 textarea
  view.querySelectorAll('.rt-continue-prefill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const q = e.currentTarget.dataset.question;
      const ta = view.querySelector('textarea[data-rt-followup]');
      if (ta) { ta.value = q; ta.focus(); }
    });
  });

  // 续问提交:POST /roundtables/{id}/continue { question, attachments? }
  // 附件 upload 跟 onCreateRoundtable 同款 flow:先 POST /roundtable-uploads
  // 拿 paths,再随 question 一起 POST /continue。
  const submitContinue = async (btn) => {
    const sessionId = btn.dataset.sessionId;
    const ta = view.querySelector('textarea[data-rt-followup]');
    const question = (ta?.value || '').trim();
    if (!question) return;
    const attachInput = view.querySelector('input[data-rt-continue-attach]');
    const fileList = attachInput?.files || [];
    const totalBytes = Array.from(fileList).reduce((s, f) => s + f.size, 0);
    if (totalBytes > 100 * 1024) {
      showError(`参考文件合计 ${(totalBytes / 1024).toFixed(1)}KB,超过 100KB 上限。拆小或只贴关键段。`);
      return;
    }
    btn.disabled = true;
    btn.textContent = '提交中...';
    try {
      let attachments = [];
      if (fileList.length > 0) {
        const formData = new FormData();
        for (const f of fileList) formData.append('files', f);
        const upResp = await fetch('/roundtable-uploads', {
          method: 'POST', body: formData, credentials: 'same-origin',
        });
        if (!upResp.ok) {
          throw new Error(`upload 失败 (HTTP ${upResp.status}): ${await upResp.text()}`);
        }
        const upData = await upResp.json();
        attachments = upData.paths || [];
      }
      const body = { question };
      if (attachments.length > 0) body.attachments = attachments;
      await api(`/roundtables/${encodeURIComponent(sessionId)}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (ta) ta.value = '';
      if (attachInput) attachInput.value = '';    // 清空已选文件
      // 后端返回 202 并启动新一轮评议;下一次 refreshAll poll 会拉到新
      // turns 并自动触发重绘,无需手动 refresh。
    } catch (err) {
      showError(`续问失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '继续问';
    }
  };

  view.querySelectorAll('.rt-continue-submit').forEach((btn) => {
    btn.addEventListener('click', () => submitContinue(btn));
  });
  // Cmd/Ctrl+Enter 提交(主流 chat 工具惯例)。Enter 单独按保持换行
  // (textarea 默认行为,不绑 preventDefault 即可)。
  view.querySelectorAll('textarea[data-rt-followup]').forEach((ta) => {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const btn = view.querySelector('.rt-continue-submit');
        if (btn && !btn.disabled) submitContinue(btn);
      }
    });
  });
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

// ---------- Command palette (Cmd+K / Ctrl+K) ----------
// C 改造(易用性 §3):快捷跳转 — workspaces / tasks / roundtables /
// settings / search,不用点 3 次 nav。`/keyword` 前缀直接转 #search 全文搜。
// PC keyboard 优先(mobile 没物理键盘,用 #search 路由替代)。

let _paletteOpen = false;
let _paletteSelectedIdx = 0;
let _paletteResults = [];

function _openCommandPalette() {
  let palette = document.getElementById('command-palette');
  if (!palette) {
    palette = document.createElement('div');
    palette.id = 'command-palette';
    palette.className = 'command-palette';
    palette.innerHTML = `
      <div class="cmd-palette-backdrop"></div>
      <div class="cmd-palette-box">
        <input class="cmd-palette-input" type="search" autocomplete="off"
               placeholder="跳 workspace / task / 设置;/<词> 搜历史">
        <div class="cmd-palette-results"></div>
        <div class="cmd-palette-footer muted">↑↓ 选 · Enter 跳 · Esc 关 · /<词> 全文搜历史</div>
      </div>
    `;
    document.body.appendChild(palette);
    const input = palette.querySelector('.cmd-palette-input');
    input.addEventListener('input', () => _updatePaletteResults(input.value));
    input.addEventListener('keydown', _onPaletteKey);
    palette.querySelector('.cmd-palette-backdrop').addEventListener('click', _closeCommandPalette);
  }
  palette.classList.add('open');
  _paletteOpen = true;
  _paletteSelectedIdx = 0;
  const input = palette.querySelector('.cmd-palette-input');
  input.value = '';
  input.focus();
  _updatePaletteResults('');
}

function _closeCommandPalette() {
  const palette = document.getElementById('command-palette');
  if (palette) palette.classList.remove('open');
  _paletteOpen = false;
}

// 收集所有"可跳转"的项:workspaces / tasks / roundtables / settings 入口。
// 历史 prompt 不直接列(数量可能几百,palette 不适合),用 `/keyword` 转 #search。
function _gatherPaletteItems() {
  const items = [];
  for (const ws of lastData.workspaces || []) {
    items.push({ icon: '📁', label: ws, sub: 'Workspace', href: `#workspaces/${encodeURIComponent(ws)}` });
  }
  for (const loop of lastData.loops || []) {
    items.push({
      icon: '⏰',
      label: loop.name,
      sub: `Task${loop.schedule ? ' · ' + loop.schedule : ''}`,
      href: `#tasks/${encodeURIComponent(loop.name)}`,
    });
  }
  for (const rt of lastData.roundtables || []) {
    items.push({
      icon: '🎯',
      label: rt.question || rt.id || '(untitled)',
      sub: 'Roundtable',
      href: `#roundtables/${encodeURIComponent(rt.id)}`,
    });
  }
  // 顶级 nav + settings 入口(常用动作)
  items.push({ icon: '🔍', label: 'Search history', sub: 'Settings', href: '#search', aliases: ['搜索', 'find'] });
  items.push({ icon: '⚙', label: 'Providers', sub: 'Settings', href: '#settings/providers', aliases: ['llm', 'api', 'provider'] });
  items.push({ icon: '⚙', label: 'Settings', sub: 'Nav', href: '#settings' });
  items.push({ icon: '🏠', label: 'Workspaces', sub: 'Nav', href: '#workspaces' });
  items.push({ icon: '✓', label: 'Tasks', sub: 'Nav', href: '#tasks' });
  items.push({ icon: '🎯', label: 'Roundtables', sub: 'Nav', href: '#roundtables' });
  return items;
}

function _updatePaletteResults(rawQuery) {
  const q = (rawQuery || '').trim();
  // 特殊语法:`/<keyword>` → 直接转 #search,query 自动填入 search 框
  if (q.startsWith('/')) {
    const kw = q.slice(1);
    _paletteResults = [{
      icon: '🔍',
      label: `搜历史:${kw || '(输入关键词)'}`,
      sub: kw ? `跳到 #search?q=${kw}` : '继续输入或 Enter',
      onSelect: () => {
        _closeCommandPalette();
        location.hash = '#search';
        // 等 render 完了把 query 填到 search 框
        setTimeout(() => {
          const inp = document.querySelector('.search-input');
          if (inp && kw) {
            inp.value = kw;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, 80);
      },
    }];
  } else {
    const items = _gatherPaletteItems();
    const lc = q.toLowerCase();
    _paletteResults = q
      ? items.filter((i) =>
          i.label.toLowerCase().includes(lc) ||
          (i.aliases || []).some((a) => a.toLowerCase().includes(lc)),
        )
      : items.slice(0, 24);   // 空 query 显示前 24 个(workspaces + nav + settings)
  }
  _paletteSelectedIdx = 0;
  _renderPaletteResults();
}

function _renderPaletteResults() {
  const palette = document.getElementById('command-palette');
  if (!palette) return;
  const container = palette.querySelector('.cmd-palette-results');
  if (_paletteResults.length === 0) {
    container.innerHTML = '<div class="cmd-palette-empty muted">无匹配。试 `/<关键词>` 全文搜历史。</div>';
    return;
  }
  container.innerHTML = _paletteResults.map((r, i) => `
    <div class="cmd-palette-item${i === _paletteSelectedIdx ? ' is-selected' : ''}" data-idx="${i}">
      <span class="cmd-palette-icon">${r.icon || ''}</span>
      <div class="cmd-palette-text">
        <div class="cmd-palette-label">${esc(r.label)}</div>
        ${r.sub ? `<div class="cmd-palette-sub muted">${esc(r.sub)}</div>` : ''}
      </div>
    </div>
  `).join('');
  for (const el of container.querySelectorAll('.cmd-palette-item')) {
    el.addEventListener('click', () => {
      _paletteSelectedIdx = parseInt(el.dataset.idx, 10);
      _executePaletteSelected();
    });
    el.addEventListener('mousemove', () => {
      const i = parseInt(el.dataset.idx, 10);
      if (i !== _paletteSelectedIdx) {
        _paletteSelectedIdx = i;
        _renderPaletteResults();
      }
    });
  }
  // 滚到选中项
  const sel = container.querySelector('.cmd-palette-item.is-selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function _onPaletteKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    _closeCommandPalette();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    _paletteSelectedIdx = Math.min(_paletteSelectedIdx + 1, _paletteResults.length - 1);
    _renderPaletteResults();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _paletteSelectedIdx = Math.max(_paletteSelectedIdx - 1, 0);
    _renderPaletteResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    _executePaletteSelected();
  }
}

function _executePaletteSelected() {
  const item = _paletteResults[_paletteSelectedIdx];
  if (!item) return;
  if (item.onSelect) {
    item.onSelect();
  } else if (item.href) {
    _closeCommandPalette();
    location.hash = item.href;
  }
}

// 全局快捷键:Cmd+K (Mac) / Ctrl+K (Win/Linux)。捕获到任何 input 焦点状态
// 都生效(用户能从输入框直接呼出 palette)。再次按 Cmd+K 切换 close。
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (_paletteOpen) _closeCommandPalette();
    else _openCommandPalette();
  }
});

// ---------- Search view (#search) ----------
// D 改造(易用性 §3):全文搜索历史 runs 的 prompt + reply。后端走 SQLite
// LIKE(KISS,见 backend/db.search_runs),前端 250ms debounce 输入 → 调
// /search?q=&limit=50 → 列表显示 + 高亮关键词。
// 入口:Settings hub 一个 link。后续 C(命令面板)做了之后,Cmd+K 也能搜。

function renderSearchView() {
  const view = $('view');
  // 从 hash 拿初始 q(如果 #search?q=xxx 这种形式 — 当前 parseRoute 不解析
  // query string,后续可以加;现在 hash 是单纯 #search)
  view.innerHTML = `
    <div class="search-page">
      <h2 style="margin:0 0 var(--space-3)">Search history</h2>
      <form class="search-form" id="search-form">
        <input class="search-input" name="q" type="search" autocomplete="off"
               placeholder="搜历史 prompt / claude reply(至少 2 个字)" autofocus>
      </form>
      <div class="search-results" id="search-results">
        <p class="muted">输入关键词查 runs 历史 — 在 prompt 和 reply 文本里 case-insensitive 子串匹配。</p>
      </div>
    </div>
  `;
  const input = view.querySelector('.search-input');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(() => _doSearch(q), 250);   // debounce 250ms,避免每个字符都打 backend
  });
  view.querySelector('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    _doSearch(input.value.trim());
  });
}

async function _doSearch(q) {
  const results = document.getElementById('search-results');
  if (!results) return;
  if (!q || q.length < 2) {
    results.innerHTML = '<p class="muted">输入至少 2 个字符开始搜索。</p>';
    return;
  }
  results.innerHTML = '<p class="muted">Searching…</p>';
  try {
    const rows = await api(`/search?q=${encodeURIComponent(q)}&limit=50`);
    if (!Array.isArray(rows) || rows.length === 0) {
      results.innerHTML = `<p class="muted">没找到含 <code>${esc(q)}</code> 的 run。换个关键词试试。</p>`;
      return;
    }
    results.innerHTML = `
      <div class="search-result-count muted">${rows.length} 条匹配(按时间倒序)</div>
      ${rows.map((r) => _searchResultRow(r, q)).join('')}
    `;
  } catch (err) {
    showError(err);
    results.innerHTML = '<p class="muted">搜索失败,看 toast 详情。</p>';
  }
}

function _searchResultRow(r, query) {
  const when = timeAgo(r.started_at);
  const elapsed = r.elapsed_s ? `${r.elapsed_s}s` : '';
  const status = r.status || '?';
  const statusClass = status === 'done' ? 'done' : (status === 'failed' || status === 'error' ? 'failed' : 'running');
  return `
    <a class="search-result" href="#workspaces/${encodeURIComponent(r.workspace)}">
      <div class="search-result-head">
        <strong>${esc(r.workspace)}</strong>
        <span class="tag tag-${statusClass}">${esc(status)}</span>
        <span class="muted">${esc(r.source || '')} · ${esc(when)}${elapsed ? ' · ' + esc(elapsed) : ''}</span>
      </div>
      <div class="search-result-prompt">
        <span class="search-field-label">prompt</span>
        <span>${_highlight(r.prompt_preview || '', query)}</span>
      </div>
      ${r.output_preview ? `
        <div class="search-result-output">
          <span class="search-field-label">reply</span>
          <pre>${_highlight(r.output_preview, query)}</pre>
        </div>
      ` : ''}
    </a>
  `;
}

// 把命中的 query 子串包成 <mark>。case-insensitive,跟后端 LIKE 行为一致。
// 注意:先 esc 防 XSS,再 regex replace —— 否则 query 里的 < > 会破坏 DOM。
function _highlight(text, query) {
  if (!text) return '';
  const escaped = esc(text);
  if (!query) return escaped;
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${safe})`, 'gi');
  return escaped.replace(re, '<mark>$1</mark>');
}

// ---------- Settings views (#settings / #settings/providers) ----------
// 配置可视化第一弹:providers.json 可以在 PWA 里加 / 改 / 删 / 测连通性,
// 不用 ssh。secrets.toml / workspaces.json 是后续子项,目前 Settings hub
// 里显示成 disabled placeholder。

function renderSettingsView() {
  const view = $('view');
  view.innerHTML = `
    <h2 style="margin:0 0 var(--space-3)">Settings</h2>
    <div class="settings-hub">
      <a class="settings-card" href="#search">
        <div class="settings-card-title"><strong>Search history</strong> 🔍</div>
        <div class="muted">全文搜索历史 run 的 prompt 和 claude reply(找回上次跟 claude 讨论过的某事)</div>
      </a>
      <a class="settings-card" href="#settings/providers">
        <div class="settings-card-title"><strong>Providers</strong></div>
        <div class="muted">LLM 服务商配置:API key / base URL / model;加 / 改 / 删 / 测连通性</div>
      </a>
      <a class="settings-card" href="#settings/agents">
        <div class="settings-card-title"><strong>Subagents</strong></div>
        <div class="muted">管理 <code>~/.claude/agents/</code> 下的 Claude Code 子代理(code-dev / code-review / 你自己加的)</div>
      </a>
      <div class="settings-card is-disabled">
        <div class="settings-card-title"><strong>Secrets</strong> <span class="tag">soon</span></div>
        <div class="muted">登录用户名/密码 / 飞书 token。目前要 ssh 改 <code>~/.cc-workflow/secrets.toml</code></div>
      </div>
      <div class="settings-card is-disabled">
        <div class="settings-card-title"><strong>Workspaces</strong> <span class="tag">partial</span></div>
        <div class="muted">每 workspace 的 trust / provider 已能在 workspace 详情页 ⚙ 改。完整管理(批量 / engine 切换)待后续</div>
      </div>
    </div>
  `;
}

function renderSettingsSectionView(section) {
  if (section === 'providers') return renderSettingsProvidersView();
  if (section === 'roles') return renderSettingsRolesView();   // 角色默认 model 配置
  if (section === 'agents') return renderSettingsAgentsView();
  // 未知 section → 退回 hub(避免白屏)
  window.history.replaceState(null, '', '#settings');
  renderSettingsView();
}

function renderSettingsProvidersView() {
  const view = $('view');
  const list = lastData.providers || [];
  const rows = list.map(_settingsProviderRow).join('');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link">← Settings</a></p>
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="provider-new-btn">+ New provider</button>
    </div>
    ${list.length
      ? `<div class="providers-list">${rows}</div>`
      : '<p class="muted">还没有 provider。点 + New provider 加一个(deepseek / kimi / claude 等)。</p>'}

    <dialog class="ws-new-dialog" id="provider-dialog">
      <form class="ws-new-form" id="provider-form">
        <h3 id="provider-dialog-title">New provider</h3>
        <input type="hidden" name="original_name" value="">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+" required placeholder="deepseek"></label>
        <label>base URL <input name="base_url" type="url" required placeholder="https://api.deepseek.com/anthropic"></label>
        <label>model <input name="model" required placeholder="deepseek-chat"></label>
        <label>API key
          <input name="api_key" type="password" autocomplete="off" placeholder="sk-...">
          <span class="muted" style="font-size:11px" id="api-key-hint">必填</span>
        </label>
        <p class="muted" style="font-size:11px;margin:0">
          保存到 <code>~/.cc-workflow/providers.json</code>。改完立即生效(后端每次调用都从 json 读),不用 restart cc-workflow。
        </p>
        <div class="ws-new-actions">
          <button type="button" class="ws-new-cancel">Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </dialog>
  `;
  view.querySelector('#provider-new-btn')?.addEventListener('click', _onProviderNewClick);
  view.querySelector('.ws-new-cancel')?.addEventListener('click', _onProviderCancel);
  view.querySelector('#provider-form')?.addEventListener('submit', _onProviderFormSubmit);
  for (const btn of view.querySelectorAll('.provider-edit-btn')) btn.addEventListener('click', _onProviderEditClick);
  for (const btn of view.querySelectorAll('.provider-delete-btn:not([disabled])')) btn.addEventListener('click', _onProviderDeleteClick);
  for (const btn of view.querySelectorAll('.provider-test-btn')) btn.addEventListener('click', _onProviderTestClick);
}

async function renderSettingsRolesView() {
  const view = $('view');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link">← Settings</a></p>
    <h3 style="margin:0 0 var(--space-2)">Roundtable Roles</h3>
    <p class="muted" style="margin:0 0 var(--space-3)">配每个角色默认用哪个 model。新建 round 表单的 per-role 下拉仍可临时 override 这里的默认。</p>
    <div id="roles-table" class="muted">加载中...</div>`;

  let data;
  try {
    data = await api('/roundtables/models');
  } catch (err) {
    $('roles-table').innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    return;
  }

  const allModels = data.models || [];
  const allRoles = data.roles || [];

  // Vertical stacked cards;model picker 复用 .rt-role-picker /
  // .ws-menu-radio / .ws-radio-dot 风格(跟新建 roundtable 表单一致)。
  // 仅样式复用 — state 模型不同(rt 那边用 localStorage,这里用 DOM
  // is-selected 状态收集到 save 时统一提交)。
  const rows = allRoles.map(role => {
    return `
      <div class="role-config-row" data-role="${esc(role.name)}" data-default-model="${esc(role.default_model)}"
           style="margin-bottom:var(--space-3);padding:var(--space-2);border:1px solid var(--c-border, #333);border-radius:6px">
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:6px">
          <strong>${esc(role.name)}</strong>
          <span class="muted" style="font-size:11px">(${esc(role.kind)})</span>
        </div>
        ${_renderSettingsRoleModelPicker(role, allModels)}
        <details class="role-prompt-toggle" style="margin-top:8px">
          <summary class="muted" style="font-size:11px;cursor:pointer;user-select:none">
            自定义 system_prompt(可选,清空 = 用默认)
          </summary>
          <textarea data-role-prompt="${esc(role.name)}" class="role-prompt-textarea"
                    rows="8"
                    style="width:100%;font-family:monospace;font-size:12px;margin-top:6px;box-sizing:border-box;resize:vertical"
                    placeholder="留空使用 roles.py 的默认 prompt">${esc(role.default_system_prompt || '')}</textarea>
          <button type="button" class="role-prompt-reset ws-new-btn" data-role="${esc(role.name)}"
                  style="margin-top:6px;background:transparent;color:var(--c-fg);font-size:12px">重置为默认(清空 textarea)</button>
        </details>
      </div>`;
  }).join('');

  $('roles-table').innerHTML = `
    <div>${rows}</div>
    <div style="margin-top:var(--space-3);display:flex;gap:var(--space-2);flex-wrap:wrap">
      <button class="ws-new-btn" id="roles-save-btn" type="button">保存</button>
      <button class="ws-new-btn" id="roles-reset-btn" type="button" style="background:transparent;color:var(--c-fg)">全部重置(回 hardcode)</button>
    </div>`;

  // Bind radio click(picker 内部 model 选择,仅更新 DOM 状态,save 时收集)
  for (const btn of document.querySelectorAll('.settings-role-radio')) {
    btn.addEventListener('click', _onSettingsRoleRadioClick);
  }

  $('roles-save-btn').addEventListener('click', _onRolesSave);
  $('roles-reset-btn').addEventListener('click', _onRolesReset);
  for (const btn of document.querySelectorAll('.role-prompt-reset')) {
    btn.addEventListener('click', _onRolePromptReset);
  }
}

// Settings 页的 model picker — 复用 .rt-role-picker / .ws-menu-radio
// 跟新建 roundtable 表单同一视觉语言。state 走 DOM is-selected,
// 不写 localStorage(那是 rt form 的本地草稿);save 时统一从 DOM 收集
// 提交给 backend。radio list 上限 50vh 避免 model 列表过长撑页面。
function _renderSettingsRoleModelPicker(role, models) {
  const current = role.default_model;
  const currentEndpoint = (models.find((m) => m.name === current) || {}).endpoint || '';
  const kindHint = role.kind === 'synthesizer' ? '<span class="muted rt-role-kind">(整理员)</span>'
                  : role.kind === 'reviewer' ? '<span class="muted rt-role-kind">(审查员)</span>'
                  : role.kind === 'proponent' ? '<span class="muted rt-role-kind">(1v1 对抗)</span>'
                  : '';
  const radios = models.map((m) => {
    const selected = m.name === current;
    const rowClass = selected ? 'ws-menu-radio settings-role-radio is-selected' : 'ws-menu-radio settings-role-radio';
    const dotClass = selected ? 'ws-radio-dot is-selected' : 'ws-radio-dot';
    return `
      <button type="button" class="${rowClass}"
              data-settings-role="${esc(role.name)}"
              data-value="${esc(m.name)}"
              data-endpoint="${esc(m.endpoint)}">
        <span class="${dotClass}"></span>
        <span class="ws-radio-label">${esc(m.name)}  ·  ${esc(m.endpoint)}</span>
      </button>`;
  }).join('');
  return `
    <details class="rt-role-picker">
      <summary class="rt-role-summary">
        <span class="rt-role-name">${esc(role.name)} ${kindHint}</span>
        <span class="rt-role-current">${esc(current)} · ${esc(currentEndpoint)}</span>
      </summary>
      <div class="rt-role-radio-list" style="max-height:50vh;overflow-y:auto">${radios}</div>
    </details>`;
}

function _onSettingsRoleRadioClick(e) {
  const btn = e.currentTarget;
  const val = btn.dataset.value;
  const endpoint = btn.dataset.endpoint || '';
  const picker = btn.closest('.rt-role-picker');
  if (!picker) return;
  // 仅在该 picker 内换 is-selected — 不影响别的 role 的 picker。
  for (const b of picker.querySelectorAll('.settings-role-radio.is-selected')) {
    b.classList.remove('is-selected');
    b.querySelector('.ws-radio-dot')?.classList.remove('is-selected');
  }
  btn.classList.add('is-selected');
  btn.querySelector('.ws-radio-dot')?.classList.add('is-selected');
  // 更新 summary 显示
  const summary = picker.querySelector('.rt-role-current');
  if (summary) summary.textContent = `${val} · ${endpoint}`;
  // 收起 details(跟 rt form 同行为)
  picker.open = false;
}

async function _onRolesSave(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '保存中...';

  // 收集 nested {role: {model?, system_prompt?}} — model 从每行 picker
  // 的 .settings-role-radio.is-selected 拿;prompt 从该行 textarea 拿。
  const role_models = {};
  for (const row of document.querySelectorAll('.role-config-row')) {
    const role = row.dataset.role;
    if (!role) continue;
    const selected = row.querySelector('.settings-role-radio.is-selected');
    if (selected) {
      role_models[role] = { model: selected.dataset.value };
    }
    const ta = row.querySelector('textarea[data-role-prompt]');
    if (ta) {
      const prompt = ta.value.trim();
      if (prompt) {
        if (!role_models[role]) role_models[role] = {};
        role_models[role].system_prompt = prompt;
      }
    }
    // 空 prompt 不加字段 → backend 看到只有 model 没 prompt → 清掉 prompt override
  }

  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models }),
    });
    showToast('success', 'role overrides 已保存', { ttl: 2500 });
    // 保存成功后重新 fetch — backend 可能 normalize 值(strip 空白等),
    // 不刷新页面值会跟存盘值不一致。跟 _onRolesReset 对称(I-1 修)。
    renderSettingsRolesView();
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function _onRolesReset(e) {
  if (!confirm('清空所有 role override,所有角色回到 hardcode 默认?')) return;
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '清空中...';
  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models: {} }),
    });
    showToast('success', '已清空所有 override', { ttl: 2500 });
    renderSettingsRolesView();    // 刷新当前页
  } catch (err) {
    showError(`清空失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '全部重置(回 hardcode)';
  }
}

function _onRolePromptReset(e) {
  const role = e.currentTarget.dataset.role;
  const ta = document.querySelector(`textarea[data-role-prompt="${CSS.escape(role)}"]`);
  if (ta) { ta.value = ''; ta.focus(); }
  // 不立即调 API — 用户得点"保存"才真正提交。给个 toast 提示。
  showToast('info', `${role} prompt 已清空 — 点保存才真正回默认`, { ttl: 2500 });
}

// ---- #settings/agents — Claude Code subagent CRUD ---- //

async function renderSettingsAgentsView() {
  const view = $('view');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link">← Settings</a></p>
    <h3 style="margin:0 0 var(--space-2)">Subagents</h3>
    <p class="muted" style="margin:0 0 var(--space-3)">
      管理 user-global subagents(<code>~/.claude/agents/*.md</code>)。改完 Claude Code 立刻生效,无需重启 backend。
    </p>
    <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap">
      <button class="ws-new-btn" id="agent-new-btn" type="button">+ New agent</button>
    </div>
    <div id="agents-list" class="muted">加载中...</div>`;

  let agents;
  try {
    agents = await api('/agents');
  } catch (err) {
    $('agents-list').innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    return;
  }

  if (agents.length === 0) {
    $('agents-list').innerHTML = `<p class="muted">还没有 subagent。点 "+ New agent" 加一个,或 ssh 在 ~/.claude/agents/ 手编。</p>`;
  } else {
    $('agents-list').innerHTML = agents.map((a) => _renderAgentCard(a, false)).join('');
  }

  // Bind events
  $('agent-new-btn').addEventListener('click', _onAgentNewClick);
  for (const btn of document.querySelectorAll('.agent-save-btn')) {
    btn.addEventListener('click', _onAgentSave);
  }
  for (const btn of document.querySelectorAll('.agent-delete-btn')) {
    btn.addEventListener('click', _onAgentDelete);
  }
}

function _renderAgentCard(agent, isNew) {
  const nameHtml = isNew
    ? `<input data-agent-field="name" placeholder="新 agent 名(小写字母/数字/-)" pattern="[a-z0-9][a-z0-9-]*" required style="font-weight:bold;font-size:14px;padding:4px 6px">`
    : `<strong>${esc(agent.name)}</strong>`;
  const summaryDesc = isNew
    ? '<span class="muted">(新建)</span>'
    : `<span class="muted" style="font-size:12px;margin-left:8px">${esc(agent.description || '(no description)')}</span>`;
  const deleteBtn = isNew
    ? ''
    : `<button class="ws-new-btn agent-delete-btn" data-name="${esc(agent.name)}" type="button" style="background:transparent;color:var(--c-fg)">删除</button>`;
  return `
    <div class="agent-card" data-name="${esc(agent.name)}" data-is-new="${isNew ? '1' : '0'}"
         style="margin-bottom:var(--space-3);padding:var(--space-2);border:1px solid var(--c-border, #333);border-radius:6px">
      <details ${isNew ? 'open' : ''}>
        <summary style="cursor:pointer;user-select:none;list-style:none">
          ${nameHtml}
          ${summaryDesc}
        </summary>
        <div style="margin-top:var(--space-2);display:flex;flex-direction:column;gap:var(--space-2)">
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">description(main agent 看这个决定要不要 dispatch)</div>
            <textarea data-agent-field="description" rows="3"
                      style="width:100%;font-size:12px;box-sizing:border-box;resize:vertical">${esc(agent.description || '')}</textarea>
          </label>
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">tools(逗号分隔 — Read, Edit, Bash, Glob, Grep, WebFetch, Skill 等)</div>
            <input data-agent-field="tools" type="text"
                   style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;padding:4px 6px"
                   value="${esc((agent.tools || []).join(', '))}">
          </label>
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">system_prompt(markdown)</div>
            <textarea data-agent-field="system_prompt" rows="20"
                      style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;resize:vertical">${esc(agent.system_prompt || '')}</textarea>
          </label>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button class="ws-new-btn agent-save-btn" data-name="${esc(agent.name)}" type="button">保存</button>
            ${deleteBtn}
          </div>
        </div>
      </details>
    </div>`;
}

function _onAgentNewClick() {
  const list = $('agents-list');
  // 如果 list 当前显示的是"还没有 subagent..." 文案(没有 .agent-card),先清空
  if (list.querySelector('.agent-card') === null) {
    list.innerHTML = '';
  }
  const emptyAgent = { name: '', description: '', tools: [], system_prompt: '' };
  list.insertAdjacentHTML('afterbegin', _renderAgentCard(emptyAgent, true));
  const newCard = list.querySelector('.agent-card[data-is-new="1"]');
  newCard.querySelector('input[data-agent-field="name"]')?.focus();
  // 重新 bind 这张新卡的 save handler(新建卡没有 delete 按钮)
  newCard.querySelector('.agent-save-btn')?.addEventListener('click', _onAgentSave);
}

async function _onAgentSave(e) {
  const btn = e.currentTarget;
  const card = btn.closest('.agent-card');
  if (!card) return;
  const isNew = card.dataset.isNew === '1';
  let name;
  if (isNew) {
    const nameInput = card.querySelector('input[data-agent-field="name"]');
    name = (nameInput?.value || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      showError('agent name 必须匹配 [a-z0-9][a-z0-9-]* 且 ≤64 字');
      nameInput?.focus();
      return;
    }
  } else {
    name = btn.dataset.name;
  }

  const desc = card.querySelector('textarea[data-agent-field="description"]').value;
  const toolsRaw = card.querySelector('input[data-agent-field="tools"]').value;
  const tools = toolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const promptText = card.querySelector('textarea[data-agent-field="system_prompt"]').value;

  btn.disabled = true; btn.textContent = '保存中...';
  try {
    await api(`/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: desc, tools, system_prompt: promptText,
      }),
    });
    showToast('success', `agent "${name}" 已保存`, { ttl: 2500 });
    renderSettingsAgentsView();
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function _onAgentDelete(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.name;
  if (!confirm(`确定删除 subagent "${name}"?\n\n这会删 ~/.claude/agents/${name}.md 文件,Claude Code 之后不再认识这个 agent。`)) {
    return;
  }
  btn.disabled = true; btn.textContent = '删除中...';
  try {
    await api(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('success', `agent "${name}" 已删除`, { ttl: 2500 });
    renderSettingsAgentsView();
  } catch (err) {
    showError(`删除失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '删除';
  }
}

function _settingsProviderRow(p) {
  const dDis = p.is_default ? 'disabled title="default 不能删,先改 config.toml#provider"' : '';
  return `
    <div class="provider-row${p.is_default ? ' is-default' : ''}" data-name="${esc(p.name)}">
      <div class="provider-row-head">
        <strong>${esc(p.name)}</strong>
        ${p.is_default ? '<span class="tag">default</span>' : ''}
      </div>
      <div class="provider-row-body">
        <div class="provider-field"><span class="muted">base_url</span><code>${esc(p.base_url || '—')}</code></div>
        <div class="provider-field"><span class="muted">model</span><code>${esc(p.model || '—')}</code></div>
        <div class="provider-field"><span class="muted">key</span><code>${esc(p.key_masked || '—')}</code></div>
      </div>
      <div class="provider-row-actions">
        <button class="provider-test-btn" type="button" data-name="${esc(p.name)}">Test</button>
        <button class="provider-edit-btn" type="button" data-name="${esc(p.name)}">Edit</button>
        <button class="provider-delete-btn" type="button" data-name="${esc(p.name)}" ${dDis}>Delete</button>
      </div>
    </div>
  `;
}

function _onProviderNewClick() {
  const dlg = document.getElementById('provider-dialog');
  const form = dlg.querySelector('form');
  form.reset();
  form.elements.original_name.value = '';
  document.getElementById('provider-dialog-title').textContent = 'New provider';
  document.getElementById('api-key-hint').textContent = '必填';
  dlg.showModal();
}

function _onProviderEditClick(e) {
  const name = e.currentTarget.dataset.name;
  const p = (lastData.providers || []).find((x) => x.name === name);
  if (!p) return;
  const dlg = document.getElementById('provider-dialog');
  const form = dlg.querySelector('form');
  form.reset();
  form.elements.original_name.value = name;
  form.elements.name.value = name;
  form.elements.base_url.value = p.base_url || '';
  form.elements.model.value = p.model || '';
  form.elements.api_key.value = '';
  document.getElementById('provider-dialog-title').textContent = `Edit ${name}`;
  document.getElementById('api-key-hint').textContent = `留空 = 不改(当前: ${p.key_masked || '(none)'})`;
  dlg.showModal();
}

function _onProviderCancel() {
  document.getElementById('provider-dialog')?.close();
}

async function _onProviderFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const original = form.elements.original_name.value;
  const isEdit = !!original;
  const fd = Object.fromEntries(new FormData(form).entries());
  if (isEdit && original !== fd.name) {
    showError(`不能改 name(${original} → ${fd.name});先 Delete 再 New 一个新的`);
    return;
  }
  const body = {
    name: fd.name,
    base_url: fd.base_url,
    model: fd.model,
    api_key: fd.api_key,
  };
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    if (isEdit) {
      await api(`/providers/${encodeURIComponent(original)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await api('/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    document.getElementById('provider-dialog').close();
    showToast('success', isEdit ? `Provider ${fd.name} 已更新` : `Provider ${fd.name} 已添加`);
    await refreshAll();
    renderSettingsProvidersView();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function _onProviderDeleteClick(e) {
  const name = e.currentTarget.dataset.name;
  if (!confirm(`删除 provider 「${name}」?\nproviders.json 会被改写,不可撤销。`)) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await api(`/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('success', `Provider ${name} 已删除`);
    await refreshAll();
    renderSettingsProvidersView();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

async function _onProviderTestClick(e) {
  const name = e.currentTarget.dataset.name;
  const btn = e.currentTarget;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  try {
    const r = await api(`/providers/${encodeURIComponent(name)}/test`, { method: 'POST' });
    showToast('success', `${name}: ${(r.reply || '(empty)').slice(0, 80)}`, { ttl: 4000 });
  } catch (err) {
    showError(err, { prefix: `${name} test` });
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ---------- boot ----------
render();
refreshAll();
setInterval(refreshAll, 3000);
