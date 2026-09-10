import { createHash } from 'node:crypto';
import { assertValue } from './errors.js';

export const AGENT_LIMITS = Object.freeze({ textBytes: 2000, requestBytes: 8192, replyBytes: 1024,
  pending: 4, sockets: 4, receiveMs: 3000, expiryMs: 25000, clientMs: 30000,
  burst: 4, refillMs: 10000, cooldownMs: 30000, dedupeMs: 300000, metadata: 64 });
export const AGENT_KINDS = ['progress', 'blocked', 'question', 'done', 'error'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export interface AgentRequest {
  kind: AgentKind; text: string; session?: string; project?: string;
  tmux?: { socket: string; pid: number; pane: string };
}
export interface AgentMessage { kind: AgentKind; text: string; session?: string; project?: string }
export interface AgentReceipt { status: 'sent' | 'rejected' | 'uncertain'; code: string }
export const rejected = (code: string): AgentReceipt => ({ status: 'rejected', code });
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clean = (s: string) => !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(s) && Buffer.from(s).toString('utf8') === s;

export function agentRequest(value: unknown): AgentRequest {
  assertValue(object(value) && Object.keys(value).every(k => ['kind', 'text', 'session', 'project', 'tmux'].includes(k)), 400, 'invalid_notification');
  assertValue(AGENT_KINDS.includes(value.kind as AgentKind) && typeof value.text === 'string' && value.text.trim().length > 0
    && value.text.length <= AGENT_LIMITS.textBytes && Buffer.byteLength(value.text) <= AGENT_LIMITS.textBytes && clean(value.text), 400, 'invalid_notification');
  assertValue(value.session === undefined || typeof value.session === 'string' && /^[a-f0-9]{32}$/.test(value.session), 400, 'invalid_session');
  assertValue(value.project === undefined || typeof value.project === 'string' && value.project.length > 0 && value.project.length <= 80
    && Buffer.byteLength(value.project) <= 320 && clean(value.project) && !/[\n\t/\\]/.test(value.project), 400, 'invalid_project_label');
  if (value.tmux !== undefined) {
    const t = value.tmux;
    assertValue(value.session === undefined && object(t) && Object.keys(t).length === 3
      && typeof t.socket === 'string' && t.socket.startsWith('/') && t.socket.length <= 512 && clean(t.socket) && !/[\n\t]/.test(t.socket)
      && Number.isSafeInteger(t.pid) && Number(t.pid) > 0 && typeof t.pane === 'string' && /^%\d{1,10}$/.test(t.pane), 400, 'invalid_terminal_context');
  }
  return value as unknown as AgentRequest;
}

export interface AgentEntry extends AgentMessage {
  epoch: string; expires: number; sending: boolean; settled: boolean;
  resolve: (receipt: AgentReceipt) => void; release: () => void;
}

// Four short messages INCLUDING the in-flight send. No disk outbox, transcripts,
// per-session watchers or per-entry timers. The bot's existing 1s tick prunes it.
export class AgentNotices {
  private entries = new Set<AgentEntry>();
  private seen = new Map<string, number>();
  private cooldowns = new Map<string, number>();
  private tokens = AGENT_LIMITS.burst as number;
  private refillAt: number;
  constructor(private now: () => number = Date.now) { this.refillAt = now(); }
  get hasPending() { return this.entries.size > 0; }
  enqueue(message: AgentMessage, epoch: string, signal: AbortSignal): Promise<AgentReceipt> {
    this.prune();
    if (signal.aborted) return Promise.resolve(rejected('cancelled'));
    const now = this.now(), key = (message.session || 'unlinked') + ':' + message.kind;
    const hash = createHash('sha256').update(key + '\0' + message.text.trim()).digest('hex');
    if (this.seen.has(hash)) return Promise.resolve(rejected('duplicate_suppressed'));
    if (this.entries.size >= AGENT_LIMITS.pending) return Promise.resolve(rejected('queue_full'));
    if (this.tokens < 1 || (this.cooldowns.get(key) || 0) > now) return Promise.resolve(rejected('rate_limited'));
    this.tokens--;
    for (const map of [this.seen, this.cooldowns]) if (map.size >= AGENT_LIMITS.metadata) map.delete(map.keys().next().value!);
    this.seen.set(hash, now + AGENT_LIMITS.dedupeMs); this.cooldowns.set(key, now + AGENT_LIMITS.cooldownMs);
    return new Promise(resolve => {
      const entry: AgentEntry = { ...message, epoch, expires: now + AGENT_LIMITS.expiryMs, sending: false, settled: false, resolve, release: () => signal.removeEventListener('abort', abort) };
      const abort = () => this.finish(entry, entry.sending ? { status: 'uncertain', code: 'delivery_unknown' } : rejected('cancelled'));
      this.entries.add(entry); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  take(epoch: string) {
    this.prune();
    if ([...this.entries].some(entry => entry.sending)) return;
    for (const entry of this.entries) {
      if (entry.epoch !== epoch) { this.finish(entry, rejected('binding_changed')); continue; }
      if (!entry.sending) { entry.sending = true; return entry; }
    }
  }
  finish(entry: AgentEntry, receipt: AgentReceipt, transportFinished = false) {
    // A disconnected sender cannot free the in-flight capacity reservation
    // while the bounded Telegram request still owns its copied request body.
    if (transportFinished) this.entries.delete(entry);
    if (entry.settled) return;
    entry.settled = true; entry.text = ''; entry.release();
    if (!entry.sending) this.entries.delete(entry);
    entry.resolve(receipt);
  }
  clear(code: string) {
    for (const entry of this.entries) this.finish(entry, entry.sending ? { status: 'uncertain', code: 'delivery_unknown' } : rejected(code));
  }
  prune() {
    const now = this.now();
    for (const map of [this.seen, this.cooldowns]) for (const [key, expires] of map) if (expires <= now) map.delete(key);
    for (const entry of this.entries) if (entry.expires <= now) this.finish(entry, entry.sending ? { status: 'uncertain', code: 'delivery_unknown' } : rejected('expired'));
    this.tokens = Math.min(AGENT_LIMITS.burst, this.tokens + Math.max(0, now - this.refillAt) / AGENT_LIMITS.refillMs); this.refillAt = now;
  }
  close() { this.clear('shutting_down'); this.seen.clear(); this.cooldowns.clear(); }
  stats() { return { pending: this.entries.size, sending: [...this.entries].filter(e => e.sending).length,
    textBytes: [...this.entries].reduce((n, e) => n + Buffer.byteLength(e.text), 0), dedupeHashes: this.seen.size, cooldowns: this.cooldowns.size }; }
}
