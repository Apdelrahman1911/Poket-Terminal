import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { harness, until } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof harness>>;
const id = 'd'.repeat(32);
const missing = () => Promise.reject(Object.assign(new Error('synthetic missing session'), { stderr: `can't find session: pt_${id}` }));
function seed(h: Fixture, state = 'stopped') {
  h.service.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,NULL)').run(id, `pt_${id}`, 'Synthetic deletion entry', 'shell', h.config.defaultCwd, state, Date.now(), Date.now());
}

test('Delete API: authentication, CSRF, origin, exact confirmation and schema are mandatory', async () => {
  const h = await harness('delete-security');
  try {
    seed(h);
    const url = `/api/sessions/${id}`;
    assert.equal((await h.api('DELETE', url, { confirm: id })).statusCode, 401);
    await h.login();
    assert.equal((await h.api('DELETE', url, { confirm: id }, { 'x-csrf-token': '' })).statusCode, 403);
    assert.equal((await h.api('DELETE', url, { confirm: id }, { origin: 'https://invalid.example' })).statusCode, 403);
    assert.equal((await h.api('DELETE', url, { confirm: id }, { 'content-type': 'text/plain' })).statusCode, 415);
    const mismatch = await h.api('DELETE', url, { confirm: 'e'.repeat(32) });
    assert.equal(mismatch.statusCode, 400); assert.equal(mismatch.json().error, 'confirmation_required');
    for (const body of [{}, { confirm: 'invalid' }, { confirm: id, force: true }]) assert.equal((await h.api('DELETE', url, body)).statusCode, 400);
    assert.equal((await h.api('DELETE', '/api/sessions/invalid', { confirm: id })).statusCode, 400);
    assert.equal((await h.api('DELETE', `/api/sessions/${'e'.repeat(32)}`, { confirm: 'e'.repeat(32) })).statusCode, 404);
    assert.equal(h.service.sessions.get(id).state, 'stopped');
    assert.equal(h.service.bridges.stats().created, 0);
  } finally { await h.close(); }
});

test('Delete API: running, starting and stale stopped metadata with live/dead tmux sessions are refused without signaling', async () => {
  const h = await harness('delete-existing');
  try {
    await h.login();
    const row = await h.service.sessions.create({ kind: 'shell' }), target = `=${row.tmux_name}:0.0`;
    const pid = (await h.service.sessions.tmux(['display-message', '-p', '-t', target, '#{pane_pid}'])).trim();
    const remove = () => h.api('DELETE', `/api/sessions/${row.id}`, { confirm: row.id });
    for (const state of ['running', 'starting']) {
      h.service.store.db.prepare('UPDATE terminals SET state=? WHERE id=?').run(state, row.id);
      const response = await remove(); assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'session_not_stopped');
    }
    h.service.store.db.prepare("UPDATE terminals SET state='stopped' WHERE id=?").run(row.id);
    let response = await remove(); assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'session_still_exists');
    assert.equal((await h.service.sessions.tmux(['display-message', '-p', '-t', target, '#{pane_pid}'])).trim(), pid);
    process.kill(Number(pid), 0);
    // Exit only this disposable shell; remain-on-exit means tmux still exists and must not be deleted by this API.
    await h.service.sessions.tmux(['send-keys', '-t', target, 'exit', 'Enter']);
    await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', target, '#{pane_dead}'])).trim() === '1');
    response = await remove(); assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'session_still_exists');
    await h.service.sessions.tmux(['has-session', '-t', `=${row.tmux_name}`]);
    assert.equal(h.service.sessions.get(row.id).state, 'stopped');
  } finally { await h.close(); }
});

test('Delete API: only the stopped row is removed; files/history and other jobs survive reconciliation and backend reopen', async () => {
  const h = await harness('delete-retention');
  let next: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await h.login();
    const row = await h.service.sessions.create({ kind: 'shell' }), keep = await h.service.sessions.create({ kind: 'shell', label: 'Keep running' });
    const pid = (await h.service.sessions.tmux(['display-message', '-p', '-t', `=${keep.tmux_name}:0.0`, '#{pane_pid}'])).trim();
    const history = path.join(h.config.defaultCwd, '.codex/sessions/synthetic.jsonl');
    fs.mkdirSync(path.dirname(history), { recursive: true }); fs.writeFileSync(history, 'synthetic history, no model call\n');
    const files = [path.join(h.config.defaultCwd, 'README'), history].map(file => ({ file, bytes: fs.readFileSync(file) }));
    assert.equal((await h.api('POST', `/api/sessions/${row.id}/stop`, { confirm: row.id })).statusCode, 200);
    const keepBefore = h.service.sessions.get(keep.id), authCount = h.service.auth.stats().authRecords;
    const response = await h.api('DELETE', `/api/sessions/${row.id}`, { confirm: row.id });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { ok: true });
    assert.throws(() => h.service.sessions.get(row.id), /session_not_found/);
    assert.deepEqual(h.service.sessions.get(keep.id), keepBefore); assert.equal(h.service.auth.stats().authRecords, authCount);
    assert.equal((await h.api('DELETE', `/api/sessions/${row.id}`, { confirm: row.id })).statusCode, 404);
    const list = (await h.api('GET', '/api/sessions')).json().sessions;
    assert.deepEqual(list.map((s: { id: string }) => s.id), [keep.id]);
    await h.service.close(); next = await createApp(h.config);
    assert.throws(() => next!.sessions.get(row.id), /session_not_found/);
    assert.equal(next.sessions.get(keep.id).state, 'running'); assert.equal(next.auth.initialized(), true);
    assert.equal((await next.sessions.tmux(['display-message', '-p', '-t', `=${keep.tmux_name}:0.0`, '#{pane_pid}'])).trim(), pid);
    for (const file of files) assert.deepEqual(fs.readFileSync(file.file), file.bytes);
  } finally { if (next) await next.close(); await h.close(); }
});

test('Delete API: busy and uncertain probes fail closed; only a known-absent probe permits metadata deletion', async () => {
  let release: (() => void) | undefined;
  let probe = async () => { await new Promise<void>(resolve => { release = resolve; }); throw Object.assign(new Error('synthetic unavailable'), { stderr: 'permission denied' }); };
  const calls: string[][] = [];
  const h = await harness('delete-uncertain', { tmux: async args => { calls.push(args); return args[0] === 'has-session' ? probe() : ''; } });
  try {
    await h.login(); seed(h);
    const remove = () => h.api('DELETE', `/api/sessions/${id}`, { confirm: id });
    const pending = remove(); await until(() => !!release);
    let response = await remove(); assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'session_busy');
    assert.equal((await h.api('POST', `/api/sessions/${id}/stop`, { confirm: id })).statusCode, 409);
    const count = calls.length; await h.service.sessions.reconcile(); assert.equal(calls.length, count);
    release!(); response = await pending; assert.equal(response.statusCode, 503); assert.equal(response.json().error, 'delete_state_uncertain');
    assert.equal(h.service.sessions.get(id).state, 'stopped'); assert.equal(h.service.sessions.stats().reservations, 0);
    probe = missing; calls.length = 0;
    assert.equal((await remove()).statusCode, 200);
    assert.deepEqual(calls, [['has-session', '-t', `=pt_${id}`]]);
  } finally { release?.(); await h.close(); }
});

test('Delete API: delayed pre-delete reconciliation cannot recreate the removed row', async () => {
  let snapshot = '', release: (() => void) | undefined, delaySnapshot = false;
  const h = await harness('delete-reconcile', { tmux: async args => {
    if (args[0] === 'has-session') return missing();
    if (args[0] === 'list-panes') {
      const captured = snapshot;
      if (delaySnapshot) await new Promise<void>(resolve => { release = resolve; });
      return captured;
    }
    return '';
  } });
  try {
    await h.login(); seed(h); snapshot = `pt_${id}\t0\t${h.config.defaultCwd}\n`; delaySnapshot = true;
    const reconciling = h.service.sessions.reconcile(); await until(() => !!release);
    assert.equal((await h.api('DELETE', `/api/sessions/${id}`, { confirm: id })).statusCode, 200);
    snapshot = ''; delaySnapshot = false; release!(); await reconciling;
    assert.throws(() => h.service.sessions.get(id), /session_not_found/);
    assert.deepEqual((await h.api('GET', '/api/sessions')).json().sessions, []);
    assert.equal(h.service.sessions.stats().reservations, 0);
  } finally { release?.(); await h.close(); }
});

test('Delete API: conditional SQL retains a row whose stopped state changes during the absence probe', async () => {
  let release: (() => void) | undefined;
  const h = await harness('delete-conditional', { tmux: async args => {
    if (args[0] === 'has-session') { await new Promise<void>(resolve => { release = resolve; }); return missing(); }
    return '';
  } });
  try {
    await h.login(); seed(h);
    const deleting = h.api('DELETE', `/api/sessions/${id}`, { confirm: id }); await until(() => !!release);
    h.service.store.db.prepare("UPDATE terminals SET state='running' WHERE id=?").run(id);
    release!(); const response = await deleting;
    assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'session_not_stopped');
    assert.equal(h.service.sessions.get(id).state, 'running'); assert.equal(h.service.sessions.stats().reservations, 0);
  } finally { release?.(); await h.close(); }
});
