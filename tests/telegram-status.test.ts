import test from 'node:test';
import assert from 'node:assert/strict';
import { botFixture } from './telegram-fixture.js';
import { TG_LIMITS } from '../src/server/telegram-api.js';

test('Telegram dashboard groups input first, filters/paginates stopped separately, refreshes stale snapshots and never sends terminal input', async () => {
  const panes = new Map<string, string>(); let captures = 0;
  const f = await botFixture('tg-status-dashboard', { initialize: false, tmux: async args => {
    if (args[0] === 'list-panes') return [...panes].map(([id, activity]) => `pt_${id}\t0\t/synthetic\t${activity}\t\t`).join('\n');
    if (args[0] === 'capture-pane') { captures++; throw new Error('No dashboard output capture'); }
    return '';
  } });
  try {
    const seed = (n: number, activity: string, reason: string | null = null) => {
      const id = n.toString(16).padStart(32, '0'), stopped = reason !== null;
      f.h.service.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,?)').run(id, 'pt_' + id, `Synthetic ${n}`, 'codex', f.h.config.defaultCwd, stopped ? 'stopped' : 'running', Date.now() + n, Date.now(), reason);
      if (!stopped) panes.set(id, activity);
      return id;
    };
    const input = seed(1, 'awaiting_input'), working = seed(2, 'working'), ready = seed(3, 'ready');
    const unknown = seed(4, 'unavailable'), error = seed(5, 'unavailable', 'start_failed');
    for (let n = 6; n <= 12; n++) seed(n, 'unavailable', n === 12 ? 'job_exited' : 'owner_stopped');
    const clickRoute = (message: any, route: string) => {
      const b = message.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data === route);
      assert(b, 'Expected read-only route ' + route); return f.click(message, b.text);
    };
    const list = (await f.send('/sessions')).message;
    assert.match(list.text, /SESSION DASHBOARD/); assert.match(list.text, /🟡 Input 1 · 🔵 Working 1 · 🟢 Ready 1/);
    assert.match(list.text, /⚫ Stopped 7 · 🔴 Errors 1 · ❔ Other 1/);
    assert(list.text.indexOf(input) < list.text.indexOf(working)); assert(list.text.indexOf(error) < list.text.indexOf(working));
    assert.match(list.text, /Snapshot, not live/);
    assert(list.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data === 'n:select:' + input).text.startsWith('🟡 Input needed'));
    assert(list.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data === 'n:select:' + ready).text.startsWith('🟢 Ready'));
    let stopped = (await clickRoute(list, 'n:sessions:0:stopped')).message;
    assert.match(stopped.text, /Sessions 1–5 of 7/); assert.match(stopped.text, /⚫ STOPPED \/ EXITED/);
    assert(!stopped.text.includes('Target: ' + input)); assert(!stopped.text.includes('Target: ' + ready));
    stopped = (await f.click(stopped, 'Next')).message;
    assert.match(stopped.text, /Sessions 6–7 of 7/);
    assert(!stopped.reply_markup.inline_keyboard.flat().some((b: any) => b.text === 'Next'));
    for (const [filter, id] of [['input', input], ['working', working], ['ready', ready], ['error', error], ['other', unknown]]) {
      const filtered = (await clickRoute(list, 'n:sessions:0:' + filter)).message;
      assert.match(filtered.text, /Sessions 1–1 of 1/); assert(filtered.text.includes('Target: ' + id));
      assert.equal((filtered.text.match(/Target:/g) || []).length, 1);
    }
    panes.set(input, 'working');
    const empty = (await clickRoute(list, 'n:sessions:0:input')).message;
    assert.match(empty.text, /Sessions 0 ·/); assert.match(empty.text, /No sessions in this category/);
    assert(!empty.text.includes('1–0'));
    assert.equal(f.h.service.telegram.stats().effectAttempts, 0); assert.equal(f.h.service.telegram.stats().actions, 0);
    assert.equal(f.h.service.bridges.stats().created, 0); assert.equal(captures, 0);
    for (const call of f.fake.calls.filter(c => c.method === 'sendMessage')) {
      assert(call.body.text.length <= TG_LIMITS.text); assert(!('parse_mode' in call.body));
      assert(call.body.reply_markup.inline_keyboard.length <= 16);
      for (const b of call.body.reply_markup.inline_keyboard.flat()) {
        assert(b.text.length <= 60);
        if (b.callback_data) assert(Buffer.byteLength('f:' + 'a'.repeat(16) + ':' + b.callback_data) <= 64);
      }
    }
  } finally { await f.close(); }
});

test('Telegram status dashboard uses capped metadata reads and only five entries even with a full archive', async () => {
  const f = await botFixture('tg-status-archive', { initialize: false, tmux: async () => '' });
  try {
    const insert = f.h.service.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,?)');
    for (let n = 1; n <= 180; n++) {
      const id = n.toString(16).padStart(32, '0');
      insert.run(id, 'pt_' + id, '🙂'.repeat(40), 'shell', f.h.config.defaultCwd, 'stopped', n, n, 'owner_stopped');
    }
    const limits: number[] = [], original = f.h.service.sessions.list.bind(f.h.service.sessions);
    f.h.service.sessions.list = (limit, offset) => { limits.push(limit ?? 100); return original(limit, offset); };
    const listing = (await f.send('/sessions')).message;
    assert.match(listing.text, /⚫ Stopped 180/); assert.equal((listing.text.match(/Target:/g) || []).length, 5);
    assert(listing.text.length < 3000); assert(limits.includes(100) && limits.includes(80)); assert(limits.every(n => n <= 100));
    assert.equal(f.h.service.telegram.stats().actions, 0); assert(f.h.service.telegram.stats().baseline <= 20);
    assert.equal(f.h.service.bridges.stats().created, 0);
  } finally { await f.close(); }
});
