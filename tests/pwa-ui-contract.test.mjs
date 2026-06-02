import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STATUS_ACCENTS,
  ROUNDTABLE_PERSONAS,
  foldToolResult,
  nextRunLabel,
  parseStreamLinesToEvents,
  roundtablePersonaAvatarsHtml,
  workspaceAutoScrollState,
  workspaceTurnExpansion,
  resolveRunSessionKey,
  filterTurnsBySession,
  isUserSession,
  sessionChipLabel,
  sessionSafe,
  sessionTileId,
  parseSessionTileId,
  tileKeyFor,
  MAX_PANES,
  paneStateReducer,
  buildSidebarTree,
  _prunePanes,
  loadShellState,
  navModelFromTree,
} from '../pwa/ui_contract.mjs';

test('status accent mapping follows the mobile overview design', () => {
  assert.equal(STATUS_ACCENTS.running, 'var(--accent-cyan)');
  assert.equal(STATUS_ACCENTS.done, 'var(--accent-green)');
  assert.equal(STATUS_ACCENTS.failed, 'var(--accent-red)');
  assert.equal(STATUS_ACCENTS.queued, 'var(--accent-blue)');
  assert.equal(STATUS_ACCENTS.paused, 'var(--text-disabled)');
});

test('roundtable personas keep fixed glyphs and colors', () => {
  assert.deepEqual(
    ROUNDTABLE_PERSONAS.map((p) => [p.short, p.color]),
    [
      ['极', 'green'],
      ['场', 'cyan'],
      ['借', 'amber'],
      ['悲', 'red'],
    ],
  );
  const html = roundtablePersonaAvatarsHtml((s) => String(s));
  assert.match(html, /rt-avatar-green[^>]*>极</);
  assert.match(html, /rt-avatar-amber[^>]*>借</);
});

test('nextRunLabel gives next-fire text for common cron shapes', () => {
  const now = new Date('2026-05-16T10:20:00');

  assert.equal(nextRunLabel('0 11 * * *', now), '下次 11:00 · in 40m');
  assert.equal(nextRunLabel('30 * * * *', now), '下次 10:30 · in 10m');
  assert.equal(nextRunLabel('*/15 * * * *', now), '下次 10:30 · in 10m');
  assert.equal(nextRunLabel('0 */6 * * *', now), '下次 12:00 · in 1h40m');
});

test('workspaceTurnExpansion expands the last turn by default(其余全收起)', () => {
  const turns = [
    { id: 'r1', status: 'done' },
    { id: 'r2', status: 'failed' },
    { id: 'r3', status: 'done' },
  ];

  // 默认规则:数组最后一条展开(用户最关心的"最近一次"),其余收起。
  // 2026-05-21 重新引入 — 之前砍掉过一次,用户改主意了。
  assert.deepEqual(workspaceTurnExpansion(turns).map((t) => [t.id, t.expanded]), [
    ['r1', false],
    ['r2', false],
    ['r3', true],
  ]);

  // 加 running:running 是最后一条 → 只它展开,前面 done 全收
  assert.deepEqual(
    workspaceTurnExpansion([...turns, { id: 'r4', status: 'running' }]).map((t) => [t.id, t.expanded]),
    [
      ['r1', false],
      ['r2', false],
      ['r3', false],
      ['r4', true],
    ],
  );
});

test('workspaceTurnExpansion: 空数组无副作用', () => {
  assert.deepEqual(workspaceTurnExpansion([]), []);
});

test('workspaceTurnExpansion: 单个 done turn 默认展开(it is the last)', () => {
  assert.deepEqual(
    workspaceTurnExpansion([{ id: 'only', status: 'done' }]).map((t) => [t.id, t.expanded]),
    [['only', true]],
  );
});

test('workspaceTurnExpansion lets manual toggles override completed turns', () => {
  const turns = [
    { id: 'r1', status: 'done' },
    { id: 'r2', status: 'done' },
  ];

  assert.deepEqual(workspaceTurnExpansion(turns, { r1: true, r2: false }).map((t) => [t.id, t.expanded]), [
    ['r1', true],
    ['r2', false],
  ]);
});

test('workspaceTurnExpansion: manual override 战胜默认 collapsed', () => {
  // 全 done,r2 被用户手动展开 → r2 保持 expanded;
  // r3 是最后一条 → 默认展开;r1 收起。
  const turns = [
    { id: 'r1', status: 'done' },
    { id: 'r2', status: 'done' },
    { id: 'r3', status: 'done' },
  ];
  assert.deepEqual(
    workspaceTurnExpansion(turns, { r2: true }).map((t) => [t.id, t.expanded]),
    [['r1', false], ['r2', true], ['r3', true]],
  );
});

test('workspaceTurnExpansion: manual collapse 战胜默认 expand-last', () => {
  // r3 是最后一条 — 但用户手动收起过 → 尊重用户。
  const turns = [
    { id: 'r1', status: 'done' },
    { id: 'r2', status: 'done' },
    { id: 'r3', status: 'done' },
  ];
  assert.deepEqual(
    workspaceTurnExpansion(turns, { r3: false }).map((t) => [t.id, t.expanded]),
    [['r1', false], ['r2', false], ['r3', false]],
  );
});

test('workspaceTurnExpansion expandAll opens every turn(PC detail 模式)', () => {
  const turns = [
    { id: 'r1', status: 'done' },
    { id: 'r2', status: 'done' },
    { id: 'r3', status: 'done' },
  ];
  // expandAll:true → 三个都开
  assert.deepEqual(
    workspaceTurnExpansion(turns, {}, { expandAll: true }).map((t) => [t.id, t.expanded]),
    [['r1', true], ['r2', true], ['r3', true]],
  );
  // manual 反转仍然生效:r2 手动收起
  assert.deepEqual(
    workspaceTurnExpansion(turns, { r2: false }, { expandAll: true }).map((t) => [t.id, t.expanded]),
    [['r1', true], ['r2', false], ['r3', true]],
  );
});

test('foldToolResult keeps the first five lines and reports hidden lines', () => {
  const folded = foldToolResult(['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n'));

  assert.equal(folded.truncated, true);
  assert.equal(folded.preview, ['one', 'two', 'three', 'four', 'five'].join('\n'));
  assert.equal(folded.hiddenLineCount, 2);
});

test('workspaceAutoScrollState accumulates new events while user is away from bottom', () => {
  const state = workspaceAutoScrollState(
    { eventCount: 3, newEvents: 1 },
    { eventCount: 5, atBottom: false },
  );

  assert.deepEqual(state, { eventCount: 5, newEvents: 3, atBottom: false });
  assert.deepEqual(
    workspaceAutoScrollState(state, { eventCount: 6, atBottom: true }),
    { eventCount: 6, newEvents: 0, atBottom: true },
  );
});

// ─── parseStreamLinesToEvents ──────────────────────────────────────────
// 工厂用的 stream-jsonl 一行一条 JSON。下面 3 个测试覆盖 UI 实际依赖
// 的 3 种主流形状(assistant.text / assistant.tool_use / user.tool_result),
// 加 1 个混合行 + 1 个坏行容错 + 1 个 system 过滤。

test('parseStreamLinesToEvents: assistant.text emits a text event', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '你好' }] },
  })];
  assert.deepEqual(parseStreamLinesToEvents(lines), [
    { kind: 'text', text: '你好' },
  ]);
});

test('parseStreamLinesToEvents: assistant.tool_use carries name + input', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b' } }] },
  })];
  assert.deepEqual(parseStreamLinesToEvents(lines), [
    { kind: 'tool_use', name: 'Read', input: { file_path: '/a/b' } },
  ]);
});

test('parseStreamLinesToEvents: user.tool_result flattens content array + error flag', () => {
  const lines = [JSON.stringify({
    type: 'user',
    message: { content: [{
      type: 'tool_result',
      content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
      is_error: true,
    }] },
  })];
  assert.deepEqual(parseStreamLinesToEvents(lines), [
    { kind: 'tool_result', text: 'line1\nline2', isError: true },
  ]);
});

test('parseStreamLinesToEvents: assistant 行混合 thinking + text + tool_use → 3 个 event', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: '让我想想' },
      { type: 'text', text: '我先看看文件' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
    ] },
  })];
  const out = parseStreamLinesToEvents(lines);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'thinking');
  assert.equal(out[1].kind, 'text');
  assert.equal(out[2].kind, 'tool_use');
});

test('parseStreamLinesToEvents: 跳过 system 行 + 容忍坏 JSON', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    'not-json-at-all',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ];
  assert.deepEqual(parseStreamLinesToEvents(lines), [
    { kind: 'text', text: 'ok' },
  ]);
});

test('parseStreamLinesToEvents: result 行带 token 统计', () => {
  const lines = [JSON.stringify({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1234, output_tokens: 56 },
    result: '汇总文本',
  })];
  assert.deepEqual(parseStreamLinesToEvents(lines), [
    { kind: 'result', subtype: 'success', inTokens: 1234, outTokens: 56, text: '汇总文本' },
  ]);
});

// ---------- 多 session per workspace 纯函数(W2 review fix)----------

test('resolveRunSessionKey: 选了 session 投它,否则默认 pwa-<ws>', () => {
  assert.equal(resolveRunSessionKey('myrepo', undefined), 'pwa-myrepo');
  assert.equal(resolveRunSessionKey('myrepo', ''), 'pwa-myrepo');
  assert.equal(resolveRunSessionKey('myrepo', 'myrepo--fix-bug'), 'myrepo--fix-bug');
});

test('filterTurnsBySession: "全部"(无 active)不过滤,避免藏 cron/飞书 run', () => {
  const turns = [
    { id: 'a', session_key: 'pwa-myrepo' },
    { id: 'b', session_key: 'daily-report' },   // cron
    { id: 'c', session_key: 'myrepo--fix-bug' },
  ];
  // 全部视图:原样返回(W1 footgun 防护 — cron run 不被藏)
  assert.equal(filterTurnsBySession('myrepo', turns, undefined).length, 3);
  // 选具体 user session:只留它(cron/默认 都过滤掉,这是聚焦该工作线的预期)
  const fixOnly = filterTurnsBySession('myrepo', turns, 'myrepo--fix-bug');
  assert.deepEqual(fixOnly.map((t) => t.id), ['c']);
});

test('filterTurnsBySession: 无 session_key 的 turn 归到默认 pwa-<ws>', () => {
  const turns = [{ id: 'x' }];   // 老 run 没 session_key
  assert.equal(filterTurnsBySession('myrepo', turns, 'pwa-myrepo').length, 1);
});

test('isUserSession: 只有 <ws>-- 前缀的算用户建的并行工作线', () => {
  assert.equal(isUserSession('myrepo', 'myrepo--fix-bug'), true);
  assert.equal(isUserSession('myrepo', 'pwa-myrepo'), false);   // 默认
  assert.equal(isUserSession('myrepo', 'daily-report'), false); // cron
  assert.equal(isUserSession('myrepo', 'feishu-xxx'), false);   // 飞书
});

test('sessionChipLabel: 去掉 <ws>-- 前缀;ws 名本身含 -- 不误切', () => {
  assert.equal(sessionChipLabel('myrepo', 'myrepo--fix-bug'), 'fix-bug');
  // ws 名含 --:按 ws 长度精确切,不靠 split
  assert.equal(sessionChipLabel('a--b', 'a--b--feat'), 'feat');
  // 非用户 session:原样
  assert.equal(sessionChipLabel('myrepo', 'pwa-myrepo'), 'pwa-myrepo');
});

test('sessionSafe: 跟 agent-run.sh SESSION_SAFE + merge endpoint 一致(非法字符替 _)', () => {
  assert.equal(sessionSafe('myrepo--fix-bug'), 'myrepo--fix-bug');  // α 命名已干净
  assert.equal(sessionSafe('daily report'), 'daily_report');        // cron 名含空格
  assert.equal(sessionSafe('飞书/x'), '___x');                       // 飞书/ → ___,x 保留
});

// ---------- session tile 归桶 / id(review W1:风险最高逻辑必须钉死)----------

test('tileKeyFor: default / pwa-<ws> 都归默认 tile(off + auto 模式统一)', () => {
  // off 模式 runner.submit 压成 "default" → 默认 tile(之前漏这个,看不到对话)
  assert.equal(tileKeyFor('myrepo', 'default'), 'pwa-myrepo');
  // auto 模式 PWA 默认
  assert.equal(tileKeyFor('myrepo', 'pwa-myrepo'), 'pwa-myrepo');
  // 空 session_key 兜底成默认
  assert.equal(tileKeyFor('myrepo', ''), 'pwa-myrepo');
  assert.equal(tileKeyFor('myrepo', undefined), 'pwa-myrepo');
});

test('tileKeyFor: 用户建的 <ws>--<name> 各自一个 tile', () => {
  assert.equal(tileKeyFor('myrepo', 'myrepo--fix-bug'), 'myrepo--fix-bug');
  assert.equal(tileKeyFor('myrepo', 'myrepo--feat-x'), 'myrepo--feat-x');
});

test('tileKeyFor: cron / 飞书 的 session 不出 tile(返 null)', () => {
  assert.equal(tileKeyFor('myrepo', 'daily-report'), null);   // cron loop 名
  assert.equal(tileKeyFor('myrepo', 'feishu-oc_xxx'), null);  // 飞书
  // 别的 workspace 的 key 在本 ws 也不归(前缀不匹配)
  assert.equal(tileKeyFor('myrepo', 'pwa-other'), null);
  assert.equal(tileKeyFor('myrepo', 'other--x'), null);
});

test('tileKeyFor: ws 名本身含 -- 不误判', () => {
  // ws = "a--b":它的默认 / 用户 session
  assert.equal(tileKeyFor('a--b', 'pwa-a--b'), 'pwa-a--b');
  assert.equal(tileKeyFor('a--b', 'a--b--feat'), 'a--b--feat');
  assert.equal(tileKeyFor('a--b', 'default'), 'pwa-a--b');
});

test('sessionTileId / parseSessionTileId round-trip', () => {
  const id = sessionTileId('myrepo', 'myrepo--fix');
  const { ws, sessionKey } = parseSessionTileId(id);
  assert.equal(ws, 'myrepo');
  assert.equal(sessionKey, 'myrepo--fix');
  // 默认 session
  const id2 = sessionTileId('myrepo', 'pwa-myrepo');
  assert.deepEqual(parseSessionTileId(id2), { ws: 'myrepo', sessionKey: 'pwa-myrepo' });
});

// ---------- paneStateReducer(PC 侧边栏主区 1~4 pane,spec §5.2)----------
// 纯函数 state→state,无 IO / 无 localStorage。三条不变量(每个 case 后成立):
//   ① panes 长度 ∈ [1,MAX_PANES(=4)]  ② 无重复 tileId  ③ activePaneIdx 指向存在的 pane
// reducer 泛化到任意 ≤MAX_PANES,不 hardcode 2/4 特例。

// 不变量断言 helper:任何 reducer 输出都过这一关。
function assertPaneInvariants(state) {
  assert.ok(state.panes.length >= 1 && state.panes.length <= MAX_PANES,
    `panes 长度越界: ${state.panes.length}`);
  assert.equal(new Set(state.panes).size, state.panes.length, '出现重复 tileId');
  assert.ok(state.activePaneIdx >= 0 && state.activePaneIdx < state.panes.length,
    `activePaneIdx 指向不存在的 pane: ${state.activePaneIdx}`);
}

test('MAX_PANES = 4(放开 N 只改这个常量 + 网格 CSS)', () => {
  assert.equal(MAX_PANES, 4);
});

test('paneStateReducer focus: 写进 active pane(替换它)', () => {
  const state = { panes: ['a', 'b'], activePaneIdx: 1 };
  const next = paneStateReducer(state, { type: 'focus', tileId: 'c' });
  assert.deepEqual(next.panes, ['a', 'c']);   // 写进 idx=1(active)
  assert.equal(next.activePaneIdx, 1);
  assertPaneInvariants(next);
});

test('paneStateReducer focus: 已开项只切 activePaneIdx,不重复加', () => {
  const state = { panes: ['a', 'b'], activePaneIdx: 0 };
  const next = paneStateReducer(state, { type: 'focus', tileId: 'b' });
  assert.deepEqual(next.panes, ['a', 'b']);   // 不 dup
  assert.equal(next.activePaneIdx, 1);        // 切到 b 所在 pane
  assertPaneInvariants(next);
});

test('paneStateReducer focus: focus 当前 active 自身 = no-op', () => {
  const state = { panes: ['a'], activePaneIdx: 0 };
  const next = paneStateReducer(state, { type: 'focus', tileId: 'a' });
  assert.deepEqual(next.panes, ['a']);
  assert.equal(next.activePaneIdx, 0);
  assertPaneInvariants(next);
});

test('paneStateReducer openBeside: 未满 → append 并设为 active(逐个 1→2→3→4)', () => {
  // 1 → 2
  let s = paneStateReducer({ panes: ['a'], activePaneIdx: 0 }, { type: 'openBeside', tileId: 'b' });
  assert.deepEqual(s.panes, ['a', 'b']);
  assert.equal(s.activePaneIdx, 1);
  assertPaneInvariants(s);
  // 2 → 3
  s = paneStateReducer(s, { type: 'openBeside', tileId: 'c' });
  assert.deepEqual(s.panes, ['a', 'b', 'c']);
  assert.equal(s.activePaneIdx, 2);
  assertPaneInvariants(s);
  // 3 → 4
  s = paneStateReducer(s, { type: 'openBeside', tileId: 'd' });
  assert.deepEqual(s.panes, ['a', 'b', 'c', 'd']);
  assert.equal(s.activePaneIdx, 3);
  assertPaneInvariants(s);
});

test('paneStateReducer openBeside: 满(4)后 → 替换最大的非 active 下标(active 在末尾)', () => {
  // active = idx 3(末尾),从尾往前找第一个非 active → idx 2 被替
  const state = { panes: ['a', 'b', 'c', 'd'], activePaneIdx: 3 };
  const next = paneStateReducer(state, { type: 'openBeside', tileId: 'e' });
  assert.deepEqual(next.panes, ['a', 'b', 'e', 'd']);   // c 被替,d(active)保留
  assert.equal(next.activePaneIdx, 2);                  // 替进去的成 active
  assertPaneInvariants(next);
});

test('paneStateReducer openBeside: 满(4)后 → 替换最大的非 active 下标(active 在中间)', () => {
  // active = idx 1(中间),从尾往前找第一个非 active → idx 3 被替
  const state = { panes: ['a', 'b', 'c', 'd'], activePaneIdx: 1 };
  const next = paneStateReducer(state, { type: 'openBeside', tileId: 'e' });
  assert.deepEqual(next.panes, ['a', 'b', 'c', 'e']);   // d 被替,b(active)保留
  assert.equal(next.activePaneIdx, 3);                  // 替进去的成 active
  assertPaneInvariants(next);
});

test('paneStateReducer openBeside: 满(2)时也替换最大的非 active 下标(泛化,非 hardcode)', () => {
  // MAX 虽是 4,但若当前已 2 个又用 2 验泛化 —— 用 length===MAX 才替换,
  // 2 个时 length<MAX 仍 append,所以这里验"已满即 MAX=4"语义不被 2 特例污染:
  // 2 个 openBeside 必须 append(不替换)。
  const state = { panes: ['a', 'b'], activePaneIdx: 0 };
  const next = paneStateReducer(state, { type: 'openBeside', tileId: 'c' });
  assert.deepEqual(next.panes, ['a', 'b', 'c']);   // append,不替换(因 length<MAX)
  assert.equal(next.activePaneIdx, 2);
  assertPaneInvariants(next);
});

test('paneStateReducer openBeside: tileId 已存在 → 只 focus 不 dup', () => {
  const state = { panes: ['a', 'b'], activePaneIdx: 0 };
  const next = paneStateReducer(state, { type: 'openBeside', tileId: 'b' });
  assert.deepEqual(next.panes, ['a', 'b']);   // 不 dup
  assert.equal(next.activePaneIdx, 1);        // 切到 b
  assertPaneInvariants(next);
});

test('paneStateReducer close: 删 idx < active → active 跟着前移(active-1)', () => {
  // panes=[a,b,c,d] active=2(c);删 idx 0 → active 应指向仍是 c(现 idx 1)
  const state = { panes: ['a', 'b', 'c', 'd'], activePaneIdx: 2 };
  const next = paneStateReducer(state, { type: 'close', idx: 0 });
  assert.deepEqual(next.panes, ['b', 'c', 'd']);
  assert.equal(next.activePaneIdx, 1);     // 2 - 1,仍指向 c
  assertPaneInvariants(next);
});

test('paneStateReducer close: 删 idx > active → active 不变', () => {
  // panes=[a,b,c,d] active=1(b);删 idx 3 → active 仍指 b(idx 1)
  const state = { panes: ['a', 'b', 'c', 'd'], activePaneIdx: 1 };
  const next = paneStateReducer(state, { type: 'close', idx: 3 });
  assert.deepEqual(next.panes, ['a', 'b', 'c']);
  assert.equal(next.activePaneIdx, 1);     // 不变
  assertPaneInvariants(next);
});

test('paneStateReducer close: 删 === active → clamp(min(idx,newLen-1))', () => {
  // 删的就是 active 自身,新 active = clamp(min(idx, newLen-1), 0, newLen-1)。
  // panes=[a,b,c,d] active=2(c);删 idx 2 → newLen=3,min(2,2)=2,clamp=2 → 指向 d
  const a = paneStateReducer({ panes: ['a', 'b', 'c', 'd'], activePaneIdx: 2 }, { type: 'close', idx: 2 });
  assert.deepEqual(a.panes, ['a', 'b', 'd']);
  assert.equal(a.activePaneIdx, 2);        // min(2, 2)=2 → 现 idx 2 是 d
  assertPaneInvariants(a);

  // 删末尾 active:panes=[a,b,c] active=2;删 idx 2 → newLen=2,min(2,1)=1 → 指向 b
  const b = paneStateReducer({ panes: ['a', 'b', 'c'], activePaneIdx: 2 }, { type: 'close', idx: 2 });
  assert.deepEqual(b.panes, ['a', 'b']);
  assert.equal(b.activePaneIdx, 1);        // min(2, 1)=1
  assertPaneInvariants(b);
});

test('paneStateReducer close: 2 pane 时删 idx 归位', () => {
  // active=1,删 idx 0(idx<active)→ active-1=0
  const next = paneStateReducer({ panes: ['a', 'b'], activePaneIdx: 1 }, { type: 'close', idx: 0 });
  assert.deepEqual(next.panes, ['b']);
  assert.equal(next.activePaneIdx, 0);
  assertPaneInvariants(next);

  // active=0,删 idx 1(idx>active)→ active 不变=0
  const next2 = paneStateReducer({ panes: ['a', 'b'], activePaneIdx: 0 }, { type: 'close', idx: 1 });
  assert.deepEqual(next2.panes, ['a']);
  assert.equal(next2.activePaneIdx, 0);
  assertPaneInvariants(next2);
});

test('paneStateReducer close: 单 pane 时是 no-op(至少留 1 个)', () => {
  const state = { panes: ['a'], activePaneIdx: 0 };
  const next = paneStateReducer(state, { type: 'close', idx: 0 });
  assert.deepEqual(next.panes, ['a']);        // 不删,至少留 1
  assert.equal(next.activePaneIdx, 0);
  assertPaneInvariants(next);
});

test('paneStateReducer: 未知 action type 原样返回(不破坏不变量)', () => {
  const state = { panes: ['a', 'b'], activePaneIdx: 1 };
  const next = paneStateReducer(state, { type: 'bogus' });
  assert.deepEqual(next.panes, ['a', 'b']);
  assert.equal(next.activePaneIdx, 1);
  assertPaneInvariants(next);
});

// ---------- buildSidebarTree(PC 侧边栏两级树,spec §5.1)----------
// 纯函数,无 IO。新契约(code-review checkpoint A 修订):
//   buildSidebarTree(groupBySession(workspaces, sessions))
// 它不再自己分桶 —— 直接吃 groupBySession 的输出 groups,只把 tiles 按
// workspace 组成两级树。分桶 / 排除(cron/飞书/orphan/declaredEmpty 注入)
// 全是 groupBySession 的职责,buildSidebarTree 信任 groups。
//
// groups 形状(贴 app.js groupBySession 真实返回):plain object,
//   key = sessionTileId(ws, sessionKey),value = { ws, sessionKey, active, recent }。
// 迭代顺序 = 插入序(JS string key),侧边栏 children 顺序忠实反映它。

// fixture helper:按"插入序"组装 groups,跟 groupBySession 返回形状一致。
// 每个 entry 用 sessionTileId 当 key,value 至少含 {ws, sessionKey}。
function groups(...tiles) {
  const g = {};
  for (const { ws, sessionKey, active } of tiles) {
    g[sessionTileId(ws, sessionKey)] = { ws, sessionKey, active: active || [], recent: [] };
  }
  return g;
}

test('buildSidebarTree: 单 session repo → expandable:false, sessions:[]', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'notes', sessionKey: 'pwa-notes' },
  ));
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0], {
    ws: 'notes',
    tileId: sessionTileId('notes', 'pwa-notes'),
    sessionCount: 1,
    expandable: false,
    running: false,
    sessions: [],
  });
});

test('buildSidebarTree: 无 run 的新 repo(groupBySession 保底默认 tile)→ 默认 leaf', () => {
  // groupBySession 给每个 workspace 保底一个默认 tile,即使没 run。
  const tree = buildSidebarTree(groups(
    { ws: 'fresh', sessionKey: 'pwa-fresh' },
  ));
  assert.equal(tree.length, 1);
  assert.equal(tree[0].ws, 'fresh');
  assert.equal(tree[0].tileId, sessionTileId('fresh', 'pwa-fresh'));
  assert.equal(tree[0].sessionCount, 1);
  assert.equal(tree[0].expandable, false);
  assert.deepEqual(tree[0].sessions, []);
});

test('buildSidebarTree: 多 session(≥2)repo → expandable:true + 正确 children', () => {
  // groups 插入序 = 默认 → active 线 → recent 线(groupBySession bucket
  // 顺序),children 忠实保留这个顺序,不再自己排。
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--feat-x' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--fix-bug' },
  ));
  assert.equal(tree.length, 1);
  const entry = tree[0];
  assert.equal(entry.ws, 'cc-workflow');
  assert.equal(entry.tileId, sessionTileId('cc-workflow', 'pwa-cc-workflow'));
  assert.equal(entry.sessionCount, 3);        // 默认 + 2 个用户线
  assert.equal(entry.expandable, true);
  // children 顺序 = groups 插入序(信任 groups,不重排)
  assert.deepEqual(entry.sessions, [
    { sessionKey: 'pwa-cc-workflow', label: 'pwa-cc-workflow', tileId: sessionTileId('cc-workflow', 'pwa-cc-workflow'), running: false },
    { sessionKey: 'cc-workflow--feat-x', label: 'feat-x', tileId: sessionTileId('cc-workflow', 'cc-workflow--feat-x'), running: false },
    { sessionKey: 'cc-workflow--fix-bug', label: 'fix-bug', tileId: sessionTileId('cc-workflow', 'cc-workflow--fix-bug'), running: false },
  ]);
});

test('buildSidebarTree: children label 用 sessionChipLabel(去 <ws>-- 前缀)', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'myrepo', sessionKey: 'pwa-myrepo' },
    { ws: 'myrepo', sessionKey: 'myrepo--polish' },
  ));
  const labels = tree[0].sessions.map((s) => s.label);
  assert.deepEqual(labels, ['pwa-myrepo', 'polish']);   // 用户线去前缀
});

test('buildSidebarTree: 含 declaredEmpty 空 session 的 ws → 它出现在树里(Warn 2)', () => {
  // 用户刚点 "+ 新对话"、还没 run 的空 session:groupBySession 已把它注入
  // groups(_declaredEmptySessions)。buildSidebarTree 信任 groups,所以这条
  // 空 session 忠实出现在树里(spec §7-1:新建对话立刻可见)。
  const tree = buildSidebarTree(groups(
    { ws: 'myrepo', sessionKey: 'pwa-myrepo' },
    { ws: 'myrepo', sessionKey: 'myrepo--new-chat' },   // 还没 run 的空 session
  ));
  assert.equal(tree[0].sessionCount, 2);
  assert.equal(tree[0].expandable, true);
  assert.deepEqual(tree[0].sessions.map((s) => s.sessionKey), [
    'pwa-myrepo', 'myrepo--new-chat',
  ]);
});

test('buildSidebarTree: 树不无中生有 —— groups 里没 cron/飞书 tile,树里也没有', () => {
  // groupBySession 已用 tileKeyFor 排掉 cron/飞书,给的 groups 里本就只有
  // 默认 tile。buildSidebarTree 忠实反映 groups,不会凭空造出别的 tile。
  const tree = buildSidebarTree(groups(
    { ws: 'myrepo', sessionKey: 'pwa-myrepo' },
  ));
  assert.equal(tree[0].sessionCount, 1);
  assert.equal(tree[0].expandable, false);
  assert.deepEqual(tree[0].sessions, []);
});

test('buildSidebarTree: 多 repo → 每个 repo 一个 entry,保 groups 顺序', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--a' },
    { ws: 'notes', sessionKey: 'pwa-notes' },
  ));
  assert.deepEqual(tree.map((e) => e.ws), ['cc-workflow', 'notes']);
  assert.equal(tree[0].expandable, true);     // cc-workflow 有默认 + a = 2
  assert.equal(tree[1].expandable, false);    // notes 单 session
});

test('buildSidebarTree: 顶层 tileId 默认 tile 缺失时退到该 ws 第一个 tile', () => {
  // 理论上 groupBySession 总给默认 tile;但若没有(防御),顶层 tileId
  // 退到该 ws 出现的第一个 tile,而不是凭空造一个 pwa-<ws>。
  const tree = buildSidebarTree(groups(
    { ws: 'myrepo', sessionKey: 'myrepo--only-user-line' },
  ));
  assert.equal(tree.length, 1);
  assert.equal(tree[0].tileId, sessionTileId('myrepo', 'myrepo--only-user-line'));
  assert.equal(tree[0].sessionCount, 1);
  assert.equal(tree[0].expandable, false);
});

// ---------- buildSidebarTree.running 派生(spec §4.2:running 来自 active run)----------
// node 的 running = 该 ws 任一 session 有 active run;session child 的 running =
// 该 child 的 groups[tileId].active.length > 0。纯函数,只读传入 groups。

test('buildSidebarTree.running: 全无 active → repo node + 所有 child running:false', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--feat-x' },
  ));
  assert.equal(tree[0].running, false);
  assert.deepEqual(tree[0].sessions.map((s) => s.running), [false, false]);
});

test('buildSidebarTree.running: 某 session 有 active run → 该 child + 其 repo node running:true', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--feat-x', active: [{ run_id: 'r1' }] },
  ));
  // 用户线在跑 → 该 child running:true,默认线 running:false,repo node running:true
  assert.equal(tree[0].running, true);
  assert.deepEqual(tree[0].sessions.map((s) => s.running), [false, true]);
});

test('buildSidebarTree.running: 默认 tile 有 active、用户 session 无 → repo true、用户 child false', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow', active: [{ run_id: 'r0' }] },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--feat-x' },
  ));
  assert.equal(tree[0].running, true);
  assert.deepEqual(tree[0].sessions.map((s) => s.running), [true, false]);
});

test('buildSidebarTree.running: 单 session repo 有 active → repo node running:true', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'notes', sessionKey: 'pwa-notes', active: [{ run_id: 'r2' }] },
  ));
  assert.equal(tree[0].running, true);
});

// _prunePanes —— 持久化 pane 清洗(spec §3.5):repo / session 被删后,
// localStorage 里残留的 tileId 要丢掉。validTileIds 可为 Set 或 array。
test('_prunePanes: 丢掉已不存在的 tileId,保留存在的(保序)', () => {
  const valid = new Set(['a', 'b', 'c']);
  assert.deepEqual(_prunePanes(['a', 'gone', 'b'], valid), ['a', 'b']);
});

test('_prunePanes: 全部存在 → 原样保序返回', () => {
  assert.deepEqual(_prunePanes(['b', 'a'], new Set(['a', 'b'])), ['b', 'a']);
});

test('_prunePanes: 全部失效 → []', () => {
  assert.deepEqual(_prunePanes(['x', 'y'], new Set(['a', 'b'])), []);
});

test('_prunePanes: validTileIds 传 array 也行', () => {
  assert.deepEqual(_prunePanes(['a', 'gone'], ['a', 'b']), ['a']);
});

// ---------- loadShellState(shell 状态校验,spec §4.2)----------
// 纯函数,0 IO,不碰 localStorage 本身。吃 localStorage 已读出的字符串或对象,
// 内部容错 parse → 永远返回 {collapsed:bool}。坏数据回 {collapsed:false}。

test('loadShellState: null → {collapsed:false}', () => {
  assert.deepEqual(loadShellState(null), { collapsed: false });
});

test('loadShellState: undefined → {collapsed:false}', () => {
  assert.deepEqual(loadShellState(undefined), { collapsed: false });
});

test('loadShellState: 坏 JSON 字符串 → {collapsed:false}', () => {
  assert.deepEqual(loadShellState('{not json'), { collapsed: false });
});

test('loadShellState: 非对象(JSON 数字/数组/字符串)→ {collapsed:false}', () => {
  assert.deepEqual(loadShellState('42'), { collapsed: false });
  assert.deepEqual(loadShellState('[1,2]'), { collapsed: false });
  assert.deepEqual(loadShellState('"hi"'), { collapsed: false });
});

test('loadShellState: {collapsed:true} 字符串 → 原样 {collapsed:true}', () => {
  assert.deepEqual(loadShellState('{"collapsed":true}'), { collapsed: true });
});

test('loadShellState: 已 parse 的对象也接受', () => {
  assert.deepEqual(loadShellState({ collapsed: true }), { collapsed: true });
  assert.deepEqual(loadShellState({ collapsed: false }), { collapsed: false });
});

test('loadShellState: collapsed 非 bool(字符串/数字)→ 归一成 false', () => {
  assert.deepEqual(loadShellState({ collapsed: 'yes' }), { collapsed: false });
  assert.deepEqual(loadShellState({ collapsed: 1 }), { collapsed: false });
  assert.deepEqual(loadShellState('{"collapsed":"true"}'), { collapsed: false });
});

test('loadShellState: 不变量 —— collapsed 永远是布尔', () => {
  for (const raw of [null, '{}', '{"x":1}', { collapsed: 0 }, '{"collapsed":true}']) {
    const out = loadShellState(raw);
    assert.equal(typeof out.collapsed, 'boolean');
  }
});

// ---------- navModelFromTree(buildSidebarTree → NavModel 适配器,spec §4.2)----------
// 纯函数,形状由 tree 决定。NavItem.active 留 undefined(由调用方按 paneState 填)。

test('navModelFromTree: newAction 形状 + sections 单组', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'notes', sessionKey: 'pwa-notes' },
  ));
  const model = navModelFromTree(tree);
  assert.deepEqual(model.newAction, { label: '+ 新建 workspace', data: {} });
  assert.equal(model.sections.length, 1);
  assert.equal(model.sections[0].items.length, 1);
});

test('navModelFromTree: 单 session repo → 平铺 item 无 children 无 badge', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'notes', sessionKey: 'pwa-notes' },
  ));
  const item = navModelFromTree(tree).sections[0].items[0];
  assert.equal(item.id, sessionTileId('notes', 'pwa-notes'));
  assert.equal(item.label, 'notes');
  assert.equal(item.running, false);
  assert.equal(item.children, undefined);
  assert.equal(item.badge, undefined);
  assert.equal(item.active, undefined);   // 调用方填
  assert.deepEqual(item.data, { tileId: sessionTileId('notes', 'pwa-notes') });
});

test('navModelFromTree: 多 session repo → item 带 children + badge=sessionCount', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--feat-x' },
  ));
  const item = navModelFromTree(tree).sections[0].items[0];
  assert.equal(item.label, 'cc-workflow');
  assert.equal(item.badge, 2);            // sessionCount > 1
  assert.equal(item.children.length, 2);
  // 默认 session child label = '默认'(sessionKey === pwa-<ws>)
  assert.equal(item.children[0].label, '默认');
  assert.equal(item.children[0].id, sessionTileId('cc-workflow', 'pwa-cc-workflow'));
  assert.deepEqual(item.children[0].data, { tileId: sessionTileId('cc-workflow', 'pwa-cc-workflow') });
  // 用户线 child label = sessionChipLabel(去前缀)
  assert.equal(item.children[1].label, 'feat-x');
});

test('navModelFromTree: 单 session repo badge undefined(sessionCount=1 不出角标)', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'notes', sessionKey: 'pwa-notes' },
  ));
  assert.equal(navModelFromTree(tree).sections[0].items[0].badge, undefined);
});

test('navModelFromTree: running 透传 —— repo node + session child', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'cc-workflow', sessionKey: 'pwa-cc-workflow' },
    { ws: 'cc-workflow', sessionKey: 'cc-workflow--feat-x', active: [{ run_id: 'r1' }] },
  ));
  const item = navModelFromTree(tree).sections[0].items[0];
  assert.equal(item.running, true);                  // repo node 任一在跑
  assert.equal(item.children[0].running, false);     // 默认线没跑
  assert.equal(item.children[1].running, true);      // 用户线在跑
});

test('navModelFromTree: icon 不填(nav 组件取 label 首字)', () => {
  const tree = buildSidebarTree(groups(
    { ws: 'notes', sessionKey: 'pwa-notes' },
  ));
  assert.equal(navModelFromTree(tree).sections[0].items[0].icon, undefined);
});

test('navModelFromTree: 空 tree → newAction 仍在,items 空', () => {
  const model = navModelFromTree([]);
  assert.deepEqual(model.newAction, { label: '+ 新建 workspace', data: {} });
  assert.deepEqual(model.sections[0].items, []);
});
