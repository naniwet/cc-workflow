import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STATUS_ACCENTS,
  ROUNDTABLE_PERSONAS,
  foldToolResult,
  nextRunLabel,
  roundtablePersonaAvatarsHtml,
  workspaceAutoScrollState,
  workspaceTurnExpansion,
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

test('workspaceTurnExpansion keeps running and latest completed turns open', () => {
  const turns = [
    { id: 'r1', status: 'done' },
    { id: 'r2', status: 'failed' },
    { id: 'r3', status: 'done' },
  ];

  assert.deepEqual(workspaceTurnExpansion(turns).map((t) => [t.id, t.expanded]), [
    ['r1', false],
    ['r2', false],
    ['r3', true],
  ]);

  assert.deepEqual(
    workspaceTurnExpansion([...turns, { id: 'r4', status: 'running' }]).map((t) => [t.id, t.expanded]),
    [
      ['r1', false],
      ['r2', false],
      ['r3', true],
      ['r4', true],
    ],
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
