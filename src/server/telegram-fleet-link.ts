import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { Config } from './config.js';
import { TelegramState, TelegramStateError } from './telegram-state.js';
import { exactKeys, fleetRecord, FLEET_LIMITS } from './telegram-fleet-state.js';

export interface FleetLink { version: 1; role: 'controller' | 'worker'; address: string; port: number }
export function validateFleetLink(value: unknown, testMode = false): FleetLink {
  if (!fleetRecord(value) || !exactKeys(value, ['version', 'role', 'address', 'port']) || value.version !== 1
      || !['controller', 'worker'].includes(value.role as string) || typeof value.address !== 'string' || net.isIP(value.address) !== 4
      || !Number.isInteger(value.port) || (value.port as number) < 1024 || (value.port as number) > 65535) throw new TelegramStateError();
  const [a, b] = value.address.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (testMode && value.address === '127.0.0.1'))) throw new TelegramStateError();
  return value as unknown as FleetLink;
}

// Optional, local-only routing configuration. No worker keys, bot tokens, URLs
// with credentials or arbitrary file paths. Every PEM uses the same owner-only,
// size-bounded, no-symlink boundary as existing private Telegram state.
export class FleetLinkState extends TelegramState {
  constructor(private config: Config) { super(config); }
  load(role = this.config.telegramFleet?.role): FleetLink | undefined {
    const value = this.json('fleet-link.json');
    if (value === undefined || value === null) return;
    const link = validateFleetLink(value, this.config.testMode);
    if (link.role !== role) throw new TelegramStateError();
    return link;
  }
  save(link: FleetLink | undefined) { this.write('fleet-link.json', link ? validateFleetLink(link, this.config.testMode) : null); }
  materials(role: FleetLink['role']) {
    const cert = this.read(role === 'controller' ? 'fleet-tls-cert.pem' : 'fleet-controller-ca.pem', 16384);
    const key = role === 'controller' ? this.read('fleet-tls-key.pem', 16384) : undefined;
    if (!cert || (role === 'controller' && !key)) throw new TelegramStateError();
    try { new X509Certificate(cert); tls.createSecureContext(role === 'controller' ? { cert, key } : { ca: cert }); } catch { throw new TelegramStateError(); }
    return { cert, key };
  }
}

// An additional PRIVATE TLS socket in the existing Node process, not another
// Fastify instance/proxy/daemon. Only fleet RPC and a content-free health check
// reach the existing router; no website, terminal upgrade or general API here.
export class FleetPrivateListener {
  private server: https.Server;
  private sockets = new Set<import('node:stream').Duplex>();
  private closing?: Promise<void>;
  constructor(private link: FleetLink, material: { cert: string; key?: string }, handler: import('node:http').RequestListener) {
    this.server = https.createServer({ ...material, minVersion: 'TLSv1.2', handshakeTimeout: 5000, maxHeaderSize: 8192,
      requestTimeout: 10000, headersTimeout: 5000, connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 }, (req, res) => {
      if ((req.method === 'POST' && req.url === '/api/telegram-fleet') || (req.method === 'GET' && req.url === '/health')) return handler(req, res);
      res.writeHead(404, { Connection: 'close', 'Content-Length': '0' }); res.end();
    });
    this.server.maxConnections = FLEET_LIMITS.nodes * 2;
    this.server.maxHeadersCount = 32; this.server.maxRequestsPerSocket = 1000;
    this.server.setTimeout(FLEET_LIMITS.rpcMs + 5000, socket => socket.destroy());
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (_req, socket) => socket.destroy());
    this.server.on('error', () => { /* Startup failure rejects below; never log TLS/config/request payloads. */ });
  }
  start() {
    if (this.closing) return Promise.reject(new TelegramStateError());
    return new Promise<void>((resolve, reject) => {
      const failed = () => { this.server.off('listening', ready); reject(new TelegramStateError()); };
      const ready = () => { this.server.off('error', failed); resolve(); };
      this.server.once('error', failed); this.server.once('listening', ready);
      this.server.listen({ host: this.link.address, port: this.link.port, backlog: 16 });
    });
  }
  close() {
    return this.closing ??= new Promise<void>(resolve => {
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }
}
