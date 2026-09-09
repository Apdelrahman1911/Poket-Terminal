import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { hash, verify, Algorithm, Version } from '@node-rs/argon2';
import { Store } from './db.js';
import { LIMITS } from './config.js';
import { HttpError } from './errors.js';

export const COOKIE = '__Host-pocketterminal';
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const csrfFor = (token: string) => createHash('sha256').update('pocketterminal-csrf\0').update(token).digest('base64url');
export function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function cookieToken(cookie: string | undefined): string | undefined {
  if (!cookie || cookie.length > 4096) return;
  const entries = cookie.split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
  if (entries.length !== 1) return;
  const token = entries[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export const cookieValue = (token: string, maxAge = LIMITS.authMs / 1000) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
export function strongPassword(password: string) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter(r => r.test(password)).length;
  return [...password].length >= 16 && Buffer.byteLength(password) <= 256 && new Set(password).size >= 8 && (classes >= 3 || (password.length >= 24 && classes >= 2));
}
export async function passwordHash(password: string) {
  return hash(password, { algorithm: Algorithm.Argon2id, version: Version.V0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
}
export interface AuthRecord { token_hash: string; revision: number; created_at: number; expires_at: number }
export class Auth {
  private attempts = new Map<string, { count: number; until: number }>();
  private global = { count: 0, until: 0 };
  private verifying = 0;
  constructor(readonly store: Store, readonly now = Date.now) {}
  initialized() { return !!this.store.db.prepare('SELECT id FROM owner WHERE id=1').get(); }
  async setPassword(password: string, mode: 'init' | 'reset') {
    if (!strongPassword(password)) throw new HttpError(400, 'password_strength');
    const digest = await passwordHash(password);
    this.store.transaction(() => {
      if (mode === 'init' && this.initialized()) throw new HttpError(409, 'already_initialized');
      if (mode === 'reset' && !this.initialized()) throw new HttpError(409, 'not_initialized');
      this.store.db.prepare('INSERT INTO owner(id,password_hash,revision,updated_at) VALUES(1,?,1,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,revision=owner.revision+1,updated_at=excluded.updated_at').run(digest, this.now());
      this.store.db.exec('DELETE FROM auth_sessions');
    });
  }
  cleanup() {
    const now = this.now();
    this.store.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
  }
  private throttle(ip: string) {
    const now = this.now();
    this.cleanup();
    if (this.global.until <= now) this.global = { count: 0, until: now + 15 * 60 * 1000 };
    let item = this.attempts.get(ip);
    if (!item) {
      if (this.attempts.size >= 128) throw new HttpError(429, 'login_throttled');
      item = { count: 0, until: now + 15 * 60 * 1000 }; this.attempts.set(ip, item);
    }
    if (item.count >= 5 || this.global.count >= 20 || this.verifying >= 2) throw new HttpError(429, 'login_throttled');
    item.count++; this.global.count++;
  }
  async login(password: string, ip: string) {
    this.throttle(ip);
    if (!this.initialized()) throw new HttpError(503, 'owner_setup_required');
    const owner = this.store.db.prepare('SELECT password_hash,revision FROM owner WHERE id=1').get() as { password_hash: string; revision: number };
    this.verifying++;
    let valid = false;
    try { valid = await verify(owner.password_hash, password); } finally { this.verifying--; }
    if (!valid) throw new HttpError(401, 'invalid_credentials');
    const raw = randomBytes(32).toString('base64url'), now = this.now();
    const result = this.store.transaction(() => {
      // A concurrent SSH reset must not resurrect the old password's session.
      const current = this.store.db.prepare('SELECT revision FROM owner WHERE id=1').get() as { revision: number };
      if (current.revision !== owner.revision) throw new HttpError(401, 'credentials_changed');
      this.store.db.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions ORDER BY created_at DESC,token_hash LIMIT -1 OFFSET ?)').run(LIMITS.authRecords - 1);
      this.store.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').run(tokenHash(raw), owner.revision, now, now + LIMITS.authMs);
      return { raw, csrf: csrfFor(raw), expiresAt: now + LIMITS.authMs };
    });
    this.attempts.delete(ip);
    return result;
  }
  authenticate(token: string | undefined): AuthRecord | undefined {
    if (!token) return;
    const row = this.store.db.prepare('SELECT a.* FROM auth_sessions a JOIN owner o ON o.id=1 AND o.revision=a.revision WHERE a.token_hash=? AND a.expires_at>?').get(tokenHash(token), this.now()) as AuthRecord | undefined;
    return row;
  }
  revoke(token: string) { this.store.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash(token)); }
  stats() { return { throttleKeys: this.attempts.size, verifying: this.verifying, authRecords: Number((this.store.db.prepare('SELECT count(*) n FROM auth_sessions').get() as { n: number }).n) }; }
}
