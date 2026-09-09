import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ROOT, type Config } from '../src/server/config.js';
import { Auth } from '../src/server/auth.js';
import { Store } from '../src/server/db.js';
import { cleanupTmux, configEnv, freePort, TEST_PASSWORD, testConfig, until } from './helpers.js';

// Real minimal-env foreground supervisor + HTTP backend behind an isolated TLS ingress.
// Neither the production data/socket nor any owner authentication is used.
export async function foreground(name: string, options: { telegramEndpoint?: string; prepare?: (config: Config) => void | Promise<void> } = {}) {
  const config = await testConfig(name), tls = config.tls!;
  config.tls = undefined;
  const ingressPort = await freePort(); config.origin = `https://localhost:${ingressPort}`;
  const store = new Store(config.dataDir); await new Auth(store).setPassword(TEST_PASSWORD, 'init'); store.close();
  await options.prepare?.(config);
  const env = Object.fromEntries(Object.entries(configEnv(config)).filter(([k, v]) => (k.startsWith('PT_') || k === 'TMUX_TMPDIR') && v !== undefined));
  if (options.telegramEndpoint) env.PT_TEST_TELEGRAM_API = options.telegramEndpoint;
  const log = fs.createWriteStream(path.join(config.dataDir, 'foreground.log'), { mode: 0o600 });
  const home = path.join(config.dataDir, 'home'); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const child = spawn(path.join(ROOT, 'scripts/service.sh'), [], { cwd: ROOT, env: { ...env, HOME: home, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log); child.stderr!.pipe(log, { end: false });
  const sockets = new Set<net.Socket>();
  const ingress = https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert) }, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: config.port, method: req.method, path: req.url, headers: req.headers, agent: false }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  ingress.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  ingress.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(config.port, '127.0.0.1', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((s, v, i) => s + v + (i % 2 ? '\r\n' : ': '), '')}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (ingress.listening) await new Promise<void>(resolve => ingress.close(() => resolve()));
    let forced = false;
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM');
      const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
      await done; clearTimeout(timer);
    }
    log.end(); cleanupTmux(config);
    return { graceful: !forced && child.exitCode === 0, exitCode: child.exitCode };
  };
  try {
    // web.pid is written before Node listens; health, not merely the PID file, is readiness.
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${config.port}/health`)).ok; } catch { return false; } }, 10000);
    await new Promise<void>(resolve => ingress.listen(ingressPort, '127.0.0.1', resolve));
    const backendPid = Number(fs.readFileSync(path.join(config.dataDir, 'web.pid'), 'utf8'));
    return { config, child, backendPid, close };
  } catch (error) { await close(); throw error; }
}
