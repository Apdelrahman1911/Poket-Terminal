import test from 'node:test';
import assert from 'node:assert/strict';
import { botFixture } from './telegram-fixture.js';
import { until, delay } from './helpers.js';

type State = { activity: string; dead?: number; status?: number };
async function fixture(name: string) {
  let skew = 0, inventories = 0, captures = 0;
  const panes = new Map<string, State>();
  const f = await botFixture(name, { telegram: { endpoint: '', now: () => Date.now() + skew }, tmux: async args => {
    if (args[0] === 'list-panes') {
      inventories++;
      return [...panes].map(([id, p]) => `pt_${id}\t${p.dead || 0}\t/synthetic\t${p.activity}\t${p.dead ? p.status ?? 0 : ''}\t`).join('\n');
    }
    if (args[0] === 'kill-session') panes.delete(args.at(-1)!.replace('=pt_', ''));
    if (args[0] === 'capture-pane') { captures++; throw new Error('Automatic output forbidden'); }
    return '';
  } });
  const seed = (n: number, activity = 'unavailable') => {
    const id = n.toString(16).padStart(32, '0');
    f.h.service.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,NULL)').run(id, 'pt_' + id, 'Synthetic state ' + n, 'codex', f.h.config.defaultCwd, 'running', Date.now() + n, Date.now());
    panes.set(id, { activity }); return id;
  };
  const advance = async () => {
    const before = inventories; skew += 3100;
    await until(() => inventories > before, 6000); await delay(40);
  };
  return { ...f, panes, seed, advance, get captures() { return captures; }, now: () => Date.now() + skew };
}

test('Telegram observe→send: silent baseline, native ready/input and verified lifecycle delivery, dedupe, browser-open delivery and notification-off suppression', async () => {
  const f = await fixture('tg-notify-delivery');
  try {
    const id = f.seed(1, 'ready'), legacy = f.seed(2);
    await f.advance(); assert.equal(f.fake.sent.length, 0);
    await f.h.login(); assert.equal((await f.h.api('GET', '/api/sessions?limit=20')).statusCode, 200); // an open browser/catalog does not suppress alerts
    f.panes.set(id, { activity: 'working' }); await f.advance(); assert.equal(f.fake.sent.length, 0);
    let before = f.last(); f.panes.set(id, { activity: 'ready' }); await f.advance();
    const finished = await f.waitMessage(before); assert.match(finished.text, /Observed turn finished \/ ready/); assert.match(finished.text, /NOT a task-success claim/);
    assert.match(finished.text, /^🟢 READY \/ AWAITING PROMPT/);
    const count = f.fake.sent.length; await f.advance(); assert.equal(f.fake.sent.length, count);
    before = f.last(); f.panes.set(id, { activity: 'awaiting_input' }); await f.advance();
    const inputNotice = await f.waitMessage(before);
    assert.match(inputNotice.text, /Native Codex reports input\/action required/); assert.match(inputNotice.text, /^🟡 NEEDS YOUR INPUT/);
    await f.advance(); assert.equal(f.fake.sent.filter(m => /input\/action required/.test(m.text)).length, 1);
    f.panes.set(id, { activity: 'working' }); await f.advance(); f.panes.set(id, { activity: 'unknown' }); await f.advance();
    const afterUnknown = f.fake.sent.length; f.panes.set(id, { activity: 'ready' }); await f.advance(); assert.equal(f.fake.sent.length, afterUnknown);
    const menu = (await f.send('/notifications', { date: Math.floor(f.now() / 1000) })).message;
    await f.click(menu, 'Turn notifications off');
    f.panes.set(id, { activity: 'working' }); await f.advance(); before = f.last(); f.panes.set(id, { activity: 'ready' }); await f.advance(); assert.equal(f.last(), before);
    const off = (await f.send('/notifications', { date: Math.floor(f.now() / 1000) })).message; await f.click(off, 'Turn notifications on');
    await f.advance();
    before = f.last(); f.panes.set(legacy, { activity: 'unavailable', dead: 1, status: 0 }); await f.advance();
    const exited = await f.waitMessage(before); assert.match(exited.text, new RegExp(legacy)); assert.match(exited.text, /Session exited/);
    assert.match(exited.text, /^⚫ STOPPED \/ EXITED/);
    before = f.last(); f.panes.set(id, { activity: 'unavailable', dead: 1, status: 7 }); await f.advance();
    const errorNotice = await f.waitMessage(before);
    assert.match(errorNotice.text, /Verified start\/exit error/); assert.match(errorNotice.text, /^🔴 ERROR/);
    const delivered = f.fake.sent.length; await f.advance(); assert.equal(f.fake.sent.length, delivered);
    assert.equal(f.captures, 0); assert.equal(f.h.service.bridges.stats().created, 0);
    assert.equal(f.h.service.telegram.stats().pendingNotifications, 0);
  } finally { await f.close(); }
});

test('Telegram metadata churn >20: evicted stopped and deleted IDs release owners, bounded baselines/notices, no watchers/PTYS/captures', async () => {
  const f = await fixture('tg-notify-churn');
  try {
    let previous: string[] = [];
    for (let round = 0; round < 3; round++) {
      for (const id of previous) {
        f.panes.delete(id);
        f.h.service.store.db.prepare("UPDATE terminals SET state='stopped',stopped_reason='job_missing_or_reboot',updated_at=? WHERE id=?").run(Date.now(), id);
      }
      // Include missing metadata, not just stopped rows evicted from a catalog.
      if (previous[0]) f.h.service.store.db.prepare('DELETE FROM terminals WHERE id=?').run(previous[0]);
      const ids = Array.from({ length: 20 }, (_, i) => f.seed(round * 20 + i + 1));
      await f.advance();
      assert.equal(f.h.service.bridges.stats().telegramControllers, 0);
      for (const id of ids) await f.h.service.bridges.takeTelegram(id, '');
      assert.equal(f.h.service.bridges.stats().telegramControllers, 20);
      assert(f.h.service.telegram.stats().baseline <= 20); assert(f.h.service.telegram.stats().pendingNotifications <= 20);
      previous = ids;
    }
    f.panes.clear();
    await f.advance(); await until(() => f.h.service.bridges.stats().controllers === 0);
    assert.equal(f.h.service.bridges.stats().created, 0); assert.equal(f.h.service.bridges.stats().telegramControllers, 0); assert.equal(f.captures, 0);
    assert(f.h.service.telegram.stats().actions <= 64); assert(f.h.service.telegram.stats().baseline <= 20);
  } finally { await f.close(); }
});
