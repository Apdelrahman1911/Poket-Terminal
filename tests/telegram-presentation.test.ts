import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramSessionView, telegramLabel, telegramSessionButton, isSessionFilter } from '../src/server/telegram-presentation.js';
import { navigationData, parseNavigation } from '../src/server/telegram-ui.js';

test('Telegram state badges: activity is not lifecycle or success, with explicit input/working/ready/stopped/error separation', () => {
  for (const [lifecycle, activity, filter, prefix] of [
    ['running', 'working', 'working', '🔵'], ['running', 'awaiting_input', 'input', '🟡'],
    ['running', 'ready', 'ready', '🟢'], ['stopped', 'working', 'stopped', '⚫'],
    ['exited', 'awaiting_input', 'stopped', '⚫'], ['error', 'ready', 'error', '🔴'],
    ['starting', 'working', 'other', '⚪'], ['stopping', 'working', 'other', '🟠'],
    ['unknown', 'working', 'other', '❔'], ['running', 'unknown', 'other', '❔'],
    ['running', 'unavailable', 'other', '❔'], ['unrecognized', 'ready', 'other', '❔'],
    ['__proto__', 'working', 'other', '❔'],
  ]) {
    const view = telegramSessionView({ lifecycle: lifecycle!, activity: activity! });
    assert.equal(view.filter, filter); assert(view.heading.startsWith(prefix!));
    assert(!/successfully|task completed/i.test(view.label));
  }
  assert.match(telegramSessionView({ lifecycle: 'running', activity: 'ready' }).detail, /still running.*not a success claim/);
  assert.match(telegramSessionView({ lifecycle: 'exited', activity: 'ready' }).detail, /does not prove/);
  assert.match(telegramSessionView({ lifecycle: 'running', activity: 'unknown' }).detail, /Not a stopped or finished/);
  assert(isSessionFilter('input')); assert(!isSessionFilter('__proto__')); assert(!isSessionFilter('constructor'));
});

test('Telegram labels are single-line, bounded and surrogate-safe; filters remain readonly and fit fleet callbacks', () => {
  const label = 'اسم 🙂'.repeat(40) + '\n🔴 ERROR\u202e\t';
  assert(!/[\n\r\t\u202e]/.test(telegramLabel(label)));
  assert.equal(telegramLabel('\u0000\n\u202e'), '(unnamed)');
  for (const activity of ['working', 'awaiting_input', 'ready', 'unknown', 'unavailable']) {
    const button = telegramSessionButton(label, { lifecycle: 'running', activity });
    assert(button.length <= 60); assert(!/[\ud800-\udbff]$/.test(button));
  }
  assert.equal(telegramLabel('a'.repeat(79) + '🙂'), 'a'.repeat(79));
  for (const filter of ['all', 'input', 'working', 'ready', 'stopped', 'error', 'other']) {
    const data = navigationData({ action: 'sessions', filter, offset: 175 })!;
    assert(Buffer.byteLength('f:' + 'a'.repeat(16) + ':' + data) <= 64);
    assert.deepEqual(parseNavigation(data), { action: 'sessions', filter, offset: 175 });
  }
  assert.deepEqual(parseNavigation('n:sessions:0'), { action: 'sessions', offset: 0 });
});
