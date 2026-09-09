import http from 'node:http';
import https from 'node:https';
import { numericId } from './telegram-state.js';
import type { TelegramBotIdentity } from './config.js';

export const TG_LIMITS = Object.freeze({ response: 64 * 1024, request: 24 * 1024, text: 3500,
  input: 4096, actions: 64, replies: 8, expiryMs: 120000, oldMs: 60000, pollSeconds: 3,
  intervalMs: 300, reconcileMs: 3000, maxBackoffMs: 60000 });
export class TelegramApiError extends Error {
  constructor(readonly code: 'unavailable' | 'aborted' | 'api_rejected' | 'rate_limited' | 'invalid_response' | 'busy', readonly retryMs = 0) { super('Telegram ' + code); }
}
export interface TelegramTransport {
  call<T = unknown>(method: string, body: object, signal?: AbortSignal): Promise<T>;
  close(): void;
}
export class TelegramApi implements TelegramTransport {
  private agent: http.Agent;
  private endpoint: URL;
  private request?: http.ClientRequest;
  private closed = false;
  constructor(private token: string, test?: { testMode: boolean; endpoint: string }) {
    this.endpoint = new URL('https://api.telegram.org');
    if (test) {
      const url = new URL(test.endpoint);
      if (!test.testMode || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Telegram tests require an explicit loopback fake API.');
      this.endpoint = url;
    }
    this.agent = this.endpoint.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }) : new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }
  call<T = unknown>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    if (!['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'answerCallbackQuery', 'setMyCommands', 'getMyCommands', 'setChatMenuButton', 'getChatMenuButton'].includes(method)) return Promise.reject(new TelegramApiError('api_rejected'));
    if (this.closed || signal?.aborted) return Promise.reject(new TelegramApiError('aborted'));
    if (this.request) return Promise.reject(new TelegramApiError('busy'));
    const json = JSON.stringify(body);
    if (json.length > TG_LIMITS.request || Buffer.byteLength(json) > TG_LIMITS.request) return Promise.reject(new TelegramApiError('api_rejected'));
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: TelegramApiError, value?: T) => {
        if (done) return; done = true;
        clearTimeout(deadline); signal?.removeEventListener('abort', abort);
        this.request = undefined;
        if (error) reject(error); else resolve(value!);
      };
      // Never surface a ClientRequest/error/URL: the Bot API places its token in
      // the URL path. No redirects, proxy environment, raw API errors or logging.
      const request = (this.endpoint.protocol === 'https:' ? https : http).request({
        protocol: this.endpoint.protocol, hostname: this.endpoint.hostname.replace(/[\[\]]/g, ''), port: this.endpoint.port || undefined,
        path: '/bot' + this.token + '/' + method, method: 'POST', agent: this.agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
      }, response => {
        const buffer = Buffer.allocUnsafe(TG_LIMITS.response); let used = 0;
        response.on('data', (chunk: Buffer) => {
          if (used + chunk.length > buffer.length) { finish(new TelegramApiError('invalid_response')); response.destroy(); request.destroy(); return; }
          chunk.copy(buffer, used); used += chunk.length;
        });
        response.on('error', () => finish(new TelegramApiError('unavailable')));
        response.on('end', () => {
          if (done) return;
          let parsed: { ok?: unknown; result?: T; error_code?: unknown; parameters?: { retry_after?: unknown } };
          try { parsed = JSON.parse(buffer.subarray(0, used).toString('utf8')); }
          catch { return finish(new TelegramApiError('invalid_response')); }
          if (!parsed || typeof parsed !== 'object') return finish(new TelegramApiError('invalid_response'));
          if (response.statusCode === 429 || parsed.error_code === 429) {
            const seconds = parsed.parameters?.retry_after;
            return finish(new TelegramApiError('rate_limited', typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(1000, Math.min(TG_LIMITS.maxBackoffMs, seconds * 1000)) : 5000));
          }
          if (response.statusCode !== 200 || parsed.ok !== true) return finish(new TelegramApiError('api_rejected'));
          finish(undefined, parsed.result);
        });
      });
      this.request = request;
      const abort = () => { finish(new TelegramApiError('aborted')); request.destroy(); };
      const deadline = setTimeout(() => { finish(new TelegramApiError('unavailable')); request.destroy(); }, method === 'getUpdates' ? 10000 : 5000);
      deadline.unref();
      request.on('error', () => finish(new TelegramApiError('unavailable')));
      signal?.addEventListener('abort', abort, { once: true });
      request.end(json);
    });
  }
  close() { this.closed = true; this.request?.destroy(); this.agent.destroy(); this.token = ''; }
}

export async function verifyBot(api: TelegramTransport, expected: TelegramBotIdentity, signal?: AbortSignal) {
  const bot = await api.call<{ id: number; is_bot: boolean; username: string }>('getMe', {}, signal);
  if (!bot || !numericId(bot.id) || bot.is_bot !== true || bot.username !== expected.username || bot.id !== expected.id) throw new Error('Unexpected Telegram bot identity; unchanged and disabled.');
  const webhook = await api.call<{ url: string }>('getWebhookInfo', {}, signal);
  if (!webhook || webhook.url !== '') throw new Error('Telegram webhook is configured or unknown; polling disabled.');
  return bot.id;
}
export function updateId(update: unknown): number | undefined {
  const id = (update as { update_id?: unknown } | null)?.update_id;
  return Number.isSafeInteger(id) && (id as number) >= 0 && (id as number) < Number.MAX_SAFE_INTEGER - 1 ? id as number : undefined;
}
export async function updates(api: TelegramTransport, offset: number, signal?: AbortSignal, timeout: number = TG_LIMITS.pollSeconds) {
  const result = await api.call<unknown>('getUpdates', { offset, limit: 1, timeout, allowed_updates: ['message', 'callback_query'] }, signal);
  if (!Array.isArray(result) || result.length > 1 || (result.length && updateId(result[0]) === undefined)) throw new TelegramApiError('invalid_response');
  return result as Record<string, unknown>[];
}
export async function discardBacklog(api: TelegramTransport, signal?: AbortSignal) {
  const batch = await updates(api, -1, signal, 0);
  return batch.length ? updateId(batch[0])! + 1 : 0;
}
