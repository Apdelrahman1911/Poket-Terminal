import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { Config, TelegramBotIdentity } from './config.js';

export const generation = () => randomBytes(16).toString('hex');
export interface TelegramControl {
  version: 1; epoch: string; enabled: boolean;
  owner?: { userId: number; chatId: number }; botId?: number; botUsername?: string; pairedAt?: number;
}
export const numericId = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const epoch = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every(k => keys.includes(k));
export class TelegramStateError extends Error {
  constructor() { super('Telegram private state unavailable or unsafe; controls disabled.'); }
}

// Kernel-owned exclusive abstract Unix socket: no stale PID/file-lock recovery race,
// inherited lock fd, public listener or helper daemon. Incoming local connections
// receive nothing and are closed. Linux is the supported deployment platform.
export class TelegramLock {
  private server?: net.Server;
  constructor(readonly key: string) {}
  async acquire(): Promise<boolean> {
    if (this.server) return true;
    const server = net.createServer(socket => socket.destroy());
    server.maxConnections = 1;
    return new Promise((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve(false); else reject(new TelegramStateError());
      });
      server.listen({ path: '\0pt-telegram-' + createHash('sha256').update(this.key).digest('hex').slice(0, 48) }, () => {
        server.unref(); this.server = server; resolve(true);
      });
    });
  }
  async close() {
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export class TelegramState {
  readonly dir: string;
  private boundary: string;
  private readonly bot?: TelegramBotIdentity;
  constructor(config: Pick<Config, 'root' | 'dataDir' | 'testMode' | 'telegramBot'>) {
    this.bot = config.telegramBot && Object.freeze({ ...config.telegramBot });
    this.dir = config.testMode ? path.join(config.dataDir, 'telegram') : path.join(config.root, '.runtime/telegram');
    this.boundary = path.join(config.root, '.runtime');
    if (!this.dir.startsWith(this.boundary + '/')) throw new TelegramStateError();
  }
  identity(): TelegramBotIdentity {
    if (!this.bot) throw new TelegramStateError();
    return this.bot;
  }
  private directory(create = false) {
    const parts = path.relative(this.boundary, this.dir).split(path.sep);
    let current = this.boundary;
    for (const part of ['', ...parts]) {
      if (part) current = path.join(current, part);
      if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      let st: fs.Stats;
      try { st = fs.lstatSync(current); } catch { throw new TelegramStateError(); }
      if (!st.isDirectory() || st.uid !== process.geteuid?.() || (st.mode & 0o777) !== 0o700) throw new TelegramStateError();
    }
  }
  private check(st: fs.Stats, limit: number) {
    if (!st.isFile() || st.uid !== process.geteuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > limit) throw new TelegramStateError();
  }
  private read(name: string, limit = 4096): string | undefined {
    // Absent installation does not create files or touch the token.
    if (!fs.existsSync(this.dir)) return undefined;
    this.directory();
    let fd: number;
    try { fd = fs.openSync(path.join(this.dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new TelegramStateError(); }
    try {
      this.check(fs.fstatSync(fd), limit);
      const value = Buffer.allocUnsafe(limit + 1); let used = 0;
      while (used < value.length) {
        const n = fs.readSync(fd, value, used, value.length - used, null);
        if (!n) break; used += n;
      }
      if (used > limit) throw new TelegramStateError();
      return value.subarray(0, used).toString('utf8');
    } finally { fs.closeSync(fd); }
  }
  private json(name: string): unknown {
    const text = this.read(name);
    if (text === undefined) return undefined;
    try { return JSON.parse(text); } catch { throw new TelegramStateError(); }
  }
  private write(name: string, value: unknown) {
    this.directory(true);
    const file = path.join(this.dir, name), text = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(text) > 4096) throw new TelegramStateError();
    try { this.check(fs.lstatSync(file), 4096); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const temp = path.join(this.dir, '.' + name + '.' + generation());
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      const directory = fs.openSync(this.dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); }
      finally { try { fs.unlinkSync(temp); } catch { /* renamed or never created */ } }
    }
  }
  control(): TelegramControl | undefined {
    const x = this.json('control.json');
    if (x === undefined) return undefined;
    if (!record(x) || !exact(x, ['version', 'epoch', 'enabled', 'owner', 'botId', 'botUsername', 'pairedAt']) || x.version !== 1 || !epoch(x.epoch) || typeof x.enabled !== 'boolean') throw new TelegramStateError();
    const paired = record(x.owner) && exact(x.owner, ['userId', 'chatId']) && numericId(x.owner.userId) && numericId(x.owner.chatId) && numericId(x.botId) && typeof x.botUsername === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(x.botUsername) && numericId(x.pairedAt);
    if ((x.enabled || x.owner !== undefined || x.botId !== undefined || x.botUsername !== undefined || x.pairedAt !== undefined) && !paired) throw new TelegramStateError();
    // Both the SSH-persisted numeric bot identity/name and this launch's exact
    // configured pin must agree. An env/token edit alone never switches bots,
    // enables an old binding or reuses its action generation. Legacy unpinned
    // controls fail closed; explicit private revoke/re-pair is required.
    if (paired && (!this.bot || x.botId !== this.bot.id || x.botUsername !== this.bot.username)) throw new TelegramStateError();
    return x as unknown as TelegramControl;
  }
  // Only the SSH CLI writes control.json. The poller writes cursor/preferences
  // separately, so an in-flight fsync can NEVER overwrite emergency disable.
  setControl(control: TelegramControl) { this.write('control.json', control); }
  cursor(e: string): number {
    const x = this.json('cursor.json');
    if (!record(x) || !exact(x, ['version', 'epoch', 'next']) || x.version !== 1 || x.epoch !== e || !Number.isSafeInteger(x.next) || (x.next as number) < 0 || (x.next as number) >= Number.MAX_SAFE_INTEGER) throw new TelegramStateError();
    return x.next as number;
  }
  claim(e: string, next: number) {
    if (!epoch(e) || !Number.isSafeInteger(next) || next < 0 || next >= Number.MAX_SAFE_INTEGER) throw new TelegramStateError();
    this.write('cursor.json', { version: 1, epoch: e, next });
  }
  notifications(e: string): boolean {
    const x = this.json('preferences.json');
    if (!record(x) || !exact(x, ['version', 'epoch', 'notifications']) || x.version !== 1 || x.epoch !== e || typeof x.notifications !== 'boolean') throw new TelegramStateError();
    return x.notifications;
  }
  setNotifications(e: string, notifications: boolean) { this.write('preferences.json', { version: 1, epoch: e, notifications }); }
  token(): string {
    const value = this.read('token', 256)?.trim();
    if (!value || !/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/.test(value)) throw new TelegramStateError();
    return value;
  }
  async withControlLock<T>(operation: () => T): Promise<T> {
    const lock = new TelegramLock(this.dir + '/control');
    if (!await lock.acquire()) throw new Error('Another private setup command is active; retry.');
    try { return operation(); } finally { await lock.close(); }
  }
  disable(revoke = false) {
    let current: TelegramControl | undefined;
    try { current = this.control(); } catch { /* a secure but corrupt file may be replaced with disabled state */ }
    const next: TelegramControl = { version: 1, epoch: generation(), enabled: false };
    if (!revoke && current?.owner) { next.owner = current.owner; next.botId = current.botId; next.botUsername = current.botUsername; next.pairedAt = current.pairedAt; }
    this.setControl(next);
    return next;
  }
}
