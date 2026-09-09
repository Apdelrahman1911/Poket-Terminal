import { numericId } from './telegram-state.js';
import { parseNavigation } from './telegram-ui.js';

export type Message = { message_id: number; date: number; text?: string; from: { id: number; is_bot: boolean; username?: unknown };
  chat: { id: number; type: string }; reply_to_message?: Message; [key: string]: unknown };
export type Callback = { id: string; data: string; from: { id: number; is_bot: boolean }; message: Message };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const forbidden = ['edit_date', 'forward_origin', 'forward_date', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'is_automatic_forward', 'sender_chat', 'via_bot', 'business_connection_id', 'sender_business_bot', 'is_topic_message'];
export function privateMessage(value: unknown, fromBot = false): value is Message {
  if (!object(value) || forbidden.some(key => key in value) || !numericId(value.message_id) || !numericId(value.date)) return false;
  const from = value.from, chat = value.chat;
  return object(from) && numericId(from.id) && from.is_bot === fromBot && object(chat) && chat.type === 'private' && numericId(chat.id);
}
export function userMessage(update: Record<string, unknown>): Message | undefined {
  if (Object.keys(update).some(k => k !== 'update_id' && k !== 'message') || !privateMessage(update.message)) return;
  return update.message;
}
export function callback(update: Record<string, unknown>, botId: number): Callback | undefined {
  if (Object.keys(update).some(k => k !== 'update_id' && k !== 'callback_query')) return;
  const c = update.callback_query;
  if (!object(c) || !object(c.from) || !numericId(c.from.id) || c.from.is_bot !== false || !privateMessage(c.message, true) || c.message.from.id !== botId || 'inline_message_id' in c) return;
  if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.id) || typeof c.data !== 'string' || (!/^p:[A-Za-z0-9_-]{22}$/.test(c.data) && !parseNavigation(c.data))) return;
  return c as unknown as Callback;
}
export function fresh(date: number, now: number, maxAgeMs: number) { return date * 1000 >= now - maxAgeMs && date * 1000 <= now + 5000; }
