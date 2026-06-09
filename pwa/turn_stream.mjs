// Turn 渲染/流式模块(2026-06-09 从 workspaces.mjs 抽出)。
// 一个 run 的事件流渲染 + 增量轮询 + 折叠 + 工具事件(diff/下载)+ 审批块。
// 自带状态(_turnEventsTimers/_foldState)。被 workspace / task / roundtable 三处
// detail 复用 —— 抽出后它们直接 import 这里,不再借 workspaces 内部件。
// 依赖:core + ICONS + ui_contract + components + workspaces 的少量共享件
// (_scrollToBottom/cssQuoteEsc/eventFilterShowAll + const 对象 timelineScroll/
// workspaceStreamState,只读/属性改,ESM 共享引用安全)。
import { $, esc, api, showToast, showError, lastData, requestRender as render, requestRefresh as refreshAll } from './core.mjs';
import { ICONS } from './icons.mjs';
import { foldToolResult, formatToolUse, parseSessionTileId, parseStreamLinesToEvents } from './ui_contract.mjs';
import { _addTapFallback, _fileDownloadHref } from './components.mjs';
import { renderMarkdown, timeAgo } from './app.js';
import { _scrollToBottom, cssQuoteEsc, eventFilterShowAll, timelineScroll, workspaceStreamState } from './workspaces.mjs';

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

// Pending approvals for a single run — used to render [Approve][Deny]
// blocks alongside the timeline row.
function pendingApprovalsFor(runId) {
  if (!runId) return [];
  return (lastData.pendingApprovals || []).filter((a) => a.run_id === runId);
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
  // running turn 不再在用户气泡旁渲大"✕ Cancel" —— 底部 composer 的 ⏹ Stop
  // 已覆盖取消(activeRun 时显示,投同一个 run_id),turn 内再放一个是冗余 + 占地。
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
      <div class="turn-body">
        ${asstIndicatorHtml}
        ${eventsHtml}
        ${pendingHint}
        ${approvals}
      </div>
    </article>
  `;
}

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
    const html = newEvents.map((ev) => _renderTurnEvent(ev, elapsedS, _ws)).join('');

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

    // append 后立刻贴底(如果之前就在底)。读 stream.scrollHeight(_scrollToBottom
    // 里)已强制同步 layout,拿到的是插入后的新高,**无需 requestAnimationFrame**。
    // 原来用 rAF 等 layout,但 rAF 在后台 / 隐藏标签页被浏览器节流不触发 —— 正是它
    // 让"打开时补滚"漏掉(harness 实测:wasAtBottom=true 但 rAF 回调从不跑 → 永远
    // 停在顶,mobile 打开不滚到底的真根因)。
    if (wasAtBottom && stream) _scrollToBottom(stream);
  } else if (already === 0 && allLines.length === 0) {
    // tail 文件存在但还没行
    _setLoadingText('Waiting for first event…');
  }

  if (isRunning) {
    _turnEventsTimers[runId] = setTimeout(() => _loadTurnEvents(runId), 2500);
  }
  // 不 running 的 turn:渲染完一次性结束,不留 timer。
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

// Write/Edit/MultiEdit 工具事件 → ⬇ 下载链(file_path 是工具 input 里的精确路径)。
// ws 传进来可能是 colKey(desktop pane 的 .ws-timeline[data-ws] = tileId,含分隔符)
// 或纯 ws 名(mobile stream) —— 统一 parseSessionTileId 取纯 ws 名喂给下载 URL。
function _toolFileDownloadHtml(ws, name, input) {
  const filePath = (input && input.file_path) || '';
  if (!ws || !filePath) return '';
  if (name !== 'Write' && name !== 'Edit' && name !== 'MultiEdit') return '';
  const wsName = parseSessionTileId(ws).ws;
  return `<a class="event-tool-dl" href="${esc(_fileDownloadHref(wsName, filePath))}"`
    + ` download title="下载 ${esc(filePath)}">${ICONS.download}</a>`;
}

// elapsedS:turn 级用时(秒),由 _loadTurnEvents 从 .turn-events 容器的
//   data-elapsed 取出传入 —— result event 自己只带 tokens,没有 elapsed。
function _renderTurnEvent(ev, elapsedS, ws) {
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
    // Write/Edit/MultiEdit 写到了文件 → 旁边给个 ⬇ 下载链(file_path 就是工具
    // 调用里的精确路径,不猜)。href 指向后端 GET /workspaces/<ws>/file。
    const dlHtml = _toolFileDownloadHtml(ws, ev.name, ev.input || {});
    return `
      <div class="event-tool event-tool-${esc(verb)}">
        <div class="event-tool-call">
          <span class="tool-glyph">${esc(glyph)}</span>
          <span class="tool-verb">${esc(verb)}</span>
          <code class="tool-target">${esc(target)}</code>
          ${dlHtml}
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
    // 行末 mark 按 result subtype 显:成功(或老日志缺 subtype 向后兼容)→ ✓,
    // 明确 error_* → ✗ + 红 + 附 subtype。原来无条件 ✓,失败的 run 也显成功,
    // 跟侧栏红点打架(用户反馈"正常对话完了怎么红色")。注:红点本身来自后端
    // run.status(exit_code),这里只让 footer 诚实反映 claude 自己报的结果。
    const ok = !ev.subtype || ev.subtype === 'success';
    const errTag = ok ? '' : `<span class="turn-meta-err">${esc(ev.subtype || 'error')}</span>`;
    return `
      <div class="turn-meta-foot${ok ? '' : ' is-error'}">
        <span class="turn-meta-mark">${ok ? '✓' : '✗'}</span>
        ${elapsedHtml}<span class="turn-meta-tokens">${esc(ev.inTokens)}→${esc(ev.outTokens)} tok</span>
        ${errTag}
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

export { _bindTurnInteractions, _loadTurnEvents, _renderTurnEvent, _stopAllTurnEventsPolls, _syncWorkspaceNewEventsButton, _workspaceTurnHtml };
