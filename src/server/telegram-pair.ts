import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TelegramState, TelegramLock, TelegramControl } from './telegram-state.js';
import { discardBacklog, TelegramTransport, updates, updateId, verifyBot } from './telegram-api.js';
import { fresh, userMessage } from './telegram-update.js';

export interface PairIO {
  interactive: boolean;
  showCode(code: string): void;
  confirm(prompt: string, expected: string, signal: AbortSignal): Promise<boolean>;
}
export async function privateSetup(state: TelegramState, mode: 'pair' | 'enable', io: PairIO, factory: (token: string) => TelegramTransport, signal?: AbortSignal) {
  if (!io.interactive) throw new Error('Pair/enable requires a private interactive SSH TTY; no IDs, codes or token arguments.');
  const identity = state.identity();
  const abort = new AbortController(), parentAbort = () => abort.abort();
  signal?.addEventListener('abort', parentAbort, { once: true });
  if (signal?.aborted) abort.abort();
  const deadline = setTimeout(() => abort.abort(), 5 * 60 * 1000); deadline.unref();
  const lock = new TelegramLock(state.dir + '/poller');
  let api: TelegramTransport | undefined;
  let current: TelegramControl | undefined;
  const unchanged = () => {
    if (abort.signal.aborted || state.control()?.epoch !== current?.epoch) throw new Error('Setup cancelled/expired; controls remain disabled.');
  };
  try {
    if (!await io.confirm(`This grants ROOT terminal control to a Telegram private account via @${identity.username}. Pairing disables any old binding.`, mode.toUpperCase(), abort.signal)) throw new Error('Setup cancelled; unchanged.');
    current = await state.withControlLock(() => {
      const previous = state.control();
      if (mode === 'enable' && !previous?.owner) throw new Error('No verified owner binding. Use pair privately first.');
      return state.disable(mode === 'pair');
    });
    // The running service notices the independent control file within one second
    // and aborts its HTTP request before releasing this kernel lock.
    const until = Date.now() + 5000;
    while (!await lock.acquire()) {
      unchanged();
      if (Date.now() >= until) throw new Error('Polling owner is still shutting down; controls remain disabled. Retry privately.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    unchanged(); api = factory(state.token());
    const botId = await verifyBot(api, identity, abort.signal);
    state.claim(current.epoch, await discardBacklog(api, abort.signal));
    let owner = mode === 'enable' ? current.owner : undefined;
    let usernameHint = 'not supplied';
    if (mode === 'pair') {
      const code = randomBytes(32).toString('base64url'), issued = Date.now();
      io.showCode(code);
      while (!owner) {
        unchanged();
        const batch = await updates(api, state.cursor(current.epoch), abort.signal);
        for (const update of batch) {
          state.claim(current.epoch, updateId(update)! + 1);
          const message = userMessage(update);
          if (!message || typeof message.text !== 'string' || !fresh(message.date, Date.now(), 5 * 60 * 1000) || message.date * 1000 < issued - 1000 || message.reply_to_message) continue;
          const text = message.text.startsWith('/pair ') ? message.text.slice(6) : message.text;
          if (!/^[A-Za-z0-9_-]{43}$/.test(text) || !timingSafeEqual(Buffer.from(text), Buffer.from(code))) continue;
          // No username, first-/start, supplied numeric ID or group trust.
          if (message.chat.id !== message.from.id) continue;
          owner = { userId: message.from.id, chatId: message.chat.id };
          if (typeof message.from.username === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(message.from.username)) usernameHint = '@' + message.from.username;
        }
      }
    }
    unchanged();
    const expected = `BIND ${owner!.userId} ${owner!.chatId}`;
    if (!await io.confirm(`Verified bot @${identity.username} (${botId}). Candidate numeric user ${owner!.userId}, PRIVATE chat ${owner!.chatId}. Username hint: ${usernameHint} (UNVERIFIED; not authentication). Confirm this is YOUR account. Username is not proof.`, expected, abort.signal)) throw new Error('Binding declined; controls remain disabled.');
    unchanged();
    // Everything queued before final local approval is discarded, never run.
    const next = await discardBacklog(api, abort.signal);
    await state.withControlLock(() => {
      unchanged();
      state.claim(current!.epoch, Math.max(next, state.cursor(current!.epoch)));
      state.setNotifications(current!.epoch, true);
      state.setControl({ version: 1, epoch: current!.epoch, enabled: true, owner, botId, botUsername: identity.username, pairedAt: Date.now() });
    });
    return { userId: owner!.userId, chatId: owner!.chatId, botId };
  } finally {
    clearTimeout(deadline); signal?.removeEventListener('abort', parentAbort);
    api?.close(); await lock.close();
  }
}
