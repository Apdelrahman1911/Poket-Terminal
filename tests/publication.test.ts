import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODEX_ARGS, ROOT, codexArgs, configFromEnv, sshHint, telegramBotFromEnv } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { Sessions } from '../src/server/sessions.js';
import { createApp } from '../src/server/app.js';
import { TelegramState } from '../src/server/telegram-state.js';
import { privateSetup } from '../src/server/telegram-pair.js';
import { TelegramApi, verifyBot } from '../src/server/telegram-api.js';
import { telegramCommand } from '../src/server/telegram-bot.js';
import { testConfig, cleanupTmux, until } from './helpers.js';
import { BOT_ID, BOT_USERNAME, DUMMY_TOKEN, dummyState, fakeTelegram, message } from './telegram-fake.js';

const env = { PT_ORIGIN: 'https://terminal.example.com', PT_DESKTOP_ENABLED: '0' };

test('Publication Telegram: command suffix accepts only the configured pinned username', () => {
  const id = 'a'.repeat(32);
  assert.deepEqual(telegramCommand('/sessions', BOT_USERNAME), { cmd: 'sessions', id: undefined });
  assert.deepEqual(telegramCommand('/sessions@' + BOT_USERNAME, BOT_USERNAME), { cmd: 'sessions', id: undefined });
  assert.deepEqual(telegramCommand('/stop@' + BOT_USERNAME + ' ' + id, BOT_USERNAME), { cmd: 'stop', id });
  assert.equal(telegramCommand('/stop@DifferentFixtureBot ' + id, BOT_USERNAME), undefined);
  assert.equal(telegramCommand('/stop@' + BOT_USERNAME + ' extra', BOT_USERNAME), undefined);
  assert.equal(telegramCommand('/' + 'x'.repeat(161), BOT_USERNAME), undefined);
});

test('Publication config: exact configured HTTPS origin, loopback by default, no forwarded/wildcard shortcut', () => {
  const c = configFromEnv(env);
  assert.equal(c.origin, env.PT_ORIGIN); assert.equal(c.host, '127.0.0.1');
  assert.equal(c.tmuxSocket, 'pocketterminal'); assert.equal(c.desktop, undefined);
  assert.equal(configFromEnv({ ...env, PT_ORIGIN: 'https://console.example.net:8443' }).origin, 'https://console.example.net:8443');
  for (const origin of ['', 'http://terminal.example.com', 'https://*.example.com', 'https://terminal.example.com/', 'https://terminal.example.com/path', 'https://terminal.example.com?q=x', 'https://terminal.example.com#x', 'https://user:pass@terminal.example.com', 'https://terminal.example.com:443']) {
    assert.throws(() => configFromEnv({ ...env, PT_ORIGIN: origin }));
  }
  assert.throws(() => configFromEnv({ ...env, PT_TMUX_SOCKET: 'unrelated-owner-server' }));
  assert.throws(() => configFromEnv({ ...env, PT_TEST_MODE: '1' }));
});

test('Publication config: configurable direct-child projects retain realpath confinement', async () => {
  const c = configFromEnv({ ...env, PT_PROJECT_ROOT: '/srv/projects', PT_DEFAULT_CWD: '/srv/projects/work' });
  assert.equal(c.projectRoot, '/srv/projects'); assert.equal(c.defaultCwd, '/srv/projects/work');
  assert.equal(configFromEnv({ ...env, PT_PROJECT_ROOT: '/srv/projects' }).defaultCwd, '/srv/projects/default');
  for (const cwd of ['/etc', '/srv/projects', '/srv/projects/work/nested', 'relative', '/srv/projects/bad\n']) {
    assert.throws(() => configFromEnv({ ...env, PT_PROJECT_ROOT: '/srv/projects', PT_DEFAULT_CWD: cwd }));
  }
  const fixture = await testConfig('publication-cwd'), store = new Store(fixture.dataDir);
  const sessions = new Sessions(store, fixture, async () => { throw new Error('No tmux invocation in cwd test'); });
  try {
    const outside = path.join(fixture.dataDir, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.projectRoot, 'escape'));
    fs.mkdirSync(path.join(fixture.defaultCwd, 'nested'));
    assert.equal(await sessions.validateCwd(fixture.defaultCwd), fs.realpathSync(fixture.defaultCwd));
    await assert.rejects(sessions.validateCwd(path.join(fixture.projectRoot, 'escape')));
    await assert.rejects(sessions.validateCwd(path.join(fixture.defaultCwd, 'nested')));
  } finally { store.close(); }
});

test('Publication config: SSH hints cannot inject shell/SSH options; local attach is the default', () => {
  const name = 'pt_' + 'a'.repeat(32);
  assert.equal(sshHint(configFromEnv(env), name), `tmux -L pocketterminal attach -t =${name}`);
  const c = configFromEnv({ ...env, PT_SSH_TARGET: 'root@vps.example.com', PT_SSH_JUMP: 'operator@bastion.example.com:2222' });
  assert.equal(sshHint(c, name), `ssh -t -J operator@bastion.example.com:2222 -- root@vps.example.com 'tmux -L pocketterminal attach -t =${name}'`);
  for (const target of ['-oProxyCommand=id', 'root@host;id', "root@host'", 'host\n', 'user@host other']) assert.throws(() => configFromEnv({ ...env, PT_SSH_TARGET: target }));
  for (const jump of ['host:0', 'host:65536', 'a,b', '$(id)']) assert.throws(() => configFromEnv({ ...env, PT_SSH_TARGET: 'host', PT_SSH_JUMP: jump }));
  assert.throws(() => configFromEnv({ ...env, PT_SSH_JUMP: 'host' }));
  assert.throws(() => sshHint(c, 'pt_bad;id'));
});

test('Publication config: full-access Codex uses owner defaults, only validated explicit overrides', () => {
  assert.deepEqual(codexArgs({}), CODEX_ARGS);
  assert.ok(CODEX_ARGS.includes('danger-full-access')); assert.ok(CODEX_ARGS.includes('never'));
  assert.ok(!CODEX_ARGS.includes('-m'));
  const args = codexArgs({ PT_CODEX_MODEL: 'owner-model', PT_CODEX_PROVIDER: 'owner_provider', PT_CODEX_REASONING_EFFORT: 'high' });
  assert.deepEqual(args.slice(0, 8), ['-m', 'owner-model', '-c', 'model_provider="owner_provider"', '-c', 'model_reasoning_effort="high"', '-c', 'plan_mode_reasoning_effort="high"']);
  for (const overrides of [{ PT_CODEX_MODEL: '-c malicious' }, { PT_CODEX_PROVIDER: 'bad"\nx=1' }, { PT_CODEX_REASONING_EFFORT: 'high"' }]) assert.throws(() => codexArgs(overrides));
});

test('Publication Telegram: configuration alone is unpaired; missing/nonnumeric pins fail before token/network', async () => {
  assert.equal(telegramBotFromEnv({}), undefined);
  assert.equal(configFromEnv(env).telegramBot, undefined);
  for (const pins of [{ PT_TELEGRAM_BOT_USERNAME: BOT_USERNAME }, { PT_TELEGRAM_BOT_ID: String(BOT_ID) }, { PT_TELEGRAM_BOT_ID: '0', PT_TELEGRAM_BOT_USERNAME: BOT_USERNAME }, { PT_TELEGRAM_BOT_ID: '9007199254740992', PT_TELEGRAM_BOT_USERNAME: BOT_USERNAME }, { PT_TELEGRAM_BOT_ID: String(BOT_ID), PT_TELEGRAM_BOT_USERNAME: '@' + BOT_USERNAME }]) assert.throws(() => telegramBotFromEnv(pins));
  const c = await testConfig('publication-unpaired');
  const state = new TelegramState(c); assert.equal(state.control(), undefined); assert.equal(fs.existsSync(state.dir), false);
  const unconfigured = new TelegramState({ ...c, telegramBot: undefined });
  let network = 0;
  await assert.rejects(privateSetup(unconfigured, 'pair', { interactive: true, showCode() {}, confirm: async () => true }, () => { network++; throw new Error('No network expected'); }));
  assert.equal(network, 0); assert.equal(fs.existsSync(state.dir), false);
});

test('Publication Telegram: env-only identity changes/legacy controls fail closed; revoke rotates stale generation', async () => {
  const c = await testConfig('publication-pins'), state = dummyState(c, true), old = state.control()!;
  const fake = await fakeTelegram();
  try {
    for (const telegramBot of [undefined, { id: BOT_ID + 1, username: BOT_USERNAME }, { id: BOT_ID, username: 'DifferentFixtureBot' }]) {
      const changed = { ...c, telegramBot };
      assert.throws(() => new TelegramState(changed).control());
      fake.enqueue(message(99, '/create'));
      const service = await createApp(changed, { telegram: { endpoint: fake.endpoint } });
      try {
        await until(() => service.telegram.stats().status === 'unsafe_state');
        assert.equal(service.telegram.stats().enabled, false); assert.equal(service.telegram.stats().poller, 0);
        assert.equal(service.telegram.stats().effectAttempts, 0); assert.equal(service.sessions.list().length, 0);
        assert.equal(fake.calls.length, 0);
      } finally { await service.close(); }
    }
    const legacy = { ...old }; delete legacy.botUsername; state.setControl(legacy);
    assert.throws(() => state.control());
    const revoked = state.disable(true);
    assert.notEqual(revoked.epoch, old.epoch); assert.equal(revoked.enabled, false); assert.equal(revoked.owner, undefined);
    assert.throws(() => state.cursor(revoked.epoch)); // old cursor/buttons cannot authorize work
    assert.equal(new TelegramState({ ...c, telegramBot: { id: BOT_ID + 1, username: 'DifferentFixtureBot' } }).control()!.enabled, false);
  } finally { await fake.close(); cleanupTmux(c); }
});

test('Publication Telegram: getMe must match both numeric ID and exact username (fake API only)', async () => {
  const fake = await fakeTelegram(), api = new TelegramApi(DUMMY_TOKEN, { testMode: true, endpoint: fake.endpoint });
  try {
    const pin = { id: BOT_ID, username: BOT_USERNAME };
    fake.botId = BOT_ID + 1; await assert.rejects(verifyBot(api, pin), /Unexpected Telegram/);
    fake.botId = BOT_ID; fake.username = 'DifferentFixtureBot'; await assert.rejects(verifyBot(api, pin), /Unexpected Telegram/);
    fake.username = BOT_USERNAME; assert.equal(await verifyBot(api, pin), BOT_ID);
  } finally { api.close(); await fake.close(); }
});

test('Publication deployment examples: foreground supervisor owns shutdown, independent tmux jobs not cgroup-killed', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'deploy/pocketterminal.service'), 'utf8');
  assert.match(unit, /^KillMode=process$/m); assert.match(unit, /^SendSIGKILL=no$/m);
  assert.match(unit, /^ExecStart=\/opt\/pocketterminal\/scripts\/service.sh$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/pocketterminal\/env$/m);
  assert.doesNotMatch(unit, /^KillMode=(?:mixed|control-group)|^PrivateTmp=yes|^User=pocketdesktop/m);
  const proxy = fs.readFileSync(path.join(ROOT, 'deploy/Caddyfile'), 'utf8');
  assert.match(proxy, /reverse_proxy 127\.0\.0\.1:3000/); assert.doesNotMatch(proxy, /header_up\s+(?:Host|Origin)/i);
});
