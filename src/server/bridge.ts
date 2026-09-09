import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { Auth, cookieToken, csrfFor, equal } from './auth.js';
import { Config, LIMITS } from './config.js';
import { Sessions, TerminalRow } from './sessions.js';
import { assertValue } from './errors.js';
import { InputTarget, NativeAction, NativeInput, NativeRunner } from './native-input.js';

interface Connection {
  id: string; ws: WebSocket; raw: string; session: TerminalRow; terminal?: pty.IPty;
  exitSubscription?: { dispose(): void };
  subscriptions: { dispose(): void }[]; sent: number; acked: number; progressAt: number;
  paused: boolean; done: boolean; closedAt: number; pongAt: number;
  rateAt: number; messages: number; inputBytes: number; controlAt: number;
  input?: Buffer; inputOffset: number; inputStarted: number; inputTimer?: NodeJS.Timeout;
  resize?: { cols: number; rows: number }; resizing: boolean;
}
export function requestOriginAllowed(req: Pick<IncomingMessage, 'headers'>, origin: string, requireOrigin = false) {
  const expected = new URL(origin);
  if (req.headers.host !== expected.host) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  if (requireOrigin && req.headers.origin !== origin) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
export class Bridges {
  readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: LIMITS.inbound,
    handleProtocols: protocols => protocols.has('pocketterminal.v1') ? 'pocketterminal.v1' : false });
  private connections = new Map<string, Connection>();
  // Own native attachments until onExit confirms both child reaping and PTY read-stream closure.
  // A closed WebSocket is NOT evidence that a paused tmux attachment has exited.
  private nativePtys = new Map<string, Connection>();
  private controllers = new Map<string, string>();
  private controlRevisions = new Map<string, string>();
  private resizeJobs = new Map<string, { pending?: { c: Connection; cols: number; rows: number }; done: Promise<void> }>();
  private historyJobs = new Map<string, Promise<void>>();
  private nativeInput: NativeInput;
  private telegramJob?: { id: string; abort: AbortController; done: Promise<void>; next?: Connection };
  private timer: NodeJS.Timeout;
  private closing = false;
  private shutdown?: Promise<void>;
  private ticks = 0;
  private created = 0;
  private disposed = 0;
  private peakOutstanding = 0;
  private peakTransport = 0;
  private reasons: Record<string, number> = {};
  constructor(readonly auth: Auth, readonly sessions: Sessions, readonly config: Config, nativeRunner?: NativeRunner) {
    this.nativeInput = new NativeInput(sessions, nativeRunner);
    this.timer = setInterval(() => this.sweep(), LIMITS.heartbeatMs);
    this.timer.unref();
  }
  upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const deny = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (this.closing || !requestOriginAllowed(req, this.config.origin, true)) return deny(403);
    const match = /^\/api\/terminal\/([a-f0-9]{32})$/.exec(req.url || '');
    if (!match) return deny(404);
    const raw = cookieToken(req.headers.cookie);
    if (!raw || !this.auth.authenticate(raw)) return deny(401);
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    if (protocols.length !== 2 || protocols[0] !== 'pocketterminal.v1' || !equal(protocols[1] || '', `csrf.${csrfFor(raw)}`)) return deny(403);
    if (this.connections.size >= LIMITS.attachments || this.nativePtys.size >= LIMITS.attachments) return deny(429);
    let session: TerminalRow;
    try { session = this.sessions.get(match[1]!); } catch { return deny(404); }
    if (session.state !== 'running') return deny(409);
    // No async gap between cap check, authorization and allocation.
    this.wss.handleUpgrade(req, socket, head, ws => {
      const now = Date.now();
      const c: Connection = { id: randomBytes(8).toString('hex'), ws, raw, session, subscriptions: [], sent: 0, acked: 0,
        progressAt: now, paused: false, done: false, closedAt: 0, pongAt: now, rateAt: now,
        messages: 0, inputBytes: 0, controlAt: 0, inputOffset: 0, inputStarted: 0, resizing: false };
      this.connections.set(c.id, c);
      ws.on('error', () => this.detach(c, 'transport_error'));
      ws.on('close', () => { this.detach(c, 'client_closed'); this.connections.delete(c.id); });
      ws.on('pong', () => { c.pongAt = Date.now(); });
      ws.on('message', (data, binary) => this.message(c, data, binary));
      try {
        // -f/start-server does not reload config in a surviving tmux server. Apply
        // mouse routing to this exact managed session, including pre-update jobs.
        c.terminal = pty.spawn('tmux', ['-L', this.config.tmuxSocket, 'set-option', '-t', session.tmux_name, 'mouse', 'on', ';', 'attach-session', '-f', 'ignore-size', '-t', `=${session.tmux_name}`], {
          name: 'xterm-256color', cols: 100, rows: 30, cwd: this.config.dataDir,
          env: { ...process.env, TMUX: '', TERM: 'xterm-256color', LC_ALL: 'C.UTF-8' } as Record<string, string>, encoding: null,
        });
        this.nativePtys.set(c.id, c);
        this.created++;
        c.subscriptions.push(c.terminal.onData(data => this.output(c, Buffer.isBuffer(data) ? data : Buffer.from(data))));
        c.exitSubscription = c.terminal.onExit(() => {
          c.exitSubscription?.dispose(); c.exitSubscription = undefined;
          c.terminal = undefined; this.nativePtys.delete(c.id); this.disposed++;
          this.detach(c, 'terminal_detached');
        });
        if (!this.controllers.has(session.id)) this.changeController(session.id, c.id);
        this.controlState(session.id);
      } catch { this.detach(c, 'attach_failed'); }
    });
  };
  private send(c: Connection, payload: object) {
    if (c.done || c.ws.readyState !== WebSocket.OPEN) return;
    if (c.ws.bufferedAmount + 1024 > LIMITS.transport) return this.detach(c, 'transport_limit');
    c.ws.send(JSON.stringify(payload));
  }
  private output(c: Connection, data: Buffer) {
    if (c.done || !data.length) return;
    // node-pty's raw read chunk is transient. Nothing is cached for replay; a rejected chunk ends the attachment.
    if (c.sent - c.acked + data.byteLength > LIMITS.outstanding) return this.detach(c, 'output_limit_reconnect');
    if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount + data.byteLength + 512 > LIMITS.transport) return this.detach(c, 'transport_limit');
    if (c.sent === c.acked) c.progressAt = Date.now();
    for (let offset = 0; offset < data.length; offset += LIMITS.frame) {
      const frame = data.subarray(offset, offset + LIMITS.frame);
      c.sent += frame.byteLength;
      c.ws.send(frame, { binary: true, compress: false });
    }
    this.peakOutstanding = Math.max(this.peakOutstanding, c.sent - c.acked);
    this.peakTransport = Math.max(this.peakTransport, c.ws.bufferedAmount);
    if (c.sent - c.acked >= LIMITS.outstanding / 2 && !c.paused) { c.paused = true; c.terminal?.pause(); }
  }
  private message(c: Connection, data: import('ws').RawData, binary: boolean) {
    if (c.done) return;
    if (!this.auth.authenticate(c.raw)) return this.detach(c, 'auth_revoked', 4001);
    if (binary || !Buffer.isBuffer(data) || data.length > LIMITS.inbound) return this.detach(c, 'invalid_frame');
    const now = Date.now();
    if (now - c.rateAt >= 1000) { c.rateAt = now; c.messages = 0; c.inputBytes = 0; }
    if (++c.messages > 256) return this.detach(c, 'message_rate');
    let m: Record<string, unknown>;
    try { m = JSON.parse(data.toString()); } catch { return this.detach(c, 'invalid_json'); }
    if (!m || Array.isArray(m) || typeof m !== 'object' || typeof m.type !== 'string') return this.detach(c, 'invalid_message');
    switch (m.type) {
      case 'ack': {
        if (Object.keys(m).length !== 2 || !Number.isSafeInteger(m.bytes) || (m.bytes as number) <= c.acked || (m.bytes as number) > c.sent) return this.detach(c, 'invalid_ack');
        c.acked = m.bytes as number; c.progressAt = now;
        if (c.paused && c.sent - c.acked <= LIMITS.outstanding / 4) { c.paused = false; c.terminal?.resume(); }
        break;
      }
      case 'input': {
        if (Object.keys(m).length !== 2 || typeof m.data !== 'string' || m.data.length > LIMITS.input || Buffer.byteLength(m.data) > LIMITS.input || !m.data.length) return this.detach(c, 'invalid_input');
        if (this.controllers.get(c.session.id) !== c.id) { this.send(c, { type: 'error', code: 'view_only' }); break; }
        c.inputBytes += Buffer.byteLength(m.data);
        if (c.input || c.inputBytes > LIMITS.inputPerSecond) return this.detach(c, 'input_backpressure');
        c.input = Buffer.from(m.data); c.inputOffset = 0; c.inputStarted = now;
        this.flushInput(c);
        break;
      }
      case 'resize': {
        if (Object.keys(m).length !== 3 || !Number.isInteger(m.cols) || !Number.isInteger(m.rows) || (m.cols as number) < 2 || (m.cols as number) > LIMITS.cols || (m.rows as number) < 2 || (m.rows as number) > LIMITS.rows) return this.detach(c, 'invalid_dimensions');
        try { c.terminal?.resize(m.cols as number, m.rows as number); } catch { return this.detach(c, 'resize_failed'); }
        if (this.controllers.get(c.session.id) === c.id) {
          c.resize = { cols: m.cols as number, rows: m.rows as number }; // replace, never append/chain
          void this.resize(c);
        }
        break;
      }
      case 'take_control': {
        if (Object.keys(m).length !== 1 || now - c.controlAt < 250) return this.detach(c, 'control_rate');
        c.controlAt = now;
        this.browserControl(c);
        break;
      }
      case 'exit_history': {
        if (Object.keys(m).length !== 1) return this.detach(c, 'invalid_history_message');
        if (this.controllers.get(c.session.id) !== c.id) { this.send(c, { type: 'error', code: 'view_only' }); break; }
        this.exitHistory(c);
        break;
      }
      default: this.detach(c, 'unknown_message');
    }
  }
  private flushInput(c: Connection) {
    c.inputTimer = undefined;
    if (c.done || !c.input || !c.terminal) return;
    if (this.controllers.get(c.session.id) !== c.id || Date.now() - c.inputStarted > 250) return this.detach(c, 'input_backpressure');
    try {
      // Linux node-pty exposes the nonblocking master fd. Do NOT use its unbounded CustomWriteStream queue.
      const fd = (c.terminal as pty.IPty & { fd: number }).fd;
      c.inputOffset += fs.writeSync(fd, c.input, c.inputOffset, c.input.length - c.inputOffset);
    } catch (e) {
      if (!['EAGAIN', 'EWOULDBLOCK'].includes((e as NodeJS.ErrnoException).code || '')) return this.detach(c, 'input_failed');
    }
    if (c.inputOffset === c.input.length) { c.input = undefined; this.send(c, { type: 'input_ack' }); }
    else c.inputTimer = setTimeout(() => this.flushInput(c), 10);
  }
  private async resize(c: Connection) {
    if (!c.resize || c.done) return;
    const next = { c, ...c.resize }; c.resize = undefined;
    const existing = this.resizeJobs.get(c.session.id);
    if (existing) { existing.pending = next; return; }
    const job: { pending?: typeof next; done: Promise<void> } = { pending: next, done: Promise.resolve() };
    this.resizeJobs.set(c.session.id, job);
    job.done = (async () => {
      try {
        while (job.pending && !this.closing) {
          const size = job.pending; job.pending = undefined;
          if (size.c.done || this.controllers.get(c.session.id) !== size.c.id) continue;
          await this.sessions.tmux(['resize-window', '-t', `=${c.session.tmux_name}:`, '-x', String(size.cols), '-y', String(size.rows), ';', 'set-option', '-t', c.session.tmux_name, 'default-size', `${size.cols}x${size.rows}`]);
        }
      } catch { this.detach(c, 'resize_failed'); }
      finally { this.resizeJobs.delete(c.session.id); }
    })();
    await job.done;
  }
  private exitHistory(c: Connection) {
    // One operation per session, a finite global cap, no pending/retry queue.
    if (this.historyJobs.has(c.session.id)) return;
    if (this.historyJobs.size >= LIMITS.attachments) { this.send(c, { type: 'error', code: 'history_exit_failed' }); return; }
    const job = (async () => {
      try {
        // -X addresses tmux copy-mode only. Never send Escape/q/arrow guesses to a shell/TUI.
        await this.sessions.tmux(['send-keys', '-X', '-t', `=${c.session.tmux_name}:`, 'cancel']);
      } catch (error) {
        if (!/not in a mode/.test((error as { stderr?: string }).stderr || '')) this.send(c, { type: 'error', code: 'history_exit_failed' });
      } finally { this.historyJobs.delete(c.session.id); }
    })();
    this.historyJobs.set(c.session.id, job);
  }
  private controlState(sessionId: string) {
    for (const c of this.connections.values()) if (!c.done && c.session.id === sessionId) this.send(c, { type: 'control', controller: this.controllers.get(sessionId) === c.id, connectionId: c.id, owner: this.controller(sessionId).kind });
  }
  controller(id: string) {
    const owner = this.controllers.get(id) || '';
    const stamp = owner && !owner.startsWith('tg:') ? `browser:${this.controlRevisions.get(id)}:${owner}` : owner;
    return { kind: owner.startsWith('tg:') ? 'telegram' : owner ? 'browser' : 'none', stamp } as const;
  }
  private changeController(id: string, next?: string) {
    const old = this.controllers.get(id);
    if (next) this.controllers.set(id, next); else this.controllers.delete(id);
    if (old !== next) {
      if (next) this.controlRevisions.set(id, randomBytes(8).toString('hex')); else this.controlRevisions.delete(id);
      const c = old ? this.connections.get(old) : undefined;
      if (c) {
        const partial = c.input && c.inputOffset > 0;
        if (c.inputTimer) clearTimeout(c.inputTimer); c.inputTimer = undefined;
        c.input = undefined; c.resize = undefined;
        if (partial) this.detach(c, 'input_control_changed_no_replay');
      }
      const resize = this.resizeJobs.get(id); if (resize) resize.pending = undefined;
    }
    this.controlState(id);
  }
  private browserControl(c: Connection) {
    if (this.telegramJob?.id === c.session.id) {
      // Fence takeover until the old native write/cancel has reaped. Only one
      // replacement claimant, not a queue; uncertain input is never replayed.
      this.telegramJob.next = c; this.telegramJob.abort.abort(); return;
    }
    this.changeController(c.session.id, c.id);
  }
  telegramTarget(id: string, signal?: AbortSignal) { return this.nativeInput.target(id, signal); }
  // Caller MUST hold Telegram's exclusive poller lock. Non-polling close/release
  // only cleans a buffer owned by this instance, never another poller's paste.
  telegramStartup() { return this.nativeInput.clear(true); }
  reapControllers() {
    // Bounded controller metadata is not tied to which twenty catalog rows are
    // currently sampled. Deleted/evicted jobs must not retain ownership forever.
    for (const id of this.controllers.keys()) {
      try { if (this.sessions.get(id).state !== 'running') this.stopSession(id); }
      catch { this.stopSession(id); }
    }
  }
  async takeTelegram(id: string, expected: string) {
    this.sessions.inputReady(id);
    this.reapControllers();
    assertValue(!this.closing && !this.telegramJob, 409, 'telegram_input_busy');
    assertValue(this.controller(id).stamp === expected, 409, 'controller_changed');
    if (expected.startsWith('tg:')) return expected;
    assertValue([...this.controllers.values()].filter(owner => owner.startsWith('tg:')).length < LIMITS.sessions, 409, 'telegram_controller_limit');
    const stamp = 'tg:' + randomBytes(16).toString('hex');
    this.changeController(id, stamp);
    // A previously authorized resize/history command may already be in tmux.
    // Drain it before bot input; queued replacements have just been discarded.
    await Promise.all([this.resizeJobs.get(id)?.done, this.historyJobs.get(id)]);
    assertValue(this.controller(id).stamp === stamp && !this.closing, 409, 'controller_changed');
    return stamp;
  }
  async telegramInput(target: InputTarget, stamp: string, action: NativeAction, enabled: () => boolean) {
    const guard = () => {
      assertValue(!this.closing && enabled() && stamp.startsWith('tg:') && this.controller(target.sessionId).stamp === stamp, 409, 'control_changed_no_replay');
      this.sessions.inputReady(target.sessionId);
    };
    guard(); assertValue(!this.telegramJob, 429, 'telegram_input_busy');
    const job: NonNullable<Bridges['telegramJob']> = { id: target.sessionId, abort: new AbortController(), done: Promise.resolve() };
    this.telegramJob = job;
    job.done = this.nativeInput.perform(target, action, guard, job.abort.signal).finally(() => {
      this.telegramJob = undefined;
      if (job.next && !job.next.done && !this.closing) this.changeController(job.id, job.next.id);
    });
    await job.done;
  }
  async releaseTelegram(id?: string) {
    const job = this.telegramJob;
    if (job && (!id || job.id === id)) { job.abort.abort(); try { await job.done; } catch { /* uncertain: never retry */ } }
    for (const [sessionId, owner] of this.controllers) if ((!id || id === sessionId) && owner.startsWith('tg:')) {
      const next = [...this.connections.values()].find(c => !c.done && c.session.id === sessionId);
      this.changeController(sessionId, !this.closing ? next?.id : undefined);
    }
    try { await this.nativeInput.clear(); } catch { /* single reserved buffer remains bounded; never replay it */ }
  }
  private detach(c: Connection, reason: string, code = 4000) {
    if (c.done) return;
    c.done = true; c.closedAt = Date.now();
    this.reasons[reason] = (this.reasons[reason] || 0) + 1;
    for (const sub of c.subscriptions) sub.dispose();
    c.subscriptions.length = 0;
    if (c.inputTimer) clearTimeout(c.inputTimer); c.inputTimer = undefined;
    c.input = undefined; c.resize = undefined; c.raw = '';
    if (c.terminal) {
      // Public node-pty APIs only. A paused tmux client may otherwise wait forever to flush on HUP.
      // Drop application data subscriptions first, resume bounded native reads, then terminate ONLY
      // the attach client. Keep ownership/cap/exit subscription until actual native exit; never signal
      // the independent tmux server or the persistent shell/Codex job.
      try { c.terminal.resume(); } catch { /* already closing */ }
      try { c.terminal.kill('SIGHUP'); } catch { /* sweep escalates if still owned */ }
    }
    c.sent = c.acked = 0;
    if (this.controllers.get(c.session.id) === c.id) {
      const next = [...this.connections.values()].find(x => !x.done && x.session.id === c.session.id);
      this.changeController(c.session.id, next?.id);
    }
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close(code, reason);
    else if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
  }
  revokeInvalid() { for (const c of this.connections.values()) if (!c.done && !this.auth.authenticate(c.raw)) this.detach(c, 'auth_revoked', 4001); }
  stopSession(id: string) {
    if (this.telegramJob?.id === id) this.telegramJob.abort.abort();
    for (const c of this.connections.values()) if (c.session.id === id) this.detach(c, 'session_stopped');
    this.controllers.delete(id); this.controlRevisions.delete(id);
  }
  private sweep() {
    const now = Date.now(); this.ticks++;
    // Existing single sweep is also the bounded native-termination watchdog; no per-client timer queue.
    for (const c of this.nativePtys.values()) if (c.done && now - c.closedAt >= 1000) {
      try { c.terminal?.kill('SIGKILL'); } catch { /* wait for node-pty's actual onExit */ }
    }
    for (const c of this.connections.values()) {
      if (c.done) { if (now - c.closedAt > 250) { c.ws.terminate(); this.connections.delete(c.id); } continue; }
      if (!this.auth.authenticate(c.raw)) { this.detach(c, 'auth_revoked', 4001); continue; }
      if (c.sent > c.acked && now - c.progressAt > this.config.ackMs) { this.detach(c, 'slow_client_reconnect'); continue; }
      if (now - c.pongAt > 30000) { this.detach(c, 'heartbeat_timeout'); continue; }
      if (c.ws.bufferedAmount > LIMITS.transport) { this.detach(c, 'transport_limit'); continue; }
      if (this.ticks % 10 === 0) c.ws.ping();
    }
    if (this.ticks % 60 === 0) this.auth.cleanup();
  }
  stats() {
    const live = [...this.connections.values()].filter(c => !c.done);
    return { connections: this.connections.size, attachments: live.length, ptys: this.nativePtys.size,
      retiringPtys: [...this.nativePtys.values()].filter(c => c.done).length, controllers: this.controllers.size,
      outstandingBytes: live.reduce((n, c) => n + c.sent - c.acked, 0), pendingInputBytes: live.reduce((n, c) => n + (c.input?.length || 0), 0),
      transportBytes: live.reduce((n, c) => n + c.ws.bufferedAmount, 0), subscriptions: live.reduce((n, c) => n + c.subscriptions.length, 0) + [...this.nativePtys.values()].filter(c => c.exitSubscription).length,
      inputTimers: live.filter(c => c.inputTimer).length, resizeJobs: this.resizeJobs.size, historyJobs: this.historyJobs.size, heartbeatTimers: this.closing ? 0 : 1, created: this.created, disposed: this.disposed,
      telegramControllers: [...this.controllers.values()].filter(value => value.startsWith('tg:')).length, telegramInput: this.nativeInput.stats(),
      peakOutstandingBytes: this.peakOutstanding, peakTransportBytes: this.peakTransport, detachReasons: { ...this.reasons } };
  }
  close() { return this.shutdown ??= this.doClose(); }
  private async doClose() {
    this.closing = true; clearInterval(this.timer);
    await this.releaseTelegram();
    for (const c of this.connections.values()) { this.detach(c, 'backend_restart'); c.ws.terminate(); }
    this.connections.clear(); this.controllers.clear(); this.controlRevisions.clear();
    // The sweep is stopped now. Give resumed HUP clients a short grace period, then force only
    // remaining attachment children to exit. Do not silently discard their handles or counters.
    const grace = Date.now() + 250;
    while (this.nativePtys.size && Date.now() < grace) await new Promise(resolve => setTimeout(resolve, 10));
    for (const c of this.nativePtys.values()) { try { c.terminal?.kill('SIGKILL'); } catch { /* already reaping */ } }
    const deadline = Date.now() + 2000;
    while (this.nativePtys.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.nativePtys.size) throw new Error('Native attachment shutdown timeout');
    await Promise.all([...this.resizeJobs.values()].map(job => job.done));
    this.resizeJobs.clear();
    await Promise.all(this.historyJobs.values()); this.historyJobs.clear();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
  }
}
