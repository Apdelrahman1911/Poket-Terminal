import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { generation, TelegramState } from '../src/server/telegram-state.js';
import type { Config } from '../src/server/config.js';
import { BOT_USERNAME, BOT_ID } from './identities.js';
export { BOT_USERNAME, BOT_ID } from './identities.js';

export const DUMMY_TOKEN = '123456789:synthetic_dummy_credentials_only_0123456789';
export const OWNER = 123456789;
export function message(update_id: number, text: string, extra: object = {}) {
  return { update_id, message: { message_id: update_id + 100, date: Math.floor(Date.now() / 1000), from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, text, ...extra } };
}
export async function fakeTelegram() {
  let messageId = 1000;
  const queue: Record<string, unknown>[] = [], calls: { method: string; body: any }[] = [], sent: any[] = [];
  const sockets = new Set<net.Socket>();
  const fake = { username: BOT_USERNAME, botId: BOT_ID, webhook: '', delay: 15, fail: '', oversized: '', hang: '', rateLimited: '',
    calls, sent, queue, endpoint: '', maxActive: 0, active: 0,
    activePolls: 0, maxPolls: 0, activeOutgoing: 0, maxOutgoing: 0,
    enqueue(update: Record<string, unknown>) { if (queue.length >= 128) throw new Error('Synthetic fake queue cap'); queue.push(update); },
    async close() { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); },
  };
  const server = http.createServer(async (req, res) => {
    // Deliberately never retain/log the URL token, even this synthetic one.
    const method = req.url?.split('/').at(-1) || '';
    if (req.method !== 'POST' || !['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'answerCallbackQuery', 'setMyCommands', 'getMyCommands', 'setChatMenuButton', 'getChatMenuButton'].includes(method)) { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of req) { raw += part; if (raw.length > 32768) { req.destroy(); return; } }
    let body: any; try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    fake.active++; fake.maxActive = Math.max(fake.maxActive, fake.active);
    if (method === 'getUpdates') { fake.activePolls++; fake.maxPolls = Math.max(fake.maxPolls, fake.activePolls); }
    else { fake.activeOutgoing++; fake.maxOutgoing = Math.max(fake.maxOutgoing, fake.activeOutgoing); }
    res.once('close', () => { fake.active--; if (method === 'getUpdates') fake.activePolls--; else fake.activeOutgoing--; });
    if (calls.length >= 512) calls.shift(); calls.push({ method, body });
    if (fake.hang === method) return;
    if (fake.oversized === method) { res.end('x'.repeat(65537)); return; }
    if (fake.rateLimited === method) { res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 999999 }, description: 'do not log synthetic secrets' })); return; }
    if (fake.fail === method) { res.writeHead(500).end(JSON.stringify({ ok: false, description: 'do not log synthetic secrets' })); return; }
    let result: unknown = true;
    if (method === 'getMe') result = { id: fake.botId, username: fake.username, is_bot: true };
    if (method === 'getWebhookInfo') result = { url: fake.webhook };
    if (method === 'getUpdates') {
      await new Promise(r => setTimeout(r, fake.delay));
      if (body.offset < 0) {
        if (queue.length > 1) queue.splice(0, queue.length - 1);
      } else while (queue.length && (queue[0]!.update_id as number) < body.offset) queue.shift();
      result = queue.slice(0, 1);
    }
    if (method === 'sendMessage') {
      const m = { message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: 'private' }, from: { id: BOT_ID, is_bot: true }, text: body.text, reply_markup: body.reply_markup };
      if (sent.length >= 128) sent.shift(); sent.push(m); result = m;
    }
    if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return fake;
}
export function dummyState(config: Config, enabled = false) {
  if (!config.testMode || !config.dataDir.includes('/.runtime/tests/')) throw new Error('Synthetic Telegram state only');
  const state = new TelegramState(config);
  const e = generation();
  state.setControl({ version: 1, epoch: e, enabled, owner: { userId: OWNER, chatId: OWNER }, botId: BOT_ID, botUsername: BOT_USERNAME, pairedAt: Date.now() });
  state.claim(e, 0); state.setNotifications(e, true);
  fs.writeFileSync(path.join(state.dir, 'token'), DUMMY_TOKEN, { mode: 0o600 });
  return state;
}
