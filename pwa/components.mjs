// 共享 UI 组件叶子模块(2026-06-09 从 workspaces.mjs 抽出)。
// form-picker(表单单选控件 + 全局点击委托)+ nav 状态点 —— 被 workspaces /
// tasks / roundtables 三个模块共用的纯 UI builder/handler。只 import core +
// ui_contract,是叶子(无 workspace 状态耦合),让那三个模块不必再从
// workspaces.mjs 借这些通用件。
import { esc } from './core.mjs';
import { STATUS_ACCENTS, isDoneStale, DONE_STALE_SEC } from './ui_contract.mjs';

// nav 行的状态点(spec §4.2 扩展:不止 running)。
//   - 'running' → 青色脉冲点(.shell-nav-dot,复用现有脉冲 CSS + aria-label)。
//   - 其它已知 status(done/failed/queued/paused)→ 静态小圆点,颜色内联
//     STATUS_ACCENTS[status](与 mobile overview 同一套色板,单一真相源)。
//   - null(没跑过)/ 未知 status → 不渲点(沉默是金,没活动不占视觉)。
// status 由 buildSidebarTree → navModelFromTree 派生(纯函数,有单测)。
function _navStatusDot(status, latestAt) {
  if (status === 'running') {
    return '<span class="shell-nav-dot" aria-label="运行中"></span>';
  }
  const color = STATUS_ACCENTS[status];
  if (!color) return '';   // null / 未知 → 不渲
  // done 且距上次活动超过 DONE_STALE_SEC → 空心圆(完成但久远,不再实心常亮抢眼)。
  // Date.now() 在这层(render)用没问题;判定逻辑 isDoneStale 是纯函数有单测。
  // latestAt 缺省(roundtable / tasks 不传)→ isDoneStale 直接 false(它们也不出 done)。
  if (isDoneStale(status, latestAt, Date.now() / 1000, DONE_STALE_SEC)) {
    return `<span class="shell-nav-status-dot is-hollow" style="border-color:${color}" aria-label="${esc(status)} (久远)"></span>`;
  }
  return `<span class="shell-nav-status-dot" style="background:${color}" aria-label="${esc(status)}"></span>`;
}

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

// 拼 workspace 文件下载 URL(后端 GET /workspaces/<ws>/file?path=)。缺 ws/path → ''。
// 对话 Write/Edit ⬇ + Git 区改动文件 ⬇ 共用。
function _fileDownloadHref(ws, path) {
  if (!ws || !path) return '';
  return `/workspaces/${encodeURIComponent(ws)}/file?path=${encodeURIComponent(path)}`;
}

export { _renderFormPicker, _onFormPickerClick, _navStatusDot, _addTapFallback, _fileDownloadHref };
