import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TelegramState, TelegramLock } from '../src/server/telegram-state.js';
import { TelegramApi, verifyBot, updates } from '../src/server/telegram-api.js';
import { privateSetup } from '../src/server/telegram-pair.js';
import { testConfig, delay, until } from './helpers.js';
import { fakeTelegram, dummyState, message, OWNER, BOT_ID, BOT_USERNAME, DUMMY_TOKEN } from './telegram-fake.js';

test('Telegram setup: non-TTY cannot access credentials/network; missing state is disabled; kernel polling ownership is exclusive/reusable', async () => {
  const c = await testConfig('tg-setup-lock'), state = new TelegramState(c);
  assert.equal(state.control(), undefined);
  let factory = 0;
  await assert.rejects(privateSetup(state, 'pair', { interactive: false, showCode() { throw new Error('unexpected'); }, confirm: async () => true }, () => { factory++; throw new Error('unexpected'); }), /private interactive SSH/);
  assert.equal(factory, 0); assert.equal(fs.existsSync(state.dir), false);
  const a = new TelegramLock(state.dir), b = new TelegramLock(state.dir);
  assert.equal(await a.acquire(), true); assert.equal(await b.acquire(), false);
  await a.close(); assert.equal(await b.acquire(), true); await b.close();
});

test('Telegram setup: exact bot identity + absent webhook, private high-entropy code AND local numeric confirmation; backlog never acts', async () => {
  const config = await testConfig('tg-private-pair'), state = dummyState(config), fake = await fakeTelegram();
  const factory = (token: string) => new TelegramApi(token, { testMode: true, endpoint: fake.endpoint });
  try {
    for (const invalid of ['someone_else_bot', 'PocketTerminalFixtureBot_']) {
      fake.username = invalid; const api = factory(DUMMY_TOKEN);
      await assert.rejects(verifyBot(api, config.telegramBot!), /Unexpected Telegram/); api.close();
    }
    fake.username = BOT_USERNAME; fake.webhook = 'https://invalid.example/synthetic';
    const api = factory(DUMMY_TOKEN); await assert.rejects(verifyBot(api, config.telegramBot!), /webhook/); api.close(); fake.webhook = '';
    fake.enqueue(message(10, '/stop old-backlog'));
    let confirms = 0;
    const result = await privateSetup(state, 'pair', {
      interactive: true,
      showCode(code) {
        assert.match(code, /^[A-Za-z0-9_-]{43}$/); assert.equal(state.control()!.enabled, false);
        fake.enqueue(message(11, '/start'));
        fake.enqueue(message(12, '/pair ' + code, { chat: { id: -100, type: 'group' } }));
        fake.enqueue(message(13, '/pair ' + code, { forward_origin: { type: 'user' } }));
        fake.enqueue({ update_id: 14, edited_message: message(1, code).message });
        fake.enqueue(message(15, '/pair ' + code, { sender_chat: { id: OWNER } }));
        fake.enqueue(message(16, '/pair ' + code, { from: { id: OWNER, is_bot: false, username: 'SyntheticOwner' } }));
      },
      async confirm(prompt, expected) {
        confirms++;
        if (confirms === 1) assert.equal(expected, 'PAIR');
        else {
          assert.equal(expected, `BIND ${OWNER} ${OWNER}`); assert.match(prompt, /Username is not proof/); assert.match(prompt, /@SyntheticOwner \(UNVERIFIED; not authentication\)/);
          assert.equal(state.control()!.enabled, false);
          fake.enqueue(message(17, '/create queued-before-local-approval'));
        }
        return true;
      },
    }, factory);
    assert.deepEqual(result, { userId: OWNER, chatId: OWNER, botId: BOT_ID }); assert.equal(confirms, 2);
    const bound = state.control()!; assert.equal(bound.enabled, true); assert.deepEqual(bound.owner, { userId: OWNER, chatId: OWNER });
    assert.equal(state.cursor(bound.epoch), 18); assert.equal(fake.calls.filter(c => c.method === 'sendMessage').length, 0);
    const files = fs.readdirSync(state.dir);
    for (const name of files) assert.equal(fs.statSync(path.join(state.dir, name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(state.dir).mode & 0o777, 0o700);
    assert(!fs.readFileSync(path.join(state.dir, 'control.json'), 'utf8').includes(DUMMY_TOKEN));
  } finally { await fake.close(); }
});

test('Telegram setup: local rejection, disable during confirmation and revoke fail closed; cursor writes cannot resurrect enable', async () => {
  const state = dummyState(await testConfig('tg-pair-disable')), fake = await fakeTelegram();
  const factory = (token: string) => new TelegramApi(token, { testMode: true, endpoint: fake.endpoint });
  try {
    let count = 0;
    await assert.rejects(privateSetup(state, 'enable', { interactive: true, showCode() {}, confirm: async () => ++count === 1 }, factory), /declined/);
    assert.equal(state.control()!.enabled, false);
    count = 0;
    await assert.rejects(privateSetup(state, 'enable', {
      interactive: true, showCode() {}, async confirm() { if (++count === 2) state.disable(); return true; },
    }, factory), /cancelled/);
    const old = state.control()!; const disabled = state.disable();
    state.claim(old.epoch, 99); assert.equal(state.control()!.enabled, false); assert.equal(state.control()!.epoch, disabled.epoch);
    state.disable(true); assert.equal(state.control()!.owner, undefined);
    await assert.rejects(privateSetup(state, 'enable', { interactive: true, showCode() {}, confirm: async () => true }, factory), /No verified/);
  } finally { await fake.close(); }
});

test('Telegram private files: corruption, missing cursor/preferences, symlinks, oversized/insecure credentials and permissions are rejected', async () => {
  const state = dummyState(await testConfig('tg-files'), true), e = state.control()!.epoch;
  fs.writeFileSync(path.join(state.dir, 'cursor.json'), '{}'); assert.throws(() => state.cursor(e));
  fs.unlinkSync(path.join(state.dir, 'preferences.json')); assert.throws(() => state.notifications(e));
  fs.writeFileSync(path.join(state.dir, 'control.json'), '{broken'); assert.throws(() => state.control());
  state.disable(); assert.equal(state.control()!.enabled, false);
  const tokenFile = path.join(state.dir, 'token');
  fs.chmodSync(tokenFile, 0o644); assert.throws(() => state.token()); fs.chmodSync(tokenFile, 0o600);
  fs.writeFileSync(tokenFile, 'x'.repeat(257)); assert.throws(() => state.token());
  fs.unlinkSync(tokenFile); fs.symlinkSync('control.json', tokenFile); assert.throws(() => state.token()); fs.unlinkSync(tokenFile);
  fs.chmodSync(state.dir, 0o755); assert.throws(() => state.control()); fs.chmodSync(state.dir, 0o700);
});

test('Telegram HTTP: explicit loopback only in tests, one request, bounded bodies/timeouts/429 and sanitized errors, abort cleanup', async () => {
  assert.throws(() => new TelegramApi(DUMMY_TOKEN, { testMode: false, endpoint: 'http://127.0.0.1:1' }));
  assert.throws(() => new TelegramApi(DUMMY_TOKEN, { testMode: true, endpoint: 'https://api.telegram.org' }));
  const fake = await fakeTelegram(), api = new TelegramApi(DUMMY_TOKEN, { testMode: true, endpoint: fake.endpoint });
  try {
    fake.oversized = 'getMe'; await assert.rejects(api.call('getMe', {}), /invalid_response/); fake.oversized = '';
    fake.rateLimited = 'getMe'; await assert.rejects(api.call('getMe', {}), (e: any) => e.code === 'rate_limited' && e.retryMs === 60000 && !e.message.includes('secret')); fake.rateLimited = '';
    fake.fail = 'getMe'; await assert.rejects(api.call('getMe', {}), (e: Error) => !e.message.includes(DUMMY_TOKEN) && !e.message.includes('secret')); fake.fail = '';
    await assert.rejects(api.call('sendMessage', { text: 'x'.repeat(24577) }), /api_rejected/);
    fake.hang = 'getUpdates'; const abort = new AbortController();
    const pending = updates(api, 0, abort.signal);
    await until(() => fake.calls.some(c => c.method === 'getUpdates'));
    await assert.rejects(api.call('getMe', {}), /busy/); abort.abort(); await assert.rejects(pending, /aborted/);
    await until(() => fake.active === 0); assert(fake.maxActive <= 1);
    api.close(); await assert.rejects(api.call('getMe', {}), /aborted/);
  } finally { api.close(); await fake.close(); }
});
