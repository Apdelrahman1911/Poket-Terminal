import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Store } from './db.js';
import { CODEX_ARGS, Config, LIMITS } from './config.js';
import { assertValue, HttpError } from './errors.js';
import { ACTIVITY_FORMAT, ACTIVITY_OPTION, ACTIVITY_VERSION, Activity, activity } from './status.js';
import { CODEX_THREAD_ID, CodexControl, codexControl } from './codex-control.js';
const exec = promisify(execFile);
export interface TerminalRow {
  id: string; tmux_name: string; label: string; kind: 'codex' | 'shell'; cwd: string;
  state: 'starting' | 'running' | 'stopped'; created_at: number; updated_at: number; stopped_reason: string | null;
}
export type TmuxRunner = (args: string[]) => Promise<string>;
const idPattern = /^[a-f0-9]{32}$/;
export class Sessions {
  readonly tmux: TmuxRunner;
  private busy = new Map<string, 'starting' | 'stopping' | 'deleting' | 'restarting'>();
  private restarting = false;
  private codex: CodexControl;
  private activities = new Map<string, Activity>();
  private observedAt = 0;
  private snapshots = 0;
  private reconciling?: Promise<void>;
  private stopped = false;
  private mutations = 0;
  constructor(readonly store: Store, readonly config: Config, runner?: TmuxRunner, codex?: CodexControl) {
    this.codex = codex || codexControl(config.root);
    this.tmux = runner || (async args => {
      const { stdout } = await exec('tmux', ['-L', config.tmuxSocket, ...args], { timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, TMUX: '', LC_ALL: 'C.UTF-8' } });
      return stdout;
    });
  }
  async initialize() {
    const configPath = path.join(this.config.dataDir, 'tmux.conf');
    fs.writeFileSync(configPath, `set -g history-limit ${LIMITS.history}\nset -g status off\nset -g prefix C-b\nset -g mouse on\nset -g destroy-unattached off\nset -s exit-empty off\nset -g remain-on-exit on\nset -g update-environment ''\nset -s escape-time 10\n`, { mode: 0o600 });
    await this.tmux(['-f', configPath, 'start-server']);
    await this.reconcile();
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const previous = this.store.db.prepare("SELECT value FROM metadata WHERE key='boot_id'").get() as { value: string } | undefined;
    if (previous && previous.value !== bootId) this.store.db.prepare("UPDATE terminals SET state='stopped',stopped_reason='host_reboot',updated_at=? WHERE state<>'stopped'").run(Date.now());
    this.store.db.prepare("INSERT INTO metadata VALUES('boot_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(bootId);
  }
  get(id: string) {
    assertValue(idPattern.test(id), 400, 'invalid_id');
    const row = this.store.db.prepare('SELECT * FROM terminals WHERE id=?').get(id) as TerminalRow | undefined;
    assertValue(row, 404, 'session_not_found');
    return row;
  }
  inputReady(id: string) {
    assertValue(!this.stopped, 503, 'shutting_down');
    const row = this.get(id);
    assertValue(row.state === 'running' && !row.stopped_reason && !this.busy.has(id), 409, 'session_not_running_or_busy');
    return row;
  }
  list(limit = 100, offset = 0) {
    assertValue(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0 && offset <= 200, 400, 'invalid_pagination');
    return this.store.db.prepare("SELECT * FROM terminals ORDER BY state='stopped',created_at DESC,id LIMIT ? OFFSET ?").all(limit, offset) as unknown as TerminalRow[];
  }
  describe(row: TerminalRow) {
    const operation = this.busy.get(row.id), reason = row.stopped_reason;
    const lifecycle = operation === 'restarting' ? 'starting' : operation === 'stopping' ? 'stopping' : row.state === 'starting' ? 'starting'
      : row.state === 'running' ? reason === 'spawn_uncertain' ? 'unknown' : 'running'
      : reason === 'start_failed' || reason === 'codex_restart_failed' || reason?.startsWith('job_exit_') || reason?.startsWith('job_signal_') ? 'error' : reason === 'job_exited' ? 'exited' : 'stopped';
    const native = lifecycle === 'running' && Date.now() - this.observedAt < 10000 ? this.activities.get(row.id) : undefined;
    return { lifecycle, activity: native || 'unavailable', activitySource: native && native !== 'unavailable' ? 'codex_title' : 'unavailable', observedAt: this.observedAt,
      codexResumeAvailable: row.kind === 'codex' && !!this.resumeId(row.id) };
  }
  private resumeId(id: string) {
    const record = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('codex_resume:' + id) as { value: string } | undefined;
    return record && CODEX_THREAD_ID.test(record.value) ? record.value : undefined;
  }
  private async onlyPane(row: TerminalRow) {
    const lines = (await this.tmux(['list-panes', '-s', '-t', `=${row.tmux_name}`, '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}'])).trim().split('\n');
    assertValue(lines.length === 1, 409, 'codex_requires_single_pane');
    const fields = lines[0]!.split('\t'), [name, pane, pid, dead] = fields;
    assertValue(fields.length === 4 && name === row.tmux_name && /^%\d+$/.test(pane || '')
      && /^[1-9]\d{0,9}$/.test(pid || '') && (dead === '0' || dead === '1'), 409, 'codex_target_changed');
    return { pane: pane!, pid: Number(pid), dead: dead === '1' };
  }
  async restartCodex(id: string, expectedUpdatedAt: number, guard: () => void, detach: () => Promise<void>) {
    assertValue(!this.stopped, 503, 'shutting_down');
    const row = this.get(id);
    assertValue(row.kind === 'codex', 409, 'codex_only');
    assertValue(!this.busy.has(id) && !this.restarting, 409, 'codex_restart_busy');
    assertValue(row.updated_at === expectedUpdatedAt, 409, 'session_changed_refresh');
    assertValue(row.state === 'stopped' || (row.state === 'running' && !row.stopped_reason), 409, 'session_not_running_or_busy');
    this.busy.set(id, 'restarting'); this.restarting = true; this.mutations++;
    let reserved = false, spawnAttempted = false;
    try {
      // No side effects until the exact saved main conversation is known.
      const cwd = await this.validateCwd(row.cwd);
      const pane = row.state === 'running' || await this.exists(row.tmux_name) ? await this.onlyPane(row) : undefined;
      assertValue(row.state === 'running' ? pane && !pane.dead : !pane || pane.dead, 409, 'codex_target_changed');
      const identity = row.state === 'running' ? await this.codex.inspect(pane!.pid, cwd) : undefined;
      const threadId = identity?.threadId || this.resumeId(id);
      assertValue(threadId && CODEX_THREAD_ID.test(threadId), 409, 'codex_history_unavailable');
      guard();
      this.store.transaction(() => {
        if (row.state === 'stopped') {
          const n = Number(this.store.db.prepare("SELECT count(*) n FROM terminals WHERE state IN ('starting','running')").get()!.n);
          assertValue(n < LIMITS.sessions, 409, 'session_limit');
        }
        // Existing schema-v1 metadata: one UUID, no transcript, credentials,
        // serialized CLI config, or schema migration. Stale requests cannot
        // restart the newly resumed process again after the first call finishes.
        this.store.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('codex_resume:' + id, threadId);
        this.store.db.prepare("UPDATE terminals SET state='starting',stopped_reason=NULL,updated_at=? WHERE id=?").run(Math.max(Date.now(), row.updated_at + 1), id);
      });
      reserved = true; this.activities.delete(id);
      await detach(); guard();
      if (identity) {
        const current = await this.onlyPane(row);
        assertValue(current.pane === pane!.pane && current.pid === pane!.pid && !current.dead, 409, 'codex_target_changed');
        guard(); await this.codex.exit(identity, cwd, { socket: this.config.tmuxSocket, pane: pane!.pane, sessionName: row.tmux_name });
        const deadline = Date.now() + 2000;
        while (true) {
          const current = await this.onlyPane(row);
          assertValue(current.pane === pane!.pane && current.pid === pane!.pid, 409, 'codex_target_changed');
          if (current.dead) break;
          assertValue(Date.now() < deadline, 409, 'codex_exit_timeout');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      guard(); assertValue(!this.stopped, 503, 'shutting_down');
      // Explicit UUID only: --last could resume someone else's managed chat in
      // the same directory. No prompt, auto-continue, shell string, or replay.
      const program = ['codex', 'resume', threadId, ...(this.config.codexArgs ?? CODEX_ARGS), '--cd', cwd];
      spawnAttempted = true;
      if (pane) {
        const current = await this.onlyPane(row);
        assertValue(current.pane === pane.pane && current.pid === pane.pid && current.dead, 409, 'codex_target_changed');
        guard();
        // No -k: tmux itself refuses to replace a live/replaced pane.
        await this.tmux(['respawn-pane', '-t', pane.pane, '-c', cwd, '-e', 'PT_SESSION_ID=' + id, '--', ...program]);
      } else {
        await this.tmux(['new-session', '-d', '-s', row.tmux_name, '-c', cwd, '-x', '100', '-y', '30', '-e', 'PT_SESSION_ID=' + id, '--', ...program]);
        await this.tmux(['set-window-option', '-t', `=${row.tmux_name}:0`, 'window-size', 'manual']);
      }
      const next = await this.onlyPane(row);
      await this.tmux(['set-option', '-p', '-t', next.pane, ACTIVITY_OPTION, ACTIVITY_VERSION]);
      this.store.db.prepare("UPDATE terminals SET state='running',stopped_reason=NULL,updated_at=? WHERE id=?").run(Math.max(Date.now(), row.updated_at + 2), id);
      return this.get(id);
    } catch (error) {
      if (reserved) {
        // An uncertain command may already have started the new CLI. Retain its
        // reservation and NEVER retry/kill it automatically. Saved UUID remains
        // available for a deliberate Resume after a confirmed failure/exit.
        let state = 'running', reason: string | null = 'spawn_uncertain';
        try {
          if (!await this.exists(row.tmux_name) || (await this.onlyPane(row)).dead) { state = 'stopped'; reason = 'codex_restart_failed'; }
          else if (!spawnAttempted) reason = null;
        } catch { /* fail closed while tmux state is uncertain */ }
        this.store.db.prepare('UPDATE terminals SET state=?,stopped_reason=?,updated_at=? WHERE id=?').run(state, reason, Math.max(Date.now(), row.updated_at + 2), id);
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'codex_restart_uncertain');
    } finally { this.busy.delete(id); this.restarting = false; this.mutations++; }
  }
  async snapshot(id: string) {
    assertValue(!this.stopped, 503, 'shutting_down');
    const row = this.get(id);
    assertValue(row.state === 'running' && !this.busy.has(id), 409, 'session_not_running');
    // One ephemeral capture globally, no pending queue, no transcript persistence.
    assertValue(this.snapshots === 0, 429, 'snapshot_busy');
    this.snapshots++;
    try {
      let captured: string;
      try { captured = await this.tmux(['capture-pane', '-p', '-t', `=${row.tmux_name}:`, '-S', '-199']); }
      catch { throw new HttpError(503, 'snapshot_unavailable_or_too_large'); }
      assertValue(this.get(id).state === 'running' && !this.busy.has(id), 409, 'session_not_running');
      // Native subprocess output is capped at128KiB/5s. Return only the most recent
      // 200 physical lines and64KiB, on UTF-8 boundaries, without ANSI escapes.
      const lines = captured.replace(/\n$/, '').split('\n'), text = lines.slice(-200).join('\n');
      const bytes = Buffer.from(text), max = 64 * 1024;
      let start = Math.max(0, bytes.length - max);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      return { text: bytes.subarray(start).toString('utf8'), truncated: lines.length > 200 || start > 0, source: 'recent', maxLines: 200, maxBytes: max };
    } finally { this.snapshots--; }
  }
  projects() {
    return fs.readdirSync(this.config.projectRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).slice(0, 100).map(e => ({ name: e.name.slice(0, 80), path: path.join(this.config.projectRoot, e.name) })).filter(e => !/[\x00-\x1f\x7f]/.test(e.path));
  }
  async validateCwd(cwd: unknown) {
    assertValue(typeof cwd === 'string' && cwd.length <= 4096 && !/[\x00-\x1f\x7f]/.test(cwd), 400, 'invalid_cwd');
    let actual: string;
    try { actual = await fs.promises.realpath(cwd); } catch { throw new HttpError(400, 'invalid_cwd'); }
    // v1 offers existing direct project directories only, not arbitrary device/system paths or symlinks outside the project root.
    const root = await fs.promises.realpath(this.config.projectRoot);
    assertValue(path.dirname(actual) === root && (await fs.promises.stat(actual)).isDirectory(), 400, 'invalid_cwd');
    return actual;
  }
  label(value: unknown) {
    assertValue(typeof value === 'string' && value.trim().length > 0 && [...value].length <= 80 && Buffer.byteLength(value) <= 320 && !/[\x00-\x1f\x7f]/.test(value), 400, 'invalid_label');
    return value.trim();
  }
  async create(input: { kind?: unknown; cwd?: unknown; label?: unknown }, guard?: () => void) {
    assertValue(!this.stopped, 503, 'shutting_down');
    const kind = input.kind ?? 'codex';
    assertValue(kind === 'codex' || kind === 'shell', 400, 'invalid_kind');
    const cwd = await this.validateCwd(input.cwd ?? this.config.defaultCwd);
    guard?.();
    const label = this.label(input.label ?? (kind === 'codex' ? 'Codex' : 'Shell'));
    const id = randomBytes(16).toString('hex'), name = `pt_${id}`, now = Date.now();
    this.store.transaction(() => {
      const n = Number((this.store.db.prepare("SELECT count(*) n FROM terminals WHERE state IN ('starting','running')").get() as { n: number }).n);
      assertValue(n < LIMITS.sessions, 409, 'session_limit');
      this.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,NULL)').run(id, name, label, kind, cwd, 'starting', now, now);
    });
    this.busy.set(id, 'starting'); this.mutations++;
    try {
      const program = kind === 'codex' ? ['codex', ...(this.config.codexArgs ?? CODEX_ARGS)] : [this.config.shell, '--noprofile', '--norc', '-i'];
      await this.tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '100', '-y', '30', '-e', 'PT_SESSION_ID=' + id, '--', ...program]);
      // tmux 3.4 crashes creating its first window with a global manual default. Set it on the existing window only.
      await this.tmux(['set-window-option', '-t', `=${name}:0`, 'window-size', 'manual']);
      if (kind === 'codex') await this.tmux(['set-option', '-p', '-t', `=${name}:0.0`, ACTIVITY_OPTION, ACTIVITY_VERSION]);
      this.store.db.prepare("UPDATE terminals SET state='running',updated_at=? WHERE id=?").run(Date.now(), id);
      this.prune();
      return this.get(id);
    } catch {
      // A timed-out spawn may already have created the named session. Kill only this reservation before rollback.
      let exists: boolean;
      try { exists = await this.exists(name); } catch {
        // Unknown tmux state must keep consuming its reservation; never admit a 21st job.
        throw new HttpError(503, 'spawn_uncertain_reservation_retained');
      }
      if (exists) {
        try { await this.tmux(['kill-session', '-t', `=${name}`]); }
        catch {
          this.store.db.prepare("UPDATE terminals SET state='running',stopped_reason='spawn_uncertain',updated_at=? WHERE id=?").run(Date.now(), id);
          throw new HttpError(503, 'spawn_uncertain_reservation_retained');
        }
      }
      this.store.db.prepare("UPDATE terminals SET state='stopped',stopped_reason='start_failed',updated_at=? WHERE id=?").run(Date.now(), id);
      this.prune();
      throw new HttpError(503, 'spawn_failed');
    } finally { this.busy.delete(id); this.mutations++; }
  }
  rename(id: string, label: unknown) {
    this.get(id);
    this.store.db.prepare('UPDATE terminals SET label=?,updated_at=? WHERE id=?').run(this.label(label), Date.now(), id);
    return this.get(id);
  }
  async stop(id: string) {
    const row = this.get(id);
    assertValue(!this.busy.has(id), 409, 'session_busy');
    this.busy.set(id, 'stopping'); this.mutations++;
    try {
      try { await this.tmux(['kill-session', '-t', `=${row.tmux_name}`]); }
      catch {
        let live: boolean;
        try { live = await this.exists(row.tmux_name); } catch { throw new HttpError(503, 'stop_state_uncertain'); }
        assertValue(!live, 503, 'stop_failed');
      }
      this.store.db.prepare("UPDATE terminals SET state='stopped',stopped_reason='owner_stopped',updated_at=? WHERE id=?").run(Date.now(), id);
      this.activities.delete(id);
      return this.get(id);
    } finally { this.busy.delete(id); this.mutations++; }
  }
  async deleteStopped(id: string, guard?: () => void) {
    assertValue(!this.stopped, 503, 'shutting_down');
    const row = this.get(id);
    assertValue(!this.busy.has(id), 409, 'session_busy');
    assertValue(row.state === 'stopped', 409, 'session_not_stopped');
    this.busy.set(id, 'deleting'); this.mutations++;
    try {
      let exists: boolean;
      try { exists = await this.exists(row.tmux_name); } catch { throw new HttpError(503, 'delete_state_uncertain'); }
      assertValue(!exists, 409, 'session_still_exists');
      guard?.();
      // Metadata only: never signal tmux or touch the project/Codex history.
      const result = this.store.db.prepare("DELETE FROM terminals WHERE id=? AND state='stopped'").run(id);
      assertValue(result.changes === 1, 409, 'session_not_stopped');
      this.store.db.prepare('DELETE FROM metadata WHERE key=?').run('codex_resume:' + id);
      this.activities.delete(id);
    } finally { this.busy.delete(id); this.mutations++; }
  }
  async reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async exists(name: string): Promise<boolean> {
    try { await this.tmux(['has-session', '-t', `=${name}`]); return true; }
    catch (error) {
      if (/can't find session|no server running|no sessions|no current target|No such file/.test((error as { stderr?: string }).stderr || '')) return false;
      throw error;
    }
  }
  private async doReconcile() {
    if (this.busy.size) return;
    const generation = this.mutations;
    let output: string;
    try { output = await this.tmux(['list-panes', '-a', '-F', `#{session_name}\t#{pane_dead}\t#{pane_current_path}\t${ACTIVITY_FORMAT}\t#{pane_dead_status}\t#{pane_dead_signal}`]); }
    catch (e) {
      const stderr = (e as { stderr?: string }).stderr || '';
      if (!/no server running|no sessions|no current target|No such file/.test(stderr)) { this.observedAt = 0; this.activities.clear(); throw e; }
      output = '';
    }
    // The tmux snapshot is stale if a create/stop/delete began or finished while it was being read.
    if (generation !== this.mutations || this.busy.size) return;
    const live = new Map<string, string>();
    const dead = new Map<string, string>();
    const activities = new Map<string, Activity>();
    for (const line of output.trim().split('\n')) {
      const [name, exited, cwd, native, exitStatus, exitSignal] = line.split('\t');
      if (!name || !/^pt_[a-f0-9]{32}$/.test(name)) continue;
      if (exited === '1') {
        const error = exitStatus && /^[1-9]\d{0,2}$/.test(exitStatus) ? `job_exit_${exitStatus}`
          : exitSignal && /^[A-Z0-9]{1,16}$/.test(exitSignal) ? `job_signal_${exitSignal}` : undefined;
        dead.set(name, error || dead.get(name) || 'job_exited');
      } else {
        live.set(name, cwd || this.config.defaultCwd);
        if (native !== 'unavailable' && activities.size < LIMITS.sessions) activities.set(name.slice(3), activity(native));
      }
    }
    // A dead pane is not a dead session: standard tmux key bindings can create other live windows/panes.
    for (const name of live.keys()) dead.delete(name);
    // A crash between tmux spawn and DB update is adopted. Missing jobs are stopped, never relaunched.
    this.store.transaction(() => {
      const rows = this.store.db.prepare('SELECT * FROM terminals').all() as unknown as TerminalRow[];
      const known = new Set(rows.map(row => row.tmux_name));
      for (const row of rows) {
        if (this.busy.has(row.id)) continue;
        if (live.has(row.tmux_name)) this.store.db.prepare("UPDATE terminals SET state='running',stopped_reason=NULL WHERE id=?").run(row.id);
        else if (row.state !== 'stopped') this.store.db.prepare("UPDATE terminals SET state='stopped',stopped_reason=?,updated_at=? WHERE id=?").run(dead.get(row.tmux_name) || 'job_missing_or_reboot', Date.now(), row.id);
      }
      for (const [name, cwd] of live) if (!known.has(name)) {
        this.store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,NULL)').run(name.slice(3), name, 'Recovered session', 'shell', cwd.slice(0, 4096), 'running', Date.now(), Date.now());
      }
    });
    this.activities = activities; this.observedAt = Date.now();
    for (const name of dead.keys()) {
      if (!this.busy.has(name.slice(3))) { try { await this.tmux(['kill-session', '-t', `=${name}`]); } catch { /* next reconciliation retries */ } }
    }
    this.prune();
  }
  private prune() {
    this.store.db.exec("DELETE FROM terminals WHERE state='stopped' AND id IN (SELECT id FROM terminals ORDER BY created_at DESC,id LIMIT -1 OFFSET 180)");
    this.store.db.exec("DELETE FROM metadata WHERE key GLOB 'codex_resume:*' AND substr(key,14) NOT IN (SELECT id FROM terminals)");
  }
  async shutdown() {
    this.stopped = true;
    while (this.busy.size || this.snapshots) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.reconciling) await this.reconciling;
  }
  stats() { return { reservations: this.busy.size, codexRestarts: Number(this.restarting), snapshots: this.snapshots, activityRecords: this.activities.size, managedRunning: Number((this.store.db.prepare("SELECT count(*) n FROM terminals WHERE state IN ('starting','running')").get() as { n: number }).n) }; }
}
