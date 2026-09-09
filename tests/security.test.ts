import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Auth, cookieToken, csrfFor, passwordHash, strongPassword, tokenHash } from '../src/server/auth.js';
import { Store } from '../src/server/db.js';
import { LIMITS, ROOT } from '../src/server/config.js';
import { harness, delay, until, TEST_PASSWORD } from './helpers.js';

test('Auth: Argon2id parameters, strong-password policy, opaque hashed tokens, 12-hour Secure host-only cookies', async () => {
  assert.equal(strongPassword('password'), false); assert.equal(strongPassword(TEST_PASSWORD), true);
  assert.match(await passwordHash(TEST_PASSWORD), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  const h = await harness('auth-cookie');
  try {
    const { result, cookie, csrf } = await h.login();
    const full = String(result.headers['set-cookie']); assert.match(full, /__Host-pocketterminal=/); assert.match(full, /Secure; HttpOnly; SameSite=Strict; Max-Age=43200/); assert.doesNotMatch(full, /Domain=/);
    const token = cookieToken(cookie)!; assert.equal(token.length, 43); assert.equal(csrf, csrfFor(token));
    const row = h.service.store.db.prepare('SELECT * FROM auth_sessions').get()!;
    assert.equal(row.token_hash, tokenHash(token)); assert.equal(Number(row.expires_at) - Number(row.created_at), LIMITS.authMs); assert.notEqual(row.token_hash, token);
    assert.equal(cookieToken(`${cookie}; ${cookie}`), undefined);
    assert.equal((await h.api('GET', '/')).headers['x-frame-options'], 'DENY');
    assert.match(String((await h.api('GET', '/')).headers['content-security-policy']), /frame-ancestors 'none'/);
  } finally { await h.close(); }
});
test('Security: unauthenticated REST/WS and uninitialized bootstrap fail closed without a PTY', async () => {
  const h = await harness('auth-closed', { initialize: false });
  try {
    assert.equal((await h.api('GET', '/api/sessions')).statusCode, 401);
    assert.equal((await h.api('POST', '/api/login', { password: TEST_PASSWORD })).statusCode, 503);
    assert.equal((await h.api('GET', '/api/auth')).json().setupRequired, true);
    await assert.rejects(h.ws('a'.repeat(32)), /401/);
    assert.equal(h.service.bridges.stats().created, 0);
    assert.equal((await h.api('GET', '/health', undefined, { host: 'irrelevant.invalid' })).body, '{"ok":true}');
    assert.equal((await h.api('GET', '/api/metrics')).statusCode, 401);
  } finally { await h.close(); }
});
test('Security: exact Host/Origin, CSRF, cross-site requests and forged proxy headers are rejected', async () => {
  const h = await harness('origin');
  try {
    await h.login();
    for (const headers of [{ host: 'evil.test' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'x-csrf-token': 'forged' }]) {
      assert.equal((await h.api('POST', '/api/sessions', { kind: 'shell' }, headers)).statusCode, 403);
    }
    assert.equal((await h.api('POST', '/api/sessions', { kind: 'shell' }, { origin: '', 'x-forwarded-host': new URL(h.config.origin).host, 'x-forwarded-proto': 'https' })).statusCode, 403);
    assert.equal((await h.api('GET', '/api/sessions', undefined, { host: 'direct.invalid', 'x-forwarded-host': new URL(h.config.origin).host })).statusCode, 403);
    const id = (await h.api('POST', '/api/sessions', { kind: 'shell' })).json().session.id;
    await assert.rejects(h.ws(id, { headers: { origin: 'https://evil.test' } }), /403/);
    await assert.rejects(h.ws(id, { protocols: ['pocketterminal.v1', 'csrf.forged'] }), /403/);
    assert.equal(h.service.bridges.stats().created, 0);
  } finally { await h.close(); }
});
test('Security: failed-login throttling is not bypassed by forged forwarded addresses', async () => {
  const h = await harness('throttle');
  try {
    for (let i = 0; i < 5; i++) assert.equal((await h.api('POST', '/api/login', { password: 'invalid' }, { 'x-forwarded-for': `203.0.113.${i}`, forwarded: `for=198.51.100.${i}` })).statusCode, 401);
    assert.equal((await h.api('POST', '/api/login', { password: TEST_PASSWORD }, { 'x-forwarded-for': '8.8.8.8' })).statusCode, 429);
    assert.equal(h.service.auth.stats().throttleKeys, 1);
  } finally { await h.close(); }
});
test('Security/RAM: concurrent Argon2 verification is capped at two with zero pending queue', async () => {
  const h = await harness('kdf-burst');
  try {
    const baseline = process.memoryUsage(); let peakRss = baseline.rss, peakVerifying = 0;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); peakVerifying = Math.max(peakVerifying, h.service.auth.stats().verifying); }, 1);
    const results = await Promise.all(Array.from({ length: 80 }, (_, i) => h.api('POST', '/api/login', { password: 'wrong-synthetic-password' }, { 'x-forwarded-for': String(i) })));
    clearInterval(sampler);
    assert.equal(results.filter(r => r.statusCode === 401).length, 2); assert.equal(results.filter(r => r.statusCode === 429).length, 78); assert.ok(peakVerifying <= 2); assert.equal(h.service.auth.stats().verifying, 0);
    fs.writeFileSync(path.join(ROOT, '.runtime/evidence/login-kdf.json'), JSON.stringify({ attempted: 80, verified: 2, rejectedWithoutQueue: 78, peakVerifying, baseline, peakRss, peakDeltaMiB: (peakRss - baseline.rss) / 1048576, methodology: 'Natural GC; in-process integration runner. Production isolated-process KDF peak also measured by benchmark.' }, null, 2), { mode: 0o600 });
  } finally { await h.close(); }
});
test('Auth: logout rejects REST/WS and closes only the browser attachment, not its job', async () => {
  const h = await harness('logout');
  try {
    await h.login(); const id = (await h.api('POST', '/api/sessions', { kind: 'shell' })).json().session.id;
    const w = await h.ws(id); await until(() => w.control);
    const closed = new Promise<number>(resolve => w.socket.once('close', code => resolve(code)));
    assert.equal((await h.api('POST', '/api/logout', {})).statusCode, 200); assert.equal(await closed, 4001);
    assert.equal((await h.api('GET', '/api/sessions')).statusCode, 401); await assert.rejects(h.ws(id), /401/);
    await h.service.sessions.tmux(['has-session', '-t', `=pt_${id}`]); assert.equal(h.service.bridges.stats().ptys, 0);
  } finally { await h.close(); }
});
test('Auth: expiry revokes REST/WS and active sockets without stopping tmux', async () => {
  let now = Date.now(); const h = await harness('expiry', { now: () => now });
  try {
    await h.login(); const id = (await h.api('POST', '/api/sessions', { kind: 'shell' })).json().session.id; const w = await h.ws(id);
    now += LIMITS.authMs + 1;
    assert.equal((await h.api('GET', '/api/sessions')).statusCode, 401); await assert.rejects(h.ws(id), /401/);
    await until(() => w.socket.readyState === WebSocket.CLOSED, 3000); await h.service.sessions.tmux(['has-session', '-t', `=pt_${id}`]);
    h.service.auth.cleanup(); assert.equal(h.service.auth.stats().authRecords, 0);
  } finally { await h.close(); }
});
test('Auth: external SSH-style password reset revokes live sockets across DB connections', async () => {
  const h = await harness('reset');
  try {
    await h.login(); const id = (await h.api('POST', '/api/sessions', { kind: 'shell' })).json().session.id; const w = await h.ws(id);
    const separate = new Store(h.config.dataDir);
    try { await new Auth(separate).setPassword('New-Synthetic-Password!49', 'reset'); } finally { separate.close(); }
    assert.equal((await h.api('GET', '/api/sessions')).statusCode, 401); await assert.rejects(h.ws(id), /401/);
    await until(() => w.socket.readyState === WebSocket.CLOSED, 3000); await h.service.sessions.tmux(['has-session', '-t', `=pt_${id}`]);
    assert.equal((await h.api('POST', '/api/login', { password: TEST_PASSWORD })).statusCode, 401);
  } finally { await h.close(); }
});
test('Security: bounded bodies, identifiers, labels and project paths reject injection/traversal', async () => {
  const h = await harness('validation');
  try {
    await h.login();
    for (const body of [{ kind: 'shell', cwd: '/' }, { kind: 'shell', cwd: h.config.defaultCwd + '/../../..' }, { kind: 'shell', label: '\nunsafe' }, { kind: 'shell', label: 'x'.repeat(81) }, { kind: 'evil' }]) assert.equal((await h.api('POST', '/api/sessions', body)).statusCode, 400);
    assert.equal((await h.api('POST', '/api/sessions', { label: 'x'.repeat(8192) })).statusCode, 413);
    assert.equal((await h.api('GET', '/api/sessions?limit=1000')).statusCode, 400);
    assert.equal((await h.api('PATCH', '/api/sessions/not-an-id', { label: 'a' })).statusCode, 400);
    const marker = path.join(h.config.defaultCwd, 'SHOULD_NOT_EXIST');
    const result = await h.api('POST', '/api/sessions', { kind: 'shell', label: '$(touch SHOULD_NOT_EXIST); <img onerror=alert(1)>' });
    assert.equal(result.statusCode, 201); assert.equal(fs.existsSync(marker), false);
    assert.equal((await h.api('POST', `/api/sessions/${result.json().session.id}/stop`, { confirm: 'a'.repeat(32) })).statusCode, 400);
  } finally { await h.close(); }
});
