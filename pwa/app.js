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
  isDoneStale,
  DONE_STALE_SEC,
  navModelFromRoundtables,
  navModelFromLoops,
  loadShellState,
  paneStateReducer,
  gitBadgeText,
  hunksToHtml,
  _prunePanes,
} from './ui_contract.mjs';
import { ICONS } from './icons.mjs';
import { _bindSidebarNavHandlers, _bindTurnInteractions, _closeStrayDialogs, _dispatchAllQueues, _isMobileViewport, _lastPaintedStatus, _mobileCardCache, _navStatusDot, _onFormPickerClick, _renderFormPicker, _workspaceTurnHtml, bindSidebarCollapse, bindWorkspaceColHandlers, clearDetails, clearDraft, renderRunDetailView, renderWorkspaceDetailView, renderWorkspacesView, restoreDrafts, snapshotDrafts } from './workspaces.mjs';
import { $, esc, api, showToast, showError, clearError, lastData, setLastData, _redirectingToLogin, setRender, setRefresh } from './core.mjs';

// $ / esc → ./core.mjs

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

// ICONS / inline SVG icon set → ./icons.mjs(2026-06-09 抽出为独立模块)

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
// api(path, opts) + _redirectingToLogin → ./core.mjs

// toast: showToast / showError / dismissToast / clearError → ./core.mjs

// 共享数据 lastData(+ setLastData setter)→ ./core.mjs(只读 import;refreshAll 用 setLastData 写)

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
    setLastData({
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
    });
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
// workspace 状态+helper(W1)→ ./workspaces.mjs
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

// Workspaces 视图(W2,#workspaces/*)→ ./workspaces.mjs
// Tasks 视图(#tasks/*)→ ./tasks.mjs(2026-06-09 抽出)。
import { renderTaskSidebarNav, _ensureTaskNewDialog, _openTaskNewDialog, renderTasksView, renderTaskDetailView } from './tasks.mjs';
// Roundtable 视图(#roundtables/*)→ ./roundtables.mjs(2026-06-09 抽出)。
import { renderRoundtableSidebarNav, renderRoundtablesView, renderRoundtableDetailView } from './roundtables.mjs';
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

// Settings 视图(#settings/*)→ ./settings.mjs(2026-06-09 抽出)。
import { renderSettingsSidebarNav, renderSettingsView, renderSettingsSectionView } from './settings.mjs';
// ---------- boot ----------
// 给 core 的 render-bus 登记真函数 —— 拆出去的 view 模块靠它转发调 render/refreshAll
setRender(render);
setRefresh(refreshAll);
bindSidebarCollapse();   // 常驻 #sidebar 收起钮,绑一次(不随 render 重建)
render();
refreshAll();
setInterval(refreshAll, 3000);

// 供拆出的 view 模块 import(app↔view 运行时循环,函数体内调用安全)。

export { _runPreviewLine, humanizeCron, parseRoute, renderMarkdown, statusTag, timeAgo };
