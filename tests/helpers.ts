import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import type { TmuxRunner } from '../src/server/sessions.js';
import type { NativeRunner } from '../src/server/native-input.js';
import { configFromEnv, ROOT, Config } from '../src/server/config.js';
import { BOT_USERNAME, BOT_ID } from './identities.js';
// Test tmux filesystem sockets stay inside this disposable checkout.
process.env.TMUX_TMPDIR = path.join(ROOT, '.runtime/test-tmux');
fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 });
export const TEST_PASSWORD = 'Isolated-Synthetic-Only!47';
export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until(check: () => boolean | Promise<boolean>, ms = 5000, message = 'condition timed out') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error(message);
}
export async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
export async function testConfig(name: string): Promise<Config> {
  const dir = path.join(ROOT, '.runtime/tests', `${name}-${randomBytes(5).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'projects/fixture'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'projects/fixture/README'), 'Disposable PocketTerminal synthetic fixture.\n', { mode: 0o600 });
  const tls = path.join(ROOT, '.runtime/tests/tls');
  fs.mkdirSync(tls, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(tls, 'key.pem'))) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-keyout', path.join(tls, 'key.pem'), '-out', path.join(tls, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(path.join(tls, 'key.pem'), 0o600);
  const port = await freePort();
  return configFromEnv({ PT_TELEGRAM_BOT_USERNAME: BOT_USERNAME, PT_TELEGRAM_BOT_ID: String(BOT_ID), PT_TEST_MODE: '1', PT_DATA_DIR: dir, PT_HOST: '127.0.0.1', PT_PORT: String(port), PT_ORIGIN: `https://localhost:${port}`, PT_TMUX_SOCKET: `pt-test-${path.basename(dir)}`, PT_TEST_TLS_KEY: path.join(tls, 'key.pem'), PT_TEST_TLS_CERT: path.join(tls, 'cert.pem') });
}
export function configEnv(config: Config) {
  const env = { ...process.env, PT_CODEX_MODEL: undefined, PT_CODEX_PROVIDER: undefined, PT_CODEX_REASONING_EFFORT: undefined, PT_SSH_TARGET: config.sshTarget, PT_SSH_JUMP: config.sshJump, PT_TELEGRAM_BOT_USERNAME: config.telegramBot?.username, PT_TELEGRAM_BOT_ID: config.telegramBot ? String(config.telegramBot.id) : undefined, PT_TEST_MODE: '1', PT_DATA_DIR: config.dataDir, PT_HOST: config.host, PT_PORT: String(config.port), PT_ORIGIN: config.origin, PT_TMUX_SOCKET: config.tmuxSocket, PT_TEST_TLS_KEY: config.tls?.key, PT_TEST_TLS_CERT: config.tls?.cert,
    PT_DESKTOP_ENABLED: config.desktop ? '1' : '0', PT_TEST_DESKTOP_ASSETS: config.desktop?.assetsDir.startsWith(path.join(ROOT, '.runtime/')) ? config.desktop.assetsDir : undefined };
  // node-pty stringifies undefined env entries instead of dropping them.
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
export function cleanupTmux(config: Config) {
  if (!config.tmuxSocket.startsWith('pt-test-')) throw new Error('Refuse to clean non-test socket');
  try { execFileSync('tmux', ['-L', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no test server */ }
}
export async function harness(name: string, options: { initialize?: boolean; now?: () => number; tmux?: TmuxRunner; telegram?: { endpoint: string; now?: () => number }; nativeRunner?: NativeRunner } = {}) {
  const config = await testConfig(name);
  const service = await createApp(config, { now: options.now, tmux: options.tmux, telegram: options.telegram, nativeRunner: options.nativeRunner });
  if (options.initialize !== false) await service.auth.setPassword(TEST_PASSWORD, 'init');
  await service.app.listen({ host: config.host, port: config.port });
  const headers = { host: new URL(config.origin).host, origin: config.origin };
  let cookie = '', csrf = '';
  const api = (method: string, url: string, body?: object, custom: Record<string, string> = {}) => service.app.inject({ method: method as 'GET', url, headers: { ...headers, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...custom }, payload: body });
  const login = async () => {
    const result = await api('POST', '/api/login', { password: TEST_PASSWORD });
    if (result.statusCode !== 200) throw new Error(`Synthetic login failed: ${result.statusCode}`);
    cookie = String(result.headers['set-cookie']).split(';')[0]!; csrf = result.json().csrf;
    return { cookie, csrf, result };
  };
  const ws = async (id: string, options: { ack?: boolean; headers?: Record<string, string>; protocols?: string[] } = {}) => {
    const socket = new WebSocket(`${config.origin.replace('https:', 'wss:')}/api/terminal/${id}`, options.protocols || ['pocketterminal.v1', `csrf.${csrf}`], { rejectUnauthorized: false, headers: { ...headers, cookie, ...options.headers } });
    let consumed = 0, output = '', control = false;
    const messages: object[] = [];
    socket.on('message', (data, binary) => {
      if (binary) {
        consumed += data.length;
        if (output.length < 65536) output += data.toString();
        if (options.ack !== false && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', bytes: consumed }));
      } else { const m = JSON.parse(data.toString()); if (messages.length < 128) messages.push(m); if (m.type === 'control') control = m.controller; }
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, get output() { return output; }, get control() { return control; }, messages, send: (value: object) => socket.send(JSON.stringify(value)) };
  };
  return { config, service, api, login, ws, headers, get cookie() { return cookie; }, get csrf() { return csrf; },
    close: async () => { await service.close(); cleanupTmux(config); } };
}
