// Tasks 视图模块(2026-06-09 从 app.js 抽出第四块)。
// #tasks(cron loops 列表)+ #tasks/<name>(task detail,复用 workspace turn 流)。
// 依赖:core + ICONS + ui_contract(nextRunLabel/navModelFromLoops)+ app.js 的
// workspace 共享 helper(form-picker / turn 交互 / turn HTML / nav 绑定 —— 都在
// Workspaces 区,app↔view 运行时循环,函数体内调用,ESM 安全)。
import { $, esc, api, showToast, showError, clearError, lastData, requestRender as render, requestRefresh as refreshAll } from './core.mjs';
import { ICONS } from './icons.mjs';
import { nextRunLabel, navModelFromLoops } from './ui_contract.mjs';
import { humanizeCron } from './app.js';
import { _bindSidebarNavHandlers, _bindTurnInteractions, _navStatusDot, _onFormPickerClick, _renderFormPicker, _workspaceTurnHtml, bindWorkspaceColHandlers, clearDraft, clearDetails } from './workspaces.mjs';

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

  // 裸 #tasks(没选具体 task):#view 渲 task 卡片列表(desktop + mobile 同款,
  // 2026-06-04 用户要求"切到 task 把现有 task 卡片式列到右侧")。点卡片或点左侧
  // sidebar 项都进 #tasks/<name> detail(detail 自带 ← 返回)。desktop 同时有
  // sidebar 列表 + 右侧卡片,两边都可点。dialog 由 _ensureTaskNewDialog 全局宿主。
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

export { renderTaskSidebarNav, _ensureTaskNewDialog, _openTaskNewDialog, renderTasksView, renderTaskDetailView };
