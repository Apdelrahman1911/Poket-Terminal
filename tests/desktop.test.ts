import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import { Auth, cookieToken, tokenHash } from '../src/server/auth.js';
import { Store } from '../src/server/db.js';
import { LIMITS, ROOT } from '../src/server/config.js';
import { RfbInput, DESKTOP_LIMITS as L } from '../src/server/desktop-rfb.js';
import { pinDesktopSocket } from '../src/server/desktop.js';
import { desktopOptIn } from '../src/server/desktop-opt-in.js';
import { testConfig, TEST_PASSWORD, cleanupTmux, delay, until } from './helpers.js';

// Fake sockets only: no desktop account, native helper or GUI is used.
const uid = process.getuid!() === 0 ? 65534 : process.getuid!();
const gid = process.getgid!();
const socketDir = (prefix: string) => fs.mkdtempSync(path.join(ROOT, '.runtime/', prefix));
async function desktopHarness(name: string, now?: () => number) {
  const config = await testConfig('desktop-' + name);
  const run = socketDir('rfb-'); fs.chmodSync(run, 0o700); fs.chownSync(run, uid, gid);
  config.desktop = { assetsDir: path.join(ROOT, 'desktop/.runtime/candidates/client/client'), socketPath: path.join(run, 'rfb.sock'), uid, startCommand: 'test-start' };
  const peers = new Set<net.Socket>(); let nativeConnections = 0, nativeBytes = 0;
  const native = net.createServer(socket => { nativeConnections++; peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); socket.on('data', data => { nativeBytes += data.length; }); });
  await new Promise<void>(r => native.listen(config.desktop!.socketPath, r)); fs.chmodSync(config.desktop.socketPath, 0o600); fs.chownSync(config.desktop.socketPath, uid, gid);
  const service = await createApp(config, { now }); await service.auth.setPassword(TEST_PASSWORD, 'init');
  await service.app.listen({ host: config.host, port: config.port });
  let cookie = '', csrf = '';
  const headers = { host: new URL(config.origin).host, origin: config.origin };
  const api = (method: string, url: string, body?: object, custom: Record<string, string> = {}) => service.app.inject({ method: method as 'GET', url, headers: { ...headers, cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...custom }, payload: body });
  const login = async () => { const result = await api('POST', '/api/login', { password: TEST_PASSWORD }); assert.equal(result.statusCode, 200); cookie = String(result.headers['set-cookie']).split(';')[0]!; csrf = result.json().csrf; return { cookie, csrf }; };
  const ws = (custom: { url?: string; headers?: Record<string, string>; protocols?: string[] } = {}) => new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(config.origin.replace('https:', 'wss:') + (custom.url || '/api/desktop/socket'), custom.protocols || ['pocketdesktop.v1', `csrf.${csrf}`], { rejectUnauthorized: false, headers: { ...headers, cookie, ...custom.headers } });
    socket.once('open', () => resolve(socket)); socket.on('error', reject);
  });
  return { config, service, api, login, ws, peers, get cookie() { return cookie; }, get csrf() { return csrf; },
    get nativeConnections() { return nativeConnections; }, get nativeBytes() { return nativeBytes; },
    close: async () => { await service.close(); for (const peer of peers) peer.destroy(); await new Promise<void>(r => native.close(() => r())); cleanupTmux(config); fs.rmSync(run, { recursive: true, force: true }); } };
}

test('Desktop: safe login HTML; unauthorized assets/start/WS never open RFB or start a helper', async () => {
  const h = await desktopHarness('unauthorized');
  try {
    assert.equal((await h.api('GET', '/desktop/')).statusCode, 200);
    assert.equal((await h.api('GET', '/desktop/desktop.js')).statusCode, 401);
    assert.equal((await h.api('POST', '/api/desktop/start', {})).statusCode, 401);
    await assert.rejects(h.ws(), /401/);
    assert.equal(h.nativeConnections, 0); assert.equal(h.service.desktop!.stats().helperProcesses, 0);
    const { cookie } = await h.login(); assert.ok(cookieToken(cookie));
    assert.equal((await h.api('GET', '/api/auth')).json().desktop, true);
    assert.equal((await h.api('GET', '/desktop/desktop.js')).statusCode, 200);
    for (const headers of [{ host: 'evil.invalid' }, { origin: 'https://evil.invalid' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
      await assert.rejects(h.ws({ headers }), /403/);
      assert.equal((await h.api('POST', '/api/desktop/start', {}, headers)).statusCode, 403);
    }
    await assert.rejects(h.ws({ protocols: ['pocketdesktop.v1', 'csrf.invalid'] }), /403/);
    for (const url of ['/api/desktop/socket?target=/run/secret', '/api/desktop/socket/', '/unknown', '/api/terminal/invalid']) await assert.rejects(h.ws({ url }), /404/);
    for (const url of ['/desktop/../service/control.py', '/desktop/%2e%2e%2fservice%2fcontrol.py', '/desktop/etc/passwd', '/desktop/desktop.js%00', '/desktop/source/rfb.js']) assert.equal((await h.api('GET', url)).statusCode, 404);
    assert.equal(h.nativeConnections, 0);
    assert.equal((await h.api('POST', '/api/desktop/start', {}, { 'x-csrf-token': 'wrong' })).statusCode, 403);
  } finally { await h.close(); }
});
test('Desktop: one dispatcher preserves terminal upgrades; duplicate auth session refused without displacement; total cap two', async () => {
  const h = await desktopHarness('caps');
  try {
    await h.login(); const first = await h.ws(); await until(() => h.nativeConnections === 1);
    await assert.rejects(h.ws(), /409/); assert.equal(first.readyState, WebSocket.OPEN);
    await h.login(); const second = await h.ws(); await until(() => h.nativeConnections === 2);
    await h.login(); await assert.rejects(h.ws(), /429/); assert.equal(h.nativeConnections, 2);
    const id = (await h.api('POST', '/api/sessions', { kind: 'shell' })).json().session.id;
    const terminal = await h.ws({ url: '/api/terminal/' + id, protocols: ['pocketterminal.v1', `csrf.${h.csrf}`] });
    assert.equal(terminal.protocol, 'pocketterminal.v1'); assert.equal(h.service.app.server.listenerCount('upgrade'), 1);
    terminal.terminate(); first.terminate(); second.terminate();
    await until(() => h.service.desktop!.stats().connections === 0);
  } finally { await h.close(); }
});
test('Desktop: logout, external password reset, expiry and displaced sessions revoke within one second', async () => {
  for (const mode of ['logout', 'reset', 'expiry', 'displaced']) {
    let now = Date.now(); const h = await desktopHarness(mode, () => now);
    try {
      await h.login(); const socket = await h.ws(); await until(() => h.nativeConnections === 1);
      const closed = new Promise<number>(resolve => socket.once('close', resolve));
      const began = Date.now();
      if (mode === 'logout') assert.equal((await h.api('POST', '/api/logout', {})).statusCode, 200);
      else if (mode === 'reset') { const other = new Store(h.config.dataDir); try { await new Auth(other).setPassword('Synthetic-Reset-Password!943', 'reset'); } finally { other.close(); } }
      else if (mode === 'expiry') now += LIMITS.authMs + 1;
      else {
        h.service.store.db.prepare('UPDATE auth_sessions SET created_at=?').run(now - 100);
        for (let i = 0; i < LIMITS.authRecords; i++) h.service.store.db.prepare('INSERT INTO auth_sessions VALUES(?,1,?,?)').run(tokenHash('synthetic-' + i), now + i, now + LIMITS.authMs);
        await h.login(); // Existing Auth record displacement, not a parallel policy.
      }
      assert.equal(await closed, 4001); assert.ok(Date.now() - began < 1100, mode);
      await until(() => h.service.desktop!.stats().upstreams === 0);
    } finally { await h.close(); }
  }
});
test('Desktop: output ACK/backpressure pauses changing RFB, then detaches a slow reader with bounded queues', async () => {
  const h = await desktopHarness('slow');
  try {
    await h.login(); const socket = await h.ws(); await until(() => h.peers.size === 1);
    socket.send(Buffer.from('RFB 003.008\n')); socket.send(Buffer.from([1, 1]));
    let sent = 0; const peer = [...h.peers][0]!;
    const timer = setInterval(() => { if (!peer.destroyed && peer.writableLength < 128 * 1024) { peer.write(Buffer.alloc(32 * 1024, sent++ % 255)); } }, 2);
    try {
      await until(() => h.service.desktop!.stats().paused > 0);
      const stats = h.service.desktop!.stats(); assert.ok(stats.outstandingBytes <= L.outstanding); assert.ok(stats.transportBytes <= L.transport);
      await until(() => socket.readyState === WebSocket.CLOSED, 6500);
      assert.ok(h.service.desktop!.stats().detachReasons.slow_client! > 0);
      assert.equal(h.service.desktop!.stats().pendingInputBytes, 0);
    } finally { clearInterval(timer); socket.terminate(); }
  } finally { await h.close(); }
});
test('Desktop: oversized and invalid RFB/clipboard/resize input never reaches fixed native peer', async () => {
  for (const data of [Buffer.alloc(L.frame + 1), Buffer.from([251, 0, 255, 255, 255, 255, 1, 0]), Buffer.from([6, 0, 0, 0, 0, 0, 16, 1]), Buffer.from([6, 0, 0, 0, 255, 255, 255, 240])]) {
    const h = await desktopHarness('input');
    try {
      await h.login(); const socket = await h.ws(); await until(() => h.nativeConnections === 1);
      socket.send(Buffer.from('RFB 003.008\n')); socket.send(Buffer.from([1, 1]));
      await until(() => h.nativeBytes === 14); const before = h.nativeBytes;
      socket.send(data); await until(() => socket.readyState === WebSocket.CLOSED);
      assert.equal(h.nativeBytes, before);
    } finally { await h.close(); }
  }
});
test('Desktop: incomplete handshake and fragmented packet resources expire', async () => {
  const h = await desktopHarness('timeouts');
  try {
    await h.login(); const socket = await h.ws(); await until(() => h.nativeConnections === 1);
    socket.send(Buffer.from('RFB'));
    await until(() => socket.readyState === WebSocket.CLOSED, 3100);
    assert.equal(h.service.desktop!.stats().detachReasons.input_timeout, 1);
    const untouched = await h.ws();
    await until(() => untouched.readyState === WebSocket.CLOSED, 9000);
    assert.equal(h.service.desktop!.stats().detachReasons.handshake_timeout, 1);
  } finally { await h.close(); }
});
test('Desktop O_PATH: symlink swap cannot connect ROOT to a privileged canary socket', async () => {
  const config = await testConfig('desktop-pin'); const run = socketDir('pin-');
  fs.chmodSync(run, 0o700); fs.chownSync(run, uid, gid);
  let originalHits = 0, canaryHits = 0; const sockets = new Set<net.Socket>();
  const original = net.createServer(s => { originalHits++; sockets.add(s); s.end(); });
  const canary = net.createServer(s => { canaryHits++; sockets.add(s); s.end(); });
  const target = path.join(run, 'rfb.sock'), other = path.join(run, 'canary.sock');
  await new Promise<void>(r => original.listen(target, r)); await new Promise<void>(r => canary.listen(other, r));
  fs.chmodSync(target, 0o600); fs.chownSync(target, uid, gid);
  const pinned = pinDesktopSocket(target, uid);
  try {
    fs.renameSync(target, target + '.old'); fs.symlinkSync(other, target);
    await new Promise<void>((resolve, reject) => { const s = net.connect(pinned.path); s.on('error', reject); s.on('close', resolve); });
    assert.equal(originalHits, 1); assert.equal(canaryHits, 0);
    assert.throws(() => pinDesktopSocket(target, uid), /unsafe_desktop_socket/);
    fs.unlinkSync(target); fs.writeFileSync(target, 'not a socket'); fs.chownSync(target, uid, gid); fs.chmodSync(target, 0o600);
    assert.throws(() => pinDesktopSocket(target, uid), /unsafe_desktop_socket/);
    assert.throws(() => pinDesktopSocket(other, uid), /unsafe_desktop_socket/);
  } finally { fs.closeSync(pinned.fd); for (const s of sockets) s.destroy(); await Promise.all([new Promise<void>(r => original.close(() => r())), new Promise<void>(r => canary.close(() => r()))]); cleanupTmux(config); fs.rmSync(run, { recursive: true, force: true }); }
});
test('Desktop RFB stream gate: arbitrary fragmentation is bounded; geometry/encodings/plain clipboard allowed, oversized refused', () => {
  const input = new RfbInput(); let bytes = 0;
  for (const byte of Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])])) input.feed(Buffer.from([byte]), b => { bytes += b.length; });
  assert.equal(input.ready, true); assert.equal(bytes, 14); assert.equal(input.pendingBytes, 0);
  const clipboard = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 16, 0]), Buffer.alloc(4096, 65)]);
  for (let i = 0; i < clipboard.length; i += 13) input.feed(clipboard.subarray(i, i + 13), b => { bytes += b.length; });
  assert.equal(bytes, 4118); assert.equal(input.pendingBytes, 0);
  assert.throws(() => input.feed(Buffer.from([2, 0, 0, 65]), () => {}), /encoding_limit/);
  assert.throws(() => input.feed(Buffer.from([3, 0, 0, 0, 0, 0, 255, 255, 255, 255]), () => {}), /geometry_rejected/);
});
test('Desktop persistent opt-in: secure allowlist read on each Node start; malformed, symlink and permissions fail closed', async () => {
  const config = await testConfig('desktop-opt-in'); const dir = path.join(config.dataDir, 'opt-in'); fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, 'gateway.json');
  assert.equal(desktopOptIn(file).enabled, false);
  fs.writeFileSync(file, '{"enabled":true,"autoStart":false}', { mode: 0o600 }); assert.deepEqual(desktopOptIn(file), { enabled: true, autoStart: false });
  fs.chmodSync(file, 0o644); assert.equal(desktopOptIn(file).enabled, false); fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '{"enabled":true,"autoStart":true,"command":"untrusted"}'); assert.equal(desktopOptIn(file).enabled, false);
  fs.renameSync(file, file + '.old'); fs.symlinkSync(file + '.old', file); assert.equal(desktopOptIn(file).enabled, false);
});
