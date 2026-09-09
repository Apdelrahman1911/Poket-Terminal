import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until } from './helpers.js';
import { Sessions } from '../src/server/sessions.js';
import { ACTIVITY_OPTION, ACTIVITY_VERSION } from '../src/server/status.js';
import { CODEX_ARGS } from '../src/server/config.js';
import { boundedText } from '../src/client/snapshot.js';

test('Copy API: auth/CSRF/schema; bounded real prior history and active-window targeting without a PTY or stored transcript', async () => {
  const h = await harness('copy-api');
  try {
    const row = await h.service.sessions.create({ kind: 'shell' }), url = `/api/sessions/${row.id}/snapshot`, pane = `=${row.tmux_name}:0.0`;
    assert.equal((await h.api('POST', url, {})).statusCode, 401); await h.login();
    assert.equal((await h.api('POST', url, {}, { 'x-csrf-token': '' })).statusCode, 403);
    assert.equal((await h.api('POST', url, {}, { origin: 'https://invalid.example' })).statusCode, 403);
    assert.equal((await h.api('POST', url, { lines: 9000 })).statusCode, 400);
    await h.service.sessions.tmux(['send-keys', '-t', pane, `python3 -c "for i in range(300): print('COPY_ROW_%03d 界🙂'%i)"`, 'Enter']);
    await until(async () => Number((await h.service.sessions.tmux(['display-message', '-p', '-t', pane, '#{history_size}'])).trim()) >= 250);
    const result = await h.api('POST', url, {}); assert.equal(result.statusCode, 200);
    const snapshot = result.json(); assert.match(snapshot.text, /COPY_ROW_299/); assert.match(snapshot.text, /COPY_ROW_150/);
    assert.doesNotMatch(snapshot.text, /COPY_ROW_000|\x1b|�/); assert.ok(Buffer.byteLength(snapshot.text) <= 65536); assert.ok(snapshot.text.split('\n').length <= 200);
    assert.equal(snapshot.truncated, true); assert.equal(h.service.bridges.stats().created, 0); assert.equal(h.service.sessions.stats().snapshots, 0);
    assert.doesNotMatch(JSON.stringify(h.service.sessions.list()), /COPY_ROW_/);
    await h.service.sessions.tmux(['new-window', '-t', `=${row.tmux_name}`, '--', '/bin/bash', '--noprofile', '--norc', '-i']);
    await h.service.sessions.tmux(['send-keys', '-t', `=${row.tmux_name}:1.0`, 'echo SECOND_ACTIVE_WINDOW', 'Enter']);
    await until(async () => (await h.api('POST', url, {})).json().text.includes('SECOND_ACTIVE_WINDOW'));
    assert.doesNotMatch((await h.api('POST', url, {})).json().text, /COPY_ROW_/);
    await h.service.sessions.stop(row.id); assert.equal((await h.api('POST', url, {})).statusCode, 409);
  } finally { await h.close(); }
});

test('Copy API: one capture/no queue, UTF-8 byte limit, failure and concurrent-stop cleanup', async () => {
  const id = 'c'.repeat(32); let release: (() => void) | undefined, fail = false, delayed = false;
  const h = await harness('copy-bounds', { tmux: async args => {
    if (args[0] === 'capture-pane') { if (delayed) await new Promise<void>(resolve => { release = resolve; }); if (fail) throw new Error('synthetic capture failure'); return '界🙂'.repeat(15000); }
    return '';
  } });
  try {
    await h.login(); h.service.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,NULL)').run(id, `pt_${id}`, 'Synthetic', 'shell', h.config.defaultCwd, 'running', Date.now(), Date.now());
    const capture = () => h.api('POST', `/api/sessions/${id}/snapshot`, {});
    let response = await capture(); assert.equal(response.statusCode, 200); assert.ok(Buffer.byteLength(response.json().text) <= 65536); assert.equal(response.json().truncated, true); assert.doesNotMatch(response.json().text, /�/);
    delayed = true; const pending = capture(); await until(() => !!release);
    assert.equal((await capture()).statusCode, 429); assert.equal(h.service.sessions.stats().snapshots, 1);
    await h.service.sessions.stop(id); release!(); assert.equal((await pending).statusCode, 409); assert.equal(h.service.sessions.stats().snapshots, 0);
    h.service.store.db.prepare("UPDATE terminals SET state='running' WHERE id=?").run(id); delayed = false; fail = true;
    assert.equal((await capture()).statusCode, 503); assert.equal(h.service.sessions.stats().snapshots, 0);
  } finally { release?.(); await h.close(); }
});

test('Catalog: native exact states, active-pane/window and current-Codex guards; never transfer raw titles or infer from liveness', async () => {
  const h = await harness('status-native');
  try {
    await h.login(); const row = await h.service.sessions.create({ kind: 'shell' }), pane = `=${row.tmux_name}:0.0`;
    const state = async () => (await h.api('GET', '/api/sessions?limit=20')).json().sessions.find((s: { id: string }) => s.id === row.id);
    const title = async (value: string) => h.service.sessions.tmux(['select-pane', '-t', pane, '-T', value]);
    await title('Ready'); assert.equal((await state()).activity, 'unavailable');
    await h.service.sessions.tmux(['set-option', '-p', '-t', pane, ACTIVITY_OPTION, ACTIVITY_VERSION]);
    assert.equal((await state()).activity, 'unavailable'); // stale title/marker + a shell is not Codex
    // Harmless process with an explicit synthetic argv0; NOT a Codex/model invocation.
    await h.service.sessions.tmux(['send-keys', '-t', pane, 'exec -a codex /bin/sleep 120', 'Enter']);
    await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', pane, '#{pane_current_command}'])).trim() === 'codex');
    for (const [value, expected] of [['Ready', 'ready'], ...[...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'].map(c => [c + ' Working', 'working']), ['⠋ Thinking', 'working'], ['[ . ] Action Required', 'awaiting_input'], ['[ ! ] Action Required', 'awaiting_input'], ['UNRECOGNIZED_PRIVATE_TITLE', 'unknown']]) {
      await title(value!); const result = await state(); assert.equal(result.activity, expected, value); assert.equal(result.lifecycle, 'running'); assert.ok(result.observedAt > 0); assert.equal(result.activitySource, 'codex_title');
      assert.doesNotMatch(JSON.stringify(result), /UNRECOGNIZED_PRIVATE_TITLE|pane_title|pane_current_command/);
    }
    await title('⠋ Working');
    await h.service.sessions.tmux(['new-window', '-t', `=${row.tmux_name}`, '--', '/bin/bash', '--noprofile', '--norc', '-i']);
    assert.equal((await state()).activity, 'unavailable');
    await h.service.sessions.tmux(['select-window', '-t', `=${row.tmux_name}:0`]); assert.equal((await state()).activity, 'working');
    const other = (await h.service.sessions.tmux(['split-window', '-P', '-F', '#{pane_id}', '-t', pane, '--', '/bin/bash', '--noprofile', '--norc', '-i'])).trim();
    assert.equal((await state()).activity, 'unavailable');
    await h.service.sessions.tmux(['select-pane', '-t', pane]); assert.equal((await state()).activity, 'working');
    await h.service.sessions.tmux(['respawn-pane', '-k', '-t', pane, '--', '/bin/bash', '--noprofile', '--norc', '-i']); await title('Ready');
    assert.equal((await state()).activity, 'unavailable'); await h.service.sessions.tmux(['has-session', '-t', `=${row.tmux_name}`]);
    assert.ok(other.startsWith('%')); assert.equal(h.service.bridges.stats().created, 0);
  } finally { await h.close(); }
});

test('Catalog: starting/stopping/failed-start/uncertain/stale inventory and deletion use guarded lifecycle metadata', async () => {
  const h = await harness('status-transitions');
  let release: (() => void) | undefined;
  try {
    let phase = 'start', native = '', delayList = false, errorList = false, delayedList: (() => void) | undefined;
    const manager = new Sessions(h.service.store, h.config, async args => {
      if (args[0] === 'new-session') { if (phase === 'fail') throw new Error('synthetic failed start'); await new Promise<void>(resolve => { release = resolve; }); }
      if (args[0] === 'kill-session' && phase === 'stop') await new Promise<void>(resolve => { release = resolve; });
      if (args[0] === 'has-session') throw Object.assign(new Error('synthetic missing'), { stderr: "can't find session" });
      if (args[0] === 'list-panes') { const captured = native; if (delayList) await new Promise<void>(resolve => { delayedList = resolve; }); if (errorList) throw new Error('synthetic unavailable'); return captured; }
      return '';
    });
    const creating = manager.create({ kind: 'shell' }); await until(() => !!release);
    const row = manager.list()[0]!; assert.equal(manager.describe(row).lifecycle, 'starting'); assert.equal(manager.stats().managedRunning, 1);
    release!(); await creating; assert.equal(manager.describe(manager.get(row.id)).lifecycle, 'running');
    native = `${row.tmux_name}\t0\t${row.cwd}\tworking\t\t\n`; await manager.reconcile(); assert.equal(manager.describe(manager.get(row.id)).activity, 'working');
    errorList = true; await assert.rejects(manager.reconcile()); assert.equal(manager.describe(manager.get(row.id)).activity, 'unavailable'); errorList = false;
    phase = 'stop'; release = undefined; const stopping = manager.stop(row.id); await until(() => !!release);
    assert.equal(manager.describe(manager.get(row.id)).lifecycle, 'stopping'); await manager.reconcile(); release!(); await stopping;
    assert.equal(manager.describe(manager.get(row.id)).lifecycle, 'stopped'); assert.equal(manager.stats().managedRunning, 0);
    delayList = true; const old = manager.reconcile(); await until(() => !!delayedList); await manager.deleteStopped(row.id); native = ''; delayList = false; delayedList!(); await old;
    assert.throws(() => manager.get(row.id), /session_not_found/); assert.equal(manager.stats().activityRecords, 0);
    phase = 'fail'; await assert.rejects(manager.create({ kind: 'shell' }), /spawn_failed/);
    const failure = manager.list()[0]!; assert.equal(failure.state, 'stopped'); assert.equal(failure.stopped_reason, 'start_failed'); assert.equal(manager.describe(failure).lifecycle, 'error'); assert.equal(manager.stats().managedRunning, 0);
    h.service.store.db.prepare("UPDATE terminals SET state='running',stopped_reason='spawn_uncertain' WHERE id=?").run(failure.id);
    assert.equal(manager.describe(manager.get(failure.id)).lifecycle, 'unknown');
    assert.ok(CODEX_ARGS.includes('tui.terminal_title=["activity","status"]'));
    assert.equal(CODEX_ARGS.includes('--dangerously-bypass-hook-trust'), false);
  } finally { release?.(); await h.close(); }
});

test('Catalog: verified native nonzero/zero exits, missing jobs and paginated selected metadata, no output', async () => {
  const h = await harness('status-exits');
  try {
    await h.login();
    for (const code of [7, 0]) {
      const row = await h.service.sessions.create({ kind: 'shell' }), pane = `=${row.tmux_name}:0.0`;
      await h.service.sessions.tmux(['send-keys', '-t', pane, `exit ${code}`, 'Enter']);
      await until(async () => (await h.service.sessions.tmux(['display-message', '-p', '-t', pane, '#{pane_dead}'])).trim() === '1');
      await h.service.sessions.reconcile(); const result = h.service.sessions.describe(h.service.sessions.get(row.id));
      assert.equal(result.lifecycle, code ? 'error' : 'exited'); assert.equal(result.activity, 'unavailable');
    }
    const missing = await h.service.sessions.create({ kind: 'shell' }); await h.service.sessions.tmux(['kill-session', '-t', `=${missing.tmux_name}`]);
    await h.service.sessions.reconcile(); assert.equal(h.service.sessions.get(missing.id).stopped_reason, 'job_missing_or_reboot');
    const keep = await h.service.sessions.create({ kind: 'shell' });
    for (let i = 0; i < 25; i++) h.service.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,?)').run(i.toString(16).padStart(32, '0'), 'pt_' + i.toString(16).padStart(32, '0'), 'Old synthetic entry', 'shell', h.config.defaultCwd, 'stopped', i, i, 'owner_stopped');
    const response = await h.api('GET', `/api/sessions?limit=20&offset=20&selected=${keep.id}`);
    assert.equal(response.statusCode, 200); assert.ok(response.json().sessions.length <= 20); assert.equal(response.json().selectedSession.id, keep.id); assert.equal(response.json().runningCount, 1);
    assert.equal(response.json().nextOffset, null); assert.equal(h.service.bridges.stats().created, 0);
  } finally { await h.close(); }
});

test('Copy visible helper: character/UTF-8/line caps preserve whole Unicode without a transcript buffer', () => {
  for (const text of ['界🙂'.repeat(40000), 'x'.repeat(65535) + '🙂', 'line\n'.repeat(600)]) {
    const snapshot = boundedText(text, 'visible'); assert.ok(snapshot.text.length <= 65536); assert.ok(Buffer.byteLength(snapshot.text) <= 65536); assert.ok(snapshot.text.split('\n').length <= 200); assert.equal(snapshot.truncated, true); assert.doesNotMatch(snapshot.text, /�/);
  }
});
