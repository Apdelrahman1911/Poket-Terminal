import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { TelegramState, TelegramStateError, generation } from './telegram-state.js';
import { FleetState, currentBinding, newFleetNode, sameBinding, validateFleet, FLEET_LIMITS, type FleetWorker } from './telegram-fleet-state.js';

export async function initializeFleet(config: Config, label: string) {
  const state = new FleetState(config);
  await state.withControlLock(() => {
    if (state.load() || !state.control()?.enabled) throw new TelegramStateError();
    state.save({ version: 1, role: 'controller', binding: currentBinding(state), local: newFleetNode(label), workers: [] });
  });
}
export async function addFleetWorker(config: Config, label: string, saveInvitation: (value: FleetWorker) => void) {
  const state = new FleetState(config);
  return state.withControlLock(() => {
    const fleet = state.load();
    if (fleet?.role !== 'controller' || !state.control()?.enabled || !sameBinding(currentBinding(state), fleet.binding) || fleet.workers.length + 1 >= FLEET_LIMITS.nodes) throw new TelegramStateError();
    const node = newFleetNode(label), key = randomBytes(32).toString('hex');
    const next = validateFleet({ ...fleet, workers: [...fleet.workers, { ...node, key }] });
    // Create-only private output must succeed before authorizing this worker.
    saveInvitation({ version: 1, role: 'worker', binding: fleet.binding, controller: config.origin, node, key });
    state.save(next); return node;
  });
}
export async function joinFleet(config: Config, invitation: unknown) {
  const worker = validateFleet(invitation);
  if (worker.role !== 'worker' || worker.controller === config.origin) throw new TelegramStateError();
  if (config.telegramBot && (config.telegramBot.id !== worker.binding.bot.id || config.telegramBot.username !== worker.binding.bot.username)) throw new TelegramStateError();
  const pinned = { ...config, telegramBot: worker.binding.bot }, state = new FleetState(pinned);
  await state.withControlLock(() => {
    if (state.load() || state.control()?.enabled) throw new TelegramStateError();
    const existing = state.control();
    if (existing?.owner && !sameBinding(currentBinding(state), worker.binding)) throw new TelegramStateError();
    state.save(worker); enableWorkerState(new TelegramState(pinned), worker);
  });
  return worker.node;
}
function enableWorkerState(state: TelegramState, worker: FleetWorker) {
  const epoch = generation();
  state.claim(epoch, 0); state.setNotifications(epoch, true);
  state.setControl({ version: 1, epoch, enabled: true, owner: { ...worker.binding.owner }, botId: worker.binding.bot.id, botUsername: worker.binding.bot.username, pairedAt: Date.now() });
}
export async function enableFleetWorker(config: Config) {
  const state = new FleetState(config);
  await state.withControlLock(() => {
    const worker = state.load();
    if (worker?.role !== 'worker' || !sameBinding(currentBinding(state), worker.binding)) throw new TelegramStateError();
    enableWorkerState(state, worker);
  });
}
export async function removeFleetWorker(config: Config, id: string) {
  const state = new FleetState(config);
  await state.withControlLock(() => {
    const fleet = state.load();
    if (fleet?.role !== 'controller' || !fleet.workers.some(w => w.id === id)) throw new TelegramStateError();
    state.save({ ...fleet, workers: fleet.workers.filter(w => w.id !== id) });
  });
}
