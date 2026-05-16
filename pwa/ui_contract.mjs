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

// Turn 展开规则(简化版,3 档):
//   1. Manual override(用户手动 tap 过)→ 用用户选的
//   2. Running / queued turn → 永远展开(用户在等结果,不展开看不到)
//   3. opts.expandAll(PC detail mode)→ 全展开
//   4. 其它(包括"最近一次完成")→ 收起
//
// 历史:之前有"latest completed 自动展开"规则(设计图 §3.2 + 后续
// "newer running 来了才收"事件驱动版),用户反馈"第一次进入展开最后
// 一个 turn 也没必要,去掉这种逻辑吧"。砍掉。现在默认全 collapsed,
// 用户想看哪条点哪条 + 手动 override 持久;running 仍然自动展开因为
// "看不到 live output 体验比想点开还差"。
export function workspaceTurnExpansion(turns, manual = {}, opts = {}) {
  const safeTurns = Array.isArray(turns) ? turns : [];
  const expandAll = !!opts.expandAll;
  return safeTurns.map((turn, idx) => {
    const id = String(turn?.id ?? idx);
    // Manual override beats default(running 除外 —— running 不让用户
    // 手动收起,防止"在跑都看不见结果"那种状态)
    if (!_isRunningTurn(turn) && Object.prototype.hasOwnProperty.call(manual, id)) {
      return { ...turn, id, expanded: !!manual[id] };
    }
    if (_isRunningTurn(turn)) return { ...turn, id, expanded: true };
    if (expandAll) return { ...turn, id, expanded: true };
    return { ...turn, id, expanded: false };
  });
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
