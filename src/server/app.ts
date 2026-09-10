import Fastify from 'fastify';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './db.js';
import { Auth, cookieToken, cookieValue, csrfFor, equal } from './auth.js';
import { Config, LIMITS } from './config.js';
import { sshHint } from './config.js';
import { Sessions, TerminalRow, TmuxRunner } from './sessions.js';
import { Bridges, requestOriginAllowed } from './bridge.js';
import { assertValue, HttpError } from './errors.js';
import { TelegramBot } from './telegram-bot.js';
import { TelegramApiError } from './telegram-api.js';
import { TelegramState } from './telegram-state.js';
import { TelegramFleetHub } from './telegram-fleet-hub.js';
import { FleetRemoteTransport } from './telegram-fleet-client.js';
import { FLEET_LIMITS, FleetState, FleetLocalState, sameBinding, currentBinding } from './telegram-fleet-state.js';
import { Desktop } from './desktop.js';
import type { NativeRunner } from './native-input.js';
import type { CodexControl } from './codex-control.js';

export async function createApp(config: Config, options: { tmux?: TmuxRunner; now?: () => number; telegram?: { endpoint: string; now?: () => number }; nativeRunner?: NativeRunner; codexControl?: CodexControl } = {}) {
  process.umask(0o077);
  const store = new Store(config.dataDir);
  const auth = new Auth(store, options.now);
  const sessions = new Sessions(store, config, options.tmux, options.codexControl);
  try { await sessions.initialize(); } catch (e) { store.close(); throw e; }
  const bridges = new Bridges(auth, sessions, config, options.nativeRunner);
  const desktop = config.desktop ? new Desktop(auth, config) : undefined;
  const fleetConfig = config.telegramFleet;
  const fleet = fleetConfig?.role === 'controller' ? new TelegramFleetHub(config, fleetConfig, options.telegram) : undefined;
  const workerEnabled = () => {
    try {
      const current = new FleetState(config).load();
      return fleetConfig?.role === 'worker' && current?.role === 'worker' && current.node.id === fleetConfig.node.id && current.key === fleetConfig.key
        && current.controller === fleetConfig.controller && sameBinding(current.binding, fleetConfig.binding) && sameBinding(currentBinding(new TelegramState(config)), fleetConfig.binding);
    } catch { return false; }
  };
  const telegram = new TelegramBot(sessions, bridges, config, options.telegram, fleet ? {
    state: new FleetLocalState(config), factory: () => fleet.localTransport(), lockName: 'fleet-local', enabled: () => fleet.isReady(),
  } : fleetConfig?.role === 'worker' ? { factory: () => new FleetRemoteTransport(fleetConfig, config), enabled: workerEnabled,
    runtimeValid: api => api instanceof FleetRemoteTransport && api.healthy } : undefined);
  const serverOptions = { ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }, logger: false as const, trustProxy: false as const, bodyLimit: 2048, requestTimeout: 10000, connectionTimeout: 15000, keepAliveTimeout: 5000,
    maxRequestsPerSocket: 1000, onProtoPoisoning: 'error' as const, onConstructorPoisoning: 'error' as const };
  const app = Fastify({ ...serverOptions, ...(config.tls ? { serverFactory: (handler: import('node:http').RequestListener) => https.createServer({ key: fs.readFileSync(config.tls!.key), cert: fs.readFileSync(config.tls!.cert) }, handler) } : {}) });
  app.server.maxConnections = 128;
  app.server.maxHeadersCount = 64;
  // One exact upgrade dispatcher. No second listener can reject/consume an
  // already upgraded socket; unknown/query-string routes never allocate natives.
  const upgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (/^\/api\/terminal\/[a-f0-9]{32}$/.test(req.url || '')) return bridges.upgrade(req, socket, head);
    if (req.url === '/api/desktop/socket' && desktop) return desktop.upgrade(req, socket, head);
    socket.end('HTTP/1.1 404 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const timer = setTimeout(() => socket.destroy(), 250); timer.unref(); socket.once('close', () => clearTimeout(timer));
  };
  app.server.on('upgrade', upgrade);
  app.addHook('onRequest', async (req, reply) => {
    reply.headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=31536000', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(self), clipboard-write=(self)',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" });
    if (req.url === '/health' && req.method === 'GET') return;
    if (req.url === '/api/telegram-fleet' && req.method === 'POST') {
      // A distinct machine-credential boundary. Cookies, browser Origin and
      // Fetch Metadata never authenticate fleet traffic. No generic API bypass.
      assertValue(!!fleet && requestOriginAllowed(req.raw, config.origin) && req.headers.origin === undefined && req.headers.cookie === undefined
        && req.headers['sec-fetch-site'] === undefined && (req.headers['content-type'] || '').split(';')[0] === 'application/json'
        && fleet.authorize(req.headers['x-pocketterminal-node'], req.headers.authorization), 401, 'fleet_authentication_required');
      return;
    }
    const write = !['GET', 'HEAD'].includes(req.method);
    assertValue(requestOriginAllowed(req.raw, config.origin, write), 403, 'origin_rejected');
    if (write) assertValue((req.headers['content-type'] || '').split(';')[0] === 'application/json', 415, 'json_required');
    if (req.url.startsWith('/api/') && !['/api/auth', '/api/login'].includes(req.url)) {
      const raw = cookieToken(req.headers.cookie);
      assertValue(auth.authenticate(raw), 401, 'authentication_required');
      if (write) assertValue(typeof req.headers['x-csrf-token'] === 'string' && equal(req.headers['x-csrf-token'], csrfFor(raw!)), 403, 'csrf_rejected');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; validation?: unknown };
    const status = error instanceof HttpError ? error.status : err.validation ? 400 : (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500);
    const code = error instanceof HttpError ? error.code : status === 500 ? 'internal_error' : 'invalid_request';
    // Deliberately do not log request bodies, URL query strings, terminal data or exception payloads.
    reply.code(status).send({ error: code });
  });
  const objectBody = (properties: Record<string, object>, required: string[] = []) => ({ body: { type: 'object', properties, required, additionalProperties: false } });
  const idParams = { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, required: ['id'], additionalProperties: false };
  const present = (row: TerminalRow) => ({ ...row, ...sessions.describe(row),
    ssh: sshHint(config, row.tmux_name) });
  app.get('/health', async () => ({ ok: true }));
  app.post('/api/telegram-fleet', { bodyLimit: FLEET_LIMITS.request }, async (req, reply) => {
    const abort = new AbortController();
    const closed = () => abort.abort(); reply.raw.once('close', closed);
    try {
      assertValue(fleet && fleet.authorize(req.headers['x-pocketterminal-node'], req.headers.authorization), 401, 'fleet_authentication_required');
      const result = await fleet.rpc(req.headers['x-pocketterminal-node'] as string, req.body, abort.signal);
      const value = { ok: true, result };
      assertValue(Buffer.byteLength(JSON.stringify(value)) <= FLEET_LIMITS.response, 503, 'fleet_response_limit');
      return value;
    } catch (error) {
      if (error instanceof TelegramApiError) throw new HttpError(error.code === 'busy' ? 409 : 503, 'fleet_unavailable_or_uncertain');
      throw error;
    } finally { reply.raw.off('close', closed); }
  });
  app.get('/api/auth', async req => {
    const raw = cookieToken(req.headers.cookie), record = auth.authenticate(raw);
    return record ? { authenticated: true, csrf: csrfFor(raw!), expiresAt: record.expires_at, defaultCwd: config.defaultCwd, desktop: !!desktop } : { authenticated: false, setupRequired: !auth.initialized() };
  });
  app.post<{ Body: { password: string } }>('/api/login', { schema: objectBody({ password: { type: 'string', minLength: 1, maxLength: 256 } }, ['password']) }, async (req, reply) => {
    assertValue(Buffer.byteLength(req.body.password) <= 256, 400, 'invalid_password');
    const result = await auth.login(req.body.password, req.raw.socket.remoteAddress || 'unknown');
    bridges.revokeInvalid();
    desktop?.revokeInvalid();
    reply.header('Set-Cookie', cookieValue(result.raw));
    return { authenticated: true, csrf: result.csrf, expiresAt: result.expiresAt, defaultCwd: config.defaultCwd, desktop: !!desktop };
  });
  app.post('/api/logout', { schema: objectBody({}) }, async (req, reply) => {
    auth.revoke(cookieToken(req.headers.cookie)!); bridges.revokeInvalid();
    desktop?.revokeInvalid();
    reply.header('Set-Cookie', cookieValue('', 0)); return { ok: true };
  });
  app.get('/api/projects', async () => ({ projects: sessions.projects(), defaultCwd: config.defaultCwd }));
  app.get<{ Querystring: { limit?: string; offset?: string; selected?: string } }>('/api/sessions', async req => {
    await sessions.reconcile();
    const limit = Number(req.query.limit ?? 100), offset = Number(req.query.offset ?? 0);
    const rows = sessions.list(limit, offset);
    let selectedSession: ReturnType<typeof present> | null = null;
    if (req.query.selected) {
      try { selectedSession = present(sessions.get(req.query.selected)); }
      catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
    }
    const total = Number((store.db.prepare('SELECT count(*) n FROM terminals').get() as { n: number }).n);
    return { sessions: rows.map(present), selectedSession, limit: LIMITS.sessions, runningCount: sessions.stats().managedRunning, nextOffset: offset + limit < Math.min(total, 200) ? offset + limit : null };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/snapshot', { schema: { ...objectBody({}), params: idParams } }, async req => sessions.snapshot(req.params.id));
  app.post<{ Body: { kind?: string; cwd?: string; label?: string } }>('/api/sessions', { schema: objectBody({ kind: { type: 'string', enum: ['shell', 'codex'] }, cwd: { type: 'string', maxLength: 4096 }, label: { type: 'string', minLength: 1, maxLength: 80 } }) }, async (req, reply) => {
    const result = await sessions.create(req.body); reply.code(201); return { session: present(result) };
  });
  app.patch<{ Params: { id: string }; Body: { label: string } }>('/api/sessions/:id', { schema: { ...objectBody({ label: { type: 'string', minLength: 1, maxLength: 80 } }, ['label']), params: idParams } }, async req => ({ session: present(sessions.rename(req.params.id, req.body.label)) }));
  app.post<{ Params: { id: string }; Body: { confirm: string } }>('/api/sessions/:id/stop', { schema: { ...objectBody({ confirm: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['confirm']), params: idParams } }, async req => {
    assertValue(req.body.confirm === req.params.id, 400, 'confirmation_required');
    const session = await sessions.stop(req.params.id); bridges.stopSession(req.params.id); return { session: present(session) };
  });
  app.post<{ Params: { id: string }; Body: { confirm: string; expectedUpdatedAt: number } }>('/api/sessions/:id/restart-codex', {
    schema: { ...objectBody({ confirm: { type: 'string', pattern: '^[a-f0-9]{32}$' }, expectedUpdatedAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, ['confirm', 'expectedUpdatedAt']), params: idParams },
  }, async req => {
    assertValue(req.body.confirm === req.params.id, 400, 'confirmation_required');
    const raw = cookieToken(req.headers.cookie);
    const guard = () => { assertValue(auth.authenticate(raw), 401, 'authentication_required'); };
    const session = await sessions.restartCodex(req.params.id, req.body.expectedUpdatedAt, guard, () => bridges.prepareCodexRestart(req.params.id));
    return { session: present(session) };
  });
  app.delete<{ Params: { id: string }; Body: { confirm: string } }>('/api/sessions/:id', { schema: { ...objectBody({ confirm: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['confirm']), params: idParams } }, async req => {
    assertValue(req.body.confirm === req.params.id, 400, 'confirmation_required');
    await sessions.deleteStopped(req.params.id); return { ok: true };
  });
  const client = path.join(config.root, 'dist/client');
  if (desktop) {
    app.post('/api/desktop/start', { schema: objectBody({}) }, async () => { await desktop.start(); return { ok: true }; });
    app.get('/desktop', async (_req, reply) => reply.redirect('/desktop/'));
    // Exact file allowlist, never a wildcard/general filesystem server. HTML is
    // a safe sign-in shell; executable/assets require the same owner cookie.
    for (const [name, type] of [['index.html', 'text/html; charset=utf-8'], ['desktop.js', 'text/javascript; charset=utf-8'], ['desktop.css', 'text/css; charset=utf-8'], ['LICENSES.txt', 'text/plain; charset=utf-8']] as const) {
      app.get(name === 'index.html' ? '/desktop/' : '/desktop/' + name, async (req, reply) => {
        if (name !== 'index.html') assertValue(auth.authenticate(cookieToken(req.headers.cookie)), 401, 'authentication_required');
        const file = path.join(config.desktop!.assetsDir, name);
        assertValue(fs.existsSync(file), 503, 'desktop_build_required');
        return reply.type(type).send(fs.createReadStream(file));
      });
    }
  }
  app.get<{ Params: { '*': string } }>('/assets/*', async (req, reply) => {
    const name = req.params['*'];
    assertValue(/^[a-zA-Z0-9_.-]+\.(js|css|woff2)$/.test(name), 404, 'not_found');
    const file = path.join(client, 'assets', name);
    assertValue(fs.existsSync(file), 404, 'not_found');
    const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/woff2';
    reply.header('Cache-Control', 'public, max-age=31536000, immutable').type(type);
    return reply.send(fs.createReadStream(file));
  });
  app.get('/', async (_req, reply) => {
    assertValue(fs.existsSync(path.join(client, 'index.html')), 503, 'build_required');
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(path.join(client, 'index.html')));
  });
  const reconcileTimer = setInterval(() => { void sessions.reconcile().catch(() => { /* bounded retry at next tick; never dump command output */ }); }, 30000);
  reconcileTimer.unref();
  fleet?.start(); telegram.start();
  // Explicit root-owned opt-in only, no provider/boot configuration change.
  // Failure has no effect on terminal/Telegram startup and no automatic retry loop.
  if (config.desktop?.autoStart) void desktop!.start().catch(() => {});
  let closed = false;
  app.addHook('onClose', async () => {
    if (closed) return; closed = true;
    clearInterval(reconcileTimer); app.server.off('upgrade', upgrade);
    await fleet?.close(); await telegram.close(); await bridges.close(); await desktop?.close(); await sessions.shutdown(); store.close();
  });
  return { app, store, auth, sessions, bridges, telegram, fleet, desktop,
    stats: () => ({ pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage(), bridges: bridges.stats(), sessions: sessions.stats(), auth: auth.stats(), telegram: telegram.stats(), fleet: fleet?.stats(), desktop: desktop?.stats() }),
    close: async () => { await fleet?.close(); await telegram.close(); await bridges.close(); await desktop?.close(); await app.close(); } };
}
