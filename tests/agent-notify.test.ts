import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENT_LIMITS, AgentNotices, agentRequest, type AgentKind } from '../src/server/agent-notices.js';
import { agentArguments, notifyLocal } from '../src/server/agent-notify-client.js';
import { AgentNotifyServer } from '../src/server/agent-notify-server.js';
import { botFixture } from './telegram-fixture.js';
import { until, delay } from './helpers.js';

function raw(socketPath: string, data: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath); let result = '';
    socket.once('connect', () => socket.write(data)); socket.on('data', chunk => { result += chunk; assert(result.length <= 1024); });
    socket.on('error', reject); socket.once('close', () => resolve(result));
  });
}
const note = { kind: 'progress' as const, text: 'Synthetic non-secret milestone' };

test('agent request/CLI validation: exact shape, byte/control bounds, no recipient/token, no guessed session or socket collision', () => {
  assert.deepEqual(agentRequest(note), note);
  for (const invalid of [null, { ...note, chat_id: 1 }, { ...note, token: 'synthetic' }, { ...note, text: '' }, { ...note, text: '🙂'.repeat(501) },
    { ...note, text: '\u202eforged' }, { ...note, text: '\u001b[31mANSI' }, { ...note, text: '\ud800' }, { ...note, session: 'other-host' },
    { ...note, tmux: { socket: '/tmp/tmux', pid: 1, pane: '%0', extra: 1 } }]) assert.throws(() => agentRequest(invalid));
  const request = agentArguments(['question', 'Need a decision'], { TMUX: '/tmp/tmux-0/pocketterminal,321,0', TMUX_PANE: '%7' }, '/root/projects/demo').request;
  assert.deepEqual(request.tmux, { socket: '/tmp/tmux-0/pocketterminal', pid: 321, pane: '%7' });
  assert.equal(agentArguments(['done', 'Verified', '--unlinked'], { TMUX: 'wrong', PT_SESSION_ID: 'a'.repeat(32) }, '/root/projects/demo').request.session, undefined);
  assert.equal(agentArguments(['done', 'Verified'], { PT_SESSION_ID: 'a'.repeat(32) }, '/root/projects/demo').request.session, 'a'.repeat(32));
  assert.equal(agentArguments(['done', 'Verified'], {}, '/root/projects/demo').request.project, 'demo');
  assert.throws(() => agentArguments(['progress', 'x', '--session', 'a'.repeat(32), '--unlinked'], {}, '/root'));
});

test('agent queue: four including in-flight, one sender, category cooldown, hashes only, cancellation, expiry, disabled cleanup and churn', async () => {
  let now = 1000;
  const q = new AgentNotices(() => now), kinds: AgentKind[] = ['progress', 'blocked', 'question', 'done'];
  const aborts = kinds.map(() => new AbortController());
  const promises = kinds.map((kind, i) => q.enqueue({ kind, text: 'x'.repeat(2000), session: 'a'.repeat(32) }, 'epoch', aborts[i]!.signal));
  assert.equal(q.stats().pending, 4); assert.equal(q.stats().textBytes, 8000);
  assert.equal((await q.enqueue(note, 'epoch', new AbortController().signal)).code, 'queue_full');
  const first = q.take('epoch')!; assert(first); assert.equal(q.take('epoch'), undefined);
  aborts[0]!.abort(); assert.equal((await promises[0]!).status, 'uncertain');
  assert.equal(q.stats().pending, 4, 'Keep the sending reservation until the transport finishes');
  q.finish(first, { status: 'uncertain', code: 'delivery_unknown' }, true);
  aborts[1]!.abort(); assert.equal((await promises[1]!).code, 'cancelled');
  now += AGENT_LIMITS.expiryMs + 1; q.prune();
  assert.equal((await promises[2]!).code, 'expired'); assert.equal((await promises[3]!).code, 'expired');
  assert.equal(q.stats().textBytes, 0);
  assert.equal((await q.enqueue({ kind: 'progress', text: 'x'.repeat(2000), session: 'a'.repeat(32) }, 'epoch', new AbortController().signal)).code, 'duplicate_suppressed');
  assert.equal((await q.enqueue({ kind: 'progress', text: 'different', session: 'a'.repeat(32) }, 'epoch', new AbortController().signal)).code, 'rate_limited');
  for (let i = 0; i < 500; i++) {
    now += 31000;
    const p = q.enqueue({ ...note, text: 'Synthetic ' + i }, 'epoch', new AbortController().signal);
    q.clear('disabled'); assert.equal((await p).code, 'disabled');
    assert(q.stats().dedupeHashes <= 64); assert(q.stats().cooldowns <= 64); assert.equal(q.stats().textBytes, 0);
  }
  q.close(); assert.deepEqual(q.stats(), { pending: 0, sending: 0, textBytes: 0, dedupeHashes: 0, cooldowns: 0 });
});

test('private socket: 0600 owner authorization, no public bypass, bounded malformed input, collision and safe disposal', async () => {
  const f = await botFixture('an-auth', { initialize: false });
  const server = f.h.service.agentNotify!, socket = server.path;
  try {
    assert.equal(server.stats().status, 'listening'); assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    if (process.getuid?.() === 0) {
      const result = execFileSync('python3', ['-c', 'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ntry: s.connect(sys.argv[1]); print("UNSAFE")\nexcept OSError as e: print(e.errno)', socket], { uid: 65534, gid: 65534 }).toString().trim();
      assert.equal(result, '13');
    } else assert.fail('Linux root fixture required for the non-owner authorization gate');
    assert.equal(JSON.parse(await raw(socket, 'bad-json\n')).code, 'invalid_notification');
    assert.equal(JSON.parse(await raw(socket, 'x'.repeat(AGENT_LIMITS.requestBytes + 1))).code, 'request_too_large');
    assert.equal(JSON.parse(await raw(socket, JSON.stringify({ ...note, chat_id: 123 }) + '\n')).code, 'invalid_notification');
    const response = await f.h.api('POST', '/api/agent-notify', note); assert.equal(response.statusCode, 401);
    const inode = fs.statSync(socket).ino, collision = new AgentNotifyServer(f.h.config, f.h.service.telegram);
    await collision.start(); assert.equal(collision.stats().status, 'unavailable'); assert.equal(fs.statSync(socket).ino, inode); await collision.close();
    await until(() => server.stats().sockets === 0); assert.equal(f.fake.sent.length, 0);
    await server.close(); assert.equal(fs.existsSync(socket), false);
    fs.writeFileSync(socket, 'synthetic sentinel', { mode: 0o600 });
    const unsafe = new AgentNotifyServer(f.h.config, f.h.service.telegram); await unsafe.start();
    assert.equal(unsafe.stats().status, 'unavailable'); assert.equal(fs.readFileSync(socket, 'utf8'), 'synthetic sentinel');
    fs.unlinkSync(socket); await unsafe.close();
  } finally { await f.close(); }
});

test('managed and unlinked updates: real tmux identity, inherited ID, actor serialization, protected text, no capture/PTY or replay', async () => {
  const f = await botFixture('an-send', { initialize: false });
  try {
    const row = await f.h.service.sessions.create({ kind: 'shell', label: 'Synthetic target' });
    const identity = (await f.h.service.sessions.tmux(['display-message', '-p', '-t', '=' + row.tmux_name + ':', '#{socket_path}\t#{pid}\t#{pane_id}'])).trim().split('\t');
    const inherited = await f.h.service.sessions.tmux(['show-environment', '-t', '=' + row.tmux_name, 'PT_SESSION_ID']);
    assert.equal(inherited.trim(), 'PT_SESSION_ID=' + row.id);
    const request = { ...note, tmux: { socket: identity[0]!, pid: Number(identity[1]), pane: identity[2]! } };
    const result = await notifyLocal(f.h.service.agentNotify!.path, request); assert.equal(result.status, 'sent');
    const sent = f.fake.sent.at(-1)!; assert.match(sent.text, new RegExp(row.id)); assert.match(sent.text, /Agent-written update, not independently verified/);
    assert.equal(sent.reply_markup.inline_keyboard[0][0].callback_data, 'n:select:' + row.id);
    assert.equal((await notifyLocal(f.h.service.agentNotify!.path, request)).code, 'duplicate_suppressed');
    const bad = await notifyLocal(f.h.service.agentNotify!.path, { ...request, tmux: { ...request.tmux, socket: '/tmp/another-tmux-server' } });
    assert.equal(bad.code, 'unmanaged_terminal_use_unlinked');
    assert.equal((await notifyLocal(f.h.service.agentNotify!.path, { kind: 'question', text: 'Synthetic unlinked question', project: 'demo' })).status, 'sent');
    assert.match(f.fake.sent.at(-1)!.text, /Unlinked agent \(no managed session\)/);
    const cli = await promisify(execFile)(process.execPath, [path.join(f.h.config.root, 'dist/server/agent-notify-cli.js'), 'done', 'Synthetic CLI-only result', '--session', row.id],
      { env: { ...process.env, PT_NOTIFY_SOCKET: f.h.service.agentNotify!.path }, timeout: 10000, maxBuffer: 1024 });
    assert.match(cli.stdout, /Telegram accepted/); assert(!cli.stdout.includes('Synthetic CLI-only result'));
    assert(f.fake.calls.filter(c => c.method === 'sendMessage').every(c => c.body.protect_content === true && c.body.link_preview_options.is_disabled && !c.body.parse_mode));
    assert.equal(f.fake.maxActive, 1); assert.equal(f.h.service.bridges.stats().created, 0);
    assert.equal(f.h.service.telegram.stats().agentUpdates.textBytes, 0);
  } finally { await f.close(); }
});

test('pending agent clients: four-connection ceiling, absolute/slow-client deadlines, disconnect churn and notification-off cleanup', async () => {
  let skew = 0;
  const f = await botFixture('an-churn', { initialize: false, telegram: { endpoint: '', now: () => Date.now() + skew } });
  const local = f.h.service.agentNotify!, samples: object[] = [];
  const gc = () => (globalThis as { gc?: () => void }).gc?.();
  const sample = (phase: string) => { gc(); samples.push({ phase, memory: process.memoryUsage(), fds: fs.readdirSync('/proc/self/fd').length,
    socket: local.stats(), queue: f.h.service.telegram.stats().agentUpdates }); };
  try {
    for (let i = 0; i < 20; i++) await raw(local.path, '{}\n');
    sample('warm_idle');
    const shell = await f.h.service.sessions.create({ kind: 'shell' }); sample('one_shell_no_attachment');
    f.fake.hang = 'getUpdates'; await until(() => f.fake.active === 1);
    const cancelled = net.createConnection(local.path);
    cancelled.once('connect', () => cancelled.write(JSON.stringify({ ...note, session: shell.id, text: 'Cancelled synthetic update' }) + '\n'));
    await until(() => f.h.service.telegram.stats().agentUpdates.pending === 1);
    cancelled.destroy(); await until(() => f.h.service.telegram.stats().agentUpdates.pending === 0 && local.stats().sockets === 0);
    assert.equal(f.h.service.telegram.stats().agentUpdates.textBytes, 0); skew += 31000;
    const sockets = Array.from({ length: 4 }, () => net.createConnection(local.path));
    await until(() => local.stats().sockets === 4);
    const excess = net.createConnection(local.path); excess.on('error', () => {}); await new Promise<void>(r => excess.once('close', r));
    assert.equal(local.stats().sockets, 4);
    // Empty/slow clients cannot hold resources past the absolute receive deadline.
    await until(() => local.stats().sockets === 0, 4500); for (const s of sockets) s.destroy();
    const pending = (['progress', 'blocked', 'question', 'done'] as AgentKind[]).map(kind => notifyLocal(local.path, { kind, text: 'Synthetic queued ' + kind, session: shell.id }));
    await until(() => f.h.service.telegram.stats().agentUpdates.pending === 4); sample('four_pending');
    const c = f.state.control()!; f.state.setNotifications(c.epoch, false);
    const receipts = await Promise.all(pending); assert(receipts.every(r => r.status === 'rejected'));
    assert.equal(f.fake.sent.length, 0); await until(() => local.stats().sockets === 0);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 100; i++) {
        const s = net.createConnection(local.path); s.on('error', () => {});
        await new Promise<void>(resolve => { s.once('connect', () => { s.write('{'); s.destroy(); }); s.once('close', resolve); });
        await until(() => local.stats().sockets === 0);
      }
      sample('after_' + (round + 1) * 100 + '_disconnects');
      assert.equal(f.h.service.telegram.stats().agentUpdates.textBytes, 0);
    }
    assert.equal(f.h.service.bridges.stats().created, 0); assert.equal(f.h.service.sessions.get(shell.id).state, 'running');
    fs.mkdirSync(path.join(f.h.config.root, '.runtime/evidence'), { recursive: true });
    fs.writeFileSync(path.join(f.h.config.root, '.runtime/evidence/agent-notify-memory.json'), JSON.stringify({ synthetic: true, prolongedSoak: false, browserChanged: false, disconnectCycles: 200, samples }, null, 2));
  } finally { await f.close(); }
});

test('failed agent delivery is uncertain and never retried; disable preserves the running job', async () => {
  const f = await botFixture('an-loss', { initialize: false });
  try {
    const row = await f.h.service.sessions.create({ kind: 'shell' });
    f.fake.fail = 'sendMessage';
    const result = await notifyLocal(f.h.service.agentNotify!.path, { ...note, session: row.id }); assert.equal(result.status, 'uncertain');
    await delay(1600); assert.equal(f.fake.calls.filter(c => c.method === 'sendMessage').length, 1);
    f.state.disable(); await until(() => f.h.service.telegram.stats().poller === 0, 2500);
    assert.equal(f.h.service.sessions.get(row.id).state, 'running'); assert.equal(f.h.service.telegram.stats().agentUpdates.textBytes, 0);
  } finally { await f.close(); }
});
