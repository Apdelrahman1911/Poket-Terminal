import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { TelegramBot, notification, telegramStatus, telegramText } from '../src/server/telegram-bot.js';
import { TG_LIMITS } from '../src/server/telegram-api.js';
import { TelegramLock } from '../src/server/telegram-state.js';
import { CODEX_ARGS } from '../src/server/config.js';
import { harness, until, delay } from './helpers.js';
import { fakeTelegram, dummyState, message, OWNER, BOT_ID } from './telegram-fake.js';
import { botFixture } from './telegram-fixture.js';

test('Telegram authorization: exact private numeric user+chat; groups/forwards/edits/bots/anonymous/stale/unbound/tampered messages do nothing', async () => {
  const f = await botFixture('tg-auth', { initialize: false });
  try {
    const row = await f.h.service.sessions.create({ kind: 'shell' });
    const { message: menu } = await f.send('/select ' + row.id);
    const before = f.fake.sent.length, effects = f.h.service.telegram.stats().effectAttempts;
    const variants = [
      { from: { id: OWNER + 1, is_bot: false, username: 'SyntheticUser' } }, { chat: { id: OWNER + 1, type: 'private' } },
      { chat: { id: OWNER, type: 'group' } }, { forward_origin: { type: 'user' } }, { sender_chat: { id: OWNER } },
      { via_bot: { id: BOT_ID } }, { from: { id: OWNER, is_bot: true } }, { edit_date: Math.floor(Date.now() / 1000) },
      { date: Math.floor(Date.now() / 1000) - 61 }, { business_connection_id: 'synthetic' },
    ];
    let last = 0;
    for (const variant of variants) last = f.push(message(1, '/stop ' + row.id, variant));
    last = f.push({ edited_message: message(1, '/stop ' + row.id).message });
    last = f.push({ channel_post: message(1, '/stop ' + row.id).message });
    const data = menu.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Stop…').callback_data;
    for (const extra of [{ from: { id: OWNER + 1, is_bot: false } }, { message: { ...menu, chat: { id: OWNER + 1, type: 'private' } } }, { message: { ...menu, forward_origin: { type: 'user' } } }]) last = f.push({ callback_query: { id: 'untrusted_' + last, from: { id: OWNER, is_bot: false }, message: menu, data, ...extra } });
    await until(() => f.state.cursor(f.state.control()!.epoch) > last, 10000);
    assert.equal(f.fake.sent.length, before); assert.equal(f.h.service.telegram.stats().effectAttempts, effects);
    assert.equal(f.h.service.sessions.get(row.id).state, 'running'); assert.equal(f.h.service.bridges.stats().created, 0);
    const forged = f.push({ callback_query: { id: 'forged', from: { id: OWNER, is_bot: false }, message: menu, data: 'p:' + 'A'.repeat(22) } });
    await until(() => f.state.cursor(f.state.control()!.epoch) > forged);
    await until(() => f.fake.calls.some(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'forged'));
    assert.equal(f.h.service.telegram.stats().effectAttempts, effects);
    await f.send('unbound text must not execute');
    assert.equal(f.h.service.telegram.stats().effectAttempts, effects);
    assert(f.h.service.telegram.stats().actions <= TG_LIMITS.actions); assert.equal(f.fake.maxActive, 1);
  } finally { await f.close(); }
});

test('Telegram workflows: exact-target replies survive selection changes; slash prompts literal; stop/delete single-use cancel/confirm, files/jobs retained', async () => {
  const f = await botFixture('tg-workflows');
  try {
    const a = await f.h.service.sessions.create({ kind: 'shell', label: 'Target A' }), b = await f.h.service.sessions.create({ kind: 'shell', label: 'Target B' });
    const pid = (await f.h.service.sessions.tmux(['display-message', '-p', '-t', `=${b.tmux_name}:`, '#{pane_pid}'])).trim();
    const listing = (await f.send('/sessions')).message; assert.match(listing.text, /Running · activity not reported/);
    const rename = (await f.send('/rename ' + a.id)).message;
    await f.send('/select ' + b.id);
    await f.send('Renamed exact A', { reply_to_message: rename });
    assert.equal(f.h.service.sessions.get(a.id).label, 'Renamed exact A'); assert.equal(f.h.service.sessions.get(b.id).label, 'Target B');
    const input = (await f.send('/send ' + a.id)).message;
    await f.send('/select ' + b.id);
    const receipt = (await f.send('/new this is literal text', { reply_to_message: input })).message;
    assert.match(receipt.text, new RegExp(a.id)); assert.equal(f.h.service.sessions.stats().managedRunning, 2);
    assert.match(await f.h.service.sessions.tmux(['capture-pane', '-p', '-t', `=${a.tmux_name}:`]), /\/new this is literal text/);
    const count = f.h.service.telegram.stats().effectAttempts;
    await f.send('/new this is literal text', { reply_to_message: input }); assert.equal(f.h.service.telegram.stats().effectAttempts, count);
    // Clear only the synthetic shell's current line through a target-bound Ctrl+C button.
    const keys = (await f.send('/select ' + a.id)).message; await f.click(keys, 'Ctrl+C');
    const marker = path.join(f.h.config.defaultCwd, 'one-command');
    const prompt = (await f.send('/prompt ' + a.id)).message;
    await f.send(`printf 'once\\n' >> '${marker}'`, { reply_to_message: prompt });
    await until(() => fs.existsSync(marker)); assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
    await f.send(`printf 'once\\n' >> '${marker}'`, { reply_to_message: prompt }); assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
    const preview = (await f.send('/output ' + a.id)).message;
    assert(preview.text.length <= 3500); assert.match(preview.text, /Recent output · plain text/);
    assert(f.fake.calls.filter(c => c.method === 'sendMessage').every(c => !('parse_mode' in c.body) && c.body.protect_content === true && c.body.link_preview_options.is_disabled === true));
    const stop = (await f.send('/stop ' + a.id)).message;
    await f.click(stop, 'Cancel / sessions'); await f.click(stop, 'Confirm stop');
    assert.equal(f.h.service.sessions.get(a.id).state, 'running');
    const stop2 = (await f.send('/stop ' + a.id)).message; await f.click(stop2, 'Confirm stop');
    assert.equal(f.h.service.sessions.get(a.id).state, 'stopped');
    const remove = (await f.send('/delete ' + a.id)).message; assert.match(remove.text, /Project files\/Codex history are kept/);
    await f.click(remove, 'Confirm delete'); assert.throws(() => f.h.service.sessions.get(a.id));
    await f.h.service.sessions.reconcile(); assert.throws(() => f.h.service.sessions.get(a.id)); assert(fs.existsSync(marker)); assert(fs.existsSync(path.join(f.h.config.defaultCwd, 'README')));
    assert.equal((await f.h.service.sessions.tmux(['display-message', '-p', '-t', `=${b.tmux_name}:`, '#{pane_pid}'])).trim(), pid); process.kill(Number(pid), 0);
    assert.equal(f.h.service.bridges.stats().created, 0); assert.equal(f.h.service.bridges.stats().telegramInput.transientBuffers, 0);
  } finally { await f.close(); }
});

test('Telegram durable at-most-once: cursor fsynced before create; no effect retry after interrupted result, duplicate update, callback replay or restart/backlog', async () => {
  const f = await botFixture('tg-cursor', { initialize: false });
  let next: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const type = (await f.send('/new')).message, projects = (await f.click(type, 'Shell')).message;
    const confirm = (await f.click(projects, 'fixture')).message;
    let creates = 0, claimedBefore = 0;
    const original = f.h.service.sessions.create.bind(f.h.service.sessions);
    f.h.service.sessions.create = async (input, guard) => {
      creates++; claimedBefore = f.state.cursor(f.state.control()!.epoch);
      await original(input, guard); throw new Error('Synthetic reply lost AFTER committed create');
    };
    const created = await f.click(confirm, 'Confirm create shell'); assert.equal(creates, 1); assert.equal(claimedBefore, created.id + 1);
    assert.equal(f.h.service.sessions.stats().managedRunning, 1); assert.match(created.message.text, /NOT retried/);
    await f.click(confirm, 'Confirm create shell'); assert.equal(creates, 1);
    // Duplicate old update is confirmed/skipped by the persisted offset.
    f.fake.enqueue(message(created.id, '/new')); await delay(400); assert.equal(creates, 1);
    const rows = f.h.service.sessions.list(20), id = rows[0]!.id;
    const oldStop = (await f.send('/stop ' + id)).message;
    await f.h.service.close();
    const replay = oldStop.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Confirm stop').callback_data;
    f.push({ callback_query: { id: 'backlog', from: { id: OWNER, is_bot: false }, message: oldStop, data: replay } });
    next = await createApp(f.h.config, { telegram: { endpoint: f.fake.endpoint } });
    await until(() => next!.telegram.stats().status === 'polling', 6000);
    assert.equal(next.sessions.get(id).state, 'running');
    const postRestart = f.push({ callback_query: { id: 'old_after_restart', from: { id: OWNER, is_bot: false }, message: oldStop, data: replay } });
    await until(() => f.state.cursor(f.state.control()!.epoch) > postRestart); await delay(50);
    assert.equal(next.sessions.get(id).state, 'running'); assert.equal(next.telegram.stats().effectAttempts, 0);
    assert.equal(next.bridges.stats().created, 0);
  } finally { if (next) await next.close(); await f.close(); }
});

test('Telegram disable/state safety: paused polling aborted, ownership revoked without stopping job; insecure/missing enabled state fails closed; ordinary tests never load bot', async () => {
  const ordinary = await harness('tg-unconfigured-test', { initialize: false });
  try {
    dummyState(ordinary.config, true); await delay(50);
    assert.equal(ordinary.service.telegram.stats().poller, 0); assert.equal(ordinary.service.telegram.stats().monitorTimers, 0);
  } finally { await ordinary.close(); }
  const f = await botFixture('tg-emergency-disable', { initialize: false });
  try {
    const row = await f.h.service.sessions.create({ kind: 'shell' });
    const request = (await f.send('/send ' + row.id)).message;
    assert.equal(f.h.service.bridges.controller(row.id).kind, 'telegram');
    f.fake.hang = 'getUpdates'; await until(() => f.fake.active === 1);
    const start = Date.now(); f.state.disable();
    await until(() => f.h.service.telegram.stats().poller === 0 && f.h.service.bridges.stats().telegramControllers === 0, 2500);
    assert(Date.now() - start < 2200); assert.equal(f.fake.active, 0); assert.equal(f.h.service.sessions.get(row.id).state, 'running');
    assert.equal(f.h.service.telegram.stats().actions, 0); assert.equal(f.h.service.telegram.stats().replies, 0);
    const effects = f.h.service.telegram.stats().effectAttempts;
    f.push(message(1, 'disabled reply', { reply_to_message: request })); await delay(50); assert.equal(f.h.service.telegram.stats().effectAttempts, effects);
    const lock = new TelegramLock(f.state.dir + '/poller'); assert.equal(await lock.acquire(), true); await lock.close();
    const c = f.state.control()!; f.state.claim(c.epoch, 0); f.state.setNotifications(c.epoch, true); f.state.setControl({ ...c, enabled: true });
    fs.chmodSync(path.join(f.state.dir, 'cursor.json'), 0o644);
    await until(() => f.h.service.telegram.stats().status === 'unsafe_or_unavailable', 2500);
    assert.equal(f.h.service.telegram.stats().poller, 0); assert.equal(f.fake.active, 0); assert.equal(f.h.service.sessions.get(row.id).state, 'running');
    fs.chmodSync(path.join(f.state.dir, 'cursor.json'), 0o600);
  } finally { await f.close(); }
});

test('Telegram bounds/offline/expiry: no API/side-effect queues, cap callbacks/replies, bounded backoff, stale controls discarded', async () => {
  let skew = 0;
  const now = () => Date.now() + skew;
  const f = await botFixture('tg-bounds', { initialize: false, telegram: { endpoint: '', now } });
  try {
    const row = await f.h.service.sessions.create({ kind: 'shell' });
    for (let i = 0; i < 7; i++) await f.send('/select ' + row.id);
    assert(f.h.service.telegram.stats().actions <= 64);
    for (let i = 0; i < 9; i++) await f.send('/rename ' + row.id);
    assert.equal(f.h.service.telegram.stats().replies, 8);
    const old = f.fake.sent.at(-1), effectCount = f.h.service.telegram.stats().effectAttempts;
    skew += TG_LIMITS.expiryMs + 10;
    await f.send('stale label', { reply_to_message: old, date: Math.floor(now() / 1000) });
    assert.equal(f.h.service.telegram.stats().effectAttempts, effectCount); assert.equal(f.h.service.sessions.get(row.id).label, row.label);
    f.fake.rateLimited = 'getUpdates';
    await until(() => f.h.service.telegram.stats().status === 'offline_or_action_failed', 2000);
    const calls = f.fake.calls.length;
    await delay(700); assert.equal(f.fake.calls.length, calls); assert.equal(f.fake.active, 0);
    const stats = f.h.service.telegram.stats(); assert.equal(stats.pendingNotifications, 0); assert(stats.actions <= 64); assert(stats.replies <= 8); assert(stats.baseline <= 20); assert(stats.waitTimers <= 1);
    assert.equal(f.h.service.bridges.stats().created, 0); assert.equal(f.fake.maxActive, 1);
  } finally { await f.close(); }
});

test('Telegram notifications: silent baseline, lifecycle/native-only honest transitions, unknown breaks working chain; no fabricated success/error/input', () => {
  const observation = (lifecycle = 'running', activity = 'unavailable') => ({ lifecycle, activity, createdAt: 1 });
  assert.equal(notification(undefined, observation('running', 'ready')), undefined);
  assert.equal(notification(observation(), observation()), undefined);
  assert.equal(notification(observation(), observation('running', 'ready')), undefined);
  assert.equal(notification(observation('running', 'working'), observation('running', 'ready')), 'ready');
  for (const activity of ['unknown', 'unavailable']) assert.equal(notification(observation('running', activity), observation('running', 'ready')), undefined);
  assert.equal(notification(observation('running', 'ready'), observation('running', 'awaiting_input')), 'awaiting_input');
  assert.equal(notification(observation('running', 'awaiting_input'), observation('running', 'awaiting_input')), undefined);
  for (const state of ['stopped', 'exited', 'error']) assert.equal(notification(observation(), observation(state)), state);
  assert.match(telegramStatus(observation()), /Running · activity not reported/);
  assert.match(telegramStatus(observation('running', 'ready')), /not a success claim/);
  assert.match(telegramStatus(observation('error')), /verified start\/exit failure/);
  assert(telegramText('🙂'.repeat(4000)).length <= 3500); assert(!/[\ud800-\udbff]$/.test(telegramText('🙂'.repeat(4000), 3499)));
  assert.deepEqual(CODEX_ARGS.slice(-4), ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
});
