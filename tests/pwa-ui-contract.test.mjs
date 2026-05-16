import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STATUS_ACCENTS,
  ROUNDTABLE_PERSONAS,
  nextRunLabel,
  roundtablePersonaAvatarsHtml,
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
