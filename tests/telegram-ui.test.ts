import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOT_COMMANDS, SESSION_COMMANDS, navigationData, parseNavigation } from '../src/server/telegram-ui.js';
import { TG_LIMITS } from '../src/server/telegram-api.js';
import { createApp } from '../src/server/app.js';
import { botFixture } from './telegram-fixture.js';
import { fakeTelegram, dummyState, message, OWNER } from './telegram-fake.js';
import { harness, until, delay } from './helpers.js';

test('Telegram UI routes: only stateless navigation/reading; no terminal authority or unbounded payloads', () => {
  const id = 'a'.repeat(32);
  const routes = [
    { action: 'sessions', offset: 0 }, { action: 'select', id }, { action: 'output', id },
    { action: 'help' }, { action: 'kinds' }, { action: 'notifications' }, { action: 'cancel' },
    { action: 'projects', kind: 'shell', offset: 5 }, { action: 'picker', command: 'prompt', offset: 0 },
  ];
  for (const route of routes) {
    const data = navigationData(route)!; assert(data); assert(Buffer.byteLength(data) <= 64);
    assert.deepEqual(parseNavigation(data), route);
  }
  for (const action of ['key', 'text', 'prompt', 'create', 'choose', 'rename', 'stop', 'delete', 'take', 'release', 'exit_history']) {
    assert.equal(navigationData({ action, id }), undefined);
    assert.equal(parseNavigation(`n:${action}:${id}`), undefined);
  }
  assert.equal(navigationData({ action: 'notifications', confirmed: true }), undefined);
  for (const data of ['n:__proto__', 'n:constructor', 'n:picker:__proto__:0', 'n:sessions:5:extra', 'n:sessions:-1', 'n:sessions:999', 'n:sessions:1', 'n:sessions:00', 'n:select:../root', 'n:' + 'x'.repeat(65)]) assert.equal(parseNavigation(data), undefined);
  assert(BOT_COMMANDS.length <= 100); assert.equal(new Set(BOT_COMMANDS.map(c => c.command)).size, BOT_COMMANDS.length);
  for (const entry of BOT_COMMANDS) { assert.match(entry.command, /^[a-z_]{1,32}$/); assert(entry.description.length > 0 && entry.description.length <= 256); }
  for (const command of Object.keys(SESSION_COMMANDS)) assert(BOT_COMMANDS.some(c => c.command === command));
});

test('Telegram command menu is private-chat scoped; no-ID prompt/stop choose explicit targets; fresh input controls', async () => {
  const f = await botFixture('tg-command-menu', { initialize: false });
  try {
    const commands = f.fake.calls.find(c => c.method === 'setMyCommands')!;
    assert.deepEqual(commands.body, { scope: { type: 'chat', chat_id: OWNER }, commands: BOT_COMMANDS });
    assert.deepEqual(f.fake.calls.find(c => c.method === 'setChatMenuButton')!.body, { chat_id: OWNER, menu_button: { type: 'commands' } });
    const a = await f.h.service.sessions.create({ kind: 'shell', label: 'Menu target A' });
    const b = await f.h.service.sessions.create({ kind: 'shell', label: 'Menu target B' });
    const choices = (await f.send('/prompt')).message;
    assert.match(choices.text, /Choose the exact session/); assert.equal(f.h.service.telegram.stats().effectAttempts, 0);
    const request = (await f.click(choices, 'Menu target A')).message;
    assert.match(request.text, /Reply to THIS exact message/); assert.match(request.text, new RegExp(a.id));
    await f.send('/select ' + b.id);
    const marker = path.join(f.h.config.defaultCwd, 'menu-prompt');
    const receipt = (await f.send(`printf 'once\\n' >> '${marker}'`, { reply_to_message: request })).message;
    await until(() => fs.existsSync(marker)); assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
    assert.match(receipt.text, /Input accepted by tmux/); assert(receipt.reply_markup.inline_keyboard.flat().some((x: any) => x.text === 'Enter'));
    await f.send(`printf 'once\\n' >> '${marker}'`, { reply_to_message: request }); assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
    const stopChoices = (await f.send('/stop')).message;
    const confirm = (await f.click(stopChoices, 'Menu target A')).message;
    assert.match(confirm.text, /STOP this job/); assert.equal(f.h.service.sessions.get(a.id).state, 'running');
    await f.click(confirm, 'Cancel / sessions');
    await f.click(confirm, 'Confirm stop'); assert.equal(f.h.service.sessions.get(a.id).state, 'running');
    assert.equal(f.h.service.sessions.get(b.id).state, 'running');
    assert.equal(f.fake.maxActive, 1); assert.equal(f.h.service.bridges.stats().created, 0);
  } finally { await f.close(); }
});

test('Telegram reusable navigation, output, expiry and cap recovery never replay keys; each key returns fresh controls', async () => {
  let skew = 0;
  const f = await botFixture('tg-reusable-controls', { initialize: false, telegram: { endpoint: '', now: () => Date.now() + skew } });
  try {
    const row = await f.h.service.sessions.create({ kind: 'shell', label: 'Reusable target' });
    const listing = (await f.send('/sessions')).message;
    const menu = (await f.click(listing, row.label)).message;
    const preview = (await f.click(menu, 'Recent output')).message;
    const first = (await f.click(menu, 'Down')).message; // read-only output did not consume siblings
    assert.match(first.text, /Key accepted by tmux/);
    const second = (await f.click(first, 'Down')).message;
    assert.match(second.text, /Key accepted by tmux/); assert.equal(f.h.service.telegram.stats().effectAttempts, 2);
    const stale = (await f.click(menu, 'Down')).message;
    assert.match(stale.text, new RegExp(row.id)); assert.equal(f.h.service.telegram.stats().effectAttempts, 2);
    assert(f.fake.calls.some(c => c.method === 'answerCallbackQuery' && /Nothing was sent/.test(c.body.text || '')));
    skew += TG_LIMITS.expiryMs + 20;
    await f.click(stale, 'Enter'); assert.equal(f.h.service.telegram.stats().effectAttempts, 2);
    const refreshed = (await f.click(listing, row.label)).message;
    assert.match(refreshed.text, new RegExp(row.id));
    assert.match((await f.click(preview, 'Refresh output')).message.text, /Recent output/);
    // Chooser churn keeps metadata bounded; old navigation is not in that map.
    for (let i = 0; i < 4; i++) await f.send('/rename', { date: Math.floor((Date.now() + skew) / 1000) });
    assert(f.h.service.telegram.stats().actions <= TG_LIMITS.actions);
    await f.click(listing, row.label); assert.equal(f.h.service.telegram.stats().effectAttempts, 2);
    assert.equal(f.fake.maxActive, 1); assert.equal(f.h.service.bridges.stats().created, 0);
    assert(f.h.service.telegram.stats().waitTimers <= 1);
  } finally { await f.close(); }
});

test('Telegram menu setup failure does not stop polling; setup retry is bounded and stateless navigation survives restart', async () => {
  const fake = await fakeTelegram(); fake.fail = 'setMyCommands';
  const h = await harness('tg-menu-failure', { initialize: false, telegram: { endpoint: fake.endpoint } });
  let next: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const state = dummyState(h.config, true);
    await until(() => h.service.telegram.stats().status === 'polling', 6000);
    const row = await h.service.sessions.create({ kind: 'shell', label: 'Restart target' });
    fake.enqueue(message(1, '/sessions'));
    await until(() => fake.sent.some(m => m.text.includes(row.id)));
    const listing = fake.sent.at(-1)!;
    await delay(400); assert.equal(fake.calls.filter(c => c.method === 'setMyCommands').length, 1);
    await h.service.close(); fake.fail = '';
    next = await createApp(h.config, { telegram: { endpoint: fake.endpoint } });
    await until(() => next!.telegram.stats().status === 'polling', 6000);
    const data = listing.reply_markup.inline_keyboard.flat().find((b: any) => b.text === row.label).callback_data;
    const before = fake.sent.length;
    fake.enqueue({ update_id: 2, callback_query: { id: 'old_navigation_after_restart', from: { id: OWNER, is_bot: false }, message: listing, data } });
    await until(() => fake.sent.length > before);
    assert.match(fake.sent.at(-1).text, /Input controller/); assert.match(fake.sent.at(-1).text, new RegExp(row.id));
    assert.equal(next.telegram.stats().effectAttempts, 0); assert.equal(fake.maxActive, 1);
    assert(state.cursor(state.control()!.epoch) >= 3);
  } finally { if (next) await next.close(); await h.close(); await fake.close(); }
});
