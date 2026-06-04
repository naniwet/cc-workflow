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
  STATUS_ACCENTS,
  foldToolResult,
  formatToolUse,
  nextRunLabel,
  parseStreamLinesToEvents,
  roundtablePersonaAvatarsHtml,
  workspaceAutoScrollState,
  workspaceTurnExpansion,
  resolveRunSessionKey,
  filterTurnsBySession,
  isUserSession,
  sessionChipLabel,
  nextSessionKey,
  sessionTileId,
  parseSessionTileId,
  tileKeyFor,
  buildSidebarTree,
  navModelFromTree,
  navModelFromRoundtables,
  navModelFromLoops,
  loadShellState,
  paneStateReducer,
  gitBadgeText,
  hunksToHtml,
  _prunePanes,
} from './ui_contract.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// Minimal markdown renderer — covers what Claude actually emits ~95% of
// the time: **bold**, *italic*, ## headings, - bullets, 1. ordered lists,
// ``` fenced code, `inline code`. Deliberately NOT a full spec (no links /
// images / tables / blockquotes) — keeps the implementation small without
// the corner-case zoo that a real parser inherits. When something real
// breaks, add the specific pattern; don't reach for marked.js.
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
  // Ordered groups: run of `1. foo` lines → one <ol>. Mirrors the bullet
  // rule above; runs AFTER it so the two don't fight over the same line.
  // `\d+\. ` marker is stripped per-line (content already esc'd upstream).
  h = h.replace(/(?:^\d+\. .+\n?)+/gm, (block) => {
    const items = block.split('\n').filter(l => /^\d+\. /.test(l));
    return '<ol>' + items.map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>\n';
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
  // Maximize / minimize corner arrows (kept for potential reuse)
  maximize: `<svg ${_S}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  minimize: `<svg ${_S}><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
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
  const pending = _globalPendingCount();
  const status = $('status');
  if (status) {
    status.innerHTML = `
      ${pending > 0
        ? `<button type="button" class="pending-badge" id="pending-global-badge"
                   title="${esc(pending)} 待审批">${ICONS.warning}<span>${esc(pending)}</span></button>`
        : ''}
      <span class="status-online"><span class="status-dot"></span>在线</span>
      <span class="status-time">· ${esc(new Date().toLocaleTimeString())}</span>
    `;
  }
  // 侧边栏状态点(desktop):topbar desktop 隐藏 → 这里同步反映在线 + 待审批。
  // 有 pending 时点变红 + 角标数字(可点跳转),无 pending 时常驻绿点 = 在线。
  const sbStatus = $('sidebar-status');
  if (sbStatus) {
    sbStatus.classList.toggle('has-pending', pending > 0);
    sbStatus.title = pending > 0 ? `${pending} 待审批` : '在线';
    sbStatus.innerHTML = pending > 0
      ? `<button type="button" class="pending-badge sidebar-pending"
                 id="pending-sidebar-badge" title="${esc(pending)} 待审批">${ICONS.warning}<span>${esc(pending)}</span></button>`
      : `<span class="status-dot"></span>`;
  }
}

document.addEventListener('click', (e) => {
  // 两处 pending badge(topbar + sidebar)共用同一跳转逻辑 —— 用 class
  // .pending-badge 匹配,id 各异(#pending-global-badge / #pending-sidebar-badge)。
  const btn = e.target.closest('.pending-badge');
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

// 多 session per workspace。一个 workspace = 一个 repo,但可以并行跑多条独立
// 工作线(session_key),各自 worktree + 分支 + --resume 链。
//   workspaceActiveSession[ws] = 当前选中的 session_key(undefined = "全部"
//     视图:不过滤 timeline,Run 投到默认 pwa-<ws>)。设了具体值 = 过滤
//     timeline 到该 session + Run 投到它。
//   workspaceSessionsList[ws] = {worktree_mode, sessions:[...]} 从
//     GET /workspaces/<ws>/sessions 拉来缓存,detail 页进入时刷新。
const workspaceActiveSession = {};
const workspaceSessionsList = {};

// 用户在 overview "+ 新 session" 声明的、还没跑过 run 的空 session。
// groupBySession 基于 runs,空 session 不在 runs 里不会出 tile —— 这个集合
// 让它先出一个空 tile(用户能往里发第一条 prompt)。in-memory,刷新丢失
// (跟 _promptQueue 一致:还没 run 的声明不持久化)。元素 = sessionTileId。
const _declaredEmptySessions = new Set();

// 这两个是对 ui_contract.mjs 纯函数的薄封装,注入当前 DOM 状态
// workspaceActiveSession[ws]。纯逻辑(命名 / 过滤 / 前缀解析)都在
// ui_contract.mjs,被 pwa-ui-contract.test.mjs 单测覆盖(review W2)。
function activeSessionKey(ws) {
  return resolveRunSessionKey(ws, workspaceActiveSession[ws]);
}
function _filterTurnsBySession(ws, turns) {
  return filterTurnsBySession(ws, turns, workspaceActiveSession[ws]);
}

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
function _enqueuePrompt(ws, prompt, attachments = [], sessionKey = null) {
  if (!_promptQueue[ws]) _promptQueue[ws] = [];
  _promptQueue[ws].push({
    id: `q-${++_promptQueueSeq}`,
    prompt,
    attachments,
    sessionKey,                      // 出队 dispatch 时投到这个 session(null = activeSessionKey)
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
          session_key: next.sessionKey || activeSessionKey(ws),
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

// ─────────────────────────────────────────────────────────────────────────
// PC 侧边栏布局 —— pane 状态 + localStorage 持久化
// (spec: 2026-06-01-pc-sidebar-layout-design.md §3.5)
//
// paneState = { panes:[tileId...], activePaneIdx, expandedRepos:[ws...] }
//   panes / activePaneIdx 的变换归纯函数 paneStateReducer(ui_contract.mjs);
//   expandedRepos 是侧边栏塌缩态,由 dispatchPane 保留透传(reducer 不碰它)。
// 持久化 key 'cc.pcLayout'。Per-browser,不同步到服务器。
// ─────────────────────────────────────────────────────────────────────────
const PC_LAYOUT_KEY = 'cc.pcLayout';
let paneState = null;

// 当前数据下的侧边栏树(单点分桶:复用 groupBySession + buildSidebarTree,
// 不在这另造 groups)。
function _pcSidebarTree() {
  return buildSidebarTree(groupBySession(lastData.workspaces, lastData.sessions));
}

// 默认聚焦:第一个 repo 的默认 tile;无 repo → 空 panes(渲染层出空态)。
function _pcDefaultPanes() {
  const tree = _pcSidebarTree();
  return tree.length ? [tree[0].tileId] : [];
}

function loadPcLayout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PC_LAYOUT_KEY));
  } catch { /* 坏数据 / private mode — 静默回默认 */ }

  const tree = _pcSidebarTree();
  const validTileIds = new Set();
  for (const node of tree) {
    validTileIds.add(node.tileId);
    for (const s of node.sessions) validTileIds.add(s.tileId);
  }

  let panes = _prunePanes(Array.isArray(saved?.panes) ? saved.panes : [], validTileIds);
  // prune 后空(repo/session 全被删 或 首次进入无持久化)→ 回落默认聚焦第一个 repo。
  if (panes.length === 0) panes = _pcDefaultPanes();

  // activePaneIdx 越界夹回有效范围([0, panes.length-1];panes 空时 0)。
  let activePaneIdx = Number.isInteger(saved?.activePaneIdx) ? saved.activePaneIdx : 0;
  activePaneIdx = Math.max(0, Math.min(activePaneIdx, Math.max(0, panes.length - 1)));

  const expandedRepos = Array.isArray(saved?.expandedRepos)
    ? saved.expandedRepos.filter((n) => typeof n === 'string')
    : [];

  paneState = { panes, activePaneIdx, expandedRepos };
  return paneState;
}

function savePcLayout() {
  try {
    localStorage.setItem(PC_LAYOUT_KEY, JSON.stringify(paneState));
  } catch { /* private-mode / quota — 静默跳过 */ }
}

// pane 操作的唯一入口:跑 reducer(panes/activePaneIdx)→ 透传 expandedRepos →
// 持久化 → 重渲染。
function dispatchPane(action) {
  if (!paneState) loadPcLayout();
  const next = paneStateReducer(
    { panes: paneState.panes, activePaneIdx: paneState.activePaneIdx },
    action,
  );
  paneState = { ...next, expandedRepos: paneState.expandedRepos };
  savePcLayout();
  // 重画前后包 snapshot/restore(跟 render() 同风格):dispatchPane 会重建
  // 主区 DOM,不包就会丢掉 pane 里输了一半的草稿 / timeline scroll /
  // <details open>。render() 自己有这层包裹,dispatchPane 是另一条重画入口,
  // 得自己补。
  snapshotDrafts();
  renderDesktopSidebarLayout();
  restoreDrafts();
}

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

// 离开 roundtables / tasks tab 时,关掉挂在 document.body 上、可能还开着的
// +新建 dialog(#rt-new-dialog / #task-new-dialog)。全局宿主让弹窗不随 #view
// 生灭,代价是它不会因导航自动消失 —— 浏览器后退换路由时 modal 会浮在新页上
// (adversarial-review 抓到)。按目标路由收口:不在其 tab 就 close。同 tab 内
// 的轮询不命中(route.name 仍是本 tab),弹窗照常存活(轮询不关弹窗的语义保留)。
function _closeStrayDialogs(route) {
  const onRt = route.name === 'roundtables' || route.name === 'roundtable-detail';
  const onTasks = route.name === 'tasks' || route.name === 'task-detail';
  let closed = false;
  if (!onRt) { const d = document.getElementById('rt-new-dialog'); if (d && d.open) { d.close(); closed = true; } }
  if (!onTasks) { const d = document.getElementById('task-new-dialog'); if (d && d.open) { d.close(); closed = true; } }
  // 关掉 dialog 后,焦点可能还(异步)停在 dialog 的输入框上 → 下面"焦点在
  // input 就 bail"的守卫会误判,导致这一轮 render 不更新视图(要等下次轮询
  // 才切过去)。主动 blur:用户是导航离开(浏览器后退),不是在打字,放行守卫、
  // 本轮就完成路由切换。
  if (closed) document.activeElement?.blur?.();
}

function render() {
  const route = parseRoute();
  // 离开 roundtables / tasks tab 时,关掉挂在 body 上、可能还开着的 +新建
  // dialog。dialog 全局宿主(_ensure*Dialog)让弹窗不随 #view 生灭(好处:
  // 轮询重渲不关弹窗),副作用是浏览器后退换路由时 modal 会浮在新页上。这里
  // 按目标路由收口。**放在焦点守卫之前** —— 即使焦点还困在 dialog 输入框里
  // (modal trap),也能先 close(焦点回 opener 按钮)再正常往下重渲,避免
  // "render 一直 bail、dialog 一直浮着"的卡死。同 tab 内的轮询不命中(route
  // 仍是本 tab),弹窗照常存活。
  _closeStrayDialogs(route);

  // Don't tear DOM out from under a focused input — refresh resumes after blur.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;

  snapshotDrafts();
  const isFreshNav = location.hash !== _lastRenderedHash;
  _lastRenderedHash = location.hash;

  // 统一侧栏(spec §13.2):#sidebar-ctx 默认清空 + 解除收起 rail 态,只有
  // Workspaces desktop 的 renderDesktopSidebarLayout 会重填 repo 树 + 按
  // cc.shell.workspaces.collapsed 设回 is-rail。这样切到 Tasks / 评议 /
  // Settings / 各 detail / mobile overview 既不残留 repo 树,也不会卡在 workspaces
  // 的收起态(那些 tab 的 ctx 为空,rail 无意义 → 全宽显示 app 导航)。单一
  // 接线点,不漏路由。
  const ctx = $('sidebar-ctx');
  if (ctx) ctx.innerHTML = '';
  $('sidebar')?.classList.remove('is-rail');

  // Settings 接统一侧栏(spec §14 阶段 2):desktop 下把 3 个 section 链填进
  // 刚清空的 #sidebar-ctx,跟 Workspaces repo 树占同一槽位;mobile 保持 hub
  // 卡片 / 子页 back-link,ctx 留空。Workspaces 的 ctx 仍由
  // renderDesktopSidebarLayout 在下面重填,不受影响。
  const isDesktop = !window.matchMedia('(max-width: 768px)').matches;
  if (isDesktop && (route.name === 'settings' || route.name === 'settings-section')) {
    const activeSection = route.name === 'settings-section' ? route.id : 'providers';
    renderSettingsSidebarNav(activeSection);
  }

  // Roundtable(评议)接统一侧栏(spec §160):desktop 下裸 #roundtables 和
  // #roundtables/<id> 都把评议列表填进 #sidebar-ctx,active = 当前 detail id
  // (裸列表无 active)。mobile 保持 list + dialog 进 #view(ctx 留空)。
  if (isDesktop && (route.name === 'roundtables' || route.name === 'roundtable-detail')) {
    const activeId = route.name === 'roundtable-detail' ? route.id : null;
    renderRoundtableSidebarNav(activeId);
  }

  // Tasks(cron loops)接统一侧栏(spec §161):desktop 下裸 #tasks 和
  // #tasks/<name> 都把 loop 列表填进 #sidebar-ctx,active = 当前 detail name
  // (裸列表无 active)。mobile 保持 list + dialog 进 #view(ctx 留空)。
  // 跟 Roundtable 同款(renderRoundtableSidebarNav 镜像)。
  if (isDesktop && (route.name === 'tasks' || route.name === 'task-detail')) {
    const activeName = route.name === 'task-detail' ? route.id : null;
    renderTaskSidebarNav(activeName);
  }

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
    renderDesktopSidebarLayout();
  }
}

// PC = 左侧固定侧边栏(两级 workspace ▸ session 导航 + 新建)+ 右侧主区
// (≤4 个聚焦 pane)。2026-06-02 §13.2 统一侧栏后:repo 树(navFull/navRail)
// 渲染进常驻 #sidebar 的 #sidebar-ctx,主区 pane 网格直接进 #view(不再经
// renderShell 包壳)。收起态 .sidebar.is-rail + 收起钮 « / » 见 #sidebar-head。
//
// 数据流:_pcSidebarTree()(= groupBySession + buildSidebarTree 纯函数)→
// navModelFromTree → NavModel 给 nav;同一份 groups 给主区 pane(panes 里
// 的 tileId 直接索引 groups)。pane 状态(paneState)仍由 dispatchPane /
// loadPcLayout 管(§3.5,reducer / 阶梯 / 深链不变)。收起态走独立
// key cc.shell.workspaces(跟 cc.pcLayout 不混)。
function renderDesktopSidebarLayout() {
  // paneState 初始化 / 自愈:首次进入(null)要 load;另外 boot 的第一次
  // render() 跑在 refreshAll() 之前(lastData 还空),此时 _pcDefaultPanes()
  // 拿不到 repo → panes 被锁成空。等数据到了再 render 时,若 panes 仍空但
  // tree 已非空(= 当时数据没就绪锁的空,不是真的没 repo),重新 load 自愈,
  // 否则首屏主区会永远停在"左侧选一个 workspace"空态。
  if (!paneState || (paneState.panes.length === 0 && _pcSidebarTree().length > 0)) {
    loadPcLayout();
  }
  const groups = groupBySession(lastData.workspaces, lastData.sessions);

  // 侧栏 nav(#sidebar-ctx + .sidebar.is-rail + « / » glyph)抽成
  // _renderSidebarNav():它完全不碰 #view,所以收起/展开只需调它,主区 DOM
  // 原地不动(避免重建主区导致的闪抖,见该函数注释)。这里 render 主区前先画 nav。
  _renderSidebarNav();

  // 主区 = pane 网格(布局阶梯 .pc-main[data-pane-count] 不变)。统一侧栏后
  // (spec §13.2)nav 进 #sidebar-ctx,主区直接进 #view(#view 接管原
  // .shell-main 的 flex column 角色 —— 见 style.css #view 规则)。
  //
  // Provider picker — uses the unified form-picker component so dark
  // theming matches the workspace ⋯ menu / roundtable model picker.
  const newWsProviderPicker = _newWsProviderPickerHtml();

  // 主区 = pane 网格,直接进 #view(不再走 renderShell 的 .shell-main 包裹)。
  // new-ws dialog 跟在主区后面(原生 <dialog> 浮层,位置无所谓)。
  const view = $('view');
  view.innerHTML = `<div class="pc-main" data-pane-count="${paneState.panes.length}">${_pcMainHtml(groups)}</div>` + `
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

  // new-ws form 提交绑定(复用现有 onAddWorkspace)。
  $('view').querySelector('form[data-form-id="new-ws"]')
    ?.addEventListener('submit', onAddWorkspace);
  // ws-new-dialog 的 cancel(close)绑定。**它的 open 不再由 #ws-new-btn 直接触发**
  //(方案 A:#ws-new-btn 改开"新对话" dialog,见 _bindSidebarNavHandlers / _openNewChatDialog);
  // ws-new-dialog 现由新对话 dialog 的"或 + 新建 workspace"二级链 showModal。
  // 原生 <dialog> 自带 backdrop / ESC,submit 成功后 close 由 onAddWorkspace 处理。
  $('ws-new-dialog')?.querySelector('.ws-new-cancel')
    ?.addEventListener('click', (e) => e.target.closest('dialog')?.close());

  // 主区 pane 交互(drop 落点 / × 关闭)绑在 #view。nav 交互(focus / 拖拽 /
  // ⇲ / 塌缩 / + 新对话)已由上面 _renderSidebarNav() 绑过(#sidebar-ctx),
  // 这里不再重绑 —— 否则收起/展开重画 ctx 时若也连带重绑 view 部分,会让
  // drop/close 双触发。收起钮 « / »(data-shell-collapse)由 boot 全局绑定
  // (见 bindSidebarCollapse),它在常驻 #sidebar 里不随重画重建。
  _bindViewPaneHandlers($('view'));
  // 主区 pane 内的 trigger / provider / trust / approval / attach / turn 交互
  // (复用 detail / mobile 共享的 binder)。
  bindWorkspaceColHandlers($('view').querySelector('.pc-main'));
}

// 只渲染侧栏 nav(#sidebar-ctx + .sidebar.is-rail + « / » glyph),完全不碰
// #view —— 这是修「PC 收起/展开主区闪抖」bug 的关键:收起钮只需调它,主区
// 那批 DOM 节点原地不动,靠 CSS flex 随侧栏 reflow,不重建 → 不闪。
//
// 收起态(.sidebar.is-rail)用 rail(图标 + repo 首字母),展开态用 full(两级
// 树 + 新建)。repo 树只在「Workspaces 系」路由填进 ctx —— 即 PC 上走
// renderDesktopSidebarLayout 的两条:overview('workspaces')+ 深链单 pane
// ('workspace-detail',见 renderWorkspaceDetailView PC 分支)。其它路由
// (Tasks / Settings / Roundtable / runs)的 #sidebar-ctx 被 render() 清空,
// 这里只 toggle is-rail + glyph,绝不把 repo 树塞进去(rail 态对它们无意义)。
//
// 末尾只绑 #sidebar-ctx 的 nav handler(ctx 被 innerHTML 换新需重绑);#view
// 没动所以不重绑 view 部分(否则 drop/close 双触发)。
const _SIDEBAR_NAV_ROUTES = ['workspaces', 'workspace-detail'];
function _renderSidebarNav() {
  const collapsed = loadShellCollapsed('workspaces');
  const sidebar = $('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('is-rail', collapsed);
    // 收起钮 glyph:展开态显 «(收起),收起态显 »(展开)。aria-label 同步。
    const collapseBtn = sidebar.querySelector('[data-shell-collapse]');
    if (collapseBtn) {
      collapseBtn.textContent = collapsed ? '»' : '«';
      collapseBtn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
    }
  }

  // 只有 Workspaces 系路由的 ctx 装 repo 树。其它路由 ctx 为空 —— 不在这里塞树。
  if (!_SIDEBAR_NAV_ROUTES.includes(parseRoute().name)) return;

  if (!paneState) loadPcLayout();
  const navModel = navModelFromTree(_pcSidebarTree());
  // active 计算:active pane 的 tileId 加 .is-active,所有 open pane 加 .is-open。
  const activeId = paneState.panes[paneState.activePaneIdx];
  const activeIds = new Set(paneState.panes);
  const expandedRepos = new Set(paneState.expandedRepos || []);
  const navOpts = { activeId, activeIds, expandedRepos };

  const ctx = $('sidebar-ctx');
  if (!ctx) return;
  ctx.innerHTML = collapsed
    ? renderNavRail(navModel, navOpts)
    : renderNavFull(navModel, navOpts);

  // ctx 被 innerHTML 换新 → 重绑 nav 交互。#view 没动 → 不在这里绑 view 部分。
  _bindSidebarNavHandlers(ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
// 通用 app shell + nav 组件(spec 2026-06-02-pwa-unified-shell §4.2)
//
// 4 tab(Workspaces / Settings / Roundtable / Tasks)共用同一套布局容器 +
// nav 渲染。本批(阶段 1a)只有 Workspaces 一个真实消费者,但 class /
// 数据契约按"通用组件"钉死(spec §3.2 几乎不可逆)。
//
// 职责边界:shell 只摆 slot(nav full/rail/drawer + main)+ 收起/抽屉机制,
// 不碰业务数据(NavModel 形状 / active / running 全由调用方算好喂进来)。
// ═══════════════════════════════════════════════════════════════════════════

// shell 收起态 localStorage 读写(key cc.shell.<tab>,每 tab 独立)。
// 内部校验归一交给纯函数 loadShellState(ui_contract.mjs);这里只负责
// localStorage IO + try/catch(同 loadPcLayout / savePcLayout 纪律)。
const SHELL_STATE_KEY_PREFIX = 'cc.shell.';
function loadShellCollapsed(tab) {
  let raw = null;
  try { raw = localStorage.getItem(SHELL_STATE_KEY_PREFIX + tab); }
  catch { /* private mode — 静默回默认 */ }
  return loadShellState(raw).collapsed;
}
function saveShellCollapsed(tab, collapsed) {
  try {
    localStorage.setItem(SHELL_STATE_KEY_PREFIX + tab, JSON.stringify({ collapsed: !!collapsed }));
  } catch { /* private-mode / quota — 静默跳过 */ }
}

// 移动端 drawer 开合 = 运行时态,不持久化(spec §4.2)。每次进 app /
// 刷新都从收起开始。模块级 let,shell 渲染读它、☰/backdrop handler 翻它。
let shellDrawerOpen = false;

// rail 态图标兜底:NavItem 无 icon 时取 label 首字 1-2 char(spec §4.2)。
// 中文取 1 字,ASCII 取前 2 字(避免单字母太空)。
function _railGlyph(item) {
  if (item.icon) return item.icon;
  const label = String(item.label || '').trim();
  if (!label) return '·';
  // 第一个码点是 ASCII 字母/数字 → 取前 2 个;否则(中文等)取 1 个。
  return /^[A-Za-z0-9]/.test(label) ? label.slice(0, 2) : Array.from(label)[0];
}

// nav 行的状态点(spec §4.2 扩展:不止 running)。
//   - 'running' → 青色脉冲点(.shell-nav-dot,复用现有脉冲 CSS + aria-label)。
//   - 其它已知 status(done/failed/queued/paused)→ 静态小圆点,颜色内联
//     STATUS_ACCENTS[status](与 mobile overview 同一套色板,单一真相源)。
//   - null(没跑过)/ 未知 status → 不渲点(沉默是金,没活动不占视觉)。
// status 由 buildSidebarTree → navModelFromTree 派生(纯函数,有单测)。
function _navStatusDot(status) {
  if (status === 'running') {
    return '<span class="shell-nav-dot" aria-label="运行中"></span>';
  }
  const color = STATUS_ACCENTS[status];
  if (!color) return '';   // null / 未知 → 不渲
  return `<span class="shell-nav-status-dot" style="background:${color}" aria-label="${esc(status)}"></span>`;
}

// ── nav full 态(取代旧 _pcSidebarHtml)──────────────────────────────────
//
// 按 NavModel 渲染展开态。承接旧 _pcSidebarHtml 全部行为:active(.is-active)
// / open(.is-open)/ 塌缩三角 / +新建动作 / hover ⇲ / running 点。数据源
// 从 tree 换成 NavModel,但 data 钩子保持不变,让 _bindSidebarNavHandlers 委托
// 仍命中。
//
// class 名清单(.shell-nav-* 通用命名,4 tab 复用):
//   .shell-nav-item        每个可聚焦行公共 class(repo / session 都有)
//   .shell-nav-repo        顶层 item 行
//   .shell-nav-session     children 子行
//   .shell-nav-new         newAction 行(顶部"+ 新建")
//   .shell-nav-new-chat    "+ 新对话" 子行(data-new-chat-ws)
//   .shell-nav-toggle      塌缩三角(data-toggle-repo,▸/▾)
//   .shell-nav-label       行内文字
//   .shell-nav-open-beside hover 出的 ⇲ 按钮(data-open-beside)
//   .shell-nav-children    展开后的子行容器
//   .shell-nav-dot         running 青色脉冲点(status==='running')
//   .shell-nav-status-dot  其它状态静态点(done/failed/queued/paused,色靠内联)
//   .is-open / .is-active  高亮态
// data 钩子(保持,_bindSidebarNavHandlers 依赖):data-tile-id / draggable /
//   data-open-beside / data-toggle-repo / data-new-chat-ws。
//
// opts:{ activeId(= active pane 的 tileId,加 .is-active),
//         activeIds(Set,命中加 .is-open),
//         expandedRepos(Set,哪些 ws 展开 children) }
function renderNavFull(navModel, opts = {}) {
  const items = navModel.sections?.[0]?.items || [];
  const activeId = opts.activeId;
  const activeIds = opts.activeIds instanceof Set ? opts.activeIds : new Set(opts.activeIds || []);
  const expanded = opts.expandedRepos instanceof Set ? opts.expandedRepos : new Set(opts.expandedRepos || []);

  const newActionHtml = navModel.newAction
    ? `<div class="shell-nav-toolbar">
         <button class="shell-nav-new ws-new-btn" type="button" id="ws-new-btn">
           ${esc(navModel.newAction.label)}
         </button>
       </div>`
    : '';

  if (!items.length) {
    return newActionHtml
      + '<p class="shell-nav-empty muted">还没有 workspace,点上面 + 新建一个。</p>';
  }

  // 一个可聚焦行(顶层 item / children 子行共用)。leadingHtml 放 label 前
  // (顶层 item 的塌缩三角)。
  const itemRow = (item, kind, leadingHtml = '') => {
    const isOpen = activeIds.has(item.id);
    const isActive = item.id === activeId;
    const cls = `shell-nav-item shell-nav-${kind}`
      + (isOpen ? ' is-open' : '')
      + (isActive ? ' is-active' : '');
    return `
      <div class="${cls}" data-tile-id="${esc(item.id)}" draggable="true">
        ${leadingHtml}
        <span class="shell-nav-label">${esc(item.label)}</span>
        ${_navStatusDot(item.status)}
        <button class="shell-nav-open-beside" type="button"
                data-open-beside="${esc(item.id)}" title="并排打开" aria-label="并排打开">${ICONS.maximize}</button>
      </div>`;
  };

  const treeHtml = items.map((item) => {
    if (!item.children) {
      // 平铺 item(单 session repo,或 Settings/Tasks 这类无 children 的 tab)。
      return itemRow(item, 'repo');
    }
    // 带 children 的 item(多 session repo):顶层行带塌缩三角(点三角 toggle,
    // 行本身仍可聚焦默认 tile);展开后列 children + "+ 新对话"。
    const ws = item.data?.tileId ? parseSessionTileId(item.data.tileId).ws : item.label;
    const open = expanded.has(ws);
    const tri = `<button class="shell-nav-toggle" type="button"
                   data-toggle-repo="${esc(ws)}"
                   aria-expanded="${open ? 'true' : 'false'}"
                   aria-label="${open ? '收起' : '展开'}">${open ? '▾' : '▸'}</button>`;
    const repoRow = itemRow(item, 'repo', tri);
    const childRows = open
      ? `<div class="shell-nav-children">
           ${item.children.map((child) => itemRow(child, 'session')).join('')}
           <button class="shell-nav-item shell-nav-new-chat" type="button"
                   data-new-chat-ws="${esc(ws)}">+ 新对话</button>
         </div>`
      : '';
    return repoRow + childRows;
  }).join('');

  return newActionHtml + `<div class="shell-nav-tree">${treeHtml}</div>`;
}

// ── nav rail 态(52px 图标条,PC 收起态)──────────────────────────────────
//
// 每个顶层 item 显示 icon(无则 label 首字 1-2 char)+ badge 角标 + running
// 点 + active 高亮。children 不在 rail 展开(rail 只到顶层)。底部 » 展开按钮
// (data-shell-collapse,跟 « 同钩子,翻转 collapsed)。
//
// class:.shell-nav-rail-item / .shell-nav-rail-glyph / .shell-nav-rail-badge
// / .shell-nav-dot(复用)/ .is-active。data 钩子 data-tile-id(点 rail 项仍
// 走 focus,_bindSidebarNavHandlers 命中)。
function renderNavRail(navModel, opts = {}) {
  const items = navModel.sections?.[0]?.items || [];
  const activeId = opts.activeId;
  const activeIds = opts.activeIds instanceof Set ? opts.activeIds : new Set(opts.activeIds || []);

  return items.map((item) => {
    const isOpen = activeIds.has(item.id);
    const isActive = item.id === activeId;
    const cls = 'shell-nav-item shell-nav-rail-item'
      + (isOpen ? ' is-open' : '')
      + (isActive ? ' is-active' : '');
    const badge = item.badge
      ? `<span class="shell-nav-rail-badge">${esc(String(item.badge))}</span>`
      : '';
    return `
      <div class="${cls}" data-tile-id="${esc(item.id)}" title="${esc(item.label)}">
        <span class="shell-nav-rail-glyph">${esc(_railGlyph(item))}</span>
        ${badge}
        ${_navStatusDot(item.status)}
      </div>`;
  }).join('');
}

// 弃用(2026-06-02 §13.2 统一侧栏):nav→#sidebar-ctx / main→#view,不再调用;
// 内含的移动端 drawer(.shell-backdrop/.shell-main-chrome)是死代码(Task 12
// 未接),留待清理。
//
// ── shell 容器(布局 + 收起/抽屉机制)────────────────────────────────────
//
// PC 展开:[.shell-nav(navFull) | .shell-main(mainHtml)]
// PC 收起:[.shell-nav.is-rail(navRail) | .shell-main(mainHtml)]  (52px)
// 移动端:  [.shell-main(mainHtml)] 全宽 + ☰;drawerOpen 时 .shell-nav 覆盖层
//           滑出(navFull)+ .shell-backdrop 遮罩。
//
// chrome:« 收起(data-shell-collapse,PC)+ ☰ 抽屉(data-shell-drawer,移动)。
// PC/移动 的显隐由 CSS media query 控,JS 都渲染出来。
//
// 参数:{ tab, navFull, navRail, mainHtml, collapsed, drawerOpen }
//   tab        当前 tab 名(收起记忆 key,handler 翻 collapsed 时用)
//   collapsed  PC 是否收起(true → 用 navRail + .is-rail)
//   drawerOpen 移动端抽屉是否打开(true → .shell.is-drawer-open + backdrop)
function renderShell({ tab, navFull, navRail, mainHtml, collapsed = false, drawerOpen = false }) {
  const railCls = collapsed ? ' is-rail' : '';
  const drawerCls = drawerOpen ? ' is-drawer-open' : '';
  // 收起/展开按钮:展开态显 «(收起),收起态显 »(展开)。都挂 data-shell-collapse,
  // handler 一律翻转 collapsed。
  const collapseGlyph = collapsed ? '»' : '«';
  return `
    <div class="shell${drawerCls}" data-shell-tab="${esc(tab)}">
      <nav class="shell-nav${railCls}" aria-label="${esc(tab)}">
        <div class="shell-nav-chrome">
          <button class="shell-collapse-btn" type="button"
                  data-shell-collapse aria-label="${collapsed ? '展开侧栏' : '收起侧栏'}">${collapseGlyph}</button>
        </div>
        <div class="shell-nav-body">${collapsed ? navRail : navFull}</div>
      </nav>
      <div class="shell-main">
        <div class="shell-main-chrome">
          <button class="shell-drawer-btn" type="button"
                  data-shell-drawer aria-label="打开导航">☰</button>
        </div>
        ${mainHtml}
      </div>
      <div class="shell-backdrop" data-shell-drawer aria-hidden="true"></div>
    </div>`;
}

// 弃用(2026-06-02 §13.2 统一侧栏):配套 renderShell 一起弃用 —— shell chrome
// (« 收起 / ☰ 抽屉 / backdrop)已不渲染进 #view;收起钮改由常驻 #sidebar 里的
// 全局接线 bindSidebarCollapse 处理。本函数已无调用方,留待清理。
function bindShellChrome(tab, rerender) {
  const view = $('view');
  const collapseBtn = view.querySelector('[data-shell-collapse]');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      saveShellCollapsed(tab, !loadShellCollapsed(tab));
      rerender();
    });
  }
  // ☰ 和 backdrop 都带 data-shell-drawer,但语义相反:☰ 开、backdrop 关。
  // 用 .shell-backdrop 区分(backdrop 关,其余开)。
  for (const el of view.querySelectorAll('[data-shell-drawer]')) {
    el.addEventListener('click', () => {
      shellDrawerOpen = !el.classList.contains('shell-backdrop');
      rerender();
    });
  }
}

// 统一侧栏收起钮全局接线(spec §13.2)。« / »(data-shell-collapse)在常驻
// #sidebar 里(不随 render 重建)→ boot 时绑一次,翻 cc.shell.workspaces.collapsed
// → 只调 _renderSidebarNav() 重画侧栏(toggle .sidebar.is-rail + 翻 glyph +
// 重填 #sidebar-ctx)。**不调 render()** —— render 会经 renderDesktopSidebarLayout
// 重建 #view(主区 pane + 对话),那正是「收起/展开主区闪抖」的根因。#view
// 原地不动,靠 CSS flex 随侧栏 reflow,对话 scroll / 草稿都不丢。
// 当前只有 Workspaces tab 有收起态(其它 tab 的 #sidebar-ctx 为空,rail 态无意义)
// —— 故 key 固定 'workspaces';_renderSidebarNav 内部按路由判断,非 workspaces
// 只 toggle is-rail + glyph,不往 ctx 塞 repo 树。
function bindSidebarCollapse() {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  const btn = sidebar.querySelector('[data-shell-collapse]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    saveShellCollapsed('workspaces', !loadShellCollapsed('workspaces'));
    _renderSidebarNav();
  });
}

// 移动端选中一项后收起 drawer(供 nav focus handler 调)。只在 drawer 开着时
// 翻态;翻了由调用方的重画(dispatchPane → renderDesktopSidebarLayout)带出。
function closeShellDrawer() {
  shellDrawerOpen = false;
}

// ── 主区 pane HTML(1~2 个 pane)──────────────────────────────────────────
//
// panes 里每个 tileId → parseSessionTileId → groups[tileId] → 复用
// workspaceColHtml 的 detail 渲染。带 noSessionBar(决策 7:侧边栏即切换器,
// pane 内不再放 chip 条)+ tileId(让 colKey/scroll/draft/queue 按 tileId
// 索引,同 ws 两 pane 不串台,决策 3)。
//
// × 关闭按钮(data-close-pane=idx)在 panes.length>=2 时渲染(§3.3:至少留
// 1 个 pane,1 个时不显示 ×)。空 panes → 空态文字。
// 布局(1=全屏 / 2=左右 / 3=左大右上下 / 4=2×2)全交 CSS:容器 .pc-main 带
// data-pane-count="${panes.length}",grid 模板按 attr 切。JS 不写 grid 内联。
// class 名(交接 Task 11):.pc-pane / .pc-pane-close / .pc-main-empty。
function _pcMainHtml(groups) {
  const panes = paneState.panes;
  if (!panes.length) {
    return '<div class="pc-main-empty muted">左侧选一个 workspace 开始对话。</div>';
  }
  const showClose = panes.length >= 2;
  return panes.map((tileId, idx) => {
    const { ws, sessionKey } = parseSessionTileId(tileId);
    // groups[tileId] 可能不存在:loadPcLayout 只在进 app 时 prune 一次。
    // 本 session 内若 repo/session 被删,失效 tileId 会留在 paneState.panes
    // 直到下次进 app 才被清 —— poll 时不重 prune(那样会有"poll 抢 active
    // pane"副作用)。失效 tile 命中下面的空桶兜底,渲染成"no runs yet"空态,
    // 不崩、不丢数据、下次 loadPcLayout 自愈。(fast-follow:poll-time prune,
    // 见 spec docs/superpowers/specs/2026-06-01-pc-sidebar-layout-design.md §7)
    const data = groups[tileId] || { ws, sessionKey, active: [], recent: [] };
    const closeBtn = showClose
      ? `<button class="pc-pane-close" type="button" data-close-pane="${idx}" aria-label="关闭这个 pane">×</button>`
      : '';
    return `
      <div class="pc-pane" data-pane-idx="${idx}">
        ${closeBtn}
        ${workspaceColHtml(ws, data, { detail: true, sessionKey, tileId, noSessionBar: true })}
      </div>`;
  }).join('');
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
    <!-- 右上角圆 + FAB:主操作 = 新对话(选 workspace 起新 session),对齐 desktop
         #ws-new-btn。建 workspace 降级成 dialog 的"或 + 新建 workspace"二级链 →
         _revealMobileNewWsForm 唤起下面这张 sheet-only 表单(折叠态不渲成 FAB)。 -->
    <button class="mobile-new-chat-fab" id="m-new-chat-fab" type="button" aria-label="新对话">+</button>
    <details class="add-form add-form--sheet-only" data-details-id="add-ws">
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
      : `<p class="muted">还没有 workspace。点右上角 + → "或 + 新建 workspace"。</p>`}
  `;

  const newWsForm = view.querySelector('form[data-form-id="new-ws"]');
  newWsForm?.addEventListener('submit', onAddWorkspace);
  // 圆 + FAB → 新对话 dialog(body-host,_isMobileViewport 决定 [开始] 走 mobile 分支)。
  view.querySelector('#m-new-chat-fab')?.addEventListener('click', _openNewChatDialog);
}

// mobile 建 workspace 入口:新对话 dialog 的"或 + 新建 workspace"二级链调它 ——
// 把 overview 里 sheet-only 的 New-workspace <details> 展开成底部 sheet。仅在
// overview(#workspaces)DOM 里有这张表单;别处调到则优雅 no-op。
function _revealMobileNewWsForm() {
  const det = $('view').querySelector('details[data-details-id="add-ws"]');
  if (det) det.open = true;
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
// 每个 ws 自动拉**成功**一次就记下,避免每次打 / 重复 fetch。失败不记 →
// 下次打 / 能重试(W2:之前在 fetch 前就标记,一次抖动 = 永久静默降级)。
// 手动 Sync 不受影响(它直接 syncSkillsFor 覆盖缓存)。
const _skillsAutoFetched = new Set();
// 进行中守卫:_openOrUpdateSlashPopup 每次按键都触发,防同一 ws 并发多个 fetch。
const _skillsFetching = new Set();

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

// silent=true:自动拉(打 / 触发)时失败不弹 toast —— 用户没主动点,不该被
// 打扰;手动 Sync 按钮仍 silent=false 弹错。失败返 null,caller 据此决定要不要
// 重试(不标记"已拉过")。
async function syncSkillsFor(workspace, { silent = false } = {}) {
  try {
    const items = await api(`/skills?workspace=${encodeURIComponent(workspace)}`);
    _saveSkillsCache(workspace, Array.isArray(items) ? items : []);
    return items;
  } catch (e) {
    if (!silent) showError(e, { prefix: 'sync /commands' });
    return null;
  }
}

// Called when user presses a key in a trigger-form textarea — *before* the
// Enter-to-send check, so the slash popup gets first crack at handling
// Tab/Enter/Esc/Arrow events.
// composer textarea 自增高(spec §4.4,P2 决策:JS 自增,不用 CSS
// field-sizing —— 国产 ROM WebView 不稳)。从 1 行起,按内容 scrollHeight
// 长高,到上限(40vh)后内滚。先归零 height 再读 scrollHeight(否则缩短
// 内容时 scrollHeight 卡在旧高,不会回缩)。只对 .composer-input 生效,
// 旧 textarea(若有残留)不受影响。
function _autosizeComposer(ta) {
  if (!ta || !ta.classList.contains('composer-input')) return;
  const max = Math.round(window.innerHeight * 0.4);
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
}

function _onPromptInput(e) {
  const ta = e.currentTarget;
  _autosizeComposer(ta);
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
  // 缓存空 → 自动拉一次(免得用户必须先手动 Sync。怕记不住命令 = 打 / 就该
  // 看到列表)。_skillsAutoFetched 防重复拉:每个 ws 自动拉一次就够;手动
  // Sync 按钮仍能强制刷新(加了新命令时)。拉完若用户还在打这个 /,重开 popup。
  if (all.length === 0 && filtered.length === 0) {
    if (!_skillsAutoFetched.has(workspace) && !_skillsFetching.has(workspace)) {
      _skillsFetching.add(workspace);                       // in-flight,防并发
      _renderSlashPopupEmpty(textarea, workspace, { loading: true });
      _slashState = { textarea, workspace, items: [], filtered: [], idx: -1, queryStart };
      syncSkillsFor(workspace, { silent: true }).then((items) => {
        _skillsFetching.delete(workspace);
        if (items === null) return;          // 失败 → 不标记 fetched,下次打 / 重试
        _skillsAutoFetched.add(workspace);   // 成功(含空结果)→ 不再自动拉
        if (items.length === 0) return;
        // 用户可能已经走了 / 关了 popup;只在还聚焦该 textarea + / 还在时重开
        if (document.activeElement !== textarea) return;
        const cur = textarea.value.substring(0, textarea.selectionStart);
        const m = cur.match(_SLASH_TRIGGER_RE);
        if (!m) return;
        const q = m[1] || '';
        _openOrUpdateSlashPopup(textarea, workspace, q, textarea.selectionStart - q.length - 1);
      });
      return;
    }
    // 已自动拉过(确实没命令)或正在拉 → 空提示(正在拉时上面已设 loading)
    if (!_skillsFetching.has(workspace)) {
      _renderSlashPopupEmpty(textarea, workspace);
      _slashState = { textarea, workspace, items: [], filtered: [], idx: -1, queryStart };
    }
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

function _renderSlashPopupEmpty(textarea, workspace, { loading = false } = {}) {
  const el = _ensureSlashPopup();
  el.innerHTML = loading
    ? `<div class="slash-popup-empty"><div>加载 / 命令中…</div></div>`
    : `
    <div class="slash-popup-empty">
      <div>没有可用的 / 命令。</div>
      <div class="muted" style="font-size:11px;margin-top:4px">
        在 ~/.claude/commands/ 或 workspace 的 .claude/commands/ 放 .md 命令,
        再点 ⋯ → 🔄 Sync /commands 刷新。
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
  // 移动端软键盘的回车/换行键 = 换行(不发送)—— 手机上没有 Shift+Enter,
  // 软键盘回车当发送会让多行输入很痛(用户反馈"输入法的换行变成发送")。
  // 移动端发送走屏幕上随手可点的 Run 按钮。只有显式 Cmd/Ctrl+Enter(接了
  // 硬件键盘)才在移动端也发送。
  // 2026-05-31:从"mobile 跟 PC 一致 plain Enter 发送"翻案 —— 软键盘场景
  // 换行优先;PC 保持 plain Enter 发送不变(Shift+Enter 换行)。
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile && !e.metaKey && !e.ctrlKey) return;   // 换行,放行默认行为
  // PC plain Enter / 两端 Cmd|Ctrl+Enter = 发送
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
      // 粘贴图片(Cmd/Ctrl+V):捕获剪贴板里的 image blob → 当附件传
      // (跟 📎 同一个 _pendingUploads 管道;claude 收到路径后用 Read 看图)。
      ta.addEventListener('paste', _onPromptPaste);
      // Closing the popup on blur would race the click handler on items
      // (blur fires before click). We pre-prevent the click's default to
      // keep focus, so blur shouldn't fire for clicks. Bind anyway for
      // outside-click via document below.
      ta.addEventListener('blur', () => setTimeout(_closeSlashPopup, 150));
      // composer 自增高初始化:重画后草稿恢复的多行内容需要一次 autosize,
      // 否则停在 1 行高度(input 事件没触发,看不到全文)。
      _autosizeComposer(ta);
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
  // "+ 新 session(同 repo)" —— 在该 session tile 的 ⋯ 菜单里,给同一个
  // workspace 开一条新工作线(<ws>--<name>)。
  for (const btn of root.querySelectorAll('.ws-new-session')) {
    btn.addEventListener('click', _onNewSessionClick);
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
  // Git 区段(spec §4.3):折叠/展开/⟳/点文件懒加载。区段 HTML 已按
  // _gitExpanded / _gitData in-memory 状态渲好(_gitSectionHtml 读它),重渲后
  // 只需重绑 handler — 展开态 + 已拉数据自动恢复,折叠态不触发任何 fetch。
  for (const section of root.querySelectorAll('.git-section')) {
    _bindGitSectionHandlers(section);
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

let _pasteSeq = 0;   // 给没名字的粘贴图片合成唯一文件名

// 粘贴图片到 prompt textarea → 当附件。只拦截图片;纯文本粘贴照常走默认。
function _onPromptPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const form = e.currentTarget.closest('form');
  const ws = form?.dataset.workspace;
  if (!ws) return;
  const images = [];
  for (const it of items) {
    if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
      const f = it.getAsFile();
      if (f) images.push(f);
    }
  }
  if (images.length === 0) return;   // 没图片 → 让默认文本粘贴正常进 textarea
  e.preventDefault();                 // 有图片 → 拦下,别把二进制塞进文本框
  for (let f of images) {
    // 粘贴的图片常常没文件名 → 合成一个带扩展名的(claude 按扩展名认类型)
    if (!f.name) {
      const ext = ((f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')) || 'png';
      f = new File([f], `pasted-${++_pasteSeq}.${ext}`, { type: f.type });
    }
    if ((_pendingUploads[ws] || []).length >= _UPLOAD_MAX_FILES) {
      showError(`最多 ${_UPLOAD_MAX_FILES} 个附件,已跳过粘贴的图片`);
      break;
    }
    if (_totalPendingBytes(ws) + f.size > _UPLOAD_MAX_BYTES) {
      showError(`附件总大小超过 ${_UPLOAD_MAX_BYTES / (1024 * 1024)} MB,已跳过粘贴的图片`);
      continue;
    }
    _addPendingFile(ws, f);
  }
  _renderChips(ws);
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

// Turn 交互的子绑定(tool-result-fold + bootstrap)。
// 抽出来是因为 cron 的 patch path(只换一个 loop-row,不整页重画)也要
// rewire 新 row 里的 turn 元素,但不能跟着调 _stopAllTurnEventsPolls
// —— 那会把别的 loop-row 还活着的 poll 一起干掉。
// v4 去折叠(spec §14.1):turn 永远展开,没有 turn-toggle 可绑;只剩
// tool-result-fold 绑定 + `.turn.turn-expanded` 的 _loadTurnEvents bootstrap。
function _bindTurnInteractions(root) {
  for (const btn of root.querySelectorAll('.tool-result-fold')) {
    btn.addEventListener('click', _onToolResultFoldToggle);
    _addTapFallback(btn, _onToolResultFoldToggle);
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

// PC 侧边栏 + pane 的导航事件(逐元素绑定,贴 bindWorkspaceColHandlers 风格,
// 决策 6;不用 document 级委托)。pane 内的 trigger / provider / trust /
// approval / attach 由 renderDesktopSidebarLayout 单独调 bindWorkspaceColHandlers
// 绑(只绑主区);侧边栏导航 + pane 关闭 + 拖拽落点拆成下面两个 binder。
//
// 交互(决策 5 / Task 9):
//   点 [data-tile-id]        → focus(聚焦到 active pane)         [nav]
//   拖 [data-tile-id] 落主区  → openBeside(开/替换第二 pane)      [nav 拖源 + view 落点]
//   点 [data-open-beside]    → openBeside(⇲ 点击入口,等价拖拽)  [nav]
//   点 [data-close-pane]     → close                              [view]
//   点 [data-toggle-repo]    → toggle expandedRepos(不走 reducer,直接重画)[nav]
//   点 [data-new-chat-ws]    → 自动命名新 session → focus(决策 2,不弹框)[nav]
// 统一侧栏(spec §13.2):nav 项(focus / 拖拽源 / ⇲ / 塌缩三角 / + 新对话)
// 渲染在常驻 #sidebar-ctx 里;主区 pane(drop 落点 / × 关闭)在 #view 里。
// 两个根分开绑(_bindSidebarNavHandlers / _bindViewPaneHandlers)—— 收起/展开
// 只重建 ctx,所以收起 handler 只重绑 nav 部分(经 _renderSidebarNav),绝不重绑
// view 部分(否则 drop/close 双触发)。全量重画走 renderDesktopSidebarLayout:
// _renderSidebarNav() 绑 nav + 末尾 _bindViewPaneHandlers() 绑 view,各一次。

// 绑 #sidebar-ctx 里的 nav 交互(focus / dragstart / open-beside / toggle-repo /
// new-chat)。ctx 被 innerHTML 换新后需重绑;不碰 #view。
function _bindSidebarNavHandlers(ctx) {
  if (!ctx) return;

  // ── 点击 = focus(行内的 ⇲ / 塌缩三角各有自己的 handler,这里要排除)──
  //    full 态 .shell-nav-item 和 rail 态 .shell-nav-rail-item 都带
  //    [data-tile-id] + 公共 .shell-nav-item class,一条选择器同时命中。
  for (const item of ctx.querySelectorAll('.shell-nav-item[data-tile-id]')) {
    item.addEventListener('click', (e) => {
      // 点到行内按钮(⇲ / 三角)交给那些按钮自己处理,不当 focus。
      if (e.target.closest('.shell-nav-open-beside, .shell-nav-toggle')) return;
      // 移动端:在 drawer 里选中一项 → 收 drawer(dispatchPane 的重画带出)。
      closeShellDrawer();
      dispatchPane({ type: 'focus', tileId: item.dataset.tileId });
    });
  }

  // ── 拖拽:dragstart 标记拖拽源(让 click 不误触),drop 落主区 = openBeside ──
  for (const item of ctx.querySelectorAll('.shell-nav-item[data-tile-id]')) {
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.dataset.tileId);
      e.dataTransfer.effectAllowed = 'copy';
    });
  }

  // ── ⇲ 并排打开按钮(决策 5 的点击入口)──
  for (const btn of ctx.querySelectorAll('.shell-nav-open-beside[data-open-beside]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dispatchPane({ type: 'openBeside', tileId: btn.dataset.openBeside });
    });
  }

  // ── 塌缩三角:toggle expandedRepos(只是侧边栏展开态,不动 panes,
  //    所以直接改 paneState.expandedRepos + savePcLayout + 重画,不走 reducer)──
  for (const btn of ctx.querySelectorAll('.shell-nav-toggle[data-toggle-repo]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _togglePcRepo(btn.dataset.toggleRepo);
    });
  }

  // ── + 新对话:自动命名一条新 session(决策 2)→ focus,不弹框 ──
  for (const btn of ctx.querySelectorAll('.shell-nav-new-chat[data-new-chat-ws]')) {
    btn.addEventListener('click', () => _onPcNewChatClick(btn.dataset.newChatWs));
  }

  // ── 顶部 + 按钮(#ws-new-btn,renderNavFull 的 newAction):开"新对话" dialog
  //    (方案 A)。**必须在这里绑** —— #ws-new-btn 在 #sidebar-ctx 里,收起/展开
  //    只重渲 ctx(经 _renderSidebarNav),会重建这个钮;绑定跟它同生命周期才不丢
  //    (task 第 4 点:重渲后要重新绑)。
  ctx.querySelector('#ws-new-btn')?.addEventListener('click', _openNewChatDialog);
}

// 绑 #view 里的主区 pane 交互(.pc-main 的 drop 落点 / .pc-pane-close 的 ×)。
// 只在 #view 被 innerHTML 重建后绑;收起/展开不重建 #view,所以那条路径不调它。
function _bindViewPaneHandlers(view) {
  if (!view) return;

  const main = view.querySelector('.pc-main');
  if (main) {
    main.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    main.addEventListener('drop', (e) => {
      e.preventDefault();
      const tileId = e.dataTransfer.getData('text/plain');
      if (tileId) dispatchPane({ type: 'openBeside', tileId });
    });
  }

  // ── pane × 关闭(在主区 #view)──
  for (const btn of view.querySelectorAll('.pc-pane-close[data-close-pane]')) {
    btn.addEventListener('click', () => {
      dispatchPane({ type: 'close', idx: Number(btn.dataset.closePane) });
    });
  }
}

// 塌缩三角 toggle:翻转某 repo 在 expandedRepos 里的存在性 → 持久化 → 重画
// (snapshot/restore 包裹,保 pane 草稿/scroll,跟 dispatchPane 同理)。
function _togglePcRepo(ws) {
  if (!paneState) loadPcLayout();
  const set = new Set(paneState.expandedRepos || []);
  if (set.has(ws)) set.delete(ws); else set.add(ws);
  paneState = { ...paneState, expandedRepos: Array.from(set) };
  savePcLayout();
  snapshotDrafts();
  renderDesktopSidebarLayout();
  restoreDrafts();
}

// 该 ws 现有的全部 session_key(默认 tile + 用户建的并行线),给 nextSessionKey
// 找不撞序号用。从侧边栏树取 —— 平台无关(buildSidebarTree 纯派生自 lastData)。
function _existingSessionKeys(ws) {
  const node = _pcSidebarTree().find((n) => n.ws === ws);
  const keys = [];
  if (!node) return keys;
  // node.sessions 仅 expandable(≥2)时有;单 session repo 只有默认 tile。
  if (node.sessions.length) {
    for (const s of node.sessions) keys.push(s.sessionKey);
  } else {
    keys.push(parseSessionTileId(node.tileId).sessionKey);
  }
  return keys;
}

// + 新对话(desktop,决策 2):给 ws 声明一条自动命名的新 session(nextSessionKey
// 算不撞序号)→ 注入 _declaredEmptySessions(复用现有空 session 机制,无后端改动)
// → focus 到 active pane。
function _onPcNewChatClick(ws) {
  if (!ws) return;
  const newKey = nextSessionKey(ws, _existingSessionKeys(ws));
  const tileId = sessionTileId(ws, newKey);
  _declaredEmptySessions.add(tileId);
  dispatchPane({ type: 'focus', tileId });
}

// + 新对话(mobile):同 desktop 的命名逻辑,但落点不是 pane 而是 hash 路由 +
// workspaceActiveSession(mobile 无 pane 系统)。声明空 session → 设为该 ws 的
// active(chip 条据此高亮,_sessionBarHtml 会把还没 run 的 active 补进 chip)→
// 跳 #workspaces/<ws> detail。已在该 detail 时直接重画(setHash 同值不触发 render)。
function _startNewChatMobile(ws) {
  if (!ws) return;
  const newKey = nextSessionKey(ws, _existingSessionKeys(ws));
  _declaredEmptySessions.add(sessionTileId(ws, newKey));
  workspaceActiveSession[ws] = newKey;
  const target = `#workspaces/${encodeURIComponent(ws)}`;
  if (location.hash === target) renderWorkspaceDetailView(ws);
  else location.hash = target;
}

// ═══════════════════════════════════════════════════════════════════════════
// "新对话" dialog(方案 A):顶部 + 按钮从"直接开 new-ws"改成"先选 workspace
// 再起新对话"。建-session 逻辑复用 _onPcNewChatClick(ws)(不复制)。二级链
// "或 + 新建 workspace" 关本 dialog → 开现有 ws-new-dialog(建 repo 流程不动)。
//
// 全局宿主三件套(照搬 _ensureTaskNewDialog / _openTaskNewDialog 套路):dialog
// 挂 document.body,与 #view innerHTML 生灭解耦;workspace 下拉用打开那刻的
// lastData.workspaces 现拉(每次打开比对重建)。**只在 PC Workspaces 路由可达**
// (#ws-new-btn 只在 renderNavFull 渲),所以默认 ws / 二级链开的 ws-new-dialog
// 都在那个上下文里成立。
// ═══════════════════════════════════════════════════════════════════════════

// 默认选中 workspace:当前 active pane 的 ws → parseSessionTileId;取不到回落
// lastData.workspaces 第一个;再没有 → 空串。
function _activePaneWs() {
  if (!paneState) loadPcLayout();
  const tileId = paneState?.panes?.[paneState.activePaneIdx];
  if (tileId) {
    const { ws } = parseSessionTileId(tileId);
    if (ws && (lastData.workspaces || []).includes(ws)) return ws;
  }
  return (lastData.workspaces || [])[0] || '';
}

function _newChatDialogHtml() {
  const workspaces = lastData.workspaces || [];
  const defaultWs = _activePaneWs();
  return `
    <dialog class="ws-new-dialog" id="new-chat-dialog">
      <form data-form-id="new-chat" class="ws-new-form">
        <h3>新对话</h3>
        <label>workspace
          ${_renderFormPicker({
            name: 'workspace',
            options: workspaces.map((w) => ({ value: w, label: w })),
            value: defaultWs,
          })}
        </label>
        <p class="muted" style="font-size:11px;margin:0">
          在选中的 workspace 里起一条新对话(独立 worktree + 分支)。
        </p>
        <button type="button" class="new-chat-to-ws">或 + 新建 workspace</button>
        <div class="ws-new-actions">
          <button type="button" class="ws-new-cancel">取消</button>
          <button type="submit">开始</button>
        </div>
      </form>
    </dialog>`;
}

// 幂等挂 body(同 _ensureTaskNewDialog 纪律:已存在直接 return,不重渲/重绑)。
function _ensureNewChatDialog() {
  if (document.getElementById('new-chat-dialog')) return;
  document.body.insertAdjacentHTML('beforeend', _newChatDialogHtml());
  _bindNewChatDialog();
}

// 打开入口(#ws-new-btn 点它):ensure → 若 workspaces 列表 / 默认 ws 变了则重建
// (反映最新 + 默认选中当前 pane 的 ws)→ showModal。重建只在没开着时做。
function _openNewChatDialog() {
  _ensureNewChatDialog();
  let dlg = document.getElementById('new-chat-dialog');
  if (!dlg) return;
  if (!dlg.open) {
    // snapshot 含 ws 列表 + 默认 ws —— 任一变了都重建(默认 ws 跟 active pane 走,
    // 切了 pane 再开应反映新默认)。
    const want = (lastData.workspaces || []).join('\n') + '|' + _activePaneWs();
    if (dlg.dataset.snapshot !== want) {
      dlg.remove();
      document.body.insertAdjacentHTML('beforeend', _newChatDialogHtml());
      dlg = document.getElementById('new-chat-dialog');
      dlg.dataset.snapshot = want;
      _bindNewChatDialog();
    }
  }
  if (!dlg.open) dlg.showModal();
}

// 绑 dialog 逻辑(重建时调一次)。所有选择器锚 dialog 自身。workspace 的
// form-picker 点击由 document 级 _onFormPickerClick 处理,无需在此绑。
function _bindNewChatDialog() {
  const dlg = document.getElementById('new-chat-dialog');
  if (!dlg) return;
  // 开始:取选中 ws → 按平台起新对话(desktop = pane focus / mobile = hash 跳)→
  // 关 dialog。两路都复用 nextSessionKey 命名,差别只在落点。
  dlg.querySelector('form[data-form-id="new-chat"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const ws = e.target.querySelector('input[type="hidden"][name="workspace"]')?.value;
    if (!ws) { showError('请选择一个 workspace'); return; }
    dlg.close();
    if (_isMobileViewport) _startNewChatMobile(ws);
    else _onPcNewChatClick(ws);
  });
  // 取消:关。
  dlg.querySelector('.ws-new-cancel')?.addEventListener('click', () => dlg.close());
  // 二级链:关本 dialog → 建 repo 流程。desktop 开 ws-new-dialog(<dialog> 在
  // renderDesktopSidebarLayout 里);mobile 没有那个 dialog —— 展开 overview 里
  // sheet-only 的 "New workspace" <details>(fixed 底部 sheet,既有 mobile 建 ws 路径)。
  dlg.querySelector('.new-chat-to-ws')?.addEventListener('click', () => {
    dlg.close();
    if (_isMobileViewport) {
      _revealMobileNewWsForm();
    } else {
      const wsDlg = $('ws-new-dialog');
      if (wsDlg && !wsDlg.open) wsDlg.showModal();
    }
  });
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
  const globalDefault = lastData.globalProvider;
  const defaultLabel = globalDefault
    ? `default · ${globalDefault}`
    : 'default';
  const options = [{ value: '', label: defaultLabel }];
  for (const p of list) {
    const n = p.name || p;   // 兼容老 list[str] 格式
    // 跳过等于全局默认的那个 —— "default · <它>" 已经覆盖,再列一遍 = 视觉重复。
    // 跟 _providerRadioListHtml(⋯ 菜单)line 2029 的去重逻辑一致。新建 workspace
    // 没有"已 pin"状态,所以无条件跳过(不像 ⋯ 菜单要留 pin 行)。
    if (n === globalDefault) continue;
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

// 多 session chip 条点击(delegation:mobile + desktop detail 共用)。
// 切 active session(空 data-session = "全部")→ 重画。新建 session 走
// overview tile 的 ⋯ 菜单"+新 session"(_onNewSessionClick),不在 chip 条里。
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.ws-session-chip');
  if (!chip) return;
  const ws = chip.dataset.ws;
  if (!ws) return;
  const key = chip.dataset.session || '';
  workspaceActiveSession[ws] = key || undefined;
  renderWorkspaceDetailView(ws);
});

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
      // 扫的是 commands/*.md(slash 命令)+ skills/*/SKILL.md,两类都在 `/`
      // 自动补全里。统称 "/命令",跟按钮 "Sync /commands" 一致(别只说 skills,
      // 用户反馈"不仅仅是 skills")。
      showToast('success', `${ws}: 同步了 ${items.length} 个 / 命令`, { ttl: 2200 });
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
  // session tile 的按钮带 data-session-key → 操作该 tile 的 session;
  // 老路径退回 activeSessionKey(ws)。
  const sk = btn.dataset.sessionKey || activeSessionKey(ws);
  if (!confirm(
    `开启 "${ws}" 的新对话?(session: ${sk})\n\n` +
    `下一次 prompt 会从一张白纸开始,Claude 不再记得之前聊过什么。\n\n` +
    `(只重置当前选中的 session,其它 session / cron / 飞书不受影响。)`
  )) return;
  btn.disabled = true;
  try {
    const result = await api(
      `/workspaces/${encodeURIComponent(ws)}/session?session_key=${encodeURIComponent(sk)}`,
      { method: 'DELETE' },
    );
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
// "Create PR" 按钮:push 当前 session 的 cc/* 分支到 origin + gh pr create。
// 比直接 merge 进 main 多一层 review。后端 POST /workspaces/{ws}/create-pr,
// gh 没装 / 没 auth 时 graceful 报错(分支仍 push 了,可手动开 PR)。
async function _onMergeToMainClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  const sk = btn.dataset.sessionKey || activeSessionKey(ws);
  if (!confirm(
    `给 "${ws}" 的 session "${sk}" 开 PR?\n\n` +
    `流程:push cc/${ws}-${sk} 到 origin → gh pr create 开到 main 的 PR\n\n` +
    `(需要服务器装了 GitHub CLI 并 gh auth login。没装的话分支会 push 上去,` +
    `你可手动去 GitHub 开 PR。)`
  )) return;
  btn.disabled = true;
  const originalText = btn.querySelector('span')?.textContent || '';
  if (originalText) btn.querySelector('span').textContent = 'Creating PR…';
  try {
    const result = await api(`/workspaces/${encodeURIComponent(ws)}/create-pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_key: sk }),
    });
    const note = result?.note ? `(${result.note})` : '';
    showToast('success', `${ws}: PR ${note} → ${result.pr_url || result.branch}`, { ttl: 5000 });
    refreshAll();
  } catch (err) {
    // backend HTTPException detail 含 error + msg(gh 没装 / 没 auth / push 失败),
    // api() 已把它塞进 err.message,直接 surface。
    showError(`create PR failed: ${err.message}`);
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

// sessionTileId / parseSessionTileId / tileKeyFor 已抽到 ui_contract.mjs(有单测,review W1)。
// 桌面 overview 按 session 平铺用:把 runs 按 (workspace, session_key) 分桶。
// 只保留 PWA 工作线(pwa-<ws> 默认 + <ws>--<name> 用户建的),cron(loop 名)
// / 飞书(feishu-*)的 session 排除 —— 它们有 Tasks tab / 飞书,塞进 overview
// 会刷屏。每个 workspace 保底有默认 session tile(即使没 run,可起新)。
// 返回 { [sessionTileId]: {ws, sessionKey, active, recent} }。
function groupBySession(workspaces, sessions) {
  const valid = new Set(workspaces);
  // 归桶决策(五分支:default / pwa-<ws> / <ws>--* / cron / feishu)在
  // tileKeyFor(ui_contract.mjs,有单测)。这里只迭代组装。
  const g = {};
  // 1. 每个 workspace 保底默认 session
  for (const w of workspaces) {
    g[sessionTileId(w, `pwa-${w}`)] = { ws: w, sessionKey: `pwa-${w}`, active: [], recent: [] };
  }
  // 2. 扫 runs,PWA 工作线归桶(顺便发现用户建的 <ws>--* session)
  const bucket = (list, field) => {
    for (const r of list || []) {
      if (!valid.has(r.workspace)) continue;
      const tileKey = tileKeyFor(r.workspace, r.session_key || `pwa-${r.workspace}`);
      if (!tileKey) continue;     // cron/飞书 → 不出 tile
      const id = sessionTileId(r.workspace, tileKey);
      if (!g[id]) g[id] = { ws: r.workspace, sessionKey: tileKey, active: [], recent: [] };
      g[id][field].push(r);
    }
  };
  bucket(sessions.active, 'active');
  bucket(sessions.recent, 'recent');
  // 3. 用户 "+ 新 session" 声明的空 session(还没 run)也出 tile
  for (const id of _declaredEmptySessions) {
    const { ws, sessionKey } = parseSessionTileId(id);
    if (valid.has(ws) && !g[id]) {
      g[id] = { ws, sessionKey, active: [], recent: [] };
    }
  }
  return g;
}

// "+ 新 session" 处理:提示名 → 声明 <ws>--<name> 空 session → 重画(出新 tile)。
function _onNewSessionClick(e) {
  const btn = e.currentTarget;
  const ws = btn.dataset.ws;
  if (!ws) return;
  _closeAncestorMenu(btn);
  const raw = prompt(`在 "${ws}" 新建一条 session(独立 worktree + 分支)。名字(字母/数字/-):`, '');
  if (raw == null) return;
  const clean = raw.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) { showError('session 名不能为空 / 只含非法字符'); return; }
  _declaredEmptySessions.add(sessionTileId(ws, `${ws}--${clean}`));
  render();
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
  // session tile 模式(桌面 overview):每格一个 session。sessionKey set 时:
  //   - colKey = tileId(.ws-col / timeline 的 data-ws 用它当布局 / 状态键,
  //     避免同 ws 多 tile 串台)
  //   - run 投到这个 sessionKey(form data-session-key),不是 activeSessionKey
  //   - header 显示 ws / <session 名>,跳过 detail 的 chip 切换条
  // opts.noSessionBar(PC pane 专用,2026-06-01 侧边栏布局):detail 分支
  //   不渲染 _sessionBarHtml。新布局里侧边栏本身就是 session 切换器,pane
  //   内再放一条 chip 条 = 重复 chrome + 会让同 repo 两 pane 状态串台
  //   (_sessionBarHtml / workspaceActiveSession 按裸 ws 名索引)。mobile
  //   detail / run-detail 等不传这个 opt → 行为零变化。
  // 已知 trade-off(fast-follow,见 spec §7):附件队列 _pendingUploads 仍按
  //   裸 ws 名索引(下面 attach-* 的 data-ws=name,不是 colKey),所以同 repo
  //   两 pane 共享同一附件队列。窄场景(双 pane 且两边都挂附件)、不影响正确性
  //   (提交时按 ws 取队列);正确修法是把整条上传链改成按 tileId 索引,留作
  //   fast-follow。其余状态(timeline / 草稿 / scroll / form 投递)已按 colKey
  //   隔离,不串台。
  const sessionKey = opts.sessionKey || null;
  const colKey = opts.tileId || name;   // 布局 / 状态键(tile 模式 = tileId)
  const skAttr = sessionKey ? ` data-session-key="${esc(sessionKey)}"` : '';

  // Detail + Overview 都用同一套 turn-streaming UI(设计图 §3.2 + §4)。
  //   Detail  :expandAll=true,所有 turn 默认展开看完整 event timeline
  //   Overview:expandAll=false,默认只有 running + 最近 1 个 completed
  //              展开(per design 3.2),其余收起单行 summary。用户在
  //              overview 直接点 turn 展开后能在小卡片内看 event 详情;
  //              也可以点 workspace name 跳到 detail 看完整版。
  // 渲染走同一个 _workspaceTurnHtml,handler / CSS 都共用。
  let timelineHtml;
  // session tile:data 已经是该 session 的 run(groupBySession 分好桶),原样用。
  // detail 页按选中 session 过滤;workspace overview(老路径)不过滤。
  const allTurns = _workspaceSessionTurns(data);
  const turns = sessionKey ? allTurns
    : (detail ? _filterTurnsBySession(name, allTurns) : allTurns);
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

  // Overview: h2 wraps in a link so clicking it drills into detail.
  // Detail: plain h2 (we're already in detail; the back-link handles exit).
  // session tile:标题显示 "ws / <session 名>"(默认 session 只显示 ws)。
  // session 名 = 去掉 <ws>-- 前缀;默认 pwa-<ws> 显示"默认"。
  const sessLabel = sessionKey
    ? (sessionKey === `pwa-${name}` ? '默认' : sessionChipLabel(name, sessionKey))
    : '';
  const titleInner = sessionKey
    ? `${esc(name)} <span class="ws-session-tag">/ ${esc(sessLabel)}</span>`
    : esc(name);
  const headerTitle = detail
    ? `<h2>${esc(name)}</h2>`
    : `<h2><a class="ws-name-link" href="#workspaces/${encodeURIComponent(name)}">${titleInner}</a></h2>`;

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
            <button class="ws-merge-to-main ws-menu-item" type="button" data-ws="${esc(name)}"${skAttr}>
              ${ICONS.download} <span>Create PR</span>
            </button>
            <button class="ws-reset-session ws-menu-item" type="button" data-ws="${esc(name)}"${skAttr}>
              ${ICONS.rewind} <span>New chat</span>
            </button>
            ${sessionKey ? `<button class="ws-new-session ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.more} <span>+ 新 session(同 repo)</span>
            </button>` : ''}
          </div>
          <button class="ws-delete-workspace ws-menu-item ws-menu-item-danger" type="button" data-ws="${esc(name)}">
            ${ICONS.trash} <span>Delete workspace</span>
          </button>
        </div>
      </details>
    </div>
  `;

  // .ws-col data-ws = colKey:scroll/stream 状态键(tile 模式 = tileId,
  // 同 ws 多 tile 不串)。timeline data-ws 同样用 colKey。
  // form data-workspace=真实 ws(workspace 级动作),data-session-key=本 tile
  // 的 session(run 投递目标);老路径 sessionKey=null 时 onTriggerSubmit 退回
  // activeSessionKey(ws)。skAttr 在函数顶部已声明(providerEngineBlock 也用)。
  return `
    <div class="ws-col ${extraClass}" data-ws="${esc(colKey)}" data-tile-ws="${esc(name)}">
      <div class="ws-head">
        <div class="ws-head-row">
          ${headerTitle}
        </div>
        ${providerEngineBlock}
      </div>
      ${detail && !opts.noSessionBar ? _sessionBarHtml(name) : ''}
      ${detail ? _gitSectionHtml(name, sessionKey) : ''}
      <div class="ws-timeline" data-ws="${esc(colKey)}">${timelineHtml}</div>
      ${_queueListHtml(name, sessionKey)}
      ${_composerHtml(name, colKey, skAttr, { activeRun: (data.active || [])[0], showSendHint: true })}
    </div>
  `;
}

// composer(spec §4.4):圆角容器 + 聚焦蓝光,底部一行工具栏。
//   - textarea 自增高(JS 在 _onPromptInput 里按 scrollHeight 调,P2 决策:
//     不用 CSS field-sizing,国产 ROM WebView 不稳)。
//   - 📎 复用现有 .attach-btn + _pendingUploads;`/` slash 复用现成补全;
//     model chip 只读(从 wsSettings provider 取,退回 default);⌘↵ 提示。
//   - Run↔Stop:该 tile 有 active run → 渲染 Stop(.run-cancel-btn,
//     data-run-id=active run id),复用全局 cancel 委托(app.js document.click,
//     含 confirm + POST /runs/{id}/cancel),不写新 handler/后端。无 active
//     run → Run(type=submit,走现有 onTriggerSubmit)。
//   - 附件 chips 沿用 .attach-chips(容器内顶部,order:-1)。
//   - opts.showSendHint:PC 显 "↵ 发送 · ⇧↵ 换行" 提示(PC 实际行为:
//     Enter 发送 / Shift+Enter 换行,Cmd/Ctrl+Enter 也发送);mobile 不显
//     (传 false;mobile Enter=换行,靠 Run 按钮发)。
function _composerHtml(name, colKey, skAttr, opts = {}) {
  const activeRun = opts.activeRun || null;
  const showSendHint = !!opts.showSendHint;
  const model = lastData.wsSettings[name]?.provider || lastData.globalProvider || 'default';
  const runOrStop = activeRun
    ? `<button class="run-cancel-btn composer-stop" type="button" data-run-id="${esc(activeRun.id)}">⏹ Stop</button>`
    : `<button class="composer-send" type="submit">Run</button>`;
  return `
    <form class="trigger-form composer" data-workspace="${esc(name)}"${skAttr} data-form-id="ws-${esc(colKey)}">
      <div class="attach-chips" data-ws="${esc(name)}"></div>
      <input type="file" class="attach-input" data-ws="${esc(name)}" multiple hidden>
      <textarea name="prompt" class="composer-input" rows="1" placeholder="Message…"></textarea>
      <div class="composer-toolbar">
        <button type="button" class="attach-btn" data-ws="${esc(name)}" aria-label="Attach files">📎</button>
        <span class="composer-model-chip" title="Provider (read-only here; change in ⋯ menu)">${esc(model)}</span>
        <span class="composer-spacer"></span>
        ${showSendHint ? '<span class="composer-hint">↵ 发送 · ⇧↵ 换行</span>' : ''}
        ${runOrStop}
      </div>
    </form>
  `;
}

// Render queued prompts for a workspace(workspace 已有 run 在跑 + 用户
// 继续发的 prompt 会进这个队列;跑完一条自动 dispatch 下一条)。每条
// 一行 + ⏳ icon + 内容 + × 删除。空队列返回空字符串。
function _queueListHtml(ws, sessionKey = null) {
  // session tile 模式:只显示投到本 tile session 的排队项(同 ws 多 tile 不串)。
  // 老路径(sessionKey=null)显示该 ws 全部排队项。
  let items = _promptQueue[ws] || [];
  if (sessionKey) items = items.filter((m) => (m.sessionKey || `pwa-${ws}`) === sessionKey);
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
  // session tile 的 form 带 data-session-key → run 投这个 session;老路径
  // (workspace overview / detail)没这属性 → 退回 activeSessionKey(ws)。
  const sessionKey = form.dataset.sessionKey || activeSessionKey(ws);
  const prompt = form.elements.prompt.value.trim();
  if (!prompt) return;
  // 提交时拿当前 ws 的 pending 附件(File 对象),清掉 _pendingUploads[ws]
  // (无论走 busy / 立即提交,UI 上的 chip 都该消失)。
  const pending = [..._pendingUploads[ws] || []];
  // Workspace 已有 run 在跑 / 已有排队 → 这条进队列,不调 /run。busy-check
  // 保持 ws 级(保守:同 repo 串行,跟后端 flock 对齐)。排队项记 sessionKey,
  // 出队 dispatch 时投到对的 session。
  const busy = _hasActiveRun(ws) || (_promptQueue[ws]?.length > 0);
  if (busy) {
    // File 对象塞进队列(不上传 — 等出队时 _dispatchAllQueues 再上传)
    _enqueuePrompt(ws, prompt, pending, sessionKey);
    _clearPending(ws);
    _renderChips(ws);
    form.reset();
    clearDraft(form.dataset.formId);
    const _ta = form.querySelector('textarea'); _ta?.blur(); _autosizeComposer(_ta);
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
        session_key: sessionKey,
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
    const _ta = form.querySelector('textarea'); _ta?.blur(); _autosizeComposer(_ta);
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
// 深链 / 钻进单个 workspace 的入口(飞书 / cron 通知点进来)。PC vs mobile
// 行为不同:
//   PC      : 不再有独立 detail 页 —— 把该 repo 的默认 session 聚焦成单 pane,
//             走统一的侧边栏布局 renderDesktopSidebarLayout(2026-06-01,
//             spec §3.6)。
//   Mobile  : header arrow bar [‹] <name> [›] + the same single .ws-col
//             below. Arrows replaceState to the prev/next workspace (no
//             history pollution). Replaced the earlier swipe-carousel
//             on 2026-05-15.
function renderWorkspaceDetailView(startName, opts = {}) {
  // 进 detail 页拉一次该 workspace 的 session 列表(多 session chip 条用)。
  // 拉回来后存 workspaceSessionsList[ws] 并触发重画。每次 poll 不重拉
  // (列表变化只在新建 / 关闭 session 时,那两处会主动 refresh)。
  _ensureWorkspaceSessions(startName);
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile) {
    renderMobileWorkspaceDetail(startName, opts);
  } else {
    // PC 深链 #workspaces/<name>(飞书 / cron 通知点进来):把该 repo 的默认
    // session 聚焦到单 pane,展开它在侧边栏的塌缩态,再走统一的侧边栏布局。
    // (spec §3.6:不强制保留旧 pane;name 不存在 → 回落无 name 行为)。
    _focusWorkspaceDeepLink(startName);
    renderDesktopSidebarLayout();
  }
}

// PC 深链落点:把 startName 的默认 tileId 设成单 pane。
//   - 默认 tileId 从侧边栏树取(决策 2:不裸拼 sessionTileId,无默认 tile 时
//     裸拼会指向不存在的 tile)。name 不在树里 → 不改 pane,回落 loadPcLayout
//     的"恢复上次 / 聚焦第一个 repo"行为,不崩。
//   - expandedRepos = 并集(决策 3):保留用户上次展开态 + 额外展开这个 repo。
function _focusWorkspaceDeepLink(name) {
  if (!paneState) loadPcLayout();
  const tree = _pcSidebarTree();
  const node = tree.find((n) => n.ws === name);
  if (!node) return;                                // name 不存在 → 回落无 name 行为
  paneState = {
    panes: [node.tileId],
    activePaneIdx: 0,
    expandedRepos: [...new Set([...(paneState.expandedRepos || []), name])],
  };
  savePcLayout();
}

// 拉 session 列表 → 缓存 → 重画 chip 条。force=true 时强拉(新建 / 关闭后)。
async function _ensureWorkspaceSessions(name, { force = false } = {}) {
  if (!force && workspaceSessionsList[name]) return;
  try {
    const info = await api(`/workspaces/${encodeURIComponent(name)}/sessions`);
    workspaceSessionsList[name] = info;
    // 只在还停在该 workspace detail 时重画(避免拉回来时用户已经走了)
    const route = parseRoute();
    if (route.name === 'workspace-detail' && route.id === name) {
      renderWorkspaceDetailView(name);
    }
  } catch { /* 老 backend / 网络失败 → chip 条不显示,降级到单 session */ }
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
  const turns = _filterTurnsBySession(currentName, _workspaceSessionTurns(data));
  _pinJustFinishedTurns(turns);
  const expandedTurns = workspaceTurnExpansion(turns, workspaceTurnOverrides);
  const eventCount = expandedTurns.length + pendingApprovalsForWorkspace(currentName).length;
  workspaceStreamState[currentName] = workspaceAutoScrollState(workspaceStreamState[currentName], {
    eventCount,
    atBottom: workspaceStreamState[currentName]?.atBottom !== false,
  });
  const isRunning = turns.some((t) => t.status === 'running' || t.status === 'queued');

  const view = $('view');
  view.innerHTML = _workspaceSessionDetailHtml(currentName, expandedTurns, {
    eventCount, isRunning, activeRun: (data.active || [])[0],
  });
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

// 多 session chip 条 —— 只在 detail 页显示。worktree_mode=off 时整条隐藏
// (off 把所有 session_key 压成 default,多 session 无意义)。
// 布局(review W1=c,去掉"默认" chip):[全部] [fix-bug] [feat-x] ... [+ 新建]
//   - "全部":view-only,不过滤 timeline(含 cron / 飞书 / 默认 pwa 线)。
//     active=undefined 时高亮。Run 投默认 pwa-<ws>
//   - 用户 session chip(<ws>-- 前缀):点了过滤 timeline 到它 + Run 投它
//   - 默认 pwa-<ws> / cron / 飞书 等"系统线" **不出 chip** —— 它们在"全部"
//     视图里看,避免点"默认"反而藏掉 cron/飞书 run 的语义裂缝(W1 footgun)
//   - "+ 新建":弹名字 → 设为 active(worktree 首次 Run 时 agent-run.sh 建)
function _sessionBarHtml(name) {
  const info = workspaceSessionsList[name];
  if (!info) return '';                          // 还没拉到列表 → 不显示(下次 poll 补)
  if (info.worktree_mode === 'off') return '';   // off 模式无多 session 概念
  const active = workspaceActiveSession[name];   // undefined = 全部
  // 只展示用户建的并行工作线(<ws>-- 前缀)。
  const userSessions = (info.sessions || []).filter((s) => isUserSession(name, s.session_key));
  // 刚 + 新建 但还没 Run 的 session 不在 db 列表里 —— 把当前 active 补进去,
  // 否则点"+ 新建"后没 chip 高亮,用户一脸懵。
  const keys = new Set(userSessions.map((s) => s.session_key));
  if (active && isUserSession(name, active) && !keys.has(active)) {
    userSessions.push({ session_key: active, run_count: 0, has_worktree: false });
  }
  // 没有用户建的 session → 整条 chip 条隐藏(单 session 时一个孤零零的"全部"
  // 没意义)。新建 session 走 overview tile 的 ⋯ 菜单"+新 session",不在这里。
  if (userSessions.length === 0) return '';
  const chips = [];
  chips.push(`<button class="ws-session-chip${!active ? ' is-active' : ''}"
    data-ws="${esc(name)}" data-session="" type="button">全部</button>`);
  for (const s of userSessions) {
    const k = s.session_key;
    const label = sessionChipLabel(name, k);
    const dot = s.last_status === 'running' ? ' ●' : '';
    chips.push(`<button class="ws-session-chip${active === k ? ' is-active' : ''}"
      data-ws="${esc(name)}" data-session="${esc(k)}" type="button"
      title="${esc(k)} · ${s.run_count} runs${s.has_worktree ? ' · worktree' : ''}">${esc(label)}${dot}</button>`);
  }
  return `<div class="ws-session-bar" data-ws="${esc(name)}">${chips.join('')}</div>`;
}

function _workspaceSessionDetailHtml(name, turns, { eventCount, isRunning, activeRun }) {
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
                ${ICONS.download} <span>Create PR</span>
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
      ${_sessionBarHtml(name)}
      ${_gitSectionHtml(name, null)}
      <div class="workspace-session-stream" data-ws="${esc(name)}" data-event-count="${esc(eventCount)}">
        ${turnsHtml}
      </div>
      <button class="workspace-new-events" type="button" data-ws="${esc(name)}" ${state.newEvents ? '' : 'hidden'}>
        ↓ ${esc(state.newEvents || 0)} new
      </button>
      ${_queueListHtml(name)}
      ${_composerHtml(name, name, '', { activeRun, showSendHint: false })}
    </div>
  `;
  // ↑ composer:mobile 不显 ⌘↵ 提示(无物理键盘);其余(自增高 / 📎 /
  //   slash / model chip / Run↔Stop)跟 PC 同一份 _composerHtml。
  //   Run 按钮不再 disabled-on-running:队列机制接管,用户随时可以提
  //   prompt,后台串行 dispatch;跑动时按钮变 Stop 复用 cancel 委托。
}

function _workspaceTurnHtml(turn) {
  const status = turn.status || '?';
  const prompt = turn.prompt || '';
  // v4 去折叠(spec §14.1):turn 永远展开 —— 删了 chevron + 可点 turn-head。
  // "点击收起单条 turn"无意义,且现状气泡 = 可点 button → 被点/聚焦后整条
  // 变全宽高亮蓝条(丑)。现在用户气泡 = 普通右对齐 <div>(非 button,无全宽
  // 点击区、无 focus/active 蓝背景)。turn-events 一律加载。
  // 一个 turn 只三块(对齐 Claude 会话 UI,spec §13.1):
  //   ① 用户气泡 ×1(右对齐圆角弱底,仅 prompt 文本 + 弱时间戳)
  //   ② 助手文档(全宽流动 markdown,顶一个极轻 CLAUDE 指示)
  //   ③ 行末 meta(助手块末尾 ✓ 用时 · tokens,由 result event 渲染)
  const cancelBtn = status === 'running' && turn.id
    ? `<button class="run-cancel-btn turn-cancel" type="button" data-run-id="${esc(turn.id)}">✕ Cancel</button>`
    : '';
  const approvals = pendingApprovalsFor(turn.id || '').map(approvalBlockHtml).join('');
  const startedRel = turn.started_at ? timeAgo(turn.started_at) : '';
  const startedAbs = turn.started_at ? new Date(turn.started_at * 1000).toLocaleString() : '';
  // turn 顶 CLAUDE 轻指示:整 turn 只一个,取代每条 Reply 左标签。
  const asstIndicatorHtml = `<div class="turn-asst-indicator">Claude</div>`;
  // running/queued turn 还没 result event → 没有行末 meta,补一个"处理中…"
  // 指示,免得助手区空白看着像崩了。
  const pendingHint = (status === 'running' || status === 'queued')
    ? `<div class="turn-pending-hint muted">处理中…</div>`
    : '';
  // turn-events 容器:turn 永远 expanded → _bindTurnInteractions 的
  // `.turn.turn-expanded` bootstrap 必命中,触发一次 _loadTurnEvents 把
  // /runs/{id}/tail 的 stream-jsonl 解析渲染进来。同一 runId 二次 mount 时
  // (主 poll 触发的 view rerender),容器被重建为空 loading 态,loader 据此
  // 判断要不要重新拉取。
  // data-elapsed:把 turn 级用时挂在容器上,result event 渲染行末 meta 时
  //   读它出"用时"(result event 自己只带 tokens,没有 elapsed)。
  const elapsedAttr = turn.elapsed_s != null ? ` data-elapsed="${esc(turn.elapsed_s)}"` : '';
  const eventsHtml = `<div class="turn-events" data-run-id="${esc(turn.id || '')}" data-status="${esc(status)}"${elapsedAttr}>
         <div class="muted turn-events-loading">Loading events…</div>
       </div>`;

  return `
    <article class="turn turn-expanded turn-status-${esc(status)}"
             data-run-id="${esc(turn.id || '')}" data-status="${esc(status)}">
      <div class="turn-head">
        <div class="turn-user">
          <span class="turn-user-text">${esc(prompt)}</span>
          ${startedRel ? `<span class="turn-user-time" title="${esc(startedAbs)}">${esc(startedRel)}</span>` : ''}
        </div>
      </div>
      ${cancelBtn}
      <div class="turn-body">
        ${asstIndicatorHtml}
        ${eventsHtml}
        ${pendingHint}
        ${approvals}
      </div>
    </article>
  `;
}
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
    // 是否该 append 后补滚到底。两个信号取或:
    //   ① wasAtBottom:append 前实测就在底(运行中跟新内容的常态)
    //   ② persistedAtBottom:持久化滚动状态说"用户没往上滚过"(fresh nav
    //      进入 = 没存过状态 = undefined !== false = true)。
    // 加 ② 是因为 fresh nav 初始滚到底用的是折叠高度(展开的最后一轮 events
    // 还没异步加载),之后 events 撑开,①的临时测量在边界不可靠 → 漏补滚 →
    // 停在中间(用户报"默认停在第一个 done")。用持久状态兜住:fresh nav 后
    // 每次 event 加载都贴底,直到用户主动往上滚(scroll handler 置 atBottom=false)。
    const _ws = stream?.dataset.ws;
    const persistedAtBottom = stream?.classList.contains('ws-timeline')
      ? (timelineScroll[_ws]?.atBottom !== false)
      : (workspaceStreamState[_ws]?.atBottom !== false);
    const wasAtBottom = stream
      ? ((stream.scrollHeight - stream.clientHeight - stream.scrollTop) < 80 || persistedAtBottom)
      : false;

    const newLines = allLines.slice(already);
    const newEvents = parseStreamLinesToEvents(newLines);
    // 把 turn 级用时(挂在容器 data-elapsed)传给每个 event —— result event
    // 渲染行末 meta 要用它出"用时"。
    const elapsedS = container.dataset.elapsed;
    const html = newEvents.map((ev) => _renderTurnEvent(ev, elapsedS)).join('');

    // 只有 html 真有内容才 remove loading + 插入。html 可能为空 ——
    // 比如 system init 行被 parser 过滤,或 thinking/tool 被 "Show all
    // events"=OFF filter 过滤。这种情况下保留 placeholder,等下一波。
    if (html) {
      const loading = container.querySelector('.turn-events-loading');
      if (loading) loading.remove();
      container.insertAdjacentHTML('beforeend', html);
      for (const btn of container.querySelectorAll('.tool-result-fold:not([data-bound])')) {
        btn.addEventListener('click', _onToolResultFoldToggle);
        _addTapFallback(btn, _onToolResultFoldToggle);
        btn.dataset.bound = '1';
      }
      // 还原跨重渲保留的 fold 展开态(_foldState):数据变化触发的 #view 重写
      // 会把 fold 重建成折叠态,这里把用户之前展开过的重新展开。幂等:已展开的
      // (full.hidden=false)跳过,所以 running turn 增量 append 多次调用无副作用。
      for (const wrap of container.querySelectorAll('.tool-result-wrap')) {
        const key = _foldKeyForWrap(wrap);
        if (key && _foldState[key]) {
          const full = wrap.querySelector('.tool-result-full');
          if (full && full.hidden) _setFoldExpanded(wrap, true);
        }
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
// _onToolResultFoldToggle 现有 handler 自动 work,不写新的展开逻辑。
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

// Edit/MultiEdit/Write 的 diff 块(spec §14.2 MVP:全删旧 + 全增新,精确
// LCS 留后)。old_string 每行 .diff-del、new_string 每行 .diff-add;Write
// 没有 old_string 只渲染 new。两者都缺 → 空串(不渲染 diff 容器)。
function _diffLinesHtml(text, cls) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => `<div class="${cls}">${esc(line)}</div>`)
    .join('');
}
function _toolUseDiffHtml(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  if (name === 'Write') {
    const next = inp.content != null ? inp.content : inp.new_string;
    if (next == null) return '';
    return `<div class="event-tool-diff">${_diffLinesHtml(next, 'diff-add')}</div>`;
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const oldStr = inp.old_string;
    const newStr = inp.new_string;
    if (oldStr == null && newStr == null) return '';
    const del = oldStr != null ? _diffLinesHtml(oldStr, 'diff-del') : '';
    const add = newStr != null ? _diffLinesHtml(newStr, 'diff-add') : '';
    return `<div class="event-tool-diff">${del}${add}</div>`;
  }
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// Workspace Git 区段(spec: 2026-06-03-workspace-git-view.md)。
//
// 默认折叠、只读。展开按需拉一次 GET /workspaces/{ws}/git,渲 4 块(状态行 /
// changed files / commits / worktrees)。点 changed file 懒加载单文件 diff。
// **不进 refreshAll 3s 轮询**(spec §4.3:git subprocess 不该每 3s 跑)。
//
// 状态扛 refreshAll 重渲:展开态 + 已拉数据存 in-memory,bindWorkspaceColHandlers
// 在重画后据此恢复填充(否则 spec §4.3 说"回折叠"也可接受,这里做更好的恢复)。
// 折叠态绝不打端点 —— 只有 _gitExpanded 里有 key 时 _bindGitSection 才 fetch。
//
// 纯文案 / diff 渲染走 ui_contract.mjs(gitBadgeText / hunksToHtml),有单测;
// 这里只组装 DOM + fetch 接线。渲染函数 desktop pane + mobile detail 共用
// (spec §4.4,两端各自的 detail 渲染体都调 _gitSectionHtml)。
// ───────────────────────────────────────────────────────────────────────────

const _GIT_KEY_SEP = '\x1f';
// gitKey = ws + sep + 解析后的 session —— 同 ws 不同 session(pane / chip)
// 各自一份展开态 + 缓存,不串台。
// 生命周期(Checkpoint B 复核):这 4 个容器只增不减(无 prune)。**有意接受**
// (§5):key 数量受用户单次会话里"看过几个 ws × 几个 session × 展开过几个文件"
// bound —— 单用户单机下是个位数量级,且页面 reload 即清空。不挂 _prunePanes、不随
// ws 删清理(YAGNI:真长跑泄漏了再加,当前不值这复杂度)。
const _gitExpanded = new Set();        // 展开的 gitKey
const _gitData = new Map();            // gitKey → overview dict(已拉到)
const _gitDiffExpanded = new Set();    // 展开 diff 的 gitKey + sep + file
const _gitDiffData = new Map();        // 同上 key → diff resp dict

// Git 区段打端点用的 session:tile / pane 有显式 sessionKey 用它;否则(mobile /
// overview "全部"视图)看 workspaceActiveSession,无 active → "default"(spec §6:
// 全部视图看主目录)。**不用 activeSessionKey** —— 它无 active 时回 pwa-<ws> 而非
// default,跟 spec §6 全部视图语义不符。
//
// 口径(Checkpoint B 复核,desktop / mobile 粒度有意不同,不是 bug):
//   - desktop session-tile pane:sessionKey = pwa-<ws> 这种具体 session → git 看
//     该 session 的 worktree(per-session 粒度,pane 本就代表一个 session,看它自己
//     的分支/diff 才对)。
//   - mobile detail / overview "全部":无具体 session → 回落 default → git 看主目录
//     (ws 聚合粒度)。
// 两端不同时在场,各自语义自洽。若哪天要 desktop 默认格也看主目录,改这里回落即可。
function _gitSectionSessionKey(name, sessionKey) {
  return sessionKey || workspaceActiveSession[name] || 'default';
}
function _gitKey(name, sessionKey) {
  return `${name}${_GIT_KEY_SEP}${_gitSectionSessionKey(name, sessionKey)}`;
}

// Git 区段 HTML(desktop pane + mobile detail 共用)。默认折叠态一行 header;
// 展开态(_gitExpanded 命中)渲 ±N 角标 + 4 块(已拉到数据时)/ loading 占位。
function _gitSectionHtml(name, sessionKey) {
  const key = _gitKey(name, sessionKey);
  const session = _gitSectionSessionKey(name, sessionKey);
  const expanded = _gitExpanded.has(key);
  const data = _gitData.get(key) || null;
  const badge = (expanded && data && data.is_git_repo)
    ? gitBadgeText(data.diff_stat, data.diff_truncated) : '';
  const caret = expanded ? '▾' : '▸';
  // body 只在展开时渲;折叠态完全不出 body(也不触发任何 fetch)。
  let body = '';
  if (expanded) {
    body = data ? _gitBodyHtml(name, session, data)
                : '<div class="git-loading muted">Loading git…</div>';
  }
  return `
    <div class="git-section${expanded ? ' is-expanded' : ''}"
         data-ws="${esc(name)}" data-git-session="${esc(session)}">
      <div class="git-header">
        <button class="git-toggle" type="button"
                data-ws="${esc(name)}" data-git-session="${esc(session)}">
          <span class="git-caret">${caret}</span>
          <span class="git-title">Git</span>
          ${badge ? `<span class="git-badge">${esc(badge)}</span>` : ''}
        </button>
        ${expanded ? `<button class="git-refresh" type="button" title="Refresh git"
                data-ws="${esc(name)}" data-git-session="${esc(session)}">⟳</button>` : ''}
      </div>
      <div class="git-body">${body}</div>
    </div>
  `;
}

// 展开后的 4 块(spec §4.2)。非 git 仓库 → 单行降级文案。
function _gitBodyHtml(name, session, data) {
  if (!data.is_git_repo) {
    return '<div class="git-empty muted">非 git 仓库</div>';
  }
  return [
    _gitStatusRowHtml(data),
    _gitFilesHtml(name, session, data),
    _gitCommitsHtml(data),
    _gitWorktreesHtml(data),
    _gitWarningsHtml(data),
  ].join('');
}

// ① 状态行:branch ↑ahead ↓behind · dirty + base + cwd_kind 提示(spec §4.2)。
function _gitStatusRowHtml(data) {
  const branch = data.branch || (data.head_short ? `@${data.head_short}` : '(no branch)');
  const ahead = data.ahead ? `<span class="git-ahead">↑${esc(data.ahead)}</span>` : '';
  const behind = data.behind ? `<span class="git-behind">↓${esc(data.behind)}</span>` : '';
  const dirty = data.dirty ? '<span class="git-dirty">· dirty</span>' : '';
  // cwd_kind=worktree 时提示"看的是某 worktree";main 不提示(默认即主目录)。
  const cwdHint = data.cwd_kind === 'worktree'
    ? '<span class="git-cwd-hint">· worktree</span>' : '';
  return `
    <div class="git-status-row">
      <span class="git-branch">${esc(branch)}</span>
      ${ahead}${behind}${dirty}${cwdHint}
      <span class="git-base">base: ${esc(data.base || '?')}</span>
    </div>
  `;
}

// ② changed files:每行 status 字母 + file + +add -del。点文件名懒加载 diff
//    inline 展开(再点收起,spec §4.2)。diff 已展开时把它渲在该行下面。
function _gitFilesHtml(name, session, data) {
  const stat = Array.isArray(data.diff_stat) ? data.diff_stat : [];
  if (stat.length === 0) {
    return '<div class="git-block git-files"><div class="git-block-label">Changed files</div>'
      + '<div class="muted git-files-empty">无改动</div></div>';
  }
  const key = `${name}${_GIT_KEY_SEP}${session}`;
  const rows = stat.map((d) => {
    const status = d.status || '?';
    const adds = d.binary ? 'bin' : `+${d.additions ?? 0}`;
    const dels = d.binary ? '' : ` -${d.deletions ?? 0}`;
    const diffKey = `${key}${_GIT_KEY_SEP}${d.file}`;
    const diffOpen = _gitDiffExpanded.has(diffKey);
    const diffResp = _gitDiffData.get(diffKey) || null;
    let inline = '';
    if (diffOpen) {
      inline = diffResp ? _gitFileDiffHtml(diffResp)
                        : '<div class="git-diff-inline git-loading muted">Loading diff…</div>';
    }
    return `
      <div class="git-file-row${diffOpen ? ' is-open' : ''}">
        <button class="git-file" type="button"
                data-ws="${esc(name)}" data-git-session="${esc(session)}" data-file="${esc(d.file)}">
          <span class="git-file-status git-status-${esc(status)}">${esc(status)}</span>
          <span class="git-file-name">${esc(d.file)}</span>
          <span class="git-file-stat"><span class="git-add">${esc(adds)}</span>${esc(dels)}</span>
        </button>
        ${inline}
      </div>
    `;
  }).join('');
  return `<div class="git-block git-files">
      <div class="git-block-label">Changed files</div>${rows}</div>`;
}

// 单文件 diff inline 块。binary / 截断有提示;hunks 走 ui_contract hunksToHtml。
function _gitFileDiffHtml(diffResp) {
  if (diffResp.binary) {
    return '<div class="git-diff-inline muted">二进制文件,不显示 diff</div>';
  }
  const hunks = hunksToHtml(diffResp.hunks, esc);
  const body = hunks || '<div class="muted">(无内容)</div>';
  const trunc = diffResp.truncated
    ? '<div class="git-diff-trunc muted">diff 过长已截断</div>' : '';
  return `<div class="git-diff-inline event-tool-diff">${body}${trunc}</div>`;
}

// ③ recent commits:每行 short sha + subject + rel_date(只读,不点开)。
function _gitCommitsHtml(data) {
  const commits = Array.isArray(data.recent_commits) ? data.recent_commits : [];
  if (commits.length === 0) {
    return '<div class="git-block git-commits"><div class="git-block-label">Commits</div>'
      + '<div class="muted git-commits-empty">无提交</div></div>';
  }
  const rows = commits.map((c) => `
    <div class="git-commit-row">
      <span class="git-sha">${esc(c.sha)}</span>
      <span class="git-subject">${esc(c.subject)}</span>
      <span class="git-rel-date">${esc(c.rel_date)}</span>
    </div>
  `).join('');
  return `<div class="git-block git-commits">
      <div class="git-block-label">Commits</div>${rows}</div>`;
}

// ④ worktrees:每项 branch/path + head_short,is_current 高亮(spec §4.2)。
function _gitWorktreesHtml(data) {
  const wts = Array.isArray(data.worktrees) ? data.worktrees : [];
  if (wts.length === 0) return '';
  const rows = wts.map((w) => {
    const label = w.branch || '(detached)';
    return `
      <div class="git-worktree-row${w.is_current ? ' is-current' : ''}">
        <span class="git-wt-branch">${esc(label)}</span>
        <span class="git-wt-head">@${esc(w.head_short || '')}</span>
        ${w.is_current ? '<span class="git-wt-current">current</span>' : ''}
      </div>
    `;
  }).join('');
  return `<div class="git-block git-worktrees">
      <div class="git-block-label">Worktrees</div>${rows}</div>`;
}

// 降级 warnings(spec §7:base 不存在 / worktree 未建等非致命提示)。
function _gitWarningsHtml(data) {
  const warns = Array.isArray(data.warnings) ? data.warnings : [];
  if (warns.length === 0) return '';
  return `<div class="git-warnings">${
    warns.map((w) => `<div class="git-warning muted">⚠ ${esc(w)}</div>`).join('')
  }</div>`;
}

// ── Git 区段 fetch 接线 + 局部重渲(spec §4.3:不进 refreshAll 轮询)──

// 局部重渲一个 Git 区段:state 变化后只重画该区段 DOM(不触发整页 refreshAll),
// 再重绑它的 handler。DOM 里同 ws+session 可能存在多份(desktop 多 pane 时不会,
// 但 desktop pane + mobile 不同时在场)→ 用 querySelectorAll 全部刷新。
function _rerenderGitSection(name, session) {
  const sel = `.git-section[data-ws="${CSS.escape(name)}"][data-git-session="${CSS.escape(session)}"]`;
  for (const el of document.querySelectorAll(sel)) {
    // session 已是解析后的具体 key(data-git-session 存的是 _gitSectionSessionKey
    // 的结果)→ 直接当 sessionKey 传,_gitSectionSessionKey 非空原样返回。
    el.outerHTML = _gitSectionHtml(name, session);
  }
  // outerHTML 替换后旧节点失效,重新查一遍绑 handler。
  for (const el of document.querySelectorAll(sel)) {
    _bindGitSectionHandlers(el);
  }
}

// 拉概览填充。force=true(⟳ 刷新)忽略缓存重拉;否则有缓存就不重拉。
async function _fetchGitOverview(name, session, { force = false } = {}) {
  const key = `${name}${_GIT_KEY_SEP}${session}`;
  if (!force && _gitData.has(key)) { _rerenderGitSection(name, session); return; }
  try {
    const data = await api(
      `/workspaces/${encodeURIComponent(name)}/git?session=${encodeURIComponent(session)}`
    );
    _gitData.set(key, data);
  } catch {
    // 降级:拉失败给一个最小 dict,UI 显"非 git 仓库"占位而非空白卡死。
    _gitData.set(key, { is_git_repo: false, session });
  }
  if (_gitExpanded.has(key)) _rerenderGitSection(name, session);
}

// 拉单文件 diff 填充(懒加载)。
async function _fetchGitFileDiff(name, session, file) {
  const diffKey = `${name}${_GIT_KEY_SEP}${session}${_GIT_KEY_SEP}${file}`;
  if (_gitDiffData.has(diffKey)) { _rerenderGitSection(name, session); return; }
  try {
    const data = await api(
      `/workspaces/${encodeURIComponent(name)}/git/diff`
      + `?session=${encodeURIComponent(session)}&file=${encodeURIComponent(file)}&uncommitted=0`
    );
    _gitDiffData.set(diffKey, data);
  } catch {
    _gitDiffData.set(diffKey, { file, binary: false, hunks: [], truncated: false });
  }
  if (_gitDiffExpanded.has(diffKey)) _rerenderGitSection(name, session);
}

function _onGitToggleClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  const session = btn.dataset.gitSession;
  const key = `${name}${_GIT_KEY_SEP}${session}`;
  if (_gitExpanded.has(key)) {
    _gitExpanded.delete(key);          // 收起:不打端点,只重渲
    _rerenderGitSection(name, session);
  } else {
    _gitExpanded.add(key);             // 展开:渲 loading + 按需拉一次
    _rerenderGitSection(name, session);
    _fetchGitOverview(name, session);
  }
}

function _onGitRefreshClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  const session = btn.dataset.gitSession;
  _fetchGitOverview(name, session, { force: true });
}

function _onGitFileClick(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.ws;
  const session = btn.dataset.gitSession;
  const file = btn.dataset.file;
  const diffKey = `${name}${_GIT_KEY_SEP}${session}${_GIT_KEY_SEP}${file}`;
  if (_gitDiffExpanded.has(diffKey)) {
    _gitDiffExpanded.delete(diffKey);  // 收起 inline diff
    _rerenderGitSection(name, session);
  } else {
    _gitDiffExpanded.add(diffKey);     // 展开 + 懒加载
    _rerenderGitSection(name, session);
    _fetchGitFileDiff(name, session, file);
  }
}

// 绑一个 Git 区段内的 handler(toggle / refresh / changed file)。重渲后调它。
function _bindGitSectionHandlers(sectionEl) {
  for (const b of sectionEl.querySelectorAll('.git-toggle')) {
    b.addEventListener('click', _onGitToggleClick);
    _addTapFallback(b, _onGitToggleClick);
  }
  for (const b of sectionEl.querySelectorAll('.git-refresh')) {
    b.addEventListener('click', _onGitRefreshClick);
    _addTapFallback(b, _onGitRefreshClick);
  }
  for (const b of sectionEl.querySelectorAll('.git-file')) {
    b.addEventListener('click', _onGitFileClick);
    _addTapFallback(b, _onGitFileClick);
  }
}

// elapsedS:turn 级用时(秒),由 _loadTurnEvents 从 .turn-events 容器的
//   data-elapsed 取出传入 —— result event 自己只带 tokens,没有 elapsed。
function _renderTurnEvent(ev, elapsedS) {
  // 全局过滤(spec §14.2 默认显示内部执行过程):tool_use / tool_result 默认
  // 紧凑显示 —— agent 读了啥、跑了啥、改了啥都要看得见。只有 thinking 默认
  // 隐藏(英文 prose,长且噪),用户在 ⚙ 打开 "Show all events" 才显示。
  const showAll = eventFilterShowAll();
  if (!showAll) {
    if (ev.kind === 'thinking') return '';
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
    // doc-flow(spec §12.2):assistant 文本 = 全宽流动正文(markdown),
    // 不再 Reply 左标签 + event 内 5 行 fold(turn 级折叠已管整体长度)。
    // turn 顶有一个轻量 CLAUDE 指示(见 _workspaceTurnHtml),这里不重复。
    return `<div class="event-asst-md">${renderMarkdown(ev.text || '')}</div>`;
  }
  if (ev.kind === 'tool_use') {
    // 紧凑块(spec §14.2):glyph + verb + target 单行。verb 派生 CSS class
    // (.event-tool-<verb>)做着色 —— formatToolUse 不塞颜色。Edit/MultiEdit/
    // Write 额外在下面渲染 diff(全删旧 + 全增新两块,精确 LCS 留后)。
    const { verb, target, glyph } = formatToolUse(ev.name, ev.input || {});
    const diffHtml = _toolUseDiffHtml(ev.name, ev.input || {});
    return `
      <div class="event-tool event-tool-${esc(verb)}">
        <div class="event-tool-call">
          <span class="tool-glyph">${esc(glyph)}</span>
          <span class="tool-verb">${esc(verb)}</span>
          <code class="tool-target">${esc(target)}</code>
        </div>
        ${diffHtml}
      </div>`;
  }
  if (ev.kind === 'tool_result') {
    // 缩进 output(左 hairline rail,跟在 tool_use call 行下方读成"这个工具
    // 的返回")。正常情况 _workspaceOutputHtml 折叠超 5 行;isError 红 + 不
    // 折叠(默认全展开 —— 错误不能被静默吞掉,debug 要全文)。
    if (ev.isError) {
      return `
        <div class="event-tool-result event-tool-result-error">
          <pre class="tool-result">${esc(ev.text || '')}</pre>
        </div>`;
    }
    return `
      <div class="event-tool-result">
        ${_workspaceOutputHtml(ev.text || '')}
      </div>`;
  }
  if (ev.kind === 'result') {
    // 对齐 Claude 会话 UI(spec §13.1):助手块末尾一小撮行末 meta ——
    //   ✓ <用时>s · <in>→<out> tok
    // 用时来自 turn 级 elapsedS(容器 data-elapsed),tokens 来自本 event。
    // ev.text 故意丢弃 —— 它跟助手正文(text event 渲染的 markdown)重复,
    // 是 v2 灰字重复的根因。
    const elapsedHtml = elapsedS != null && elapsedS !== ''
      ? `<span class="turn-meta-elapsed">${esc(elapsedS)}s</span> · `
      : '';
    return `
      <div class="turn-meta-foot">
        <span class="turn-meta-mark">✓</span>
        ${elapsedHtml}<span class="turn-meta-tokens">${esc(ev.inTokens)}→${esc(ev.outTokens)} tok</span>
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
// tool-result-fold / _loadTurnEvents bootstrap / 停 poll 这一套
// bindWorkspaceColHandlers 已经做了(renderMobileWorkspaceDetail 调它在前),
// 这里再绑一次会让 _loadTurnEvents 同一 runId 并发 2 次 fetch /tail,两个
// async 都跑到渲染,大量 event duplicate(用户反馈"event 经常重复")。
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

// fold 展开态跨重渲保留。detail / pane 的 #view 在数据变化(新 run / 状态变 /
// running streaming)触发 render 时整段重写 → fold 被重建成折叠态,用户刚展开
// 的长输出又缩回去。_foldState 记住"哪些 fold 被展开过",_loadTurnEvents 渲完
// 事件后据此还原。keyed by runId + wrap 在该 turn-events 内的序号(事件顺序
// 确定 → 序号稳定)。只覆盖 .turn-events 里的 fold(别处如 mobile loop row 不
// 命中,优雅降级)。注:只保留展开/折叠态,内部滚动位置不保留(重写后回顶)。
const _foldState = {};

function _foldKeyForWrap(wrap) {
  const container = wrap.closest('.turn-events');
  if (!container) return null;
  const runId = container.dataset.runId || '';
  const idx = Array.prototype.indexOf.call(
    container.querySelectorAll('.tool-result-wrap'), wrap);
  return idx < 0 ? null : runId + ':' + idx;
}

// 设 fold 展开/折叠 DOM 态(toggle handler + 重渲还原共用)。保留按钮(不 hidden),
// 文字在「↓ Expand N lines」⇄「↑ Collapse」间切换 —— 首次展开把原始 Expand 文案
// 存进 dataset.expandLabel,折叠时还原(N lines 不丢)。
function _setFoldExpanded(wrap, expanded) {
  const preview = wrap.querySelector('.tool-result-preview');
  const full = wrap.querySelector('.tool-result-full');
  const btn = wrap.querySelector('.tool-result-fold');
  if (!preview || !full || !btn) return;
  if (expanded) {
    if (!btn.dataset.expandLabel) btn.dataset.expandLabel = btn.textContent;
    preview.hidden = true;
    full.hidden = false;
    btn.textContent = '↑ Collapse';
  } else {
    preview.hidden = false;
    full.hidden = true;
    btn.textContent = btn.dataset.expandLabel || '↓ Expand';
  }
}

// fold 按钮 toggle(展开 ⇄ 收起)。修「有 expand 却没有收起」(旧版点 Expand
// 后把按钮自己 hidden,展开了收不回)。顺带把展开态写进 _foldState 跨重渲保留。
function _onToolResultFoldToggle(e) {
  const wrap = e.currentTarget.closest('.tool-result-wrap');
  const full = wrap?.querySelector('.tool-result-full');
  if (!wrap || !full) return;
  const expanding = full.hidden;            // 当前折叠 → 这次点是展开
  _setFoldExpanded(wrap, expanding);
  const key = _foldKeyForWrap(wrap);
  if (key) { if (expanding) _foldState[key] = true; else delete _foldState[key]; }
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
  // 复用 workspace detail 的同一套 handler:绑 tool-result-fold +
  // bootstrap _loadTurnEvents(turn 永远展开,无 turn-toggle)。
  bindWorkspaceColHandlers(view);
}


// ---------- Tasks view ----------
// Per-loop HTML cache so the patch path in renderTasksView can detect
// "this row didn't change" and skip the DOM write.
const _loopRowCache = new Map();

// desktop 统一侧栏:Tasks 路由下把 loop 列表填进 #sidebar-ctx,跟 Workspaces 的
// repo 树 / Settings 的 section 链 / Roundtable 的评议列表占同一槽位(spec §161)。
// 仿 renderRoundtableSidebarNav:复用 .shell-nav-item 视觉,但 **不带 data-tile-id**
// —— 否则 _bindSidebarNavHandlers 的 `.shell-nav-item[data-tile-id]` 选择器会误命中
// (workspace 拖拽 / focus)。列表项纯 <a href> 靠 hashchange → render() 跳转,不绑
// 自定义 handler;activeName 对应当前 detail 项加 .is-active。顶部 toolbar 的 `+New`
// 钮触发全局唯一的 #task-new-dialog —— dialog 由 _ensureTaskNewDialog() 挂在
// document.body 上(不在 #view 里),所以 list / detail 两路由下它都在,#view innerHTML
// 的生灭不影响它。收起态(.sidebar.is-rail)由 CSS 把整块 .task-sidebar-nav 隐掉。
function renderTaskSidebarNav(activeName) {
  const ctx = $('sidebar-ctx');
  if (!ctx) return;
  const items = navModelFromLoops(lastData.loops).sections[0].items;
  const links = items.length
    ? items.map((it) => {
        const cls = 'shell-nav-item shell-nav-repo'
          + (it.id === activeName ? ' is-active' : '');
        // 状态点复用 workspace / roundtable 那套 _navStatusDot(running 青脉冲 /
        // failed 红 / null 不渲)—— Option B:只标进行中 + 失败,paused/done 不显。
        const dot = _navStatusDot(it.status);
        return `<a class="${cls}" href="#tasks/${encodeURIComponent(it.id)}">`
          + `<span class="shell-nav-label">${esc(it.label)}</span>${dot}</a>`;
      }).join('')
    : '<p class="muted" style="padding:var(--space-2);font-size:12px;margin:0">还没有 cron loop</p>';
  ctx.innerHTML = `
    <div class="ws-toolbar rt-sidebar-toolbar">
      <button class="ws-new-btn" type="button" id="task-sidebar-new-btn">+ New</button>
    </div>
    <div class="task-sidebar-nav">${links}</div>`;
  // detail 路由下 #view 是单 loop 详情、不渲 dialog,所以这里确保全局 dialog 在。
  _ensureTaskNewDialog();
  // `+New` 钮:打开全局唯一 dialog。sidebar 每次重渲后重新绑(钮是新 DOM)。
  $('task-sidebar-new-btn')?.addEventListener('click', _openTaskNewDialog);
}

// 新建 cron loop dialog 的 HTML —— 唯一调用方是 _ensureTaskNewDialog(),它把这段挂到
// document.body 上(全局唯一,只渲一次)。原生 <dialog> 是 top-layer 浮层,挂哪都行;
// desktop sidebar 的 `+New` 钮(#task-sidebar-new-btn)和 mobile #view toolbar 的
// `+New` 钮(#task-new-btn)都通过 _openTaskNewDialog showModal 同一个 dialog。
// 表单内容是从 renderTasksView 原内联 <dialog> 抽出的单一来源。workspace 下拉用
// lastData.workspaces 现拉(_openTaskNewDialog 每次打开重建保证最新)。
function _taskNewDialogHtml() {
  const workspaces = lastData.workspaces || [];
  return `
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
    </dialog>`;
}

// 把全局唯一的 #task-new-dialog 挂到 document.body 上 —— 与 #view innerHTML 的生灭
// 彻底解耦(同 _ensureRtNewDialog 套路)。这样:list / detail 两路由下它都在,轮询
// render 重画 #view 不会销毁开着的 dialog,detail 页 `+New` 也能弹。
// **幂等**:已存在直接 return(不重渲 → 开着的 dialog 状态不被重置;不重绑 → submit
// 只触发一次)。workspace 下拉的"按当前数据刷新"放 _openTaskNewDialog(每次打开重建)。
function _ensureTaskNewDialog() {
  if (document.getElementById('task-new-dialog')) return;
  document.body.insertAdjacentHTML('beforeend', _taskNewDialogHtml());
  _bindTaskNewDialog();
}

// 打开 dialog 的统一入口(sidebar / mobile 的 `+New` 钮都走它):
//   ① ensure(保证 dialog 在 body 上、已绑好)
//   ② 若 workspace 列表变了(新增 / 删 ws),重建 dialog 让下拉反映最新 —— dialog 只在
//      首次 ensure 时按当时 workspaces 渲,之后 workspaces 可能变,故打开前比对重建。
//   ③ showModal(已开则不重复开)
function _openTaskNewDialog() {
  _ensureTaskNewDialog();
  let dlg = document.getElementById('task-new-dialog');
  if (!dlg) return;
  // workspace 下拉用建 dialog 那刻的 lastData.workspaces 快照;若现在 ws 列表已变,
  // 重建 dialog(只在没开着时重建,避免吞掉用户正在填的内容)。
  if (!dlg.open) {
    const want = (lastData.workspaces || []).join('\n');
    if (dlg.dataset.wsSnapshot !== want) {
      dlg.remove();
      document.body.insertAdjacentHTML('beforeend', _taskNewDialogHtml());
      dlg = document.getElementById('task-new-dialog');
      dlg.dataset.wsSnapshot = want;
      _bindTaskNewDialog();
    }
  }
  if (!dlg.open) dlg.showModal();
}

// 绑 dialog 表单逻辑 —— submit=onAddLoop / cancel / parse-btn=onParseNl。只在
// _ensureTaskNewDialog / _openTaskNewDialog 重建时调(dialog 全局唯一,绑一次即可)。
// 所有选择器锚定 dialog 自身(#task-new-dialog),不锚 #view —— dialog 已搬到
// document.body,不在 #view 里。workspace 的 form-picker 点击由 _onFormPickerClick
// (绑在 document 上)处理,无需在此绑。
function _bindTaskNewDialog() {
  const dlg = document.getElementById('task-new-dialog');
  if (!dlg) return;
  dlg.querySelector('form[data-form-id="new-loop"]')
    ?.addEventListener('submit', onAddLoop);
  dlg.querySelector('.parse-btn')
    ?.addEventListener('click', onParseNl);
  dlg.querySelector('.ws-new-cancel')
    ?.addEventListener('click', () => dlg.close());
}

function renderTasksView() {
  const loops = lastData.loops || [];
  const view = $('view');

  // desktop(spec §161):loop 列表已搬去 sidebar(renderTaskSidebarNav),#view
  // 只渲空态提示。dialog 不再渲进 #view —— 由 _ensureTaskNewDialog 挂在 body 上
  // (全局唯一,与 #view 生灭解耦)。幂等:已渲过空态就不重画(避免轮询 render
  // 重写 #view),但每次都调 _ensureTaskNewDialog(它幂等)保证 dialog 在。mobile
  // 走下面老逻辑(list + diff-patch + foldout turns),一字不动。跟 Roundtable 同款。
  if (!window.matchMedia('(max-width: 768px)').matches) {
    if (view.querySelector('.task-desktop-empty')) { _ensureTaskNewDialog(); return; }
    view.innerHTML = `
      <p class="muted task-desktop-empty">
        左侧选一个 task 查看,或点侧栏 <strong>+ New</strong> 建一个。<br>
        cron loop = 一条定时触发的 prompt。State 落在 <code>~/.cc-state/jobs/&lt;name&gt;.json</code>,
        cron 行写 <code>/etc/cron.d/cc-loops</code>;Engine 跟 workspace 设置走。
      </p>`;
    _ensureTaskNewDialog();
    return;
  }

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
  // + New 单独按钮 + 点击弹 dialog modal,创建表单平时不占空间。dialog 不再渲进
  // #view —— 由 _ensureTaskNewDialog 挂在 body 上(全局唯一,desktop / mobile 共用)。
  view.innerHTML = `
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="task-new-btn">+ New cron loop</button>
    </div>
    <div class="task-list">${rows}</div>
  `;

  for (const b of $('view').querySelectorAll('.run-now-btn, .pause-btn, .resume-btn, .delete-btn')) {
    b.addEventListener('click', onLoopAction);
  }
  // loopHistoryHtml 每条历史 run 渲染成一个 turn,需要 wire
  // tool-result-fold + 停 poll + bootstrap 已展开 turn 的 event load
  // (turn 永远展开,无 turn-toggle)。bindWorkspaceColHandlers 已封装好,复用。
  bindWorkspaceColHandlers($('view'));
  // mobile `+New` 钮走全局 dialog(ensure + 重建按当前 ws + showModal),同 rt。
  $('task-new-btn')?.addEventListener('click', _openTaskNewDialog);
  _ensureTaskNewDialog();
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
      <p><a href="#tasks" class="back-link task-back-link">← Tasks</a></p>
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
        <a class="workspace-back task-back-link" href="#tasks" aria-label="Back to tasks">←</a>
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
  // 决断员两个 mode 都可能用,统一显示。proponent 只在 1v1 显示。
  const visibleRoles = (mode === 'oneonone')
    ? roles.filter((r) => r.kind === 'proponent' || r.kind === 'synthesizer' || r.kind === 'decider')
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
                  : role.kind === 'decider' ? '<span class="muted rt-role-kind">(决断员)</span>'
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
  // mode 从 hidden input 读(此刻已被上次 mode 切换的 _onFormPickerClick 写定,
  // 稳定可靠);不传会回落 'roundtable',把 1v1 的正方/反方冲成 4 派。
  const mode = document.querySelector('input[name="mode"]')?.value || 'roundtable';
  _populateRtModelConfig(mode);
}

function _onRtModelResetAll() {
  _saveRtRoleModels({});
  // 同 _onRtModelRadioClick:从 hidden input 读当前 mode,别回落 'roundtable'。
  const mode = document.querySelector('input[name="mode"]')?.value || 'roundtable';
  _populateRtModelConfig(mode);
  showToast('info', '已恢复全部默认', { ttl: 1200 });
}

// Per-row HTML cache so renderRoundtablesView's patch path can diff
// roundtable entries by id and skip unchanged ones (same shape as
// _loopRowCache / _mobileCardCache).
const _rtRowCache = new Map();

// desktop 统一侧栏:评议路由下把评议列表填进 #sidebar-ctx,跟 Workspaces 的
// repo 树 / Settings 的 section 链占同一槽位(spec §160)。仿 renderSettingsSidebarNav:
// 复用 .shell-nav-item 视觉,但 **不带 data-tile-id** —— 否则 _bindSidebarNavHandlers
// 的 `.shell-nav-item[data-tile-id]` 选择器会误命中(workspace 拖拽 / focus)。
// 列表项纯 <a href> 靠 hashchange → render() 跳转,不绑自定义 handler;activeId
// 对应当前 detail 项加 .is-active。顶部 toolbar 的 `+新建` 钮触发全局唯一的
// #rt-new-dialog —— dialog 由 _ensureRtNewDialog() 挂在 document.body 上(不在
// #view 里),所以 list / detail 两路由下它都在,#view innerHTML 的生灭不影响它。
// 收起态(.sidebar.is-rail)由 CSS 把整块 .rt-sidebar-nav 隐掉。
function renderRoundtableSidebarNav(activeId) {
  const ctx = $('sidebar-ctx');
  if (!ctx) return;
  const items = navModelFromRoundtables(lastData.roundtables).sections[0].items;
  const links = items.length
    ? items.map((it) => {
        const cls = 'shell-nav-item shell-nav-repo'
          + (it.id === activeId ? ' is-active' : '');
        // 状态点复用 workspace 侧栏那套 _navStatusDot(running 青脉冲 / failed 红 /
        // null 不渲)—— Option B:只标进行中 + 失败,done/queued 不显(历史列表干净)。
        const dot = _navStatusDot(it.status);
        return `<a class="${cls}" href="#roundtables/${encodeURIComponent(it.id)}">`
          + `<span class="shell-nav-label">${esc(it.label)}</span>${dot}</a>`;
      }).join('')
    : '<p class="muted" style="padding:var(--space-2);font-size:12px;margin:0">还没有评议</p>';
  ctx.innerHTML = `
    <div class="ws-toolbar rt-sidebar-toolbar">
      <button class="ws-new-btn" type="button" id="rt-sidebar-new-btn">+ 新建</button>
      <a href="#settings/roles" class="ws-toolbar-link"
         style="margin-left:12px;font-size:13px;text-decoration:none;color:var(--accent-blue)">
        ⚙ 角色配置
      </a>
    </div>
    <div class="rt-sidebar-nav">${links}</div>`;
  // detail 路由下 #view 是 round×role 网格、不渲 dialog,所以这里确保全局 dialog 在。
  _ensureRtNewDialog();
  // `+新建` 钮:打开全局唯一 dialog。sidebar 每次重渲后重新绑(钮是新 DOM)。
  // click 时再 ensure 一次(防御:即便上面没调到也保证 dialog 在),然后按当前
  // 数据重填 model 下拉再 showModal —— 见 _openRtNewDialog。
  $('rt-sidebar-new-btn')?.addEventListener('click', _openRtNewDialog);
}

// 新建评议 dialog 的 HTML —— 唯一调用方是 _ensureRtNewDialog(),它把这段
// 挂到 document.body 上(全局唯一,只渲一次)。原生 <dialog> 是 top-layer 浮层,
// 挂哪都行;desktop sidebar 的 `+新建` 钮和 mobile #view toolbar 的 `+新建` 钮
// 都通过 _openRtNewDialog showModal 同一个 dialog。
function _rtNewDialogHtml() {
  return `
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
        <label class="rt-decider-row" title="勾选后 synth 之上额外给 AI 推荐方案">
          <input type="checkbox" name="enable_decider" value="1">
          <span><strong>我要最终结果(AI 拍板)</strong><br>
            <span class="muted" style="font-size:11px">在 synth 之上额外给:推荐方案 + 理由 + 代价 + 备选</span></span>
        </label>
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
    </dialog>`;
}

// 把全局唯一的 #rt-new-dialog 挂到 document.body 上 —— 与 #view innerHTML 的生灭
// 彻底解耦。原生 <dialog> 走 top-layer 浮层,挂哪都行;挂 body 上 + 全局唯一 +
// 只渲一次只绑一次,这样:list / detail 两路由下它都在,轮询 render 重画 #view
// 不会销毁开着的 dialog,detail 页 `+新建` 也能弹(修的 Block)。
// **幂等**:已存在直接 return(不重渲 → 开着的 dialog / model 下拉状态不被重置;
// 不重绑 → submit 只触发一次)。
function _ensureRtNewDialog() {
  if (document.getElementById('rt-new-dialog')) return;
  document.body.insertAdjacentHTML('beforeend', _rtNewDialogHtml());
  _bindRtNewDialog();
}

// 打开 dialog 的统一入口(sidebar / mobile 的 `+新建` 钮都走它):
//   ① ensure(保证 dialog 在 body 上、已绑好)
//   ② 按当前数据重填 model 下拉 —— dialog 只绑一次,但每次打开都重填,这样
//      用户两次打开之间改的 role override(localStorage)/ mode 能反映出来,
//      不会停在第一次打开的快照。model 列表本身来自 _rtModelsCache(独立的
//      /roundtables/models 一次性缓存,不随 lastData 变),所以"绑一次"对它无害。
//   ③ showModal(已开则不重复开)
function _openRtNewDialog() {
  _ensureRtNewDialog();
  const dlg = document.getElementById('rt-new-dialog');
  if (!dlg) return;
  const currentMode = dlg.querySelector('input[name="mode"]')?.value || 'roundtable';
  if (_rtModelsCache) {
    _populateRtModelConfig(currentMode);
  } else {
    ensureRoundtableModels().then(() => _populateRtModelConfig(currentMode));
  }
  if (!dlg.open) dlg.showModal();
}

// 绑 dialog 表单逻辑 —— submit / cancel / mode picker。只在 _ensureRtNewDialog
// 里调一次(dialog 全局唯一,绑一次即可,不重复绑)。所有选择器锚定 dialog 自身
// (#rt-new-dialog),不锚 #view —— dialog 已搬到 document.body,不在 #view 里。
function _bindRtNewDialog() {
  const dlg = document.getElementById('rt-new-dialog');
  if (!dlg) return;
  dlg.querySelector('form[data-form-id="new-roundtable"]')
    ?.addEventListener('submit', onCreateRoundtable);
  dlg.querySelector('.ws-new-cancel')
    ?.addEventListener('click', () => dlg.close());
  // mode picker change → 切换 form 显示(隐藏轮数 / 改 blurb / 切换 model 列表)
  $('rt-mode-row')?.addEventListener('click', _onRtModeChange);
  // model 下拉的填充由 _openRtNewDialog 在每次打开时做(cache-hot 同步 / cold
  // 异步 fetch 一次),这里不再填 —— 绑一次但数据每次打开都新。
}

function renderRoundtablesView() {
  const rows = lastData.roundtables || [];
  const view = $('view');

  // desktop(spec §160):列表已搬去 sidebar(renderRoundtableSidebarNav),#view
  // 只渲空态提示。dialog 不再渲进 #view —— 由 _ensureRtNewDialog 挂在 body 上
  // (全局唯一,与 #view 生灭解耦)。幂等:已渲过空态就不重画(避免轮询 render
  // 重写 #view),但每次都调 _ensureRtNewDialog(它幂等)保证 dialog 在。mobile
  // 走下面老逻辑,一字不改。
  if (!window.matchMedia('(max-width: 768px)').matches) {
    if (view.querySelector('.rt-desktop-empty')) { _ensureRtNewDialog(); return; }
    view.innerHTML = `
      <p class="muted rt-desktop-empty">
        左侧选一个评议查看,或点侧栏 <strong>+ 新建</strong> 开一场。<br>
        <strong>4 派评议</strong>:4 个角色(极简派 / 场景派 / 借鉴派 / 悲观派)对决策问题各抒己见,
        整理员综合 → <em>共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动</em>。
        <strong>1v1 对抗</strong>:把二值问题拆成正反两个立场死磕同一分歧轴(做 / 不做 / 用 / 不用)。
      </p>`;
    _ensureRtNewDialog();
    return;
  }

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
  // toolbar 模式,跟 Workspaces / Tasks tab 一致。dialog 不再渲进 #view —— 由
  // _ensureRtNewDialog 挂 body 上(全局唯一,desktop / mobile 共用同一个)。
  view.innerHTML = `
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="rt-new-btn">+ 新建</button>
      <a href="#settings/roles" class="ws-toolbar-link"
         style="margin-left:12px;font-size:13px;text-decoration:none;color:var(--accent-blue)">
        ⚙ 角色配置
      </a>
    </div>
    ${blurb}
    <div class="rt-list">${list}</div>
  `;
  for (const b of $('view').querySelectorAll('.rt-delete')) {
    b.addEventListener('click', onDeleteRoundtable);
  }
  // mobile `+新建` 钮走全局 dialog(ensure + 重填 model 下拉 + showModal)。
  $('rt-new-btn')?.addEventListener('click', _openRtNewDialog);
  _ensureRtNewDialog();
}

// Mode picker 切换时 触发 form 重排:隐藏 / 显示轮数;改 blurb;切换 placeholder;
// 重新 populate model config(过滤 1v1 / roundtable 各自的角色)。
// 用 click delegation 而不是 change event。注意:_onFormPickerClick 绑在
// document 上,在冒泡里晚于本 handler 触发(本 handler 绑在更近的 #rt-mode-row),
// 所以这里读它写的 hidden input 会拿到旧值 —— mode 改从被点选项的 data-value
// 读,详见函数体内注释。
function _onRtModeChange(e) {
  const btn = e.target.closest('.form-picker-radio');
  if (!btn) return;
  // mode 直接读被点选项的 data-value,不读 hidden input:写 hidden 的
  // _onFormPickerClick 绑在 document 上,在事件冒泡里晚于本 handler(绑在更近的
  // #rt-mode-row 上)触发 —— 此刻读 hidden 会拿到切换前的旧 mode(race),
  // 导致切到 1v1 仍按 4 派重渲。读 data-value 是切后的新值,无 race。
  const mode = btn.dataset.value || 'roundtable';
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
    const roundtableRoles = new Set(['极简派', '场景派', '借鉴派', '悲观派', '整理员', '审查员', '决断员']);
    const oneononeRoles = new Set(['正方', '反方', '整理员', '决断员']);
    const allowedRoles = mode === 'oneonone' ? oneononeRoles : roundtableRoles;
    const filteredOverrides = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (allowedRoles.has(k)) filteredOverrides[k] = v;
    }

    const body = { question: fd.question };
    if (Object.keys(filteredOverrides).length > 0) body.role_models = filteredOverrides;
    if (attachments.length > 0) body.attachments = attachments;
    // 决断员 checkbox(默认关) — 勾上 backend synth 之后跑一次出 verdict
    if (fd.enable_decider === '1') body.enable_decider = true;

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
      <p><a href="#roundtables" class="back-link rt-back-link">← Roundtable</a></p>
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
  const hasVerdict = !!row.verdict;
  const sig = `${status}:${turnsDone}:${hasR3 ? '1' : '0'}:${hasVerdict ? '1' : '0'}:${errorKey}:${reviewerKey}`;

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

  // 决断员 verdict block — opt-in 时显示(警示色边框提醒"这是 AI 拍板")。
  // verdict 段 5 段:推荐方案(单行) / 理由 / 代价 / 备选(bullet 列表) /
  // 胜方判定(1v1 单行)。decider 失败时 verdict.parsed["推荐方案"] 含
  // "决断员调用失败" 字样 — 用户 opt-in 了该知道。
  // pending state:decider_enabled=true 但 verdict 还没生成 → 显示 placeholder
  const v = row.verdict;
  let verdictBlock = '';
  // Defensive:backend 正常路径 verdict 要么 null 要么 {raw, parsed},
  // 但碰到 server-PWA 版本错位 / polling race / 旧 cache 时,可能拿到
  // {raw} 缺 parsed 的半成品。当成"没 verdict"处理,不抛 undefined.
  if (v && v.parsed && typeof v.parsed === 'object') {
    // 失败态识别:debate.py decider catch 块写的 "(决断员调用失败,无法生成推荐)"
    // 字符串塞进"推荐方案" 段。这里检测 + 独立 CSS class,避免失败态用橙色加粗
    // headline 看起来跟正常推荐一样。
    const rec = v.parsed['推荐方案'] || '';
    const isFailed = rec.includes('决断员调用失败');
    if (isFailed) {
      verdictBlock = `
        <section class="rt-verdict rt-verdict-failed">
          <h2>⚠ 决断员未生成 <span class="rt-verdict-warning">调用失败</span></h2>
          <div class="rt-verdict-failed-msg">
            ${(v.parsed['理由'] || []).map((l) => `<div>${esc(l)}</div>`).join('')}
          </div>
          <details class="rt-r3-raw">
            <summary>原始 markdown</summary>
            <pre>${esc(v.raw)}</pre>
          </details>
        </section>
      `;
    } else {
      const winner = v.parsed['胜方判定'];
      verdictBlock = `
        <section class="rt-verdict">
          <h2>⚠ 决断员推荐 <span class="rt-verdict-warning">AI 拍板,仅供参考</span></h2>
          ${rec ? `<div class="rt-verdict-headline">${esc(rec)}</div>` : ''}
          ${_rtSection('理由', v.parsed['理由'])}
          ${_rtSection('代价', v.parsed['代价'])}
          ${_rtSection('备选', v.parsed['备选'])}
          ${winner ? `<div class="rt-verdict-winner"><strong>胜方判定:</strong> ${esc(winner)}</div>` : ''}
          <details class="rt-r3-raw">
            <summary>原始 markdown</summary>
            <pre>${esc(v.raw)}</pre>
          </details>
        </section>
      `;
    }
  } else if (row.decider_enabled && r3 && status !== 'error') {
    verdictBlock = `
      <section class="rt-verdict rt-verdict-pending">
        <h2>⚠ 决断员推荐 <span class="rt-verdict-warning">生成中...</span></h2>
        <p class="muted">整理员综合完成后,决断员会基于 synth + R1/R2 给出推荐方案 / 理由 / 代价 / 备选。</p>
      </section>
    `;
  }

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
  //
  // 1v1 mode 不暴露续问 — POST /roundtables/{id}/continue 走 4 派 path
  // (_customized_role_list 返 4 派 + synth + reviewer),跟 1v1 的 [正方, 反方]
  // 不搭。用户点续问会让 1v1 session "变身"成 4 派。未来若加 1v1 续问
  // 需要专门写 submit_continue_oneonone。
  const continueInputHtml = (row.mode !== 'oneonone' && (r3 || status === 'done')) ? `
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
    <p><a href="#roundtables" class="back-link rt-back-link">← Roundtable</a></p>
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
      ${verdictBlock}
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

// desktop 统一侧栏:Settings 路由下把 3 个 section 链填进 #sidebar-ctx,跟
// Workspaces 的 repo 树占同一槽位(spec §14 阶段 2)。复用 .shell-nav-item
// 视觉,但 **不带 data-tile-id** —— 否则 _bindSidebarNavHandlers 的
// `.shell-nav-item[data-tile-id]` 选择器会误命中。纯 <a href> 靠 hashchange
// → render() 跳转,不绑自定义 handler;active section 加 .is-active。
// 收起态(.sidebar.is-rail)由 CSS 把整块 .settings-sidebar-nav 隐掉。
function renderSettingsSidebarNav(activeSection) {
  const ctx = $('sidebar-ctx');
  if (!ctx) return;
  const sections = [
    { id: 'providers', label: 'Providers' },
    { id: 'roles', label: 'Roles' },
    { id: 'agents', label: 'Agents' },
  ];
  const links = sections.map((s) => {
    const cls = 'shell-nav-item shell-nav-repo'
      + (s.id === activeSection ? ' is-active' : '');
    return `<a class="${cls}" href="#settings/${s.id}">`
      + `<span class="shell-nav-label">${esc(s.label)}</span></a>`;
  }).join('');
  ctx.innerHTML = `<div class="settings-sidebar-nav">${links}</div>`;
}

function renderSettingsView() {
  // desktop:#settings 无 section → 默认渲 providers 内容(sidebar nav 由
  // render() 填,active=providers)。**不 replaceState**,hash 留 #settings,
  // 让 Settings tab 的"裸 hash"稳定指向默认子页。mobile 保持 hub 卡片。
  if (!window.matchMedia('(max-width: 768px)').matches) {
    renderSettingsProvidersView();
    return;
  }
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
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link settings-back-link">← Settings</a></p>
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
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link settings-back-link">← Settings</a></p>
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
                  : role.kind === 'decider' ? '<span class="muted rt-role-kind">(决断员 · opt-in)</span>'
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
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link settings-back-link">← Settings</a></p>
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
bindSidebarCollapse();   // 常驻 #sidebar 收起钮,绑一次(不随 render 重建)
render();
refreshAll();
setInterval(refreshAll, 3000);
