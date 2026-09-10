import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { Sessions, TerminalRow } from './sessions.js';
import { Bridges } from './bridge.js';
import { HttpError, assertValue } from './errors.js';
import { InputTarget, NativeKey } from './native-input.js';
import { TelegramControl, TelegramLock, TelegramState } from './telegram-state.js';
import { discardBacklog, TG_LIMITS, TelegramApi, TelegramApiError, TelegramTransport, updateId, updates, verifyBot } from './telegram-api.js';
import { callback, fresh, Message, privateMessage, userMessage } from './telegram-update.js';
import { BOT_COMMANDS, navigationData, parseNavigation, SESSION_COMMANDS, SessionCommand, sessionCommand } from './telegram-ui.js';
import { AgentNotices, agentRequest, rejected, type AgentMessage } from './agent-notices.js';

type Action = 'sessions' | 'select' | 'kinds' | 'projects' | 'create' | 'rename' | 'text' | 'prompt' | 'key' | 'output' | 'stop' | 'delete' | 'take' | 'release' | 'exit_history' | 'notifications' | 'help' | 'cancel' | 'picker' | 'choose';
interface Bound {
  action: Action; id?: string; target?: InputTarget; stamp?: string; key?: NativeKey;
  kind?: 'shell' | 'codex'; project?: string; offset?: number; confirmed?: boolean; enabled?: boolean; command?: SessionCommand;
}
interface Entry extends Bound { expires: number; messageId: number; date: number }
type Button = { text: string; bound: Bound } | { text: string; url: string };
interface Runtime { control: TelegramControl; api: TelegramTransport; abort: AbortController; lock: TelegramLock; done: Promise<void>; cursor: number }
export interface TelegramDriver { state?: TelegramState; factory: () => TelegramTransport; lockName?: 'fleet-local'; enabled?: () => boolean; runtimeValid?: (api: TelegramTransport) => boolean }
type Observation = { lifecycle: string; activity: string; createdAt: number };
type Notice = 'stopped' | 'exited' | 'error' | 'awaiting_input' | 'ready';
export function telegramCommand(text: string, botUsername: string) {
  if (text.length > 160) return;
  const match = /^\/(\w+)(?:@([A-Za-z][A-Za-z0-9_]{4,31}))?(?: ([a-f0-9]{32}))?$/.exec(text);
  if (!match || (match[2] && match[2] !== botUsername)) return;
  return { cmd: match[1]!, id: match[3] };
}
const projectId = (value: string) => createHash('sha256').update(value).digest('hex');
const safeLabel = (value: string) => value.replace(/[\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 80);
export function telegramText(value: string, limit: number = TG_LIMITS.text) {
  let text = value.slice(0, limit);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text || '(empty)';
}
export function telegramStatus(description: { lifecycle: string; activity: string }) {
  if (description.lifecycle === 'running') return description.activity === 'working' ? 'Working' : description.activity === 'awaiting_input' ? 'Input needed' : description.activity === 'ready' ? 'Ready for input (not a success claim)' : description.activity === 'unknown' ? 'Running · activity unknown' : 'Running · activity not reported';
  return ({ starting: 'Starting', stopping: 'Stopping', stopped: 'Stopped', exited: 'Exited', error: 'Error (verified start/exit failure)', unknown: 'Unknown lifecycle' } as Record<string, string>)[description.lifecycle] || 'Unknown';
}
export function notification(previous: Observation | undefined, next: Observation): Notice | undefined {
  if (!previous) return;
  if (previous.lifecycle !== next.lifecycle && ['stopped', 'exited', 'error'].includes(next.lifecycle)) return next.lifecycle as Notice;
  if (next.lifecycle !== 'running' || previous.lifecycle !== 'running') return;
  if (next.activity === 'awaiting_input' && previous.activity !== 'awaiting_input') return 'awaiting_input';
  if (previous.activity === 'working' && next.activity === 'ready') return 'ready';
}

// One sequential completion-scheduled loop: one tiny long-poll batch, one API
// request, at most one side effect, no retry/outbox of terminal text. Inactive
// sessions retain only bounded IDs/enums. The 1s monitor is an independent
// emergency-disable fence while the long-poll/native operation is awaiting I/O.
export class TelegramBot {
  readonly state: TelegramState;
  private runtime?: Runtime;
  private monitoring?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private sleeper?: NodeJS.Timeout;
  private closing = false;
  private retryAt = 0;
  private fleetStartupBackoff = 1000;
  private actions = new Map<string, Entry>();
  private replies = new Map<number, Entry>();
  private baseline = new Map<string, Observation>();
  private pending = new Map<string, Notice>();
  private baselineReady = false;
  private nextReconcile = 0;
  private nextSend = 0;
  private cleanedStartup = false;
  private notifications = true;
  private status = 'disabled';
  private effects = 0;
  private accepted = 0;
  private rejected = 0;
  private now: () => number;
  private supported: boolean;
  private agentNotices: AgentNotices;
  private agentResolving = false;
  constructor(private sessions: Sessions, private bridges: Bridges, private config: Config, private test?: { endpoint: string; now?: () => number }, private driver?: TelegramDriver) {
    if (test && !config.testMode) throw new Error('Telegram fake transport requires isolated test mode');
    this.now = test?.now || Date.now;
    this.agentNotices = new AgentNotices(this.now);
    this.supported = !config.testMode || !!test;
    this.state = driver?.state || new TelegramState(config);
  }
  start() {
    if (!this.supported || this.timer || this.closing) return;
    this.timer = setInterval(() => { this.prune(); void this.monitor(); }, 1000); this.timer.unref();
    void this.monitor();
  }
  private enabled(runtime: Runtime) {
    if (this.closing || runtime.abort.signal.aborted || this.driver?.enabled?.() === false || this.driver?.runtimeValid?.(runtime.api) === false) return false;
    try {
      const c = this.state.control();
      return !!c?.enabled && c.epoch === runtime.control.epoch && c.botId === runtime.control.botId && c.botUsername === runtime.control.botUsername && c.owner?.chatId === runtime.control.owner?.chatId && c.owner?.userId === runtime.control.owner?.userId
        && this.state.cursor(c.epoch) === runtime.cursor && typeof this.state.notifications(c.epoch) === 'boolean';
    } catch { return false; }
  }
  private guard(r = this.runtime): asserts r is Runtime { assertValue(r && this.enabled(r), 409, 'telegram_disabled'); }
  private monitor() { return this.monitoring ??= this.check().finally(() => { this.monitoring = undefined; }); }
  private async check() {
    if (this.closing || !this.supported) return;
    let control: TelegramControl | undefined;
    try { control = this.state.control(); } catch { this.status = 'unsafe_state'; }
    const current = this.runtime;
    if (current && (!control?.enabled || !this.enabled(current))) {
      current.abort.abort(); current.api.close();
      await this.bridges.releaseTelegram(); await current.done;
    }
    if (!control?.enabled) {
      if (control || this.status !== 'unsafe_state') this.status = control?.owner ? 'disabled' : 'unpaired';
      if (!this.cleanedStartup && this.now() >= this.retryAt) {
        const lock = new TelegramLock(this.state.dir + '/' + (this.driver?.lockName || 'poller'));
        try {
          if (await lock.acquire()) { await this.bridges.telegramStartup(); this.cleanedStartup = true; }
        } catch { this.retryAt = this.now() + TG_LIMITS.maxBackoffMs; }
        finally { await lock.close(); }
      }
      return;
    }
    if (this.runtime || this.closing || this.now() < this.retryAt) return;
    if (this.driver?.enabled?.() === false) { this.status = 'fleet_controller_unavailable'; return; }
    const lock = new TelegramLock(this.state.dir + '/' + (this.driver?.lockName || 'poller'));
    let api: TelegramTransport | undefined;
    try {
      if (!await lock.acquire()) { this.status = 'poller_owned_elsewhere'; return; }
      if (this.closing || this.state.control()?.epoch !== control.epoch || !this.state.control()?.enabled) { await lock.close(); return; }
      const cursor = this.state.cursor(control.epoch); this.notifications = this.state.notifications(control.epoch);
      api = this.driver ? this.driver.factory() : new TelegramApi(this.state.token(), this.test ? { testMode: true, endpoint: this.test.endpoint } : undefined);
      const runtime: Runtime = { control, cursor, api, abort: new AbortController(), lock, done: Promise.resolve() };
      this.runtime = runtime; this.status = 'starting';
      runtime.done = this.run(runtime).catch(() => {
        this.status = 'unavailable'; this.retryAt = this.now() + (this.driver ? this.fleetStartupBackoff : TG_LIMITS.maxBackoffMs);
        this.fleetStartupBackoff = Math.min(TG_LIMITS.maxBackoffMs, this.fleetStartupBackoff * 2);
      }).finally(async () => {
        runtime.abort.abort(); runtime.api.close();
        this.actions.clear(); this.replies.clear(); this.baseline.clear(); this.pending.clear(); this.baselineReady = false;
        this.agentNotices.clear('unavailable');
        await this.bridges.releaseTelegram(); await lock.close();
        if (this.runtime === runtime) this.runtime = undefined;
      });
    } catch {
      api?.close(); await lock.close(); this.status = 'unsafe_or_unavailable'; this.retryAt = this.now() + TG_LIMITS.maxBackoffMs;
    }
  }
  private sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => { if (this.sleeper) clearTimeout(this.sleeper); this.sleeper = undefined; signal.removeEventListener('abort', done); resolve(); };
      this.sleeper = setTimeout(done, ms); this.sleeper.unref(); signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
  private async run(r: Runtime) {
    // Exclusive poller lock already held. Delete only the app-reserved buffer,
    // including an orphan from a process crash; never read or replay its bytes.
    await this.bridges.telegramStartup(); this.cleanedStartup = true; this.guard(r);
    await verifyBot(r.api, this.state.identity(), r.abort.signal); this.guard(r);
    const next = await discardBacklog(r.api, r.abort.signal); this.guard(r);
    // Telegram may randomize update IDs after a week idle. A nonempty -1 result
    // is a new confirmed backlog boundary, not a replay opportunity.
    const boundary = next || r.cursor; this.state.claim(r.control.epoch, boundary); r.cursor = boundary;
    this.fleetStartupBackoff = 1000;
    this.baselineReady = false; this.nextReconcile = 0;
    let backoff = TG_LIMITS.intervalMs as number, menuRetryAt = 0, menuReady = false;
    while (this.enabled(r)) {
      this.prune();
      try {
        // Idempotent, owner-chat-scoped setup; failure must not disable terminal
        // control. Retry at most once/minute in this same sequential loop.
        if (!menuReady && this.now() >= menuRetryAt) {
          menuRetryAt = this.now() + TG_LIMITS.maxBackoffMs;
          try {
            this.guard(r);
            const commands = await r.api.call('setMyCommands', { scope: { type: 'chat', chat_id: r.control.owner!.chatId }, commands: BOT_COMMANDS }, r.abort.signal);
            this.guard(r);
            const button = await r.api.call('setChatMenuButton', { chat_id: r.control.owner!.chatId, menu_button: { type: 'commands' } }, r.abort.signal);
            this.guard(r); menuReady = commands === true && button === true;
          } catch { this.guard(r); }
        }
        await this.observe(r); this.guard(r);
        const batch = await updates(r.api, r.cursor, r.abort.signal); this.guard(r);
        for (const update of batch) {
          const id = updateId(update)!;
          if (id < r.cursor) throw new TelegramApiError('invalid_response');
          // Synchronous atomic write + file+directory fsync, BEFORE any action or
          // acknowledgement. A crash loses an action; it never replays one.
          this.state.claim(r.control.epoch, id + 1); r.cursor = id + 1;
          this.guard(r); await this.handle(update, r);
        }
        // Local agents enqueue only. All actual sends remain inside this actor,
        // AFTER owner controls, using its one transport and existing send pace.
        await this.sendAgentNotice(r); this.guard(r);
        this.status = 'polling'; backoff = TG_LIMITS.intervalMs;
      } catch (error) {
        if (!this.enabled(r)) break;
        this.pending.clear(); // no offline alert/outbox growth or delivery retry
        this.agentNotices.clear('unavailable');
        this.status = 'offline_or_action_failed';
        backoff = Math.min(TG_LIMITS.maxBackoffMs, Math.max(1000, backoff * 2, error instanceof TelegramApiError ? error.retryMs : 0));
      }
      await this.sleep(backoff, r.abort.signal);
    }
  }
  private prune() {
    const now = this.now();
    for (const [key, entry] of this.actions) if (entry.expires <= now) this.actions.delete(key);
    for (const [key, entry] of this.replies) if (entry.expires <= now) this.replies.delete(key);
    this.agentNotices.prune();
    if (this.agentNotices.hasPending && !this.agentEnabled()) this.agentNotices.clear('notifications_unavailable');
  }
  private agentEnabled() {
    try { return !!this.runtime && this.enabled(this.runtime) && this.state.notifications(this.runtime.control.epoch); }
    catch { return false; }
  }
  async notifyAgent(value: unknown, signal: AbortSignal) {
    const request = agentRequest(value), r = this.runtime;
    if (!r || !this.agentEnabled() || this.status !== 'polling') return rejected('notifications_unavailable');
    if (this.agentResolving) return rejected('context_busy');
    this.agentResolving = true;
    let message: AgentMessage;
    try {
      let session = request.session;
      if (request.tmux) {
        const t = request.tmux;
        // A pane number alone can collide on another tmux server. Verify the
        // inherited socket path AND server PID; never guess from cwd or titles.
        const output = await this.sessions.tmux(['display-message', '-p', '-t', t.pane, '#{socket_path}\t#{pid}\t#{session_name}\t#{pane_id}\t#{pane_dead}']);
        const [socket, pid, name, pane, dead, extra] = output.trimEnd().split('\t');
        assertValue(socket === t.socket && pid === String(t.pid) && pane === t.pane && dead === '0' && !extra
          && /^pt_[a-f0-9]{32}$/.test(name || ''), 409, 'unmanaged_terminal_use_unlinked');
        session = name!.slice(3);
      }
      if (session) this.sessions.get(session); // exact existing metadata; no terminal content read
      message = { kind: request.kind, text: request.text.trim(), ...(session ? { session } : { project: request.project }) };
    } finally { this.agentResolving = false; }
    if (r !== this.runtime || !this.agentEnabled()) return rejected('notifications_unavailable');
    return this.agentNotices.enqueue(message, r.control.epoch, signal);
  }
  private async sendAgentNotice(r: Runtime) {
    if (!this.agentNotices.hasPending) return;
    if (!this.agentEnabled()) { this.agentNotices.clear('notifications_unavailable'); return; }
    const entry = this.agentNotices.take(r.control.epoch);
    if (!entry) return;
    let attempted = false;
    try {
      const row = entry.session ? this.sessions.get(entry.session) : undefined;
      const kind = { progress: '📌 Progress', blocked: '🚧 Blocked', question: '❓ Input needed', done: '✅ Done (agent-reported)', error: '⚠️ Error (agent-reported)' }[entry.kind];
      const source = row ? this.targetText(row) : 'Unlinked agent (no managed session)' + (entry.project ? '\nProject: ' + safeLabel(entry.project) : '');
      // No parse_mode, preview, arbitrary recipient or automatic terminal input.
      // Agent-authored claims are deliberately distinct from native observations.
      await this.send(`${kind}\n${source}\nAgent-written update, not independently verified:\n\n${entry.text}`, [[{ text: row ? 'Target controls' : 'Sessions', bound: row ? { action: 'select', id: row.id } : { action: 'sessions' } }]], false,
        () => { assertValue(!entry.settled && this.agentEnabled(), 409, 'notification_cancelled'); attempted = true; });
      this.agentNotices.finish(entry, { status: 'sent', code: 'telegram_accepted' }, true);
    } catch (error) {
      // A disable/guard failure AFTER the API call is not proof of non-delivery.
      this.agentNotices.finish(entry, !attempted && error instanceof HttpError ? rejected(error.code) : { status: 'uncertain', code: 'delivery_unknown' }, true);
      if (error instanceof TelegramApiError) throw error;
    }
  }
  private async send(text: string, rows?: Button[][], forceReply?: boolean, beforeSend?: () => void): Promise<Message> {
    const r = this.runtime; this.guard(r);
    // Private-chat output is paced to <=1 message/second. One pending operation,
    // using the loop's same sleep slot, not an outbox or a per-message timer queue.
    if (Date.now() < this.nextSend) await this.sleep(this.nextSend - Date.now(), r.abort.signal);
    this.guard(r); beforeSend?.(); this.nextSend = Date.now() + 1050;
    const nonces: string[] = [];
    // A stale one-use action can always reopen its exact target safely. Never
    // recover by parsing labels/output, guessing a terminal, or replaying input.
    let buttons = rows;
    const stateful = rows?.flat().filter((b): b is { text: string; bound: Bound } => 'bound' in b && !navigationData(b.bound)) || [];
    const target = stateful[0]?.bound.id;
    if (target && stateful.every(b => b.bound.id === target)) buttons = [...rows!, [{ text: 'Refresh controls', bound: { action: 'select', id: target } }]];
    const keyboard = buttons?.map(row => row.map(button => {
      if ('url' in button) return { text: telegramText(button.text, 60), url: button.url };
      const navigation = navigationData(button.bound);
      if (navigation) return { text: telegramText(button.text, 60), callback_data: navigation };
      while (this.actions.size >= TG_LIMITS.actions) this.actions.delete(this.actions.keys().next().value!);
      const nonce = 'p:' + randomBytes(16).toString('base64url'); nonces.push(nonce);
      this.actions.set(nonce, { ...button.bound, expires: this.now() + TG_LIMITS.expiryMs, messageId: 0, date: 0 });
      return { text: telegramText(button.text, 60), callback_data: nonce };
    }));
    try {
      const sent = await r.api.call<unknown>('sendMessage', { chat_id: r.control.owner!.chatId, text: telegramText(text),
        protect_content: true, link_preview_options: { is_disabled: true },
        ...(forceReply ? { reply_markup: { force_reply: true, input_field_placeholder: 'Reply to this exact target (2 minutes)' } } : keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }, r.abort.signal);
      this.guard(r);
      if (!privateMessage(sent, true) || sent.from.id !== r.control.botId || sent.chat.id !== r.control.owner!.chatId) throw new TelegramApiError('invalid_response');
      for (const nonce of nonces) { const entry = this.actions.get(nonce); if (entry) { entry.messageId = sent.message_id; entry.date = sent.date; } }
      return sent;
    } catch (e) { for (const nonce of nonces) this.actions.delete(nonce); throw e; }
  }
  private targetText(row: TerminalRow) { return `${safeLabel(row.label)}\nTarget: ${row.id}`; }
  private cancelSiblings(messageId: number) {
    for (const [nonce, item] of this.actions) if (item.messageId === messageId) this.actions.delete(nonce);
  }
  private async refreshControls(message: Message) {
    const keyboard = (message.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard;
    if (Array.isArray(keyboard)) for (const row of keyboard.slice(0, 16)) {
      if (!Array.isArray(row)) continue;
      for (const button of row.slice(0, 8)) {
        if (!button || !['Refresh controls', 'Refresh choices'].includes(button.text) || typeof button.callback_data !== 'string') continue;
        const navigation = parseNavigation(button.callback_data);
        if (navigation?.action === 'select' || navigation?.action === 'picker') {
          try { await this.action(navigation); return; }
          catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
        }
      }
    }
    await this.catalog(0);
  }
  private async handle(update: Record<string, unknown>, r: Runtime) {
    const msg = userMessage(update), cb = callback(update, r.control.botId!);
    const owner = r.control.owner!;
    if (msg && msg.from.id === owner.userId && msg.chat.id === owner.chatId && fresh(msg.date, this.now(), TG_LIMITS.oldMs) && typeof msg.text === 'string') {
      this.accepted++;
      try {
        // Bound replies FIRST. A prompt starting /stop or /new is literal text,
        // never a slash command. Unbound replies never become terminal input.
        if (msg.reply_to_message) {
          const original = msg.reply_to_message, entry = this.replies.get(original.message_id);
          if (!entry || !privateMessage(original, true) || original.from.id !== r.control.botId || original.chat.id !== owner.chatId || entry.date !== original.date || entry.expires <= this.now()) return void await this.send('Expired/unbound reply. No action taken. Use /sessions and the target’s buttons.');
          this.replies.delete(original.message_id);
          await this.reply(entry, msg.text); return;
        }
        await this.command(msg.text);
      } catch (error) { await this.actionError(error); }
      return;
    }
    if (cb && cb.from.id === owner.userId && cb.message.chat.id === owner.chatId) {
      const navigation = parseNavigation(cb.data);
      if (navigation) {
        this.accepted++;
        await r.api.call('answerCallbackQuery', { callback_query_id: cb.id, cache_time: 0 }, r.abort.signal);
        try {
          this.guard(r);
          if (navigation.action === 'cancel') this.cancelSiblings(cb.message.message_id);
          await this.action(navigation);
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) await this.catalog(0);
          else await this.actionError(error);
        }
        return;
      }
      const entry = this.actions.get(cb.data);
      if (!entry || entry.messageId !== cb.message.message_id || entry.date !== cb.message.date || entry.expires <= this.now()) {
        await r.api.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Controls refreshed. Nothing was sent; use the new buttons.', cache_time: 0 }, r.abort.signal);
        try { this.guard(r); await this.refreshControls(cb.message); } catch (error) { await this.actionError(error); }
        return;
      }
      // Consuming any button cancels its sibling confirmations/menu controls.
      // A later tap on an old Confirm after Cancel can never execute it.
      this.cancelSiblings(entry.messageId);
      this.accepted++;
      await r.api.call('answerCallbackQuery', { callback_query_id: cb.id, cache_time: 0 }, r.abort.signal);
      try { this.guard(r); await this.action(entry); } catch (error) { await this.actionError(error); }
      return;
    }
    this.rejected = Math.min(Number.MAX_SAFE_INTEGER, this.rejected + 1);
    // No replies, per-attacker state, title/output reads or command work.
  }
  private async actionError(error: unknown) {
    if (error instanceof TelegramApiError) throw error;
    this.guard();
    const code = error instanceof HttpError ? error.code : 'action_uncertain';
    await this.send(`Action not confirmed (${code}). It was NOT retried. Input/effects may be partial if interrupted; inspect the explicit target before sending anything again. Use /sessions for fresh controls.`);
  }
  private async command(text: string) {
    if (text.length > 160) return void await this.send('Unbound text is never sent to a terminal. Use /sessions → target → Send text / Send prompt, then reply to that exact message.');
    const match = telegramCommand(text, this.state.identity().username);
    if (!match) return void await this.send('Use /sessions, /new, /help, /website or /notifications. Unbound text is never executed; /commands inside a bound input reply are literal.');
    const { cmd, id } = match;
    if (['start', 'help'].includes(cmd) && !id) return this.help();
    if (cmd === 'website' && !id) return void await this.send(this.config.origin);
    if (cmd === 'sessions' && !id) return this.catalog(0);
    if (cmd === 'new' && !id) return this.kinds();
    if (cmd === 'notifications' && !id) return this.notificationMenu();
    if (cmd === 'cancel' && !id) { this.actions.clear(); this.replies.clear(); return void await this.send('Pending replies/buttons cancelled. No input sent; jobs continue.'); }
    const actions: Record<string, Action> = { select: 'select', rename: 'rename', send: 'text', paste: 'text', prompt: 'prompt', output: 'output', stop: 'stop', delete: 'delete', take: 'take', release: 'release', live: 'exit_history' };
    const keys: Record<string, NativeKey> = { enter: 'Enter', esc: 'Escape', tab: 'Tab', up: 'Up', down: 'Down', left: 'Left', right: 'Right', interrupt: 'C-c' };
    if (!id && sessionCommand(cmd)) return this.picker(cmd, 0);
    if (!id || !sessionCommand(cmd)) return this.help();
    const bound: Bound = { action: keys[cmd] ? 'key' : actions[cmd]!, id, key: keys[cmd] };
    if (['text', 'prompt', 'key', 'take', 'release', 'exit_history'].includes(bound.action)) {
      bound.target = await this.bridges.telegramTarget(id, this.runtime!.abort.signal); bound.stamp = this.bridges.controller(id).stamp;
      // Direct commands for keys are still a two-step explicit-target button.
      if (keys[cmd]) return void await this.send(`${this.targetText(this.sessions.get(id))}\nSend ${cmd === 'interrupt' ? 'Ctrl+C (interrupt)' : keys[cmd]}?`, [[{ text: 'Send ' + (keys[cmd] === 'C-c' ? 'Ctrl+C' : keys[cmd]), bound }], this.cancelRow()]);
    }
    await this.action(bound);
  }
  private cancelRow(): Button[] { return [{ text: 'Cancel / sessions', bound: { action: 'cancel' } }]; }
  private async help() {
    await this.send(`PocketTerminal ROOT control · @${this.state.identity().username}\nUse Telegram’s Menu button beside the message field. Commands such as /prompt or /output ask you to choose a session; no ID typing required. Explicit /prompt ID etc. still work.\n\n/sessions — list/select/page; each action names its target\n/new — Codex or shell in an existing allowed project\n/select · /send · /paste · /prompt · /rename\n/output · /stop · /delete · /take · /release · /live\n/enter · /esc · /tab · /up · /down · /left · /right · /interrupt\n/website · /notifications · /cancel · /help\n\nNavigation and recent-output buttons are reusable. Old/used terminal actions only refresh controls: NOTHING is replayed; use the new buttons. Keys/input return fresh controls automatically.\nReply to the bot’s exact 2-minute input request. Other text is NEVER executed. Paste is literal (4 KiB), prompt adds Enter; Ctrl+C interrupts. Exit history cancels tmux copy mode, not shell input.\n\nBrowsers and Telegram share control; SSH is independent. Existing/older Codex and shells may not report activity. Ready/turn finished is NOT task success; internal CLI errors are not detected unless the job exits with a verified error. Notifications use observed native state only; short transitions may be missed. Telegram bot chats are NOT end-to-end encrypted. Do not send secrets.`, [[{ text: 'Sessions', bound: { action: 'sessions' } }, { text: 'New session', bound: { action: 'kinds' } }], [{ text: 'Notifications', bound: { action: 'notifications' } }]]);
  }
  private async catalog(offset: number) {
    await this.sessions.reconcile(); this.guard();
    offset = Number.isInteger(offset) ? Math.max(0, Math.min(175, offset)) : 0;
    const rows = this.sessions.list(5, offset);
    const buttons: Button[][] = rows.map(row => [{ text: safeLabel(row.label), bound: { action: 'select', id: row.id } }]);
    const nav: Button[] = [];
    if (offset) nav.push({ text: 'Previous', bound: { action: 'sessions', offset: Math.max(0, offset - 5) } });
    if (rows.length === 5 && offset < 175) nav.push({ text: 'Next', bound: { action: 'sessions', offset: offset + 5 } });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: 'New session', bound: { action: 'kinds' } }, { text: 'Help', bound: { action: 'help' } }, { text: 'Open website', url: this.config.origin }]);
    await this.send(`Sessions ${offset + 1}–${offset + rows.length}\n${rows.length ? rows.map(row => `${this.targetText(row)}\n${telegramStatus(this.sessions.describe(row))}`).join('\n\n') : 'No entries on this page.'}\n\nSelect a target below. ${this.config.origin}`, buttons);
  }
  private async picker(command: SessionCommand, offset: number) {
    assertValue(sessionCommand(command), 400, 'unknown_command');
    await this.sessions.reconcile(); this.guard();
    offset = Number.isInteger(offset) ? Math.max(0, Math.min(175, offset)) : 0;
    const rows = this.sessions.list(5, offset);
    const buttons: Button[][] = rows.map(row => [{ text: safeLabel(row.label), bound: { action: 'choose', command, id: row.id } }]);
    const nav: Button[] = [];
    if (offset) nav.push({ text: 'Previous', bound: { action: 'picker', command, offset: offset - 5 } });
    if (rows.length === 5 && offset < 175) nav.push({ text: 'Next', bound: { action: 'picker', command, offset: offset + 5 } });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: 'Refresh choices', bound: { action: 'picker', command, offset } }], this.cancelRow());
    await this.send(`/${command} — ${SESSION_COMMANDS[command]}\nChoose the exact session below. No terminal input has been sent.\n\n${rows.length ? rows.map(row => `${this.targetText(row)}\n${telegramStatus(this.sessions.describe(row))}`).join('\n\n') : 'No entries on this page.'}`, buttons);
  }
  private async selected(id: string, receipt?: string) {
    await this.sessions.reconcile(); this.guard();
    // Only one fresh set of action buttons per target. Input replies retain
    // their immutable original binding; selecting a menu never retargets them.
    for (const [nonce, entry] of this.actions) if (entry.id === id) this.actions.delete(nonce);
    const row = this.sessions.get(id), description = this.sessions.describe(row), controller = this.bridges.controller(id);
    const buttons: Button[][] = [];
    if (row.state === 'running' && description.lifecycle === 'running') {
      const target = await this.bridges.telegramTarget(id, this.runtime!.abort.signal);
      const base = { id, target, stamp: controller.stamp };
      buttons.push([{ text: 'Send text / paste', bound: { ...base, action: 'text' } }, { text: 'Send prompt + Enter', bound: { ...base, action: 'prompt' } }]);
      buttons.push([{ text: 'Enter', bound: { ...base, action: 'key', key: 'Enter' } }, { text: 'Esc', bound: { ...base, action: 'key', key: 'Escape' } }, { text: 'Tab', bound: { ...base, action: 'key', key: 'Tab' } }, { text: 'Ctrl+C', bound: { ...base, action: 'key', key: 'C-c' } }]);
      buttons.push((['Up', 'Down', 'Left', 'Right'] as NativeKey[]).map(key => ({ text: key, bound: { ...base, action: 'key', key } })));
      buttons.push([{ text: 'Recent output', bound: { id, action: 'output' } }, { text: 'Exit history', bound: { ...base, action: 'exit_history' } }]);
      buttons.push([{ text: controller.kind === 'telegram' ? 'Release control' : 'Take control', bound: { ...base, action: controller.kind === 'telegram' ? 'release' : 'take' } }]);
      buttons.push([{ text: 'Stop…', bound: { action: 'stop', id } }]);
    } else if (row.state === 'stopped') buttons.push([{ text: 'Delete stopped entry…', bound: { action: 'delete', id } }]);
    buttons.push([{ text: 'Rename', bound: { action: 'rename', id } }, { text: 'Open website', url: this.config.origin }], this.cancelRow());
    await this.send(`${receipt ? receipt + '\n\n' : ''}${this.targetText(row)}\n${telegramStatus(description)}\nInput controller: ${controller.kind}.\nAll buttons target this entry, not a mutable selection.`, buttons);
  }
  private async inputReceipt(id: string, receipt: string) {
    try { await this.selected(id, receipt); }
    catch (error) {
      // A shell may exit/change pane immediately after accepted input. Keep
      // the acceptance receipt honest without retrying any API or root action.
      if (error instanceof TelegramApiError) throw error;
      this.guard();
      await this.send(receipt, [[{ text: 'Target controls', bound: { action: 'select', id } }]]);
    }
  }
  private async kinds() { await this.send('Create a NEW root job. Choose kind; existing jobs are never reused/restarted.', [[{ text: 'Codex', bound: { action: 'projects', kind: 'codex', offset: 0 } }, { text: 'Shell', bound: { action: 'projects', kind: 'shell', offset: 0 } }], this.cancelRow()]); }
  private async projects(kind: 'codex' | 'shell', offset: number) {
    const projects = this.sessions.projects(), shown = projects.slice(offset, offset + 5);
    const buttons: Button[][] = shown.map(project => [{ text: project.name, bound: { action: 'create', kind, project: projectId(project.path) } }]);
    if (offset) buttons.push([{ text: 'Previous projects', bound: { action: 'projects', kind, offset: Math.max(0, offset - 5) } }]);
    if (offset + 5 < projects.length) buttons.push([{ text: 'More projects', bound: { action: 'projects', kind, offset: offset + 5 } }]);
    buttons.push(this.cancelRow());
    await this.send(`New ${kind}. Existing allowed directories only:\n${shown.map(p => p.path).join('\n')}`, buttons);
  }
  private async inputLease(bound: Bound) {
    assertValue(bound.id && bound.target && bound.stamp !== undefined, 400, 'explicit_target_required');
    this.guard();
    const owner = this.bridges.controller(bound.id);
    assertValue(owner.stamp === bound.stamp, 409, 'controller_changed');
    if (owner.kind === 'browser') {
      await this.send(`${this.targetText(this.sessions.get(bound.id))}\nBrowser owns input. Nothing was sent. Explicitly take control first; this discards its queued input.`, [[{ text: 'Take control from browser…', bound: { ...bound, action: 'take' } }], this.cancelRow()]);
      return undefined;
    }
    return this.bridges.takeTelegram(bound.id, bound.stamp);
  }
  private async requestReply(bound: Bound) {
    const id = bound.id!, row = this.sessions.get(id);
    let stamp = bound.stamp;
    if (bound.action !== 'rename') { stamp = await this.inputLease(bound); if (stamp === undefined) return; }
    const purpose = bound.action === 'rename' ? 'new label (80 characters)' : bound.action === 'prompt' ? 'literal prompt; Enter will follow' : 'literal text/paste; NO extra Enter';
    const sent = await this.send(`${this.targetText(row)}\nReply to THIS exact message with ${purpose}. Expires in 2 minutes. Input ≤4 KiB; /commands here are literal. Nothing is replayed after failure.`, undefined, true);
    while (this.replies.size >= TG_LIMITS.replies) this.replies.delete(this.replies.keys().next().value!);
    this.replies.set(sent.message_id, { ...bound, stamp, messageId: sent.message_id, date: sent.date, expires: this.now() + TG_LIMITS.expiryMs });
  }
  private async reply(bound: Entry, text: string) {
    this.guard();
    if (bound.action === 'rename') { this.sessions.rename(bound.id!, text); this.effects++; await this.selected(bound.id!); return; }
    assertValue(bound.target && bound.stamp && (bound.action === 'text' || bound.action === 'prompt'), 400, 'unbound_input');
    this.effects++;
    const r = this.runtime!;
    await this.bridges.telegramInput(bound.target, bound.stamp, { kind: bound.action, text }, () => this.enabled(r));
    await this.inputReceipt(bound.id!, `Input accepted by tmux for target ${bound.id}. This does not prove CLI processing/task success. It will not be replayed.`);
  }
  private async action(bound: Bound) {
    this.guard();
    const id = bound.id;
    switch (bound.action) {
      case 'help': return this.help();
      case 'sessions': return this.catalog(bound.offset || 0);
      case 'select': return this.selected(id!);
      case 'kinds': return this.kinds();
      case 'projects': return this.projects(bound.kind!, bound.offset || 0);
      case 'picker': return this.picker(bound.command!, bound.offset || 0);
      case 'choose': {
        assertValue(bound.command && sessionCommand(bound.command) && id && /^[a-f0-9]{32}$/.test(id), 400, 'explicit_target_required');
        return this.command(`/${bound.command} ${id}`);
      }
      case 'create': {
        const project = this.sessions.projects().find(p => projectId(p.path) === bound.project);
        assertValue(project && (bound.kind === 'codex' || bound.kind === 'shell'), 409, 'project_changed');
        if (!bound.confirmed) return void await this.send(`Create ONE new ${bound.kind} root job in:\n${project.path}\nNo retry if uncertain; Codex may incur model costs when used.`, [[{ text: 'Confirm create ' + bound.kind, bound: { ...bound, confirmed: true } }], this.cancelRow()]);
        // Validate asynchronous cwd lookup, then recheck the independent disable
        // fence immediately before the session reservation/spawn side effect.
        this.effects++;
        const row = await this.sessions.create({ kind: bound.kind, cwd: project.path }, () => this.guard());
        return this.selected(row.id);
      }
      case 'rename': case 'text': case 'prompt': return this.requestReply(bound);
      case 'key': case 'exit_history': {
        const stamp = await this.inputLease(bound); if (stamp === undefined) return;
        const r = this.runtime!; this.effects++;
        await this.bridges.telegramInput(bound.target!, stamp, bound.action === 'key' ? { kind: 'key', key: bound.key! } : { kind: 'exit_history' }, () => this.enabled(r));
        return this.inputReceipt(id!, `${bound.action === 'key' ? 'Key accepted by tmux' : 'History exit requested (no shell keys)'} for target ${id}. No retry/replay.`);
      }
      case 'take': {
        assertValue(id && bound.stamp !== undefined, 400, 'explicit_target_required');
        this.sessions.inputReady(id);
        const owner = this.bridges.controller(id); assertValue(owner.stamp === bound.stamp, 409, 'controller_changed');
        if (!bound.confirmed) return void await this.send(`${this.targetText(this.sessions.get(id))}\nTake ROOT input control for Telegram? Current owner: ${owner.kind}. Browser becomes view-only; queued browser input is discarded, not replayed. Already-written input may have occurred. Browser can take back control.`, [[{ text: 'Confirm take control', bound: { ...bound, confirmed: true } }], this.cancelRow()]);
        await this.bridges.takeTelegram(id, bound.stamp); return this.selected(id);
      }
      case 'release': {
        assertValue(id && bound.stamp?.startsWith('tg:') && this.bridges.controller(id).stamp === bound.stamp, 409, 'controller_changed');
        await this.bridges.releaseTelegram(id); return this.selected(id);
      }
      case 'output': {
        const row = this.sessions.get(id!); const snapshot = await this.sessions.snapshot(id!); this.guard();
        const cleaned = snapshot.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        let tail = cleaned.slice(-3000); if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
        await this.send(`${this.targetText(row)}\nRecent output · plain text · last ≤200 lines / ≤3000 UTF-16 units${snapshot.truncated || tail.length < cleaned.length ? ' (truncated)' : ''}:\n\n${tail}`, [[{ text: 'Refresh output', bound: { action: 'output', id } }, { text: 'Target controls', bound: { action: 'select', id } }]]); return;
      }
      case 'stop': case 'delete': {
        const row = this.sessions.get(id!);
        if (bound.action === 'delete') assertValue(row.state === 'stopped', 409, 'session_not_stopped');
        if (!bound.confirmed) return void await this.send(`${this.targetText(row)}\n${bound.action === 'stop' ? 'STOP this job and all its panes/windows? Other sessions are untouched.' : 'DELETE this STOPPED entry only? Project files/Codex history are kept. No tmux processes are killed.'}`, [[{ text: 'Confirm ' + bound.action, bound: { ...bound, confirmed: true } }], this.cancelRow()]);
        this.guard(); this.effects++;
        if (bound.action === 'stop') { await this.sessions.stop(id!); this.bridges.stopSession(id!); }
        else await this.sessions.deleteStopped(id!, () => this.guard());
        this.pending.delete(id!);
        if (bound.action === 'delete') this.baseline.delete(id!);
        else if (this.baseline.has(id!)) this.baseline.set(id!, { ...this.sessions.describe(this.sessions.get(id!)), createdAt: row.created_at });
        await this.send(`${bound.action === 'stop' ? 'Stopped' : 'Removed stopped metadata only'}: ${id}`, [this.cancelRow()]); return;
      }
      case 'notifications': {
        if (bound.confirmed) {
          const r = this.runtime!; this.guard(r); this.notifications = bound.enabled === true;
          this.state.setNotifications(r.control.epoch, this.notifications); this.pending.clear(); this.baselineReady = false;
          if (!this.notifications) this.agentNotices.clear('notifications_off');
        }
        return this.notificationMenu();
      }
      case 'cancel': return this.catalog(0);
    }
  }
  private async notificationMenu() {
    await this.send(`Notifications ${this.notifications ? 'ON' : 'OFF'}, including while the website is closed. An open browser does not suppress alerts. Silent baseline; observed native input-needed / working→ready and verified lifecycle changes. Local agents can also send short, explicitly labeled agent-written updates through pocketterminal-notify. No automatic output, inferred success claims, legacy activity guesses or offline message queue. Short state transitions may be missed.`, [[{ text: this.notifications ? 'Turn notifications off' : 'Turn notifications on', bound: { action: 'notifications', confirmed: true, enabled: !this.notifications } }], this.cancelRow()]);
  }
  private async observe(r: Runtime) {
    if (this.now() >= this.nextReconcile) {
      this.nextReconcile = this.now() + TG_LIMITS.reconcileMs;
      try { await this.sessions.reconcile(); } catch { this.baseline.clear(); this.baselineReady = false; this.pending.clear(); return; }
      this.guard(r);
      this.bridges.reapControllers();
      const rows = this.sessions.list(20), sampled = new Map<string, Observation>();
      for (const row of rows) sampled.set(row.id, { ...this.sessions.describe(row), createdAt: row.created_at });
      // At most twenty previous IDs: a stopped job evicted by new live jobs still
      // gets its observed lifecycle transition, without retaining an archive.
      for (const [id, old] of this.baseline) if (!sampled.has(id)) {
        try {
          const row = this.sessions.get(id), next = { ...this.sessions.describe(row), createdAt: row.created_at };
          const event = notification(old, next); if (event && (this.pending.has(id) || this.pending.size < 20)) this.pending.set(id, event);
          if (next.lifecycle !== 'running') this.bridges.stopSession(id);
        } catch { this.pending.delete(id); this.bridges.stopSession(id); }
      }
      for (const [id, next] of sampled) {
        const event = this.baselineReady ? notification(this.baseline.get(id), next) : undefined;
        if (event && (this.pending.has(id) || this.pending.size < 20)) this.pending.set(id, event);
        if (next.lifecycle !== 'running') this.bridges.stopSession(id);
      }
      this.baseline = sampled; this.baselineReady = true;
    }
    if (!this.notifications) { this.pending.clear(); return; }
    const first = this.pending.entries().next().value;
    if (!first) return;
    const [id, event] = first; this.pending.delete(id); // a failed send is not retried
    let row: TerminalRow; try { row = this.sessions.get(id); } catch { return; }
    const latest = this.sessions.describe(row);
    if ((event === 'ready' || event === 'awaiting_input') ? latest.lifecycle !== 'running' || latest.activity !== event : latest.lifecycle !== event) return;
    const message = { ready: 'Observed turn finished / ready for input. NOT a task-success claim.', awaiting_input: 'Native Codex reports input/action required.', error: 'Verified start/exit error.', stopped: 'Session stopped / no longer running.', exited: 'Session exited.' }[event];
    await this.send(`${this.targetText(row)}\n${message}`, [[{ text: 'Target controls', bound: { action: 'select', id } }]]);
  }
  stats() { return { status: this.status, enabled: !!this.runtime && this.enabled(this.runtime), poller: this.runtime ? 1 : 0,
    monitorTimers: this.timer ? 1 : 0, waitTimers: this.sleeper ? 1 : 0, actions: this.actions.size, replies: this.replies.size,
    baseline: this.baseline.size, pendingNotifications: this.pending.size, agentUpdates: this.agentNotices.stats(), accepted: this.accepted, rejected: this.rejected, effectAttempts: this.effects }; }
  async close() {
    this.closing = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.agentNotices.close();
    this.runtime?.abort.abort(); this.runtime?.api.close();
    await this.bridges.releaseTelegram(); await this.monitoring; await this.runtime?.done;
    this.actions.clear(); this.replies.clear(); this.baseline.clear(); this.pending.clear();
  }
}
