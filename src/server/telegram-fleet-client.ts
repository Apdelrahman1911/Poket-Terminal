import https from 'node:https';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { TelegramApiError, type TelegramTransport } from './telegram-api.js';
import { FLEET_LIMITS, type FleetWorker } from './telegram-fleet-state.js';
import { FleetLinkState, type FleetLink } from './telegram-fleet-link.js';

// One bounded HTTPS connection to the pinned controller. Never talks to
// api.telegram.org, reads a Telegram token, follows redirects or retries input.
export class FleetRemoteTransport implements TelegramTransport {
  healthy = true;
  private agent: https.Agent;
  private request?: import('node:http').ClientRequest;
  private closed = false;
  private instance = randomBytes(16).toString('hex');
  private seq = 0;
  private url: URL;
  private link?: FleetLink;
  constructor(private worker: FleetWorker, config: Config) {
    this.url = new URL(worker.controller);
    if (this.url.protocol !== 'https:' || this.url.origin !== worker.controller) throw new TelegramApiError('api_rejected');
    const state = new FleetLinkState(config); this.link = state.load('worker');
    const ca = this.link ? state.materials('worker').cert : config.testMode && config.tls && ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname) ? fs.readFileSync(config.tls.cert) : undefined;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, ...(ca ? { ca } : {}) });
  }
  call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new TelegramApiError('aborted'));
    if (this.request) return Promise.reject(new TelegramApiError('busy'));
    const text = JSON.stringify({ instance: this.instance, seq: ++this.seq, method, body });
    if (Buffer.byteLength(text) > FLEET_LIMITS.request) return Promise.reject(new TelegramApiError('api_rejected'));
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const done = (error?: TelegramApiError, value?: T) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.request = undefined;
        if (error) { this.healthy = false; reject(error); } else resolve(value!);
      };
      const request = https.request({ protocol: 'https:', hostname: this.link?.address || this.url.hostname.replace(/[\[\]]/g, ''), port: this.link?.port || this.url.port || undefined,
        // Private IP only changes the TCP destination, never authenticated TLS
        // identity or HTTP Host. No cleartext/insecure/public fallback on error.
        ...(this.link ? { servername: this.url.hostname, rejectUnauthorized: true } : {}),
        path: '/api/telegram-fleet', method: 'POST', agent: this.agent,
        headers: { Host: this.url.host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
          'X-PocketTerminal-Node': this.worker.node.id, Authorization: 'Bearer ' + this.worker.key },
      }, response => {
        const bytes = Buffer.allocUnsafe(FLEET_LIMITS.response); let used = 0;
        response.on('data', (chunk: Buffer) => {
          if (used + chunk.length > bytes.length) { done(new TelegramApiError('invalid_response')); response.destroy(); request.destroy(); return; }
          chunk.copy(bytes, used); used += chunk.length;
        });
        response.on('error', () => done(new TelegramApiError('unavailable')));
        response.on('end', () => {
          if (finished) return;
          if (response.statusCode !== 200) return done(new TelegramApiError(response.statusCode === 409 ? 'busy' : 'unavailable'));
          try {
            const result = JSON.parse(bytes.subarray(0, used).toString('utf8'));
            if (!result || result.ok !== true) return done(new TelegramApiError('invalid_response'));
            done(undefined, result.result);
          } catch { done(new TelegramApiError('invalid_response')); }
        });
      });
      this.request = request;
      const abort = () => { done(new TelegramApiError('aborted')); request.destroy(); };
      const timer = setTimeout(() => { done(new TelegramApiError('unavailable')); request.destroy(); }, FLEET_LIMITS.rpcMs); timer.unref();
      request.on('error', () => done(new TelegramApiError('unavailable')));
      signal?.addEventListener('abort', abort, { once: true }); request.end(text);
    });
  }
  close() { this.closed = true; this.request?.destroy(); this.agent.destroy(); }
}
