import { randomBytes } from 'node:crypto';
import type { Config, TelegramBotIdentity } from './config.js';
import { TelegramState, TelegramStateError, numericId } from './telegram-state.js';

export const FLEET_LIMITS = Object.freeze({ nodes: 8, request: 32768, response: 98304, rpcMs: 20000,
  offlineMs: 30000, mailboxMs: 5000, replies: 8, callbacks: 8 });
export interface FleetBinding { bot: TelegramBotIdentity; owner: { userId: number; chatId: number } }
export interface FleetNode { id: string; label: string }
export interface FleetPeer extends FleetNode { key: string }
export interface FleetController { version: 1; role: 'controller'; binding: FleetBinding; local: FleetNode; workers: FleetPeer[] }
export interface FleetWorker { version: 1; role: 'worker'; binding: FleetBinding; controller: string; node: FleetNode; key: string }
export type FleetConfig = FleetController | FleetWorker;
export const fleetId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{16}$/.test(x);
export const fleetKey = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const fleetLabel = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(x);
export const fleetRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const exactKeys = (x: Record<string, unknown>, keys: readonly string[]) => Object.keys(x).every(k => keys.includes(k));
const node = (x: unknown, secret = false): x is FleetPeer => fleetRecord(x) && exactKeys(x, secret ? ['id', 'label', 'key'] : ['id', 'label']) && fleetId(x.id) && fleetLabel(x.label) && (!secret || fleetKey(x.key));
export function sameBinding(a: FleetBinding, b: FleetBinding) {
  return a.bot.id === b.bot.id && a.bot.username === b.bot.username && a.owner.userId === b.owner.userId && a.owner.chatId === b.owner.chatId;
}
export function validateFleet(x: unknown): FleetConfig {
  const bad = () => { throw new TelegramStateError(); };
  if (!fleetRecord(x) || x.version !== 1 || !fleetRecord(x.binding)) return bad();
  const b = x.binding;
  if (!exactKeys(b, ['bot', 'owner']) || !fleetRecord(b.bot) || !fleetRecord(b.owner)
      || !exactKeys(b.bot, ['id', 'username']) || !numericId(b.bot.id) || typeof b.bot.username !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(b.bot.username)
      || !exactKeys(b.owner, ['userId', 'chatId']) || !numericId(b.owner.userId) || b.owner.userId !== b.owner.chatId) return bad();
  if (x.role === 'controller') {
    if (!exactKeys(x, ['version', 'role', 'binding', 'local', 'workers']) || !node(x.local) || !Array.isArray(x.workers) || x.workers.length >= FLEET_LIMITS.nodes || !x.workers.every(p => node(p, true))) return bad();
    const nodes = [x.local, ...x.workers];
    if (new Set(nodes.map(p => p.id)).size !== nodes.length || new Set(nodes.map(p => p.label.toLowerCase())).size !== nodes.length) return bad();
  } else if (x.role === 'worker') {
    if (!exactKeys(x, ['version', 'role', 'binding', 'controller', 'node', 'key']) || !node(x.node) || !fleetKey(x.key) || typeof x.controller !== 'string') return bad();
    let url: URL; try { url = new URL(x.controller); } catch { return bad(); }
    if (url.protocol !== 'https:' || url.origin !== x.controller || url.username || url.password || url.hostname.includes('*')) return bad();
  } else return bad();
  return x as unknown as FleetConfig;
}

// Same private, owner-only, no-symlink boundary as the existing bot state.
// No SQLite changes; no prompts, terminal output or offline outbox on disk.
export class FleetState extends TelegramState {
  load(): FleetConfig | undefined {
    const x = this.json('fleet.json'); return x === undefined ? undefined : validateFleet(x);
  }
  save(config: FleetConfig) { this.write('fleet.json', validateFleet(config)); }
  saveStatus(value: object) { this.write('fleet-status.json', value); }
  status(): unknown { return this.json('fleet-status.json'); }
}
export function currentBinding(state: TelegramState): FleetBinding {
  const c = state.control();
  if (!c?.owner || !c.botId || !c.botUsername) throw new TelegramStateError();
  return { bot: { id: c.botId, username: c.botUsername }, owner: { ...c.owner } };
}
export function readFleet(config: Pick<Config, 'root' | 'dataDir' | 'testMode' | 'telegramBot'>) {
  return new FleetState(config).load();
}
export function newFleetNode(label: string): FleetNode {
  if (!fleetLabel(label)) throw new TelegramStateError();
  return { id: randomBytes(8).toString('hex'), label };
}
// The hub owns the real Telegram update cursor. The local terminal actor must
// never overwrite it with its filtered subset of updates.
export class FleetLocalState extends TelegramState {
  override cursor(epoch: string): number {
    const x = this.json('fleet-local-cursor.json');
    if (x === undefined) return 0;
    if (!fleetRecord(x) || !exactKeys(x, ['version', 'epoch', 'next']) || x.version !== 1 || typeof x.epoch !== 'string' || !/^[a-f0-9]{32}$/.test(x.epoch)
      || !Number.isSafeInteger(x.next) || (x.next as number) < 0 || (x.next as number) >= Number.MAX_SAFE_INTEGER) throw new TelegramStateError();
    return x.epoch === epoch ? x.next as number : 0;
  }
  override claim(epoch: string, next: number) {
    if (!/^[a-f0-9]{32}$/.test(epoch) || !Number.isSafeInteger(next) || next < 0 || next >= Number.MAX_SAFE_INTEGER) throw new TelegramStateError();
    this.write('fleet-local-cursor.json', { version: 1, epoch, next });
  }
}
