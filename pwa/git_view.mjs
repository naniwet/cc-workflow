// Git/Diff 视图模块(2026-06-09 从 workspaces.mjs 抽出)。
// workspace 详情里的只读 Git 区段:状态/改动文件/diff/commits/worktrees 的拉取
// + 渲染 + 展开交互。自带状态(_gitExpanded/_gitData/_gitDiff*),不碰 W1 核心。
// 依赖:core + ui_contract(gitBadgeText/hunksToHtml)+ components(下载链/tap)
// + workspaces 的 workspaceActiveSession(只读 const 对象,解析当前 session)。
import { $, esc, api, showError, requestRefresh as refreshAll } from './core.mjs';
import { ICONS } from './icons.mjs';
import { gitBadgeText, hunksToHtml } from './ui_contract.mjs';
import { _fileDownloadHref, _addTapFallback } from './components.mjs';
import { workspaceActiveSession } from './workspaces.mjs';

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
        <div class="git-file-head">
          <button class="git-file" type="button"
                  data-ws="${esc(name)}" data-git-session="${esc(session)}" data-file="${esc(d.file)}">
            <span class="git-file-status git-status-${esc(status)}">${esc(status)}</span>
            <span class="git-file-name">${esc(d.file)}</span>
            <span class="git-file-stat"><span class="git-add">${esc(adds)}</span>${esc(dels)}</span>
          </button>
          ${d.status === 'D' ? '' : `<a class="git-file-dl" href="${esc(_fileDownloadHref(name, d.file))}"`
            + ` download title="下载 ${esc(d.file)}">${ICONS.download}</a>`}
        </div>
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

export { _gitSectionHtml, _bindGitSectionHandlers };
