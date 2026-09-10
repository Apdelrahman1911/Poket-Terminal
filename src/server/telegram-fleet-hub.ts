import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { TelegramState, TelegramLock } from './telegram-state.js';
import { TelegramApi, TelegramApiError, type TelegramTransport, TG_LIMITS, verifyBot, discardBacklog, updates, updateId } from './telegram-api.js';
import { callback, userMessage, privateMessage, fresh, type Message } from './telegram-update.js';
import { BOT_COMMANDS, parseNavigation } from './telegram-ui.js';
import { FleetState, FLEET_LIMITS, fleetId, fleetKey, fleetRecord, exactKeys, sameBinding, currentBinding, type FleetController, type FleetNode } from './telegram-fleet-state.js';

const fail = (code: ConstructorParameters<typeof TelegramApiError>[0] = 'api_rejected'): never => { throw new TelegramApiError(code); };
const innerRoute = (data: string) => /^p:[A-Za-z0-9_-]{22}$/.test(data) || !!parseNavigation(data);
export function fleetRoute(data: string) {
  if (Buffer.byteLength(data) > 64) return;
  const match = /^f:([a-f0-9]{16}):(.+)$/.exec(data);
  return match && innerRoute(match[2]!) ? { node: match[1]!, data: match[2]! } : undefined;
}
const hubRoute = (data: string) => data === 'h:servers' || /^h:use:[a-f0-9]{16}$/.test(data);
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); timer.unref(); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
});
type Peer = { node: FleetNode; instance: string; seq: number; nextUpdate: number; busy: boolean; seen: number; registered: boolean;
  mailbox?: { value: Record<string, unknown>; at: number }; wake?: () => void;
  replies: Map<number, { date: number; expires: number }>; callbacks: Map<string, number> };
type Runtime = { api: TelegramApi; abort: AbortController; lock: TelegramLock; epoch: string; cursor: number; ready: boolean; done: Promise<void> };
type Job = { method: string; body: object; signal: AbortSignal; check: () => boolean; resolve: (x: unknown) => void; reject: (e: unknown) => void; cancelled: () => void };

// A bounded Bot API multiplexer, NOT a generic API proxy or remote shell.
// Only this class polls Telegram. Each VPS's existing TelegramBot still owns its
// native input arbitration, per-session confirmations and notification observer.
export class TelegramFleetHub {
  private state: FleetState;
  private peers = new Map<string, Peer>();
  private runtime?: Runtime;
  private timer?: NodeJS.Timeout;
  private checking?: Promise<void>;
  private closing = false;
  private retryAt = 0;
  private selected?: string;
  private jobs: Job[] = [];
  private draining?: Promise<void>;
  private nextSend = 0;
  private status = 'disabled';
  private nextStatus = 0;
  private forwarded = 0;
  private refused = 0;
  constructor(private config: Config, private fleet: FleetController, private test?: { endpoint: string }) {
    if (test && !config.testMode) throw new Error('Fleet fake API requires test mode');
    this.state = new FleetState(config); this.refresh();
  }
  private refresh() {
    const next = this.state.load();
    if (next?.role !== 'controller' || next.local.id !== this.fleet.local.id || !sameBinding(next.binding, this.fleet.binding)) return fail('unavailable');
    const prior = this.fleet; this.fleet = next;
    const nodes = [next.local, ...next.workers];
    for (const [id, peer] of this.peers) {
      const node = nodes.find(n => n.id === id);
      if (!node || (id !== next.local.id && prior.workers.find(n => n.id === id)?.key !== next.workers.find(n => n.id === id)?.key)) {
        peer.registered = false; peer.mailbox = undefined; peer.wake?.(); peer.replies.clear(); peer.callbacks.clear(); this.peers.delete(id);
      } else peer.node = { id: node.id, label: node.label };
    }
    for (const node of nodes) if (!this.peers.has(node.id)) this.peers.set(node.id, { node: { id: node.id, label: node.label }, instance: '', seq: 0, nextUpdate: 0, busy: false, seen: 0, registered: false, replies: new Map(), callbacks: new Map() });
    if (this.selected && !this.peers.has(this.selected)) this.selected = undefined;
  }
  isReady() {
    const r = this.runtime;
    if (this.closing || !r?.ready || r.abort.signal.aborted) return false;
    try {
      const c = this.state.control();
      return c?.enabled === true && c.epoch === r.epoch && this.state.cursor(c.epoch) === r.cursor && sameBinding(currentBinding(this.state), this.fleet.binding);
    } catch { return false; }
  }
  start() {
    if (this.timer || this.closing || (this.config.testMode && !this.test)) return;
    this.timer = setInterval(() => void this.monitor(), 1000); this.timer.unref(); void this.monitor();
  }
  private monitor() { return this.checking ??= this.check().catch(() => { this.status = 'unsafe_or_unavailable'; this.runtime?.abort.abort(); this.runtime?.api.close(); }).finally(() => {
    this.checking = undefined;
    if (Date.now() >= this.nextStatus) {
      this.nextStatus = Date.now() + 10000;
      try { this.state.saveStatus({ version: 1, at: Date.now(), ...this.stats() }); } catch { /* private diagnostics cannot enable controls */ }
    }
  }); }
  private async check() {
    let permitted = false;
    try { this.refresh(); permitted = this.state.control()?.enabled === true && sameBinding(currentBinding(this.state), this.fleet.binding); } catch { this.status = 'unsafe_or_revoked'; }
    const r = this.runtime;
    if (r && (!permitted || this.closing || this.state.control()?.epoch !== r.epoch)) { r.abort.abort(); r.api.close(); this.resetPeers(); await r.done; }
    this.prune();
    if (!permitted || this.closing || this.runtime || Date.now() < this.retryAt) return;
    const lock = new TelegramLock(this.state.dir + '/poller');
    if (!await lock.acquire()) { this.status = 'poller_owned_elsewhere'; return; }
    let api: TelegramApi | undefined;
    try {
      const c = this.state.control(); if (!c?.enabled || this.closing) { await lock.close(); return; }
      api = new TelegramApi(this.state.token(), this.test ? { testMode: true, endpoint: this.test.endpoint } : undefined);
      const run: Runtime = { api, abort: new AbortController(), lock, epoch: c.epoch, cursor: this.state.cursor(c.epoch), ready: false, done: Promise.resolve() };
      this.runtime = run;
      run.done = this.run(run).catch(() => { this.status = 'offline'; this.retryAt = Date.now() + TG_LIMITS.maxBackoffMs; }).finally(async () => {
        run.ready = false; run.abort.abort(); run.api.close(); this.resetPeers(); await this.draining; await lock.close();
        if (this.runtime === run) this.runtime = undefined;
      });
    } catch { api?.close(); await lock.close(); this.status = 'unavailable'; this.retryAt = Date.now() + 5000; }
  }
  private resetPeers() {
    this.selected = undefined;
    for (const p of this.peers.values()) {
      p.registered = false; p.seen = 0; p.mailbox = undefined; p.wake?.(); p.replies.clear(); p.callbacks.clear();
    }
    for (const job of this.jobs.splice(0)) { job.signal.removeEventListener('abort', job.cancelled); job.reject(new TelegramApiError('aborted')); }
  }
  private prune() {
    for (const p of this.peers.values()) {
      if (p.mailbox && p.mailbox.at + FLEET_LIMITS.mailboxMs < Date.now()) p.mailbox = undefined;
      for (const [id, value] of p.replies) if (value.expires <= Date.now()) p.replies.delete(id);
      for (const [id, expires] of p.callbacks) if (expires <= Date.now()) p.callbacks.delete(id);
    }
  }
  private async run(r: Runtime) {
    await verifyBot(r.api, this.fleet.binding.bot, r.abort.signal);
    const next = await discardBacklog(r.api, r.abort.signal);
    if (r.abort.signal.aborted) return;
    r.cursor = next || r.cursor; this.state.claim(r.epoch, r.cursor); r.ready = true;
    let backoff = 300, menuAt = 0;
    while (this.isReady()) {
      try {
        if (Date.now() >= menuAt) {
          menuAt = Date.now() + 60000;
          await this.schedule('setMyCommands', { scope: { type: 'chat', chat_id: this.fleet.binding.owner.chatId }, commands: [{ command: 'servers', description: 'Choose a VPS; notifications stay on for all servers' }, ...BOT_COMMANDS] }, r.abort.signal);
          await this.schedule('setChatMenuButton', { chat_id: this.fleet.binding.owner.chatId, menu_button: { type: 'commands' } }, r.abort.signal);
          menuAt = Infinity;
        }
        const batch = await updates({ call: (method, body, signal) => this.schedule(method, body, signal || r.abort.signal) as never, close() {} }, r.cursor, r.abort.signal);
        for (const update of batch) {
          const id = updateId(update)!; if (id < r.cursor) fail('invalid_response');
          // Claim durably BEFORE choosing or contacting any VPS. A failed link
          // may lose an action/receipt but can never replay it to another server.
          this.state.claim(r.epoch, id + 1); r.cursor = id + 1;
          if (!this.isReady()) break;
          await this.route(update, r);
        }
        this.status = 'polling'; backoff = TG_LIMITS.intervalMs;
      } catch (error) {
        if (!this.isReady()) break;
        this.status = 'offline_or_delivery_failed';
        for (const p of this.peers.values()) p.mailbox = undefined;
        backoff = Math.min(TG_LIMITS.maxBackoffMs, Math.max(1000, backoff * 2, error instanceof TelegramApiError ? error.retryMs : 0));
      }
      await pause(backoff, r.abort.signal);
    }
  }
  private schedule(method: string, body: object, signal: AbortSignal, check = () => this.isReady()): Promise<unknown> {
    if (!check() || signal.aborted) return Promise.reject(new TelegramApiError('aborted'));
    if (this.jobs.length >= FLEET_LIMITS.nodes + 1) return Promise.reject(new TelegramApiError('busy'));
    return new Promise((resolve, reject) => {
      const job: Job = { method, body, signal, check, resolve, reject, cancelled: () => {
        const i = this.jobs.indexOf(job); if (i >= 0) { this.jobs.splice(i, 1); reject(new TelegramApiError('aborted')); }
      } };
      signal.addEventListener('abort', job.cancelled, { once: true }); this.jobs.push(job);
      this.kick();
    });
  }
  private kick() {
    this.draining ??= this.drain().finally(() => { this.draining = undefined; if (this.jobs.length) this.kick(); });
  }
  private async drain() {
    while (this.jobs.length) {
      const job = this.jobs.shift()!;
      try {
        const r = this.runtime; if (!r) throw new TelegramApiError('aborted');
        if (!job.check() || job.signal.aborted) fail('aborted');
        const signal = AbortSignal.any([r.abort.signal, job.signal]);
        if (job.method === 'sendMessage') {
          if (Date.now() < this.nextSend) await pause(this.nextSend - Date.now(), signal);
          this.nextSend = Date.now() + 1050;
        }
        if (!job.check() || signal.aborted) fail('aborted');
        job.resolve(await r.api.call(job.method, job.body, signal));
      } catch (e) { job.reject(e instanceof TelegramApiError ? e : new TelegramApiError('unavailable')); }
      finally { job.signal.removeEventListener('abort', job.cancelled); }
    }
  }
  authorize(id: unknown, bearer: unknown) {
    try {
      this.refresh();
      if (!this.isReady() || !fleetId(id) || typeof bearer !== 'string' || !bearer.startsWith('Bearer ') || !fleetKey(bearer.slice(7))) return false;
      const node = this.fleet.workers.find(p => p.id === id);
      return !!node && timingSafeEqual(Buffer.from(node.key), Buffer.from(bearer.slice(7)));
    } catch { return false; }
  }
  private validPeer(p: Peer, instance: string) { return this.isReady() && this.peers.get(p.node.id) === p && p.instance === instance; }
  // A reverse proxy's upstream socket is not a worker's end-to-end connection:
  // it may close/reuse that hop after a successful RPC while the worker remains
  // healthy. Use authenticated RPC liveness instead. An ABORTED active request
  // still marks the peer offline immediately through its request-scoped signal;
  // idle disconnects/undetected partitions expire after the bounded 30s window.
  async rpc(id: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    this.refresh();
    if (!this.isReady() || signal.aborted || !fleetRecord(input) || !exactKeys(input, ['instance', 'seq', 'method', 'body'])
      || typeof input.instance !== 'string' || !/^[a-f0-9]{32}$/.test(input.instance) || !Number.isSafeInteger(input.seq) || (input.seq as number) < 1
      || typeof input.method !== 'string' || !fleetRecord(input.body)) return fail();
    const p = this.peers.get(id); if (!p || p.busy) return fail('busy');
    const { instance, method, body } = input, seq = input.seq as number;
    if (method === 'getMe' && seq === 1 && p.instance !== instance) {
      p.instance = instance; p.seq = 0; p.nextUpdate = 0; p.registered = false; p.mailbox = undefined; p.replies.clear(); p.callbacks.clear();
    }
    if (p.instance !== instance || seq <= p.seq) return fail('api_rejected');
    p.seq = seq; p.busy = true; p.seen = Date.now();
    const abort = () => { p.registered = false; p.seen = 0; p.mailbox = undefined; p.wake?.(); };
    signal.addEventListener('abort', abort, { once: true });
    const check = () => this.validPeer(p, instance) && !signal.aborted;
    try {
      switch (method) {
        case 'getMe': if (Object.keys(body).length) return fail(); return { ...this.fleet.binding.bot, is_bot: true };
        case 'getWebhookInfo': if (Object.keys(body).length) return fail(); return { url: '' };
        case 'setMyCommands': case 'setChatMenuButton': {
          const chat = method === 'setMyCommands' && fleetRecord(body.scope) ? body.scope.chat_id : body.chat_id;
          if (chat !== this.fleet.binding.owner.chatId) return fail();
          return true; // Only the hub installs the shared menu, including /servers.
        }
        case 'getUpdates': {
          if (!exactKeys(body, ['offset', 'limit', 'timeout', 'allowed_updates']) || !Number.isSafeInteger(body.offset) || (body.offset as number) < -1 || body.limit !== 1 || ![0, 3].includes(body.timeout as number)
              || JSON.stringify(body.allowed_updates) !== '["message","callback_query"]') return fail();
          if (body.offset === -1) { p.mailbox = undefined; return []; }
          // Virtual actor cursors are independent of Telegram's IDs, which may
          // randomize after a week idle. The persisted worker offset establishes
          // a monotonic floor before this peer can receive any new handoff.
          p.nextUpdate = Math.max(p.nextUpdate, body.offset as number);
          p.registered = true;
          if (!p.mailbox && body.timeout === 3) await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); if (p.wake === done) p.wake = undefined; resolve(); };
            const timer = setTimeout(done, 3000); timer.unref(); p.wake = done; signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
          });
          if (!check()) return fail('aborted');
          const item = p.mailbox; p.mailbox = undefined; // consume once BEFORE the HTTP response
          return item && item.at + FLEET_LIMITS.mailboxMs >= Date.now() && updateId(item.value)! >= (body.offset as number) ? [item.value] : [];
        }
        case 'sendMessage': return await this.sendFrom(p, body, signal, check);
        case 'answerCallbackQuery': {
          if (!exactKeys(body, ['callback_query_id', 'text', 'cache_time']) || typeof body.callback_query_id !== 'string' || !p.callbacks.has(body.callback_query_id)
              || (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 200)) || body.cache_time !== 0) return fail();
          p.callbacks.delete(body.callback_query_id);
          return await this.schedule(method, body, signal, check);
        }
        default: return fail();
      }
    } finally { p.busy = false; signal.removeEventListener('abort', abort); }
  }
  private async sendFrom(p: Peer, body: Record<string, unknown>, signal: AbortSignal, check: () => boolean) {
    if (!exactKeys(body, ['chat_id', 'text', 'protect_content', 'link_preview_options', 'reply_markup']) || body.chat_id !== this.fleet.binding.owner.chatId
      || typeof body.text !== 'string' || body.text.length > TG_LIMITS.text || body.protect_content !== true || !fleetRecord(body.link_preview_options) || body.link_preview_options.is_disabled !== true) return fail();
    let markup: Record<string, unknown> | undefined, force = false;
    if (body.reply_markup !== undefined) {
      const value = body.reply_markup;
      if (!fleetRecord(value)) return fail();
      if (value.force_reply === true) {
        if (!exactKeys(value, ['force_reply', 'input_field_placeholder'])) return fail();
        force = true; markup = { force_reply: true, input_field_placeholder: 'Reply to this exact VPS/session (2 minutes)' };
      } else {
        if (!exactKeys(value, ['inline_keyboard']) || !Array.isArray(value.inline_keyboard) || value.inline_keyboard.length > 16) return fail();
        markup = { inline_keyboard: value.inline_keyboard.map(row => {
          if (!Array.isArray(row) || row.length > 8) return fail();
          return row.map(b => {
            if (!fleetRecord(b) || !exactKeys(b, ['text', 'callback_data', 'url']) || typeof b.text !== 'string' || b.text.length > 60) return fail();
            if (typeof b.url === 'string' && b.callback_data === undefined) {
              let url: URL; try { url = new URL(b.url); } catch { return fail(); }
              if (url.protocol !== 'https:' || url.username || url.password || b.url.length > 512) return fail();
              return { text: b.text, url: b.url };
            }
            if (typeof b.callback_data !== 'string' || !innerRoute(b.callback_data) || b.url !== undefined) return fail();
            const data = `f:${p.node.id}:${b.callback_data}`; if (Buffer.byteLength(data) > 64) return fail();
            return { text: b.text, callback_data: data };
          });
        }) };
      }
    }
    if (!force) {
      markup ??= { inline_keyboard: [] };
      (markup.inline_keyboard as object[][]).push([{ text: 'VPS servers', callback_data: 'h:servers' }]);
    }
    let text = `[${p.node.label}]\n${body.text}`.slice(0, TG_LIMITS.text);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    const sent = await this.schedule('sendMessage', { chat_id: this.fleet.binding.owner.chatId, text, protect_content: true, link_preview_options: { is_disabled: true }, reply_markup: markup }, signal, check);
    if (!check() || !privateMessage(sent, true) || sent.from.id !== this.fleet.binding.bot.id || sent.chat.id !== this.fleet.binding.owner.chatId) return fail('invalid_response');
    if (force) {
      while (p.replies.size >= FLEET_LIMITS.replies) p.replies.delete(p.replies.keys().next().value!);
      p.replies.set(sent.message_id, { date: sent.date, expires: Date.now() + TG_LIMITS.expiryMs });
    }
    return this.unwrap(sent, p.node.id);
  }
  private unwrap(message: Message, node: string): Message {
    const markup = message.reply_markup;
    if (!fleetRecord(markup) || !Array.isArray(markup.inline_keyboard)) return message;
    return { ...message, reply_markup: { inline_keyboard: markup.inline_keyboard.slice(0, 17).map(row => Array.isArray(row) ? row.slice(0, 8).map(b => {
      const route = fleetRecord(b) && typeof b.callback_data === 'string' ? fleetRoute(b.callback_data) : undefined;
      return route?.node === node ? { ...b, callback_data: route.data } : b;
    }) : []) } };
  }
  private async tell(text: string, r: Runtime, keyboard?: object[][]) {
    return this.schedule('sendMessage', { chat_id: this.fleet.binding.owner.chatId, text, protect_content: true, link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard || [[{ text: 'VPS servers', callback_data: 'h:servers' }]] } }, r.abort.signal);
  }
  private async servers(r: Runtime) {
    const peers = [...this.peers.values()];
    await this.tell('PocketTerminal VPS servers\nChoose a VPS for new commands. Existing buttons/replies stay bound to their original VPS + session.\n\nNotifications come from ALL connected VPSs, regardless of selection (unless disabled on that VPS).\n\n' + peers.map(p => `${this.selected === p.node.id ? '→ ' : ''}${p.node.label}: ${this.online(p) ? 'Online' : 'Offline / reconnecting'}`).join('\n'), r,
      peers.map(p => [{ text: `${this.online(p) ? '🟢' : '⚫'} ${p.node.label}`, callback_data: 'h:use:' + p.node.id }]));
  }
  private online(p: Peer) { return p.registered && p.seen + FLEET_LIMITS.offlineMs >= Date.now(); }
  private async deliver(node: string, update: Record<string, unknown>, r: Runtime) {
    const p = this.peers.get(node);
    if (!p || !this.online(p) || p.mailbox || p.nextUpdate >= Number.MAX_SAFE_INTEGER - 1) {
      this.refused++;
      const cb = callback(update, this.fleet.binding.bot.id);
      if (cb) await this.schedule('answerCallbackQuery', { callback_query_id: cb.id, text: 'VPS offline or busy. Nothing forwarded.', cache_time: 0 }, r.abort.signal);
      await this.tell(`[${p?.node.label || 'Removed VPS'}] Offline or busy. This command was NOT forwarded, queued offline, rerouted or retried. Use /servers.`, r); return;
    }
    const cb = callback(update, this.fleet.binding.bot.id);
    if (cb) {
      while (p.callbacks.size >= FLEET_LIMITS.callbacks) p.callbacks.delete(p.callbacks.keys().next().value!);
      p.callbacks.set(cb.id, Date.now() + TG_LIMITS.expiryMs);
    }
    p.mailbox = { value: { ...update, update_id: p.nextUpdate++ }, at: Date.now() }; p.wake?.(); this.forwarded++;
  }
  private async route(update: Record<string, unknown>, r: Runtime) {
    this.prune();
    const owner = this.fleet.binding.owner, msg = userMessage(update);
    if (msg && msg.from.id === owner.userId && msg.chat.id === owner.chatId && fresh(msg.date, Date.now(), TG_LIMITS.oldMs) && typeof msg.text === 'string') {
      if (msg.reply_to_message) {
        const original = msg.reply_to_message;
        if (!privateMessage(original, true) || original.from.id !== this.fleet.binding.bot.id || original.chat.id !== owner.chatId) return;
        const matches = [...this.peers.values()].filter(p => p.replies.get(original.message_id)?.date === original.date);
        if (matches.length !== 1) return void await this.tell('Expired/unbound reply. Nothing forwarded. Open the exact VPS/session and request fresh input controls.', r);
        const p = matches[0]!; p.replies.delete(original.message_id);
        return this.deliver(p.node.id, { ...update, message: { ...msg, reply_to_message: this.unwrap(original, p.node.id) } }, r);
      }
      if (new RegExp('^/(servers|start)(?:@' + this.fleet.binding.bot.username + ')?$').test(msg.text)) return this.servers(r);
      if (!this.selected) return this.servers(r);
      return this.deliver(this.selected, update, r);
    }
    const cb = callback(update, this.fleet.binding.bot.id, data => hubRoute(data) || !!fleetRoute(data) || innerRoute(data));
    if (!cb || cb.from.id !== owner.userId || cb.message.chat.id !== owner.chatId) return;
    if (cb.data === 'h:servers') {
      await this.schedule('answerCallbackQuery', { callback_query_id: cb.id, cache_time: 0 }, r.abort.signal); return this.servers(r);
    }
    if (cb.data.startsWith('h:use:')) {
      const id = cb.data.slice(6); if (!this.peers.has(id)) return this.servers(r);
      this.selected = id;
      return this.deliver(id, { ...update, callback_query: { ...cb, data: 'n:sessions:0' } }, r);
    }
    const decoded = fleetRoute(cb.data);
    // Pre-upgrade, unprefixed messages belong ONLY to the original local VPS,
    // never whichever server happens to be selected now.
    const node = decoded?.node || this.fleet.local.id;
    return this.deliver(node, { ...update, callback_query: { ...cb, data: decoded?.data || cb.data, message: this.unwrap(cb.message, node) } }, r);
  }
  localTransport(): TelegramTransport {
    const instance = randomBytes(16).toString('hex'), abort = new AbortController(); let seq = 0;
    return { call: <T>(method: string, body: object, signal?: AbortSignal) => this.rpc(this.fleet.local.id, { instance, seq: ++seq, method, body }, AbortSignal.any([abort.signal, ...(signal ? [signal] : [])])) as Promise<T>, close: () => abort.abort() };
  }
  stats() { return { role: 'controller', status: this.status, telegramPollers: this.runtime?.ready ? 1 : 0, queuedApiRequests: this.jobs.length,
    forwarded: this.forwarded, refused: this.refused, nodes: [...this.peers.values()].map(p => ({ id: p.node.id, label: p.node.label, online: this.online(p), mailboxes: p.mailbox ? 1 : 0, replies: p.replies.size, callbacks: p.callbacks.size, requests: p.busy ? 1 : 0 })) }; }
  async close() { this.closing = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.runtime?.abort.abort(); this.runtime?.api.close(); this.resetPeers(); await this.checking; await this.runtime?.done; await this.draining; }
}
