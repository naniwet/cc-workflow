export const STATUS_ACCENTS = Object.freeze({
  running: 'var(--accent-cyan)',
  done: 'var(--accent-green)',
  failed: 'var(--accent-red)',
  queued: 'var(--accent-blue)',
  paused: 'var(--text-disabled)',
});

export const ROUNDTABLE_PERSONAS = Object.freeze([
  Object.freeze({ key: 'minimalist', label: '极简派', short: '极', color: 'green' }),
  Object.freeze({ key: 'scenario', label: '场景派', short: '场', color: 'cyan' }),
  Object.freeze({ key: 'precedent', label: '借鉴派', short: '借', color: 'amber' }),
  Object.freeze({ key: 'pessimist', label: '悲观派', short: '悲', color: 'red' }),
]);

export function roundtablePersonaAvatarsHtml(esc) {
  return `<div class="rt-avatars">${ROUNDTABLE_PERSONAS.map((p) =>
    `<span class="rt-avatar rt-avatar-${p.color}" title="${esc(p.label)}">${esc(p.short)}</span>`
  ).join('')}</div>`;
}

function _parts(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  return parts.length >= 5 ? parts.slice(0, 5) : null;
}

function _isNum(s) {
  return /^\d+$/.test(s);
}

function _nextDaily(hour, minute, now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function _nextEveryMinutes(interval, now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const current = d.getMinutes();
  const add = interval - (current % interval || interval);
  d.setMinutes(current + (add === 0 ? interval : add));
  if (d <= now) d.setMinutes(d.getMinutes() + interval);
  return d;
}

function _nextHourlyAt(minute, now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(minute, 0, 0);
  if (d <= now) d.setHours(d.getHours() + 1);
  return d;
}

function _nextEveryHours(interval, minute, now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const currentHour = d.getHours();
  const nextHour = Math.floor(currentHour / interval) * interval + interval;
  d.setHours(nextHour, minute, 0, 0);
  if (d <= now) d.setHours(d.getHours() + interval);
  return d;
}

function _fmtTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function _relative(d, now) {
  const mins = Math.max(1, Math.round((d.getTime() - now.getTime()) / 60000));
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h${m}m` : `in ${h}h`;
}

export function nextRunLabel(expr, now = new Date()) {
  const p = _parts(expr);
  if (!p) return '';
  const [m, h, dom, mon, dow] = p;
  if (dom !== '*' || mon !== '*' || dow !== '*') return '';

  let next = null;
  const everyM = m.match(/^\*\/(\d+)$/);
  if (everyM && h === '*') {
    next = _nextEveryMinutes(Number(everyM[1]), now);
  } else if (_isNum(m) && h.match(/^\*\/(\d+)$/)) {
    next = _nextEveryHours(Number(h.match(/^\*\/(\d+)$/)[1]), Number(m), now);
  } else if (_isNum(m) && h === '*') {
    next = _nextHourlyAt(Number(m), now);
  } else if (_isNum(m) && _isNum(h)) {
    next = _nextDaily(Number(h), Number(m), now);
  }
  if (!next) return '';
  return `下次 ${_fmtTime(next)} · ${_relative(next, now)}`;
}

function _isRunningTurn(turn) {
  return turn?.status === 'running' || turn?.status === 'queued';
}

// Turn 展开规则(4 档,优先级从高到低):
//   1. Manual override(用户手动 tap 过)→ 用用户选的(running 除外)
//   2. Running / queued turn → 永远展开(在等结果,不展开看不到 live output)
//   3. opts.expandAll(PC detail mode)→ 全展开
//   4. 数组最后一条 → 默认展开("最近一条"对应用户最关心的)
//   5. 其它 → 收起
//
// 历史:
// - 最早版本:有"latest completed 自动展开"规则。
// - 中间版本:用户反馈"第一次进入展开最后一个 turn 也没必要" → 砍掉,
//   全 collapsed(running 除外)。
// - 2026-05-21:用户改主意,加回"最后一条默认展开"(本版)— PC overview
//   / 手机进来都觉得"什么都不展开"反而要多点一下,展开最后一条对应
//   "默认看到最新一次的输出"更顺。
//
// 手动 collapse 仍然战胜默认 expand-last(用户明确点收起就尊重)。
export function workspaceTurnExpansion(turns, manual = {}, opts = {}) {
  const safeTurns = Array.isArray(turns) ? turns : [];
  const expandAll = !!opts.expandAll;
  const lastIdx = safeTurns.length - 1;
  return safeTurns.map((turn, idx) => {
    const id = String(turn?.id ?? idx);
    // Manual override beats default(running 除外 —— running 不让用户
    // 手动收起,防止"在跑都看不见结果"那种状态)
    if (!_isRunningTurn(turn) && Object.prototype.hasOwnProperty.call(manual, id)) {
      return { ...turn, id, expanded: !!manual[id] };
    }
    if (_isRunningTurn(turn)) return { ...turn, id, expanded: true };
    if (expandAll) return { ...turn, id, expanded: true };
    // 数组最后一条默认展开("最近一次"用户最关心的输出);其余收起。
    return { ...turn, id, expanded: idx === lastIdx };
  });
}

// 工具调用 → 紧凑报文三元组(coding 报文流 §14.2)。纯函数:0 IO,
// 给定 (name, input) 返回 {verb, target, glyph}。
//   - verb 是显示动词(Edit/MultiEdit 都归 'Edit',Grep/Glob 都归 'Search'),
//     着色靠 CSS class（由 verb 派生,如 .event-tool-Edit）—— 这里不塞颜色。
//   - target 缺字段一律退回空串,不崩。
//   - 未知工具:verb=原 name,target=input 里第一个 string 值,glyph='•'。
function _firstStringValue(input) {
  if (!input || typeof input !== 'object') return '';
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return v;
  }
  return '';
}

export function formatToolUse(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
      return { verb: 'Bash', target: String(inp.command || ''), glyph: '$' };
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Edit', target: String(inp.file_path || ''), glyph: '✎' };
    case 'Write':
      return { verb: 'Write', target: String(inp.file_path || ''), glyph: '✎' };
    case 'Read':
      return { verb: 'Read', target: String(inp.file_path || ''), glyph: '▢' };
    case 'Grep':
    case 'Glob':
      return { verb: 'Search', target: String(inp.pattern || inp.query || ''), glyph: '⌕' };
    default:
      return { verb: String(name || ''), target: _firstStringValue(inp), glyph: '•' };
  }
}

export function foldToolResult(text, maxLines = 5) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { preview: lines.join('\n'), hiddenLineCount: 0, truncated: false };
  }
  return {
    preview: lines.slice(0, maxLines).join('\n'),
    hiddenLineCount: lines.length - maxLines,
    truncated: true,
  };
}

export function workspaceAutoScrollState(previous = {}, next = {}) {
  const eventCount = Number(next.eventCount || 0);
  const previousCount = Number(previous.eventCount || 0);
  const incoming = Math.max(0, eventCount - previousCount);
  const atBottom = next.atBottom !== false;
  const newEvents = atBottom ? 0 : Number(previous.newEvents || 0) + incoming;
  return { eventCount, newEvents, atBottom };
}

// ─────────────────────────────────────────────────────────────────────────
// stream-jsonl → 结构化 event 解析
//
// `claude --stream-json` 每一行是一条 JSON 事件,顶层 `type` ∈
// {system, assistant, user, result}。一行能产出 0 个或多个面向 UI
// 的 event 卡片(因为 assistant.content 是个数组,可同时包含
// text / tool_use / thinking)。
//
// 输入:tail 接口返回的 lines 数组(每个是 JSON 文本字符串)
// 输出:扁平的 event 数组,kind ∈ {thinking, text, tool_use,
//       tool_result, result}。系统/init 行被丢弃,不可解析的行被
//       静默跳过(stream 偶发坏行不应该把整个 panel 搞挂)。
//
// 故意做成纯函数:0 副作用、0 IO,方便 node:test 单测。
// ─────────────────────────────────────────────────────────────────────────
export function parseStreamLinesToEvents(rawLines) {
  const out = [];
  for (const raw of rawLines || []) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'system') continue;        // init / preflight noise

    if (obj.type === 'assistant') {
      const content = obj.message?.content || [];
      for (const c of content) {
        if (c?.type === 'thinking' && c.thinking) {
          out.push({ kind: 'thinking', text: String(c.thinking) });
        } else if (c?.type === 'tool_use') {
          out.push({ kind: 'tool_use', name: String(c.name || ''), input: c.input ?? {} });
        } else if (c?.type === 'text' && c.text) {
          out.push({ kind: 'text', text: String(c.text) });
        }
      }
      continue;
    }

    if (obj.type === 'user') {
      const content = obj.message?.content || [];
      for (const c of content) {
        if (c?.type === 'tool_result') {
          let body = c.content;
          if (Array.isArray(body)) {
            body = body
              .map((x) => (typeof x === 'string' ? x : (x?.text || JSON.stringify(x))))
              .join('\n');
          } else if (typeof body !== 'string') {
            body = JSON.stringify(body);
          }
          out.push({ kind: 'tool_result', text: body || '', isError: !!c.is_error });
        }
      }
      continue;
    }

    if (obj.type === 'result') {
      out.push({
        kind: 'result',
        subtype: String(obj.subtype || ''),
        inTokens: Number(obj.usage?.input_tokens || 0),
        outTokens: Number(obj.usage?.output_tokens || 0),
        text: String(obj.result || ''),
      });
      continue;
    }
    // 未知 type:故意丢弃。原始 jsonl 仍在 ~/.cc-state/logs/ 留底。
  }
  return out;
}

// ---------------------------------------------------------------------------
// 多 session per workspace —— 纯函数(被 app.js import,被 contract test 覆盖)。
//
// 一个 workspace = 一个 repo,但可以并行跑多条独立工作线(session_key),
// 各自 worktree + 分支 + --resume 链。命名方案 α:默认 pwa-<ws>,用户建的
// 额外 session = <ws>--<name>。
// ---------------------------------------------------------------------------

// Run 投递目标:选了具体 session 投它,否则默认 pwa-<ws>(= 现状)。
export function resolveRunSessionKey(ws, activeKey) {
  return activeKey || `pwa-${ws}`;
}

// detail 页 timeline 过滤:activeKey 为空 = "全部"视图,原样返回(关键:
// 不过滤,避免把 cron / 飞书等其它 session_key 的 run 藏掉 —— review W1)。
// 选了具体 session 才过滤到它。无 session_key 的老 run 归到默认 pwa-<ws>。
export function filterTurnsBySession(ws, turns, activeKey) {
  if (!activeKey) return turns;
  return turns.filter((t) => (t.session_key || `pwa-${ws}`) === activeKey);
}

// 是不是用户建的并行工作线(<ws>-- 前缀)。默认 pwa-<ws> / cron(loop 名)/
// 飞书(feishu-*)都不算 —— 它们是"系统线",只在"全部"视图里看,不单独出 chip。
export function isUserSession(ws, sessionKey) {
  return typeof sessionKey === 'string' && sessionKey.startsWith(`${ws}--`);
}

// chip 显示名:去掉 <ws>-- 前缀。按 ws 名长度精确切(不靠 split),所以
// ws 名本身含 -- 也不误切。非用户 session 原样返回。
export function sessionChipLabel(ws, sessionKey) {
  const prefix = `${ws}--`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : sessionKey;
}

// session_key → 文件系统安全段。必须跟 agent-run.sh 的 SESSION_SAFE
// (tr -c 'A-Za-z0-9._-' '_')+ backend merge endpoint 的 re.sub 完全一致 ——
// 三处派生同一个事实(review W3:别让 worktree 路径多处真相源漂移)。
export function sessionSafe(sessionKey) {
  return String(sessionKey).replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// session tile 归桶 / id —— 桌面 overview 一格一个 session 的核心纯逻辑。
// 抽到这里被 pwa-ui-contract.test.mjs 覆盖(review W1:这是"归错 tile /
// 看不到对话"风险的真相源,五分支边界必须单测钉死)。
// ---------------------------------------------------------------------------

// session tile id:workspace + session_key 的稳定唯一键。用 unit-separator
// (\x1f)分隔 —— ws 名 / session_key 都是 [A-Za-z0-9._-],不含控制字符,不撞。
export const SESSION_ID_SEP = '';
export function sessionTileId(ws, sessionKey) {
  return `${ws}${SESSION_ID_SEP}${sessionKey}`;
}
export function parseSessionTileId(id) {
  const i = id.indexOf(SESSION_ID_SEP);
  return i < 0 ? { ws: id, sessionKey: `pwa-${id}` }
               : { ws: id.slice(0, i), sessionKey: id.slice(i + 1) };
}

// 把一条 run 的 session_key 映射成它该归的 tile key(= tile 的 sessionKey):
//   "default"(worktree_mode=off 时 runner.submit 压成)/ "pwa-<ws>"(auto 默认)
//     → 默认 tile(统一 pwa-<ws>)
//   "<ws>--<name>" → 用户建的并行工作线,各自 tile
//   其它(cron loop 名 / feishu-*)→ null,不出 tile(有 Tasks / 飞书 入口)
// 漏 "default" 会让 off 模式的 run 全被滤掉(2026-05-31 踩的坑)。
export function tileKeyFor(ws, sessionKey) {
  const key = sessionKey || `pwa-${ws}`;
  if (key === 'default' || key === `pwa-${ws}`) return `pwa-${ws}`;
  if (key.startsWith(`${ws}--`)) return key;
  return null;
}

// ---------------------------------------------------------------------------
// PC 侧边栏布局 —— 纯函数(spec: 2026-06-01-pc-sidebar-layout-design.md §5)。
// 被 app.js 的 renderDesktopSidebarLayout / dispatchPane 调,被 contract test
// 覆盖。两个都是 0 IO / 0 localStorage 的纯函数(localStorage 读写归 app.js)。
// ---------------------------------------------------------------------------

// 主区最多并排几个 pane。放开到 N 只改这一个常量 + 网格 CSS(spec §3.3,
// 轻易可逆)。2026-06-02 由 2 提到 4(2 不够用,4 封顶 — 再多每格 < ¼ 屏)。
export const MAX_PANES = 4;

// pane 状态 reducer(纯函数 state→state)。state = {panes:[tileId...],
// activePaneIdx}。泛化到任意 ≤MAX_PANES,不 hardcode 2/4 特例。
// 三条不变量(每个 action 后都成立):
//   ① panes 长度 ∈ [1, MAX_PANES]  ② 无重复 tileId
//   ③ activePaneIdx 永远指向存在的 pane
//
// action:
//   {type:'focus', tileId}      写进 active pane;tileId 已开则只切 activePaneIdx
//   {type:'openBeside', tileId} 未满(len<MAX)append 设 active;已满(len===MAX)
//                               替换"最大的非 active 下标"(从尾往前找第一个非
//                               active);已开则只 focus
//   {type:'close', idx}         len>=2 删该 idx 并按 idx 与 active 的相对位置归位;
//                               len===1 no-op(至少留 1)
export function paneStateReducer(state, action) {
  const panes = state.panes;
  const activeIdx = state.activePaneIdx;

  if (!action || typeof action !== 'object') return state;

  if (action.type === 'focus') {
    const existing = panes.indexOf(action.tileId);
    if (existing >= 0) {
      // 已开:只切 active,不 dup
      return { panes, activePaneIdx: existing };
    }
    // 写进当前 active pane(替换它)
    const nextPanes = panes.slice();
    nextPanes[activeIdx] = action.tileId;
    return { panes: nextPanes, activePaneIdx: activeIdx };
  }

  if (action.type === 'openBeside') {
    const existing = panes.indexOf(action.tileId);
    if (existing >= 0) {
      // 已开:只 focus,不 dup
      return { panes, activePaneIdx: existing };
    }
    if (panes.length < MAX_PANES) {
      // 未满:append 并设为 active
      const nextPanes = panes.concat(action.tileId);
      return { panes: nextPanes, activePaneIdx: nextPanes.length - 1 };
    }
    // 已满(len===MAX):替换最大的非 active 下标(从尾往前找第一个非 active),
    // 替进去的成 active。active 永远保留。
    let replaceIdx = -1;
    for (let i = panes.length - 1; i >= 0; i--) {
      if (i !== activeIdx) { replaceIdx = i; break; }
    }
    const nextPanes = panes.slice();
    nextPanes[replaceIdx] = action.tileId;
    return { panes: nextPanes, activePaneIdx: replaceIdx };
  }

  if (action.type === 'close') {
    if (panes.length <= 1) return state;   // 至少留 1 个 pane,no-op
    const idx = action.idx;
    const nextPanes = panes.slice();
    nextPanes.splice(idx, 1);
    const newLen = nextPanes.length;
    // 归位:
    //   删 idx < active → active 跟着前移(active-1)
    //   删 idx > active → active 不变
    //   删 === active   → clamp(min(idx, newLen-1), 0, newLen-1)
    let nextActive;
    if (idx < activeIdx) {
      nextActive = activeIdx - 1;
    } else if (idx > activeIdx) {
      nextActive = activeIdx;
    } else {
      nextActive = Math.min(idx, newLen - 1);
    }
    nextActive = Math.max(0, Math.min(nextActive, newLen - 1));
    return { panes: nextPanes, activePaneIdx: nextActive };
  }

  return state;   // 未知 action:原样返回
}

// 侧边栏两级树(纯函数,0 IO)。
//
// 契约:buildSidebarTree(groupBySession(workspaces, sessions))
//   —— 直接吃 groupBySession 的输出,只做一件事:把 tiles 按 workspace
//   组成两级树。分桶 / 排除(cron/飞书/orphan)+ 保底默认 session + 用户刚
//   "+ 新对话" 的空 session 注入(_declaredEmptySessions),全是 groupBySession
//   的职责。buildSidebarTree 信任 groups,不再自己分桶(否则两处分桶逻辑会漂)。
//
// 输入 groups:plain object,key = sessionTileId(ws, sessionKey),
//   value = {ws, sessionKey, ...}。迭代顺序 = 插入序(groupBySession 的
//   bucket 顺序:默认 tile → active 线 → recent 线 → declaredEmpty)。
//
// 输出数组(每 ws 一项,保 groups 里 ws 的首次出现顺序),每 entry:
//   {ws, tileId(默认 session 的 tile), sessionCount, expandable(>=2), sessions}
//   sessions 仅 expandable 时填,元素 {sessionKey, label, tileId},顺序严格保
//   groups 插入序(= 墙的顺序,天然一致)。顶层 tileId = 该 ws 默认 tile
//   (pwa-<ws>);groups 里没有默认 tile 时退到该 ws 第一个 tile。
export function buildSidebarTree(groups) {
  // ws → 该 ws 的 {sessionKey, tileId, running} 列表(按 groups 插入序累积)。
  // session child 的 running = 该 tile 有 active run(groups[tileId].active.length > 0)。
  const byWs = new Map();
  for (const tileId of Object.keys(groups || {})) {
    const { ws, sessionKey, active } = groups[tileId];
    const running = Array.isArray(active) && active.length > 0;
    if (!byWs.has(ws)) byWs.set(ws, []);
    byWs.get(ws).push({ sessionKey, tileId, running });
  }

  return Array.from(byWs.entries()).map(([ws, tiles]) => {
    const sessionCount = tiles.length;
    const expandable = sessionCount >= 2;
    const defaultTileId = sessionTileId(ws, `pwa-${ws}`);
    const hasDefault = tiles.some((t) => t.tileId === defaultTileId);
    // repo node 的 running = 该 ws 任一 session(含默认)有 active run。
    const running = tiles.some((t) => t.running);
    return {
      ws,
      tileId: hasDefault ? defaultTileId : tiles[0].tileId,
      sessionCount,
      expandable,
      running,
      sessions: expandable
        ? tiles.map(({ sessionKey, tileId, running: sessionRunning }) => ({
            sessionKey,
            label: sessionChipLabel(ws, sessionKey),
            tileId,
            running: sessionRunning,
          }))
        : [],
    };
  });
}

// 持久化 pane 清洗(纯函数,spec §3.5)。localStorage 里存的 panes 可能含
// 已删 repo / session 的 tileId(刷新时数据已经变了)→ 只保留仍在
// validTileIds 里的,保序;全失效返回 [](由调用方决定回落到默认聚焦)。
// validTileIds 可为 Set 或 array。
export function _prunePanes(panes, validTileIds) {
  const valid = validTileIds instanceof Set ? validTileIds : new Set(validTileIds || []);
  return (panes || []).filter((tileId) => valid.has(tileId));
}

// ---------------------------------------------------------------------------
// shell 状态校验 + NavModel 适配器(spec §4.2)—— 纯函数,0 IO。
// localStorage 的实际读写(key cc.shell.<tab>)归 app.js,不进这里
// (跟 cc.pcLayout 同纪律)。
// ---------------------------------------------------------------------------

// shell 收起态校验。raw = 从 localStorage 读出的字符串,或已 parse 的对象。
// 内部容错 parse;null / 坏 JSON / 非对象 → {collapsed:false};collapsed 非
// bool(如 "yes"/1)→ 归一成 false。不变量:返回永远 {collapsed:bool}。
export function loadShellState(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { collapsed: false }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { collapsed: false };
  return { collapsed: obj.collapsed === true };
}

// buildSidebarTree 输出(带 running)→ spec §4.2 NavModel。纯函数,形状由 tree
// 决定。NavItem.active 留 undefined(纯函数不知道谁 active,由调用方按
// paneState 填);icon 不填(nav 组件取 label 首字)。
//   repo node → NavItem{ id:tileId, label:ws, running, data:{tileId},
//                        badge:(sessionCount>1?sessionCount:undefined),
//                        children:(expandable?sessions.map(child):undefined) }
//   session child → NavItem{ id:tileId, label:(默认线?'默认':sessionChipLabel),
//                            running, data:{tileId} }
export function navModelFromTree(tree) {
  const items = (tree || []).map((node) => ({
    id: node.tileId,
    label: node.ws,
    running: node.running,
    data: { tileId: node.tileId },
    badge: node.sessionCount > 1 ? node.sessionCount : undefined,
    children: node.expandable
      ? node.sessions.map((s) => ({
          id: s.tileId,
          label: s.sessionKey === `pwa-${node.ws}` ? '默认' : s.label,
          running: s.running,
          data: { tileId: s.tileId },
        }))
      : undefined,
  }));
  return {
    newAction: { label: '+ 新建 workspace', data: {} },
    sections: [{ items }],
  };
}

// 评议列表(_roundtable_session_summary 的行形状)→ spec §4.2 NavModel。纯函数。
//   row → NavItem{ id:r.id, label:(question||'(无标题)' 截断 40),
//                  running:(status 不在终态集 {done,error}) }
// NavItem.active 留 undefined(调用方按 activeId 比对填,同 navModelFromTree)。
// **不带 data.tileId / 任何 tile 字段** —— 否则被 _bindSidebarNavHandlers 的
// `.shell-nav-item[data-tile-id]` 误绑(workspace 拖拽 / focus handler)。
// running 语义:done / error 是终态 → false;running / queued / 缺 status 都算
// 进行中 → true(后端 _roundtable_session_summary 的 status 取值集就这 4 个)。
//
// **刻意不带 navModelFromTree 的 newAction** —— 评议的新建动作由
// renderRoundtableSidebarNav 的 toolbar 直接渲(`+新建` 钮),不走
// NavModel.newAction(评议没有这个字段的消费者)。两函数形状的差异是有意的。
// label 只回落到 (无标题):后端 _roundtable_session_summary 只产 question,
// 从不产 title(main.py:_roundtable_session_summary),所以没有 `|| r.title`。
const _RT_LABEL_MAX = 40;
const _RT_TERMINAL = new Set(['done', 'error']);
export function navModelFromRoundtables(roundtables) {
  const items = (roundtables || []).map((r) => {
    const raw = r.question || '(无标题)';
    const label = raw.length > _RT_LABEL_MAX
      ? raw.slice(0, _RT_LABEL_MAX) + '…'
      : raw;
    return {
      id: r.id,
      label,
      running: !_RT_TERMINAL.has(r.status),
    };
  });
  return { sections: [{ items }] };
}

// cron loop 列表(lastData.loops 的行形状)→ spec §161 NavModel。纯函数。
//   loop → NavItem{ id:name, label:(name||'(未命名)' 截断 40), running }
// 严格对齐 navModelFromRoundtables 的输出形状(同 { id, label, running } 三字段 +
// 不带 data.tileId / 任何 tile 字段 —— 否则被 _bindSidebarNavHandlers 的
// `.shell-nav-item[data-tile-id]` 误绑)。NavItem.active 留调用方按 activeName 比对填。
// label 空名回落 (未命名),跟 rt 的 (无标题) 对称。
//
// running 判定:**loop enabled** 且最新 recent_run(recent_runs[0],后端最新在前)
// 的 status ∈ {queued, running} → true;否则(paused / 终态 / 缺 status / 空
// recent_runs / 无字段)→ false。
// 这与 app.js:_loopComputedStatus 返回 'running' **严格等价**:那段先 `if (!enabled)
// return 'paused'`、再 `if (latestRunning) return 'running'` —— 即 running ⟺
// enabled && latestRunning。**enabled 这一项不能漏**,否则一个被 pause 但恰有 in-flight
// run 的 loop,侧栏点会亮 running 而 detail badge 显 paused,口径打架(code-review 抓到)。
// _loopComputedStatus 读 DOM globals 不便在纯函数测试里 import,故此处内联同一判定,
// 两边语义必须一致 —— 改 running 定义时同步改 _loopComputedStatus。其余状态
// (paused/failed/done)侧栏 nav 都映射到 running=false,只关心"是否进行中"这一位。
const _LOOP_LABEL_MAX = 40;
const _LOOP_RUNNING = new Set(['queued', 'running']);
export function navModelFromLoops(loops) {
  const items = (loops || []).map((loop) => {
    const raw = loop.name || '(未命名)';
    const label = raw.length > _LOOP_LABEL_MAX
      ? raw.slice(0, _LOOP_LABEL_MAX) + '…'
      : raw;
    const recentRuns = Array.isArray(loop.recent_runs) ? loop.recent_runs : [];
    const latest = recentRuns[0] || null;
    return {
      id: loop.name,
      label,
      running: !!loop.enabled && !!latest && _LOOP_RUNNING.has(latest.status),
    };
  });
  return { sections: [{ items }] };
}

// ---------------------------------------------------------------------------
// Workspace Git 区段 —— 纯函数(spec: 2026-06-03-workspace-git-view.md)。
// 消费后端 GET /workspaces/{ws}/git[/diff] 的 schema(spec §3.2)。0 IO / 0 DOM,
// 被 pwa-ui-contract.test.mjs 覆盖;DOM 接线 / fetch 在 app.js。
// ---------------------------------------------------------------------------

// 展开态 header 的 ±N 角标文案。N = diff_stat 文件数;diff_truncated(后端
// 文件数 cap 200,spec §7)→ ±200+;空 / 无改动 → 空串(不显角标)。
// 折叠态不显精确 N(spec §4.3/Q1)—— 折叠时 app.js 不调本函数。
export function gitBadgeText(diffStat, diffTruncated) {
  const n = Array.isArray(diffStat) ? diffStat.length : 0;
  if (n === 0) return '';
  return diffTruncated ? '±200+' : `±${n}`;
}

// diff 行 kind → CSS class(spec §5.2 方案 A:复用 .diff-add/.diff-del 视觉层 +
// 新增 .diff-ctx 上下文行)。未知 kind → diff-ctx 中性兜底(不崩)。
// **不复用 _toolUseDiffHtml**:那个函数语义是"全删旧 + 全增新",不认 hunk /
// 上下文行(见 spec §5.1 核查结论)。
export function hunkLineClass(kind) {
  if (kind === 'add') return 'diff-add';
  if (kind === 'del') return 'diff-del';
  return 'diff-ctx';
}

// 后端结构化 hunks([{header, lines:[{kind, text}]}],parse_unified_diff 产出)
// → html。薄渲染器(spec §5.2 方案 A 核心):每个 hunk 渲一行 header(@@...)+
// 每行按 hunkLineClass(kind) 套 class 显 text。esc 由调用方注入(贴 app.js 的
// esc),**全程转义** header + 行文本,防注入。空 hunks → 空串。
export function hunksToHtml(hunks, esc) {
  if (!Array.isArray(hunks) || hunks.length === 0) return '';
  return hunks.map((hunk) => {
    const header = `<div class="diff-hunk-header">${esc(hunk.header)}</div>`;
    const lines = (hunk.lines || []).map((line) =>
      `<div class="${hunkLineClass(line.kind)}">${esc(line.text)}</div>`
    ).join('');
    return header + lines;
  }).join('');
}
