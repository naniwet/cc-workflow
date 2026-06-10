// Workspaces 视图模块(2026-06-09 从 app.js 抽出第六块/最后一块)。
// 含工作区状态(runDetailCache/队列/草稿/滚动/paneState…W1)+ 全部 workspace
// 视图(overview/detail/sidebar/run-detail…W2)。状态和视图同住一模块 → 跨模块
// 无共享可变状态(paneState 重赋值在本模块内,无需 setter)。
// 依赖:core + ICONS + ui_contract(23 纯函数)+ app.js 的 5 个
// 纯 util/router(_runPreviewLine, parseRoute, renderMarkdown, statusTag, timeAgo —— app↔ws 仅函数循环,无状态,ESM 安全)。
import { $, esc, api, showToast, showError, clearError, dismissToast, lastData, setLastData, requestRender as render, requestRefresh as refreshAll } from './core.mjs';
import { ICONS } from './icons.mjs';
import { _renderFormPicker, _onFormPickerClick, _navStatusDot, _addTapFallback, _fileDownloadHref } from './components.mjs';
import { _gitSectionHtml, _bindGitSectionHandlers } from './git_view.mjs';
import { _bindTurnInteractions, _loadTurnEvents, _renderTurnEvent, _stopAllTurnEventsPolls, _syncWorkspaceNewEventsButton, _workspaceTurnHtml } from './turn_stream.mjs';
import { DONE_STALE_SEC, STATUS_ACCENTS, _prunePanes, buildSidebarTree, detailVisibleTurns, filterTurnsBySession, foldToolResult, formatToolUse, gitBadgeText, hunksToHtml, isDoneStale, isUserSession, loadShellState, navModelFromTree, nextSessionKey, paneStateReducer, parseSessionTileId, parseStreamLinesToEvents, resolveRunSessionKey, sessionChipLabel, sessionTileId, tileKeyFor, workspaceAutoScrollState, workspaceTurnExpansion } from './ui_contract.mjs';
import { _runPreviewLine, parseRoute, renderMarkdown, statusTag, timeAgo } from './app.js';

const runDetailCache = {};                          // id → row (status=done/failed only)

// Drafts: keep what the user is typing in each workspace's prompt box across
// re-renders. Polling re-renders blow away DOM, so we snapshot textareas/inputs
// before render() and restore them after.
const drafts = {};                                  // key: form-id, val: name → value
const detailsOpen = {};                             // key: details-id, val: bool
const timelineScroll = {};                          // key: ws name → {scrollTop, atBottom}
const _detailShownCount = {};                       // colKey → detail timeline 已露出的 turn 数(默认 10,"加载更早" +10)
const DETAIL_DEFAULT_ROWS = 10;                      // detail 默认显示 + 每次"加载更早"的步长
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

// detail timeline 两个渲染路径(PC workspaceColHtml / mobile
// renderMobileWorkspaceDetail)共用:把全量 turns 截到"已露出的最近 N 条" +
// 算顶部"加载更早"按钮 html。历史已被后端封在 _RECENT_PER_WS(20)条,但全摊开
// 开面板要并发拉每条 event 流(PC expandAll)/ 渲染全部卡(mobile),很慢 ——
// 默认只露最近 DETAIL_DEFAULT_ROWS 条,更老的折在按钮里,点一次 +10(纯前端,
// 在已缓存的 ≤20 条内切片,见 ui_contract.detailVisibleTurns)。
function _detailTurnsWithEarlier(colKey, turns) {
  const shown = _detailShownCount[colKey] ?? DETAIL_DEFAULT_ROWS;
  const { visible, hidden } = detailVisibleTurns(turns, shown);
  let earlierHtml = '';
  if (hidden > 0) {
    const step = Math.min(hidden, DETAIL_DEFAULT_ROWS);
    earlierHtml =
      `<button type="button" class="load-earlier" data-ws="${esc(colKey)}">`
      + `↑ 加载更早 ${step} 条(还有 ${hidden})</button>`;
  }
  return { turnsToShow: visible, earlierHtml };
}

// "加载更早":把该 colKey 已露出的 turn 数 +DETAIL_DEFAULT_ROWS,重渲染。
// detailVisibleTurns 内部已对 turns.length 封顶,不会越界。重渲染后
// timelineScroll 恢复机制把用户大致留在原处(新内容长在上方)。
function _onLoadEarlierClick(e) {
  const btn = e.target.closest('.load-earlier');
  if (!btn) return;
  e.preventDefault();
  const colKey = btn.dataset.ws;
  if (!colKey) return;
  _detailShownCount[colKey] = (_detailShownCount[colKey] ?? DETAIL_DEFAULT_ROWS) + DETAIL_DEFAULT_ROWS;
  render();
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
    // 只存 scrollTop 供"用户曾向上翻"时 restoreDrafts 还原位置。
    // **不在这里重算 / 覆盖 workspaceStreamState.atBottom** —— snapshotDrafts 每次
    // render 开头跑,会读到异步加载途中的瞬时位置(events 已撑高但 rAF 还没贴底,
    // scrollTop 仍 0)→ 误判 atBottom=false → 之后 restoreDrafts 据此"保持"在顶,
    // 打开会话永远卡在最上面(mobile 打开不滚到底的真根因,harness 复现)。
    // follow-bottom 意图只由真实 scroll 事件(_bindWorkspaceSessionHandlers 里的
    // 监听)+ renderMobileWorkspaceDetail(保留上次意图)拥有,渲染快照不参与。
    const atBottom = Math.abs(s.scrollHeight - s.clientHeight - s.scrollTop) < 80;
    workspaceSessionScroll[s.dataset.ws] = { scrollTop: s.scrollTop, atBottom };
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
      _scrollToBottom(t);
    } else {
      t.scrollTop = saved.scrollTop;
    }
  }
  for (const s of document.querySelectorAll('.workspace-session-stream[data-ws]')) {
    const state = workspaceStreamState[s.dataset.ws];
    const saved = workspaceSessionScroll[s.dataset.ws];
    if (!saved || state?.atBottom !== false) {
      _scrollToBottom(s);
    } else {
      s.scrollTop = saved.scrollTop;
    }
    _syncWorkspaceNewEventsButton(s.dataset.ws);
  }
}

// 自动贴底:瞬时跳到底,**绕过** CSS `scroll-behavior: smooth`。打开会话 / 新
// events 异步到达时,平滑动画会被多次重设互相打断、落不到真底(mobile 打开
// 停在中间的根因 —— harness 复现:打开后约 2s 才慢慢滚到底)。这里临时把
// scroll-behavior 置 auto 做瞬时跳,再还原 —— 比依赖 scrollTo({behavior:'instant'})
// 的浏览器支持更稳(顾及国产 ROM WebView)。用户主动点"↓ N new"按钮的滚动
// 不走这里(那条单独调,保留 smooth 手感)。
function _scrollToBottom(el) {
  if (!el) return;
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight;
  el.style.scrollBehavior = prev;
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

// _navStatusDot → ./components.mjs

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
        ${_navStatusDot(item.status, item.latestAt)}
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
        ${_navStatusDot(item.status, item.latestAt)}
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
  for (const btn of root.querySelectorAll('.load-earlier')) {
    btn.addEventListener('click', _onLoadEarlierClick);
  }
  for (const btn of root.querySelectorAll('.ws-sync-skills')) {
    btn.addEventListener('click', _onSyncSkillsClick);
  }
  // 手动下载文件按钮 — tool 事件 / Git 区都没列出目标文件时的兜底入口。
  for (const btn of root.querySelectorAll('.ws-download-file')) {
    btn.addEventListener('click', _onDownloadFileClick);
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


// _addTapFallback → ./components.mjs

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
// form-picker + _navStatusDot → ./components.mjs(2026-06-09 抽出)

// 多 session chip 条点击(delegation:mobile + desktop detail 共用)。
// 切 active session(空 data-session = "全部")→ 重画。新建 session 走侧栏的
// "+ 新对话"(_onPcNewChatClick / _startNewChatMobile),不在 chip 条里。
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
  // detail:默认只露最近 N 条 + 顶部"加载更早"(见 _detailTurnsWithEarlier,
  // 治 expandAll 并发拉全部 event 流的卡顿);overview:维持 slice(-maxRows)。
  const { turnsToShow, earlierHtml } = detail
    ? _detailTurnsWithEarlier(colKey, turns)
    : { turnsToShow: turns.slice(-maxRows), earlierHtml: '' };
  _pinJustFinishedTurns(turnsToShow);
  const expandedTurns = workspaceTurnExpansion(
    turnsToShow,
    workspaceTurnOverrides,
    { expandAll: detail },
  );
  timelineHtml = expandedTurns.length
    ? earlierHtml + expandedTurns.map(_workspaceTurnHtml).join('')
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
  const providerEngineBlock = `
    <div class="ws-meta-mobile">
      ${providerLabel}
      ${engineChip}
      <details class="ws-actions-menu" data-details-id="ws-menu-${esc(name)}">
        <summary class="ws-actions-trigger" aria-label="More actions">${ICONS.more}</summary>
        <div class="ws-actions-menu-body">
          <!-- Provider / Trust 已下沉到 composer(可点模型 chip + Trust chip);
               Pull latest / Create PR 已移除(2026-06-04 控制区重构)。菜单只留
               低频 + 管理动作。 -->
          <div class="ws-menu-section">
            <span class="ws-menu-section-label">Workspace</span>
            <button class="ws-sync-skills ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.refresh} <span>Sync /commands</span>
            </button>
            <button class="ws-download-file ws-menu-item" type="button" data-ws="${esc(name)}">
              ${ICONS.download} <span>下载文件…</span>
            </button>
          </div>
          <!-- + 新 session 已移除:新建对话走侧栏的"+ 新对话"(2026-06-04)。 -->
          <div class="ws-menu-section">
            <span class="ws-menu-section-label">Session</span>
            <button class="ws-reset-session ws-menu-item" type="button" data-ws="${esc(name)}"${skAttr}>
              ${ICONS.rewind} <span>New chat</span>
            </button>
          </div>
          <!-- Show all events 挪到底部(用户要求):它是显示偏好,不是常用动作。 -->
          <div class="ws-menu-section">
            <span class="ws-menu-section-label">Display</span>
            <button class="event-filter-toggle ws-menu-item" type="button"
                    data-show-all="${eventFilterShowAll() ? '1' : '0'}">
              ${ICONS.refresh} <span>Show all events <strong>${eventFilterShowAll() ? 'ON' : 'OFF'}</strong></span>
            </button>
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
  const wsProvider = lastData.wsSettings[name]?.provider || '';
  const trustOn = effectiveTrust(name);
  const runOrStop = activeRun
    ? `<button class="run-cancel-btn composer-stop" type="button" data-run-id="${esc(activeRun.id)}">⏹ Stop</button>`
    : `<button class="composer-send" type="submit">Run</button>`;
  // 高频两个控件下沉到 composer(用户要求 2026-06-04):
  //   · 模型 chip:可点 → 向上弹 provider 单选(复用 ws-actions-menu 的关闭逻辑
  //     + _providerRadioListHtml + .ws-menu-radio→_onProviderRadioClick handler)。
  //   · Trust chip("模式"):点切自动批准(复用 .ws-trust-toggle→onTrustToggleClick)。
  // 都复用既有 handler,bindWorkspaceColHandlers 已按 class 委托绑定,无需新绑。
  return `
    <form class="trigger-form composer" data-workspace="${esc(name)}"${skAttr} data-form-id="ws-${esc(colKey)}">
      <div class="attach-chips" data-ws="${esc(name)}"></div>
      <input type="file" class="attach-input" data-ws="${esc(name)}" multiple hidden>
      <textarea name="prompt" class="composer-input" rows="1" placeholder="Message…"></textarea>
      <div class="composer-toolbar">
        <button type="button" class="attach-btn" data-ws="${esc(name)}" aria-label="Attach files">📎</button>
        <details class="ws-actions-menu composer-model-menu" data-details-id="composer-model-${esc(colKey)}">
          <summary class="composer-model-chip" title="切换模型 / provider">${esc(model)} ▾</summary>
          <div class="ws-actions-menu-body composer-model-body">
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Provider</span>
              ${_providerRadioListHtml(name, wsProvider)}
            </div>
          </div>
        </details>
        <button type="button" class="composer-trust-chip ws-trust-toggle${trustOn ? ' is-on' : ''}"
                data-ws="${esc(name)}" data-trusted="${trustOn ? '1' : '0'}"
                title="自动批准工具调用(关 = 每个工具调用弹 Approve / Deny)">
          ${trustOn ? ICONS.unlock : ICONS.lock}<span>${trustOn ? '自动批准' : '需批准'}</span>
        </button>
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


// Pending approvals for a workspace — used by the mobile overview card
// to badge workspaces that are blocked waiting on the user. Without
// this badge, mobile users had to tap into each workspace to discover
// a pending approval.
function pendingApprovalsForWorkspace(name) {
  if (!name) return [];
  return (lastData.pendingApprovals || []).filter((a) => a.workspace === name);
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
  const allTurns = _filterTurnsBySession(currentName, _workspaceSessionTurns(data));
  // detail:默认只露最近 N 条 + 顶部"加载更早"(同 PC,见 _detailTurnsWithEarlier)。
  const { turnsToShow, earlierHtml } = _detailTurnsWithEarlier(currentName, allTurns);
  _pinJustFinishedTurns(turnsToShow);
  const expandedTurns = workspaceTurnExpansion(turnsToShow, workspaceTurnOverrides);
  const eventCount = expandedTurns.length + pendingApprovalsForWorkspace(currentName).length;
  workspaceStreamState[currentName] = workspaceAutoScrollState(workspaceStreamState[currentName], {
    eventCount,
    atBottom: workspaceStreamState[currentName]?.atBottom !== false,
  });
  // "在跑"看全量(running turn 恒在最新、必在已露出的 N 条内,但语义上是
  // "这个 workspace 是否有进行中的 run",取全量更准)。
  const isRunning = allTurns.some((t) => t.status === 'running' || t.status === 'queued');

  const view = $('view');
  view.innerHTML = _workspaceSessionDetailHtml(currentName, expandedTurns, {
    eventCount, isRunning, activeRun: (data.active || [])[0], earlierHtml,
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

function _workspaceSessionDetailHtml(name, turns, { eventCount, isRunning, activeRun, earlierHtml = '' }) {
  const state = workspaceStreamState[name] || {};
  const wsProvider = lastData.wsSettings[name]?.provider || '';
  const wsEngine = lastData.wsSettings[name]?.engine || 'claude';
  const disabledAttr = isRunning ? 'disabled' : '';
  const turnsHtml = turns.length
    ? earlierHtml + turns.map(_workspaceTurnHtml).join('')
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
            <!-- Provider / Trust 下沉到 composer;Pull latest / Create PR 已移除
                 (2026-06-04 控制区重构)。菜单只留低频 + 管理。 -->
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Workspace</span>
              <button class="ws-sync-skills ws-menu-item" type="button" data-ws="${esc(name)}">
                ${ICONS.refresh} <span>Sync /commands</span>
              </button>
              <button class="ws-download-file ws-menu-item" type="button" data-ws="${esc(name)}">
                ${ICONS.download} <span>下载文件…</span>
              </button>
            </div>
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Session</span>
              <button class="ws-reset-session ws-menu-item" type="button" data-ws="${esc(name)}" ${disabledAttr}>
                ${ICONS.rewind} <span>New chat</span>
              </button>
            </div>
            <!-- Show all events 挪到底部(用户要求):显示偏好,不是常用动作。 -->
            <div class="ws-menu-section">
              <span class="ws-menu-section-label">Display</span>
              <button class="event-filter-toggle ws-menu-item" type="button"
                      data-show-all="${eventFilterShowAll() ? '1' : '0'}">
                ${ICONS.refresh} <span>Show all events <strong>${eventFilterShowAll() ? 'ON' : 'OFF'}</strong></span>
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





// CSS 选择器里的 runId 可能带 - / : 等,esc() 用于 HTML 转义不够,
// 单独写一个 CSS attribute selector 用的转义。运行时 run_id 都是
// `<workspace>-<unix_ts>-<uuid8>` 形状,只有 ASCII + `-`,所以这里
// 是防御性的简单实现 — 真有更复杂字符再换 CSS.escape()。
function cssQuoteEsc(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
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

// Git/Diff 区段 → ./git_view.mjs(2026-06-09 抽出)



// 手动下载兜底:tool 事件 / Git 区都看不到目标文件时(对话太久被 compact、
// 文件没经过 Write/Edit 落盘等),让用户直接填路径下载。走已有的安全端点
// /workspaces/{ws}/file(realpath + relative_to 兜越权)。先 fetch 探状态 →
// 404 / 越权能弹明确 toast,而不是默默下一个装着错误 JSON 的文件。
async function _onDownloadFileClick(e) {
  const ws = e.currentTarget?.dataset?.ws;
  if (!ws) return;
  const raw = window.prompt('文件路径(相对 workspace 根,或绝对路径):');
  if (!raw || !raw.trim()) return;
  const path = raw.trim();
  try {
    const r = await fetch(_fileDownloadHref(ws, path));
    if (!r.ok) {
      let msg = `下载失败 (${r.status})`;
      try {
        const j = await r.json();
        msg = j?.detail?.msg || (typeof j?.detail === 'string' ? j.detail : msg);
      } catch { /* 非 JSON 错误体,保留状态码 */ }
      showError(msg);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(`下载失败:${err.message}`);
  }
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

export { drafts, workspaceActiveSession, _bindSidebarNavHandlers, _bindTurnInteractions, _closeStrayDialogs, _dispatchAllQueues, _isMobileViewport, _lastPaintedStatus, _mobileCardCache, _navStatusDot, _onFormPickerClick, _renderFormPicker, _workspaceTurnHtml, bindSidebarCollapse, bindWorkspaceColHandlers, clearDetails, clearDraft, renderRunDetailView, renderWorkspaceDetailView, renderWorkspacesView, restoreDrafts, snapshotDrafts, _scrollToBottom, cssQuoteEsc, eventFilterShowAll, timelineScroll, workspaceStreamState };
