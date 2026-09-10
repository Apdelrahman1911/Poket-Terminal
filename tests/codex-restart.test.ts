import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { Sessions } from '../src/server/sessions.js';
import { HttpError } from '../src/server/errors.js';
import type { CodexControl } from '../src/server/codex-control.js';
import { testConfig, harness } from './helpers.js';

const THREAD = '01990000-1111-7222-8333-444444444444';
class NativeFixture {
  panes = new Map<string, { pid: number; pane: string; dead: boolean }>();
  calls: string[][] = []; exits = 0; inspected = 0; serial = 100;
  inspectGate?: () => Promise<void>; missingHistory = false; exitTimeout = false; uncertainSpawn = false;
  tmux = async (args: string[]) => {
    this.calls.push(args);
    const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').split(':')[0];
    if (args[0] === 'new-session') {
      const name = args[args.indexOf('-s') + 1]!;
      assert.ok(!this.panes.has(name));
      this.panes.set(name, { pid: ++this.serial, pane: '%' + this.serial, dead: false });
    } else if (args[0] === 'respawn-pane') {
      const pane = [...this.panes.values()].find(p => p.pane === target)!;
      assert.ok(pane?.dead, 'never force-replace a live pane');
      pane.pid = ++this.serial; pane.dead = false;
      if (this.uncertainSpawn) throw new Error('synthetic post-spawn transport error');
    } else if (args[0] === 'kill-session') this.panes.delete(target!);
    else if (args[0] === 'has-session' && !this.panes.has(target!)) throw Object.assign(new Error('missing'), { stderr: "can't find session" });
    else if (args[0] === 'list-panes') {
      if (args.includes('-s')) {
        const pane = this.panes.get(target!); assert.ok(pane);
        return `${target}\t${pane.pane}\t${pane.pid}\t${Number(pane.dead)}\n`;
      }
      return [...this.panes].map(([name, p]) => `${name}\t${Number(p.dead)}\t/fixture\tunavailable\t0\t`).join('\n');
    }
    return '';
  };
  control: CodexControl = {
    inspect: async panePid => {
      this.inspected++; await this.inspectGate?.();
      if (this.missingHistory) throw new HttpError(409, 'codex_history_unavailable');
      return { panePid, paneStart: '100', pid: panePid, start: '100', threadId: THREAD };
    },
    exit: async identity => {
      this.exits++;
      if (this.exitTimeout) throw new HttpError(409, 'codex_exit_timeout');
      const pane = [...this.panes.values()].find(p => p.pid === identity.panePid)!; assert.ok(pane); pane.dead = true;
    },
  };
}
async function fixture(name: string) {
  const config = await testConfig(name), store = new Store(config.dataDir), native = new NativeFixture();
  const sessions = new Sessions(store, config, native.tmux, native.control);
  return { config, store, native, sessions, close: async () => { await sessions.shutdown(); store.close(); } };
}

test('Codex restart: exact main UUID, same entry/pane, new process, current launch config, no replay; duplicate request is stale', async () => {
  const h = await fixture('codex-exact');
  try {
    const row = await h.sessions.create({ kind: 'codex', label: 'Synthetic main chat' });
    const before = { ...h.native.panes.get(row.tmux_name)! }; let detaches = 0;
    h.config.codexArgs = ['-c', 'agents.max_concurrent_threads_per_session=30'];
    const next = await h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => { detaches++; });
    assert.equal(next.id, row.id); assert.equal(next.cwd, row.cwd); assert.equal(next.label, row.label);
    assert.equal(h.native.panes.get(row.tmux_name)!.pane, before.pane); assert.notEqual(h.native.panes.get(row.tmux_name)!.pid, before.pid);
    const argv = h.native.calls.find(c => c[0] === 'respawn-pane')!;
    assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['codex', 'resume', THREAD, '-c', 'agents.max_concurrent_threads_per_session=30', '--cd', row.cwd]);
    assert.ok(!argv.includes('--last') && !argv.includes('-k')); assert.equal(detaches, 1); assert.equal(h.native.exits, 1);
    assert.equal(h.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('codex_resume:' + row.id)!.value, THREAD);
    assert.equal(h.sessions.describe(next).codexResumeAvailable, true); assert.equal(h.sessions.stats().codexRestarts, 0);
    await assert.rejects(h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => {}), /session_changed_refresh/);
    assert.equal(h.native.exits, 1);
  } finally { await h.close(); }
});

test('Codex restart: missing/ambiguous history never stops or replaces a CLI; shell sessions refuse the action', async () => {
  const h = await fixture('codex-history');
  try {
    const row = await h.sessions.create({ kind: 'codex' }); h.native.missingHistory = true;
    await assert.rejects(h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => { assert.fail('must not detach'); }), /codex_history_unavailable/);
    assert.deepEqual(h.sessions.get(row.id), row); assert.equal(h.native.exits, 0);
    const shell = await h.sessions.create({ kind: 'shell' });
    await assert.rejects(h.sessions.restartCodex(shell.id, shell.updated_at, () => {}, async () => {}), /codex_only/);
  } finally { await h.close(); }
});

test('Codex restart: one global operation, no queue; normal input/stop/delete are blocked during restart', async () => {
  const h = await fixture('codex-singleflight');
  let release: (() => void) | undefined;
  try {
    const a = await h.sessions.create({ kind: 'codex' }), b = await h.sessions.create({ kind: 'codex' });
    h.native.inspectGate = () => new Promise<void>(resolve => { release = resolve; });
    const work = h.sessions.restartCodex(a.id, a.updated_at, () => {}, async () => {});
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    assert.throws(() => h.sessions.inputReady(a.id), /session_not_running_or_busy/);
    await assert.rejects(h.sessions.restartCodex(a.id, a.updated_at, () => {}, async () => {}), /codex_restart_busy/);
    await assert.rejects(h.sessions.restartCodex(b.id, b.updated_at, () => {}, async () => {}), /codex_restart_busy/);
    await assert.rejects(h.sessions.stop(a.id), /session_busy/);
    await assert.rejects(h.sessions.deleteStopped(a.id), /session_busy/);
    assert.equal(h.sessions.stats().reservations, 1); release!(); await work;
    assert.equal(h.sessions.stats().reservations, 0); assert.equal(h.native.exits, 1);
  } finally { release?.(); await h.close(); }
});

test('Codex restart: refused exit never spawns a second CLI and retains the original live process', async () => {
  const h = await fixture('codex-timeout');
  try {
    const row = await h.sessions.create({ kind: 'codex' }); const pid = h.native.panes.get(row.tmux_name)!.pid;
    h.native.exitTimeout = true;
    await assert.rejects(h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => {}), /codex_exit_timeout/);
    assert.equal(h.native.panes.get(row.tmux_name)!.pid, pid); assert.equal(h.sessions.get(row.id).state, 'running');
    assert.equal(h.native.calls.filter(c => c[0] === 'respawn-pane').length, 0); assert.equal(h.sessions.stats().managedRunning, 1);
  } finally { await h.close(); }
});

test('Codex restart: auth rechecked after detach, uncertain spawn is not retried or killed', async () => {
  const h = await fixture('codex-guard');
  try {
    const row = await h.sessions.create({ kind: 'codex' }); let authorized = true;
    await assert.rejects(h.sessions.restartCodex(row.id, row.updated_at, () => { if (!authorized) throw new HttpError(401, 'authentication_required'); }, async () => { authorized = false; }), /authentication_required/);
    assert.equal(h.native.exits, 0); assert.equal(h.sessions.get(row.id).state, 'running');
    h.native.uncertainSpawn = true;
    await assert.rejects(h.sessions.restartCodex(row.id, h.sessions.get(row.id).updated_at, () => {}, async () => {}), /codex_restart_uncertain/);
    assert.equal(h.sessions.get(row.id).stopped_reason, 'spawn_uncertain'); assert.equal(h.sessions.stats().managedRunning, 1);
    assert.equal(h.native.calls.filter(c => c[0] === 'respawn-pane').length, 1); assert.equal(h.native.calls.filter(c => c[0] === 'kill-session').length, 0);
    await h.sessions.reconcile(); assert.equal(h.sessions.get(row.id).stopped_reason, null);
  } finally { await h.close(); }
});

test('Codex resume: explicitly resumes stopped linked entries, enforces 20-session cap, deletes only tiny metadata', async () => {
  const h = await fixture('codex-resume-stopped');
  try {
    let row = await h.sessions.create({ kind: 'codex' });
    row = await h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => {});
    row = await h.sessions.stop(row.id);
    for (let i = 0; i < 20; i++) await h.sessions.create({ kind: 'shell' });
    await assert.rejects(h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => {}), /session_limit/);
    assert.equal(h.sessions.get(row.id).state, 'stopped'); assert.equal(h.sessions.stats().managedRunning, 20);
    await h.sessions.stop(h.sessions.list().find(s => s.kind === 'shell')!.id);
    const resumed = await h.sessions.restartCodex(row.id, row.updated_at, () => {}, async () => {});
    assert.equal(resumed.id, row.id); assert.equal(h.native.inspected, 1, 'stopped resume uses only persisted exact UUID');
    await h.sessions.stop(row.id); await h.sessions.deleteStopped(row.id);
    assert.equal(h.store.db.prepare('SELECT count(*) n FROM metadata WHERE key=?').get('codex_resume:' + row.id)!.n, 0);
    assert.equal(h.store.db.prepare('PRAGMA user_version').get()!.user_version, 1);
  } finally { await h.close(); }
});

test('Codex restart API: auth, origin, CSRF, exact confirmation, freshness and strict body schema', async () => {
  const native = new NativeFixture(), h = await harness('codex-restart-auth', { tmux: native.tmux, codexControl: native.control });
  try {
    const row = await h.service.sessions.create({ kind: 'codex' });
    const url = `/api/sessions/${row.id}/restart-codex`, body = { confirm: row.id, expectedUpdatedAt: row.updated_at };
    assert.equal((await h.api('POST', url, body)).statusCode, 401); await h.login();
    assert.equal((await h.api('POST', url, body, { origin: 'https://evil.invalid' })).statusCode, 403);
    assert.equal((await h.api('POST', url, body, { 'x-csrf-token': 'wrong' })).statusCode, 403);
    assert.equal((await h.api('POST', url, { ...body, confirm: '0'.repeat(32) })).statusCode, 400);
    assert.equal((await h.api('POST', url, { ...body, command: 'never accepted' })).statusCode, 400);
    assert.equal((await h.api('POST', url, { confirm: row.id })).statusCode, 400);
    assert.equal(native.exits, 0);
    const result = await h.api('POST', url, body); assert.equal(result.statusCode, 200); assert.equal(result.json().session.id, row.id);
    assert.equal((await h.api('POST', url, body)).statusCode, 409); assert.equal(native.exits, 1);
  } finally { await h.close(); }
});
