// 前端 core 叶子模块(2026-06-09 从 app.js 抽出)。
//
// 这里放"几乎到处都用、且不依赖任何 view 逻辑"的基础件:DOM 取值($)、HTML
// 转义(esc)、网络层(api)、toast(showToast/showError)、以及共享数据
// lastData。它是叶子:只 import ICONS(给 toast 用),不 import 任何 view /
// router,所以 app.js 和将来的各 view 模块都能安全 import 它,无循环。
//
// lastData 的写入约束(ESM 关键点):import 进来的绑定不能被别的模块重新赋值。
// 全仓只有 refreshAll(留在 app.js)整体重赋 lastData,所以这里导出一个
// setLastData() setter,refreshAll 调它;其余模块 `import { lastData }` 只读,
// 靠 ESM live binding 看到更新。

import { ICONS } from './icons.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// One-shot guard so 7 parallel refreshAll() fetches all hitting 401 don't
// each schedule a separate navigation (last-write-wins technically, but
// some mobile browsers debounce / coalesce rapid location changes in
// surprising ways). Single navigation, single history entry.
// core 写(api),app.js 读(refreshAll 用它压掉"跳转中"的红 toast)→ 导出绑定。
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

// ---------- shared state (refreshed every 3 s by refreshAll in app.js) ----------
// 只读导出 + setLastData setter(见文件头 ESM 约束说明)。
let lastData = {
  workspaces: [],
  sessions: { active: [], queued: [], recent: [] },
  loops: [],
  providers: [],                        // claude profiles (providers.json#profiles)
  wsSettings: {},                       // name → {provider?, engine?, trust?}
  globalProvider: '',                   // config.toml's provider field
  roundtables: [],                      // list summaries from GET /roundtables
};
function setLastData(v) { lastData = v; }

export {
  $, esc, api,
  showToast, dismissToast, showError, clearError,
  lastData, setLastData, _redirectingToLogin,
};
