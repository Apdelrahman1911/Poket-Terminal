import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { TelegramBot } from './telegram-bot.js';
import { TelegramLock } from './telegram-state.js';
import { AGENT_LIMITS, rejected } from './agent-notices.js';
import { HttpError } from './errors.js';

export const agentSocketPath = (config: Pick<Config, 'dataDir'>) => path.join(config.dataDir, 'agent-notify.sock');

// A filesystem-authorized local socket, NOT an HTTP route or public listener.
// Only the app's Unix owner (root on the supported deployments) can use it.
export class AgentNotifyServer {
  readonly path: string;
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  private lock: TelegramLock;
  private status = 'not_started';
  constructor(private config: Config, private telegram: TelegramBot) {
    this.path = agentSocketPath(config); this.lock = new TelegramLock(this.path);
  }
  async start() {
    if (this.server) return;
    try {
      const dir = fs.lstatSync(this.config.dataDir);
      if (!dir.isDirectory() || dir.uid !== process.geteuid?.() || (dir.mode & 0o777) !== 0o700
        || fs.realpathSync(this.config.dataDir) !== this.config.dataDir || Buffer.byteLength(this.path) > 103) throw new Error('unsafe');
      if (!await this.lock.acquire()) throw new Error('owned');
      // The kernel lock proves another cooperating listener cannot be live.
      // Never unlink an ordinary file/symlink or a different owner's socket.
      try {
        const old = fs.lstatSync(this.path);
        if (!old.isSocket() || old.uid !== process.geteuid?.() || (old.mode & 0o777) !== 0o600) throw new Error('unsafe');
        fs.unlinkSync(this.path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const server = net.createServer({ highWaterMark: AGENT_LIMITS.requestBytes }, socket => this.accept(socket));
      this.server = server; server.maxConnections = AGENT_LIMITS.sockets;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.path, resolve); });
      fs.chmodSync(this.path, 0o600); server.unref(); this.status = 'listening';
    } catch {
      await this.close(); this.status = 'unavailable'; // optional notifier must not stop terminals
    }
  }
  private accept(socket: net.Socket) {
    if (this.sockets.size >= AGENT_LIMITS.sockets) { socket.destroy(); return; }
    this.sockets.add(socket);
    const abort = new AbortController();
    let buffer: Buffer | undefined = Buffer.alloc(AGENT_LIMITS.requestBytes), used = 0, received = false, finished = false;
    let timer = setTimeout(() => socket.destroy(), AGENT_LIMITS.receiveMs); timer.unref();
    const finish = (receipt: object) => {
      if (finished || socket.destroyed) return;
      finished = true; buffer = undefined; clearTimeout(timer);
      socket.end(JSON.stringify(receipt) + '\n');
      timer = setTimeout(() => socket.destroy(), 250); timer.unref();
    };
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); buffer = undefined; abort.abort(); this.sockets.delete(socket); });
    socket.on('data', (chunk: Buffer) => {
      if (received || finished) { socket.destroy(); return; } // no pipelining or growing read queue
      if (!buffer || used + chunk.length > buffer.length) { finish(rejected('request_too_large')); return; }
      chunk.copy(buffer, used); used += chunk.length;
      const end = buffer.subarray(0, used).indexOf(10);
      if (end < 0) return;
      if (end !== used - 1) { finish(rejected('invalid_notification')); return; }
      let value: unknown;
      try { value = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
      catch { finish(rejected('invalid_notification')); return; }
      received = true; buffer = undefined; clearTimeout(timer);
      timer = setTimeout(() => { finish({ status: 'uncertain', code: 'delivery_unknown' }); abort.abort(); }, AGENT_LIMITS.expiryMs + 1000); timer.unref();
      void this.telegram.notifyAgent(value, abort.signal).then(finish, error => finish(rejected(error instanceof HttpError ? error.code : 'unavailable')));
    });
  }
  stats() { return { status: this.status, sockets: this.sockets.size }; }
  async close() {
    this.status = 'closed';
    for (const socket of this.sockets) socket.destroy();
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await this.lock.close();
  }
}
