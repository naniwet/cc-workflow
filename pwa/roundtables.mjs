// Roundtable(评议)视图模块(2026-06-09 从 app.js 抽出第五块)。
// #roundtables(4 派评议 + 1v1 对抗列表)+ #roundtables/<id>(评议详情)。
// 依赖:core + ui_contract(roundtablePersonaAvatarsHtml/navModelFromRoundtables)
// + app.js 共享 helper(form-picker / nav / mobile 判定 / 状态 / parseRoute —— 都
// 只读或函数,app↔view 运行时循环,函数体内调用,ESM 安全)。
import { $, esc, api, showToast, showError, clearError, lastData, requestRender as render, requestRefresh as refreshAll } from './core.mjs';
import { roundtablePersonaAvatarsHtml, navModelFromRoundtables } from './ui_contract.mjs';
import { parseRoute, statusTag } from './app.js';
import { _bindSidebarNavHandlers, _isMobileViewport, _lastPaintedStatus, _mobileCardCache } from './workspaces.mjs';
import { _navStatusDot, _onFormPickerClick, _renderFormPicker } from './components.mjs';

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

// 角色头像:一个"小人"轮廓(头 + 肩),stroke:currentColor → 继承
// .rt-cell-<slug> h4 的角色配色(用户要求 2026-06-04:每个角色真的是一个小人)。
const _RT_PERSON_SVG =
  '<svg class="rt-cell-avatar" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>';

function _rtCell(role, content) {
  const head = `<h4>${_RT_PERSON_SVG}<span>${esc(role)}</span></h4>`;
  if (!content) {
    return `
      <div class="rt-cell rt-cell-${_roleSlug(role)} rt-cell-empty">
        ${head}
        <p class="muted">…等待中</p>
      </div>
    `;
  }
  return `
    <div class="rt-cell rt-cell-${_roleSlug(role)}">
      ${head}
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

export { renderRoundtableSidebarNav, renderRoundtablesView, renderRoundtableDetailView };
