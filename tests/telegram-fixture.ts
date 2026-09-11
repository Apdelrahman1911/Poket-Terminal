import assert from 'node:assert/strict';
import { harness, until } from './helpers.js';
import { dummyState, fakeTelegram, message, OWNER } from './telegram-fake.js';
import type { TerminalRow } from '../src/server/sessions.js';
import { telegramSessionButton } from '../src/server/telegram-presentation.js';

export async function botFixture(name: string, options: Parameters<typeof harness>[1] = {}) {
  const fake = await fakeTelegram();
  const h = await harness(name, { ...options, telegram: { endpoint: fake.endpoint, now: options.telegram?.now } });
  const state = dummyState(h.config, true);
  let sequence = 1;
  try { await until(() => h.service.telegram.stats().status === 'polling', 6000); }
  catch (e) { await h.close(); await fake.close(); throw e; }
  const last = () => fake.sent.at(-1)?.message_id || 0;
  const waitMessage = async (after: number, match: (m: any) => boolean = () => true) => {
    let found: any;
    await until(() => !!(found = fake.sent.find(m => m.message_id > after && match(m))), 8000, 'Expected synthetic bot response');
    return found;
  };
  const push = (update: Record<string, unknown>) => {
    const id = sequence++; fake.enqueue({ ...update, update_id: id }); return id;
  };
  const send = async (text: string, extra: object = {}, match?: (m: any) => boolean) => {
    const after = last(), id = push(message(1, text, extra));
    return { id, message: await waitMessage(after, match) };
  };
  const click = async (original: any, label: string, wait = true) => {
    const button = original.reply_markup?.inline_keyboard?.flat().find((b: any) => b.text === label);
    assert(button?.callback_data, 'Expected synthetic button ' + label);
    const after = last();
    const id = push({ callback_query: { id: 'q_' + sequence, from: { id: OWNER, is_bot: false }, message: original, data: button.callback_data } });
    if (wait) return { id, message: await waitMessage(after) };
    await until(() => state.cursor(state.control()!.epoch) > id); return { id, message: undefined };
  };
  const sessionButton = (row: TerminalRow) => telegramSessionButton(row.label, h.service.sessions.describe(row));
  return { h, fake, state, push, send, click, last, waitMessage, sessionButton,
    close: async () => { await h.close(); await fake.close(); } };
}
