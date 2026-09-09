import fs from 'node:fs';
import net from 'node:net';
import { execFile, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { Auth, cookieToken, csrfFor, equal, tokenHash } from './auth.js';
import { requestOriginAllowed } from './bridge.js';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { DESKTOP_LIMITS as L, RfbInput } from './desktop-rfb.js';

// Linux O_PATH pins the inode; O_NOFOLLOW + fstat rejects a symlink itself.
// Connecting via this fd (kept open until detach) cannot be redirected by a
// desktop-user rename/symlink swap of the original pathname. No root proxy helper.
const O_PATH = 0x200000;
export function pinDesktopSocket(file: string, uid: number) {
  const directory = fs.lstatSync(file.slice(0, file.lastIndexOf('/')));
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700 || uid === 0) throw new Error('unsafe_desktop_directory');
  const fd = fs.openSync(file, O_PATH | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isSocket() || st.uid !== uid || (st.mode & 0o777) !== 0o600) throw new Error('unsafe_desktop_socket');
    return { fd, path: `/proc/self/fd/${fd}` };
  } catch (error) { fs.closeSync(fd); throw error; }
}

interface Connection {
  ws: WebSocket; raw: string; key: string; upstream: net.Socket; pinned: number;
  input: RfbInput; done: boolean; connected: boolean; born: number; closedAt: number;
  sent: number; acked: number; progressAt: number; pongAt: number; pingAt: number;
  paused: boolean; inputPausedAt: number; partialAt: number;
  rateAt: number; messages: number; inputBytes: number;
}

export class Desktop {
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: L.frame,
    handleProtocols: protocols => protocols.has('pocketdesktop.v1') ? 'pocketdesktop.v1' : false });
  private connections = new Set<Connection>();
  private timer: NodeJS.Timeout;
  private closing = false;
  private helper?: ChildProcess;
  private helperDone?: Promise<void>;
  private nextStart = 0;
  private created = 0;
  private disposed = 0;
  private peakOutstanding = 0;
  private peakTransport = 0;
  private peakInput = 0;
  private reasons: Record<string, number> = {};
  constructor(readonly auth: Auth, readonly config: Config) {
    if (!config.desktop) throw new Error('desktop_not_enabled');
    this.timer = setInterval(() => this.sweep(), 250); this.timer.unref();
  }
  async start() {
    if (this.closing) throw new HttpError(503, 'desktop_unavailable');
    if (this.helper) throw new HttpError(409, 'desktop_starting');
    if (Date.now() < this.nextStart) {
      // Rapid foreground cycles of an already-running private desktop do not
      // spawn helpers, queue work or trigger reconnect storms.
      try { const pinned = pinDesktopSocket(this.config.desktop!.socketPath, this.config.desktop!.uid); fs.closeSync(pinned.fd); return; }
      catch { throw new HttpError(429, 'desktop_start_rate'); }
    }
    this.nextStart = Date.now() + 2000;
    const d = this.config.desktop!;
    // One fixed command, zero queued starts, no shell, bounded stdout, hard deadline.
    // It launches a detached private service; web shutdown never stops GUI apps.
    this.helperDone = new Promise<void>((resolve, reject) => {
      this.helper = execFile('/usr/local/bin/pocketdesktop', [d.startCommand], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: '/', timeout: 22000,
        maxBuffer: 4096, killSignal: 'SIGKILL', windowsHide: true,
      }, (err) => { this.helper = undefined; if (err) reject(new HttpError(503, 'desktop_start_failed')); else resolve(); });
    });
    try { await this.helperDone; } finally { this.helperDone = undefined; }
  }
  upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const deny = (code: number) => {
      socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      const timer = setTimeout(() => socket.destroy(), 250); timer.unref(); socket.once('close', () => clearTimeout(timer));
    };
    if (this.closing || !requestOriginAllowed(req, this.config.origin, true)) return deny(403);
    if (req.url !== '/api/desktop/socket') return deny(404);
    const raw = cookieToken(req.headers.cookie);
    if (!raw || !this.auth.authenticate(raw)) return deny(401);
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    if (protocols.length !== 2 || protocols[0] !== 'pocketdesktop.v1' || !equal(protocols[1] || '', `csrf.${csrfFor(raw)}`)) return deny(403);
    const key = tokenHash(raw);
    // Reject duplicate tabs rather than displacing each other in a reconnect loop.
    if ([...this.connections].some(c => c.key === key)) return deny(409);
    if (this.connections.size >= L.clients) return deny(429);
    let pinned: { fd: number; path: string };
    try { pinned = pinDesktopSocket(this.config.desktop!.socketPath, this.config.desktop!.uid); }
    catch { return deny(503); }
    let accepted = false;
    try {
      this.wss.handleUpgrade(req, socket, head, ws => {
        accepted = true;
        const now = Date.now();
        let c: Connection;
        // Public net onread API: one fixed 64-KiB native read buffer. Copy only
        // the delivered bytes because ws.send can retain them until its write.
        const upstream = new net.Socket({ onread: { buffer: new Uint8Array(L.readChunk), callback: (n, buffer) => {
          if (n > 0) this.output(c, Buffer.from(buffer.subarray(0, n)));
          return !c.done && !c.paused;
        } } });
        c = { ws, raw, key, upstream, pinned: pinned.fd, input: new RfbInput(), done: false, connected: false,
          born: now, closedAt: 0, sent: 0, acked: 0, progressAt: now, pongAt: now, pingAt: now,
          paused: false, inputPausedAt: 0, partialAt: 0, rateAt: now, messages: 0, inputBytes: 0 };
        this.connections.add(c);
        ws.on('error', () => this.detach(c, 'transport_error'));
        ws.on('close', () => { this.detach(c, 'client_closed'); this.connections.delete(c); });
        ws.on('pong', () => { c.pongAt = Date.now(); });
        ws.on('message', (data, binary) => this.message(c, data, binary));
        upstream.on('error', () => this.detach(c, 'desktop_unavailable'));
        upstream.on('close', () => this.detach(c, 'desktop_closed'));
        upstream.on('drain', () => { if (!c.done) { c.inputPausedAt = 0; ws.resume(); } });
        upstream.once('connect', () => {
          if (c.done) return upstream.destroy();
          c.connected = true; this.created++;
        });
        upstream.connect({ path: pinned.path });
      });
    } finally {
      // handleUpgrade can reject malformed WS headers without invoking callback.
      if (!accepted) fs.closeSync(pinned.fd);
    }
  };
  private output(c: Connection, data: Buffer) {
    if (c.done) return;
    if (!this.auth.authenticate(c.raw)) return this.detach(c, 'auth_revoked', 4001);
    if (data.length > L.readChunk || c.sent - c.acked + data.length > L.outstanding) return this.detach(c, 'output_limit');
    if (c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount + data.length + 16 > L.transport) return this.detach(c, 'transport_limit');
    if (c.sent === c.acked) c.progressAt = Date.now();
    c.sent += data.length;
    c.ws.send(data, { binary: true, compress: false }, err => { if (err) this.detach(c, 'transport_error'); });
    this.peakOutstanding = Math.max(this.peakOutstanding, c.sent - c.acked);
    this.peakTransport = Math.max(this.peakTransport, c.ws.bufferedAmount);
    if (c.sent - c.acked >= L.pauseAt || c.ws.bufferedAmount >= L.transport / 2) {
      c.paused = true; c.upstream.pause();
    }
  }
  private message(c: Connection, data: RawData, binary: boolean) {
    if (c.done) return;
    if (!this.auth.authenticate(c.raw)) return this.detach(c, 'auth_revoked', 4001);
    if (!Buffer.isBuffer(data)) return this.detach(c, 'invalid_frame');
    const now = Date.now();
    if (now - c.rateAt >= 1000) { c.rateAt = now; c.messages = 0; c.inputBytes = 0; }
    if (++c.messages > L.messagesPerSecond) return this.detach(c, 'message_rate');
    if (!binary) {
      if (data.length > 96) return this.detach(c, 'invalid_ack');
      let ack: { type?: unknown; bytes?: unknown };
      try { ack = JSON.parse(data.toString()); } catch { return this.detach(c, 'invalid_ack'); }
      if (!ack || Object.keys(ack).length !== 2 || ack.type !== 'ack' || !Number.isSafeInteger(ack.bytes) || (ack.bytes as number) <= c.acked || (ack.bytes as number) > c.sent) return this.detach(c, 'invalid_ack');
      c.acked = ack.bytes as number; c.progressAt = now; this.resume(c); return;
    }
    if (!c.connected || !data.length || data.length > L.frame || (c.inputBytes += data.length) > L.inputPerSecond) return this.detach(c, 'input_limit');
    try {
      c.input.feed(data, packet => {
        if (c.done) throw new Error('input_closed');
        if (c.upstream.writableLength + packet.length > L.upstreamWrite) throw new Error('input_backpressure');
        if (!c.upstream.write(packet) && !c.inputPausedAt) { c.inputPausedAt = now; c.ws.pause(); }
        this.peakInput = Math.max(this.peakInput, c.upstream.writableLength);
      });
      if (c.input.pendingBytes) { if (!c.partialAt) c.partialAt = now; } else c.partialAt = 0;
    } catch { this.detach(c, 'rfb_input_rejected'); }
  }
  private resume(c: Connection) {
    if (c.paused && c.sent - c.acked <= L.resumeAt && c.ws.bufferedAmount <= L.transport / 4) {
      c.paused = false; c.upstream.resume();
    }
  }
  private detach(c: Connection, reason: string, code = 4000) {
    if (c.done) return;
    c.done = true; c.closedAt = Date.now(); c.raw = ''; c.input.clear();
    this.reasons[reason] = (this.reasons[reason] || 0) + 1;
    c.upstream.destroy(); fs.closeSync(c.pinned);
    if (c.connected) this.disposed++;
    if (c.ws.isPaused) c.ws.resume();
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close(code, reason);
    else if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
  }
  revokeInvalid() { for (const c of this.connections) if (!c.done && !this.auth.authenticate(c.raw)) this.detach(c, 'auth_revoked', 4001); }
  private sweep() {
    const now = Date.now();
    for (const c of this.connections) {
      if (c.done) { if (now - c.closedAt >= L.terminateMs) { c.ws.terminate(); this.connections.delete(c); } continue; }
      if (!this.auth.authenticate(c.raw)) { this.detach(c, 'auth_revoked', 4001); continue; }
      if ((!c.connected && now - c.born > L.connectMs) || (!c.input.ready && now - c.born > L.handshakeMs)) { this.detach(c, 'handshake_timeout'); continue; }
      if (c.sent > c.acked && now - c.progressAt > L.ackMs) { this.detach(c, 'slow_client'); continue; }
      if ((c.inputPausedAt && now - c.inputPausedAt > L.inputMs) || (c.partialAt && now - c.partialAt > L.inputMs)) { this.detach(c, 'input_timeout'); continue; }
      if (now - c.pongAt > L.deadMs) { this.detach(c, 'heartbeat_timeout'); continue; }
      if (now - c.pingAt >= L.heartbeatMs) { c.pingAt = now; c.ws.ping(); }
      this.resume(c);
    }
  }
  stats() {
    const live = [...this.connections].filter(c => !c.done);
    return { connections: this.connections.size, attachments: live.length, upstreams: live.filter(c => c.connected).length,
      created: this.created, disposed: this.disposed, paused: live.filter(c => c.paused).length,
      outstandingBytes: live.reduce((n, c) => n + c.sent - c.acked, 0), transportBytes: live.reduce((n, c) => n + c.ws.bufferedAmount, 0),
      pendingInputBytes: live.reduce((n, c) => n + c.input.pendingBytes + c.upstream.writableLength, 0),
      peakOutstandingBytes: this.peakOutstanding, peakTransportBytes: this.peakTransport, peakInputBytes: this.peakInput,
      helperProcesses: this.helper ? 1 : 0, helperQueue: 0, sweepTimers: this.closing ? 0 : 1, detachReasons: { ...this.reasons } };
  }
  async close() {
    if (this.closing) return;
    this.closing = true; clearInterval(this.timer);
    this.helper?.kill('SIGKILL');
    if (this.helperDone) await this.helperDone.catch(() => {});
    for (const c of this.connections) { this.detach(c, 'backend_restart'); c.ws.terminate(); }
    this.connections.clear();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
  }
}
