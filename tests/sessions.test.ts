import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { CODEX_ARGS, LIMITS } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { Sessions } from '../src/server/sessions.js';
import { harness, delay, until, cleanupTmux } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';

const readStreams = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles().filter(x => x.constructor.name === 'ReadStream');
const ptyFds = () => fs.readdirSync('/proc/self/fd').filter(fd => {
  try { return /^\/dev\/(pts\/)?ptmx$/.test(fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { return false; }
});
async function nativeGone(h: Awaited<ReturnType<typeof harness>>, pid: number, before: Set<object>, fds: string[]) {
  await until(() => !fs.existsSync(`/proc/${pid}`), 3000, 'tmux attach child not actually reaped');
  await until(() => readStreams().every(x => before.has(x)), 1500, 'Native PTY ReadStream retained after detach');
  assert.deepEqual(ptyFds(), fds, 'Actual /dev/ptmx descriptors did not return to baseline');
  assert.equal(h.service.bridges.stats().ptys, 0);
  assert.equal(h.service.bridges.stats().retiringPtys, 0);
  assert.equal(h.service.bridges.stats().created, h.service.bridges.stats().disposed);
  assert.equal(h.service.bridges.stats().subscriptions, 0);
  assert.deepEqual(attachmentPids(descendants(process.pid)), [], 'Uncounted native attachment remains');
}

test('Sessions: atomic 20 running/starting reservations under 30 simultaneous HTTP creates; no idle PTYs', async () => {
  const h = await harness('cap');
  try {
    await h.login();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => h.api('POST', '/api/sessions', { kind: 'shell', label: `Synthetic ${i}` })));
    assert.equal(results.filter(r => r.statusCode === 201).length, 20); assert.equal(results.filter(r => r.statusCode === 409).length, 10);
    assert.equal(h.service.sessions.stats().managedRunning, 20); assert.equal(h.service.sessions.stats().reservations, 0);
    assert.equal(h.service.bridges.stats().ptys, 0);
    const list = (await h.api('GET', '/api/sessions')).json().sessions;
    assert.equal(list.length, 20); const w = await h.ws(list[0].id); await until(() => w.control);
    assert.equal(h.service.bridges.stats().ptys, 1); assert.equal(h.service.bridges.stats().attachments, 1);
    w.socket.close(); await until(() => h.service.bridges.stats().ptys === 0);
    assert.equal(h.service.sessions.stats().managedRunning, 20);
    assert.match(await h.service.sessions.tmux(['show-options', '-g', 'history-limit']), /2000/);
  } finally { await h.close(); }
});
test('Sessions: failed spawn rolls back; uncertain post-spawn failure kills only its own reservation', async () => {
  const h = await harness('rollback');
  try {
    let failAfterSpawn = false;
    const runner = async (args: string[]) => {
      if (args[0] === 'new-session') { if (failAfterSpawn) await h.service.sessions.tmux(args); throw new Error('injected_spawn_failure'); }
      return h.service.sessions.tmux(args);
    };
    const manager = new Sessions(h.service.store, h.config, runner);
    await assert.rejects(manager.create({ kind: 'shell' }), /spawn_failed/); assert.equal(manager.stats().managedRunning, 0);
    const keep = await h.service.sessions.create({ kind: 'shell', label: 'Keep' });
    failAfterSpawn = true; await assert.rejects(manager.create({ kind: 'shell' }), /spawn_failed/);
    assert.equal(manager.stats().managedRunning, 1); await manager.tmux(['has-session', '-t', `=${keep.tmux_name}`]);
    assert.equal((await manager.tmux(['list-sessions', '-F', '#{session_name}'])).trim(), keep.tmux_name);
  } finally { await h.close(); }
});
test('Sessions: exact Codex model/provider/max/full-access launch vector; no shell interpolation', async () => {
  const h = await harness('codex-vector');
  try {
    let captured: string[] = [];
    const manager = new Sessions(h.service.store, h.config, async args => { if (args[0] === 'new-session') captured = args; return ''; });
    const row = await manager.create({ label: 'Codex vector (synthetic, no model call)' });
    assert.equal(row.kind, 'codex'); assert.deepEqual(captured.slice(captured.indexOf('--') + 1), ['codex', ...CODEX_ARGS]);
    assert.doesNotMatch(captured.join(' '), /hook.*bypass|--yolo|gpt-6(?!-astra)/);
    assert.equal(h.service.bridges.stats().created, 0);
  } finally { await h.close(); }
});
test('Sessions: backend restart reconciles persistent jobs, interrupted reservations and orphan metadata safely', async () => {
  const h = await harness('restart'); let next: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const row = await h.service.sessions.create({ kind: 'shell' });
    const pid = (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim();
    assert.match(pid, /^\d+$/);
    h.service.store.db.prepare("UPDATE terminals SET state='starting' WHERE id=?").run(row.id);
    await h.service.close();
    next = await createApp(h.config); assert.equal(next.sessions.get(row.id).state, 'running');
    assert.equal((await next.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim(), pid);
    const orphan = 'pt_' + 'a'.repeat(32);
    await next.sessions.tmux(['new-session', '-d', '-s', orphan, '-c', h.config.defaultCwd, '--', '/bin/bash', '--noprofile', '--norc', '-i']);
    await next.sessions.reconcile(); assert.equal(next.sessions.get('a'.repeat(32)).state, 'running');
    await next.sessions.tmux(['kill-session', '-t', `=${row.tmux_name}`]); await next.sessions.reconcile(); assert.equal(next.sessions.get(row.id).state, 'stopped');
  } finally { if (next) await next.close(); await h.service.close(); cleanupTmux(h.config); }
});
test('Sessions: simulated reboot marks lost jobs stopped and never reruns commands', async () => {
  const h = await harness('reboot'); let next: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' }); const w = await h.ws(row.id); await until(() => w.control);
    const marker = path.join(h.config.defaultCwd, 'run-once');
    w.send({ type: 'input', data: 'echo once >> run-once\r' }); await until(() => fs.existsSync(marker));
    await h.service.close(); cleanupTmux(h.config); // Deliberately simulate only the disposable tmux server disappearing, NOT a VPS reboot.
    next = await createApp(h.config); assert.equal(next.sessions.get(row.id).state, 'stopped'); assert.equal(next.sessions.stats().managedRunning, 0);
    await delay(100); assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
  } finally { if (next) await next.close(); await h.service.close(); cleanupTmux(h.config); }
});
test('Bridge: multiple devices share output with one controller; take-control/resize and target Stop are isolated', async () => {
  const h = await harness('multi-device');
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' }); const keep = await h.service.sessions.create({ kind: 'shell', label: 'Keep' });
    const a = await h.ws(row.id), b = await h.ws(row.id); await until(() => a.control && !b.control);
    b.send({ type: 'input', data: 'echo wrong > forbidden\r' }); await delay(100); assert.equal(fs.existsSync(path.join(h.config.defaultCwd, 'forbidden')), false);
    b.send({ type: 'take_control' }); await until(() => b.control && !a.control);
    b.send({ type: 'input', data: 'echo allowed > controller\r' }); await until(() => fs.existsSync(path.join(h.config.defaultCwd, 'controller')));
    b.send({ type: 'resize', cols: 72, rows: 18 }); await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{window_width}x#{window_height}'])).trim() === '72x18');
    a.send({ type: 'resize', cols: 120, rows: 40 }); await delay(100); assert.equal((await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{window_width}x#{window_height}'])).trim(), '72x18');
    const result = await h.api('POST', `/api/sessions/${row.id}/stop`, { confirm: row.id }); assert.equal(result.statusCode, 200);
    await until(() => a.socket.readyState === WebSocket.CLOSED && b.socket.readyState === WebSocket.CLOSED);
    await h.service.sessions.tmux(['has-session', '-t', `=${keep.tmux_name}`]); await until(() => h.service.bridges.stats().ptys === 0);
  } finally { await h.close(); }
});
test('Bridge: bounded inbound frames, ACK bookkeeping, input and dimensions fail closed without killing jobs', async () => {
  const h = await harness('frames');
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    for (const payload of [{ type: 'ack', bytes: 99999999 }, { type: 'resize', cols: 241, rows: 100 }, { type: 'resize', cols: 2, rows: 101 }, { type: 'input', data: 'a'.repeat(4097) }, { type: 'unknown' }]) {
      const w = await h.ws(row.id); w.send(payload); await until(() => w.socket.readyState === WebSocket.CLOSED); await until(() => h.service.bridges.stats().ptys === 0);
    }
    const large = await h.ws(row.id); large.socket.send('x'.repeat(LIMITS.inbound + 1)); await until(() => large.socket.readyState === WebSocket.CLOSED);
    const binary = await h.ws(row.id); binary.socket.send(Buffer.from('input')); await until(() => binary.socket.readyState === WebSocket.CLOSED);
    await h.service.sessions.tmux(['has-session', '-t', `=${row.tmux_name}`]);
  } finally { await h.close(); }
});
test('Bridge: 32 native attachments include SIGSTOPed retirement; watchdog reaps only the client and releases cap', async () => {
  const h = await harness('attachment-cap');
  let stoppedPid = 0;
  const before = new Set(readStreams()), fds = ptyFds();
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    const panePid = (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim();
    const all = [await h.ws(row.id)];
    await until(async () => {
      stoppedPid = Number((await h.service.sessions.tmux(['list-clients', '-t', `=${row.tmux_name}`, '-F', '#{client_pid}'])).trim());
      return stoppedPid > 0;
    });
    for (let i = 1; i < 32; i++) all.push(await h.ws(row.id));
    assert.equal(h.service.bridges.stats().ptys, 32); await assert.rejects(h.ws(row.id), /429/); assert.equal(h.service.bridges.stats().created, 32);
    process.kill(stoppedPid, 'SIGSTOP');
    await until(() => /^State:\s+T/m.test(fs.readFileSync(`/proc/${stoppedPid}/status`, 'utf8')));
    const disconnectedAt = Date.now(); all[0]!.socket.close();
    await until(() => h.service.bridges.stats().connections === 31);
    assert.equal(h.service.bridges.stats().retiringPtys, 1); assert.equal(h.service.bridges.stats().ptys, 32);
    assert.equal(h.service.bridges.stats().disposed, 0, 'Logical detach must not count as native disposal');
    assert.equal(ptyFds().length, fds.length + 32);
    await assert.rejects(h.ws(row.id), /429/, 'Retiring native child must still occupy the global cap');
    await until(() => !fs.existsSync(`/proc/${stoppedPid}`), 3000, 'SIGSTOPed client was not escalated/reaped');
    await until(() => h.service.bridges.stats().ptys === 31);
    assert.ok(Date.now() - disconnectedAt < 3000);
    assert.equal((await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim(), panePid);
    process.kill(Number(panePid), 0);
    all.push(await h.ws(row.id)); assert.equal(h.service.bridges.stats().created, 33);
    for (const w of all) w.socket.close(); await until(() => h.service.bridges.stats().ptys === 0);
    await nativeGone(h, stoppedPid, before, fds);
  } finally {
    if (stoppedPid) { try { process.kill(stoppedPid, 'SIGKILL'); } catch { /* test-owned child already reaped */ } }
    await h.close();
  }
});
test('Bridge: non-ACKing client times out within bounded credit; reconnect redraws, job survives', async () => {
  const h = await harness('slow-client');
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    const start = Date.now(), slow = await h.ws(row.id, { ack: false });
    await until(() => slow.socket.readyState === WebSocket.CLOSED, 7500);
    assert.ok(Date.now() - start < 7500); assert.ok(h.service.bridges.stats().peakOutstandingBytes <= LIMITS.outstanding);
    await h.service.sessions.tmux(['has-session', '-t', `=${row.tmux_name}`]);
    const fresh = await h.ws(row.id); await until(() => fresh.output.includes('bash')); fresh.socket.close();
  } finally { await h.close(); }
});

test('Bridge: three paused high-rate non-ACK teardowns release actual PTY fds, native clients and ReadStreams', async () => {
  const h = await harness('paused-native-cleanup');
  let clientPid = 0;
  const before = new Set(readStreams()), fds = ptyFds();
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    const panePid = (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim();
    for (let i = 0; i < 3; i++) {
      const slow = await h.ws(row.id, { ack: false });
      await until(async () => {
        clientPid = Number((await h.service.sessions.tmux(['list-clients', '-t', `=${row.tmux_name}`, '-F', '#{client_pid}'])).trim());
        return clientPid > 0;
      });
      assert.deepEqual(attachmentPids(descendants(process.pid)), [clientPid], 'OS classifier must actually see the live PTY child');
      assert.equal(ptyFds().length, fds.length + 1);
      assert.equal(readStreams().filter(x => !before.has(x)).length, 1, 'Active native attachment must expose one ReadStream');
      const stats = path.join(h.config.dataDir, `producer-${i}.json`);
      slow.send({ type: 'input', data: `python3 -u ${h.config.root}/scripts/synthetic-output.py --rate 1048576 --seconds 7 --stats ${stats}\r` });
      await until(() => h.service.bridges.stats().outstandingBytes >= LIMITS.outstanding / 2, 3000, `Round ${i}: test did not actually pause PTY reads`);
      await until(() => slow.socket.readyState === WebSocket.CLOSED, 7500);
      await nativeGone(h, clientPid, before, fds);
      assert.equal((await h.service.sessions.tmux(['list-clients', '-t', `=${row.tmux_name}`, '-F', '#{client_pid}'])).trim(), '');
      assert.equal((await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim(), panePid);
      process.kill(Number(panePid), 0);
      await until(() => fs.existsSync(stats) && JSON.parse(fs.readFileSync(stats, 'utf8')).done, 5000, 'Detached producer did not keep running');
    }
    const fresh = await h.ws(row.id); await until(() => fresh.output.length > 0); fresh.socket.close();
    await until(() => h.service.bridges.stats().ptys === 0);
    await nativeGone(h, clientPid, before, fds);
  } finally {
    // Scoped cleanup also permits this regression to terminate against the old broken implementation.
    if (clientPid) { try { process.kill(clientPid, 'SIGKILL'); } catch { /* already reaped */ } }
    await h.close();
  }
});

test('Bridge: idempotent shutdown escalates stopped attachment, closes native fds and preserves pane PID', async () => {
  const h = await harness('native-shutdown');
  let clientPid = 0;
  const before = new Set(readStreams()), fds = ptyFds();
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    const panePid = (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim();
    const client = await h.ws(row.id);
    await until(async () => {
      clientPid = Number((await h.service.sessions.tmux(['list-clients', '-t', `=${row.tmux_name}`, '-F', '#{client_pid}'])).trim());
      return clientPid > 0;
    });
    process.kill(clientPid, 'SIGSTOP');
    await until(() => /^State:\s+T/m.test(fs.readFileSync(`/proc/${clientPid}/status`, 'utf8')));
    const start = Date.now(), closing = h.service.bridges.close();
    assert.equal(h.service.bridges.close(), closing, 'Concurrent close calls must join the same shutdown');
    await closing;
    assert.ok(Date.now() - start < 3000);
    await until(() => client.socket.readyState === WebSocket.CLOSED);
    await nativeGone(h, clientPid, before, fds);
    assert.equal(h.service.bridges.stats().heartbeatTimers, 0);
    assert.equal((await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_pid}'])).trim(), panePid);
    process.kill(Number(panePid), 0);
  } finally {
    if (clientPid) { try { process.kill(clientPid, 'SIGKILL'); } catch { /* only known disposable attach child */ } }
    await h.close();
  }
});

test('Measurement: native attachment classification tolerates tmux setproctitle and excludes pipe-stdin query children', async () => {
  const h = await harness('native-classifier');
  let query: ReturnType<typeof spawn> | undefined;
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    const viewer = await h.ws(row.id); let clientPid = 0;
    await until(async () => {
      clientPid = Number((await h.service.sessions.tmux(['list-clients', '-t', `=${row.tmux_name}`, '-F', '#{client_pid}'])).trim()); return clientPid > 0;
    });
    // tmux rewrites argv to "tmux: client" on this host, so matching "attach-session" alone is insufficient.
    query = spawn('tmux', ['-L', h.config.tmuxSocket, 'wait-for', 'measurement-query'], { stdio: 'pipe' });
    await until(() => fs.existsSync(`/proc/${query!.pid}/exe`));
    assert.deepEqual(attachmentPids(descendants(process.pid)), [clientPid]);
    query.kill('SIGTERM'); await new Promise(resolve => query!.once('exit', resolve));
    viewer.socket.close(); await until(() => h.service.bridges.stats().ptys === 0);
    assert.deepEqual(attachmentPids(descendants(process.pid)), []);
  } finally { query?.kill('SIGKILL'); await h.close(); }
});

test('Sessions: unknown tmux state retains reservation; stale reconciliation cannot mark a newly spawned job stopped', async () => {
  const h = await harness('reconcile-races');
  try {
    const uncertain = new Sessions(h.service.store, h.config, async () => { throw new Error('injected tmux unavailable'); });
    await assert.rejects(uncertain.create({ kind: 'shell' }), /spawn_uncertain_reservation_retained/);
    assert.equal(uncertain.stats().managedRunning, 1);
    h.service.store.db.exec("DELETE FROM terminals WHERE state='starting'");
    let release: (() => void) | undefined, captured = false;
    const manager = new Sessions(h.service.store, h.config, async args => {
      if (args[0] === 'list-panes') {
        let out = ''; try { out = await h.service.sessions.tmux(args); } catch { /* empty test server */ }
        captured = true; await new Promise<void>(resolve => { release = resolve; }); return out;
      }
      return h.service.sessions.tmux(args);
    });
    const reconcile = manager.reconcile(); await until(() => captured);
    const created = await manager.create({ kind: 'shell' }); release!(); await reconcile;
    assert.equal(manager.get(created.id).state, 'running'); await manager.tmux(['has-session', '-t', `=${created.tmux_name}`]);
  } finally { await h.close(); }
});

test('Sessions: dead pane/window never kills other live jobs; controller resize follows current active window', async () => {
  const h = await harness('multi-window');
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' });
    const pane2 = (await h.service.sessions.tmux(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `=${row.tmux_name}:0`, '--', '/bin/bash', '--noprofile', '--norc', '-i'])).trim();
    await h.service.sessions.tmux(['send-keys', '-t', pane2, 'exit', 'Enter']);
    await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', pane2, '#{pane_dead}'])).trim() === '1');
    await h.service.sessions.reconcile(); assert.equal(h.service.sessions.get(row.id).state, 'running');
    await h.service.sessions.tmux(['has-session', '-t', `=${row.tmux_name}`]);
    await h.service.sessions.tmux(['new-window', '-t', `=${row.tmux_name}`, '-n', 'Second', '--', '/bin/bash', '--noprofile', '--norc', '-i']);
    await h.service.sessions.tmux(['send-keys', '-t', `=${row.tmux_name}:0.0`, 'exit', 'Enter']);
    await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:0.0`, '#{pane_dead}'])).trim() === '1');
    await h.service.sessions.reconcile(); assert.equal(h.service.sessions.get(row.id).state, 'running');
    const viewer = await h.ws(row.id); await until(() => viewer.control);
    viewer.send({ type: 'resize', cols: 91, rows: 27 });
    await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${row.tmux_name}:1.0`, '#{window_width}x#{window_height}'])).trim() === '91x27');
    assert.equal((await h.service.sessions.tmux(['show-options', '-t', row.tmux_name, '-v', 'default-size'])).trim(), '91x27');
    viewer.socket.close(); await h.service.sessions.tmux(['has-session', '-t', `=${row.tmux_name}`]);
  } finally { await h.close(); }
});
