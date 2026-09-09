import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { foreground } from './foreground.js';
import { browserApi, browserLogin, createShell, installCounters, resources, selectSession, typeCommand } from './browser-tools.js';
import { until, delay } from './helpers.js';
import { dummyState, fakeTelegram, message, OWNER } from './telegram-fake.js';
import type { TelegramState } from '../src/server/telegram-state.js';
import { attachmentPids, descendants, procMemory } from '../scripts/memory.js';
import { ROOT } from '../src/server/config.js';

let fake: Awaited<ReturnType<typeof fakeTelegram>>, backend: Awaited<ReturnType<typeof foreground>>, state: TelegramState, sequence = 1;
const evidence: object[] = [];
const ptmx = () => fs.readdirSync(`/proc/${backend.backendPid}/fd`).filter(fd => { try { return /\/dev\/(pts\/)?ptmx$/.test(fs.readlinkSync(`/proc/${backend.backendPid}/fd/${fd}`)); } catch { return false; } }).length;
async function botSend(text: string, reply?: any) {
  const after = fake.sent.at(-1)?.message_id || 0;
  fake.enqueue(message(sequence++, text, reply ? { reply_to_message: reply } : {}));
  await until(() => fake.sent.some(m => m.message_id > after), 8000); return fake.sent.find(m => m.message_id > after);
}
async function click(original: any, label: string) {
  const button = original.reply_markup.inline_keyboard.flat().find((b: any) => b.text === label); expect(button?.callback_data).toBeTruthy();
  const after = fake.sent.at(-1)?.message_id || 0;
  fake.enqueue({ update_id: sequence++, callback_query: { id: 'mobile_' + sequence, from: { id: OWNER, is_bot: false }, message: original, data: button.callback_data } });
  await until(() => fake.sent.some(m => m.message_id > after), 8000); return fake.sent.find(m => m.message_id > after);
}
const pane = (id: string) => Number(execFileSync('tmux', ['-L', backend.config.tmuxSocket, 'display-message', '-p', '-t', `=pt_${id}:`, '#{pane_pid}'], { encoding: 'utf8' }).trim());

test.beforeAll(async () => {
  fake = await fakeTelegram();
  backend = await foreground('telegram-browser', { telegramEndpoint: fake.endpoint, prepare: config => { state = dummyState(config, true); } });
  await until(() => fake.calls.filter(c => c.method === 'getUpdates').length >= 2, 6000);
});
test.beforeEach(async ({ context, page }) => { await installCounters(context); await page.setViewportSize({ width: 390, height: 844 }); });
test.afterEach(async ({ page }) => {
  await page.close();
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptmx() === 0, 7000);
});
test.afterAll(async () => {
  if (!backend) { await fake?.close(); return; }
  const close = await backend.close(); await fake.close();
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence/telegram-browser.json'), JSON.stringify({ fixtureOnly: true, productionBuild: true, mobileViewport: { width: 390, height: 844 }, minimalEnvironment: true, at: new Date().toISOString(), tests: evidence, close }, null, 2));
  expect(close.graceful).toBe(true);
});

test('Telegram mobile buttons: browser-owner confirmation, view-only scroll/input, literal prompt, web take-back, one renderer/native attachment', async ({ page, context }) => {
  await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Telegram mobile fixture');
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  const job = procMemory(pane(row.id));
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 1 && ptmx() === 1);
  const native = attachmentPids(descendants(backend.backendPid));
  const selected = await botSend('/select ' + row.id);
  const conflict = await click(selected, 'Send text / paste'); expect(conflict.text).toContain('Browser owns input. Nothing was sent.');
  await expect(page.getByTestId('connection-status')).toContainText('You control input');
  const confirm = await click(conflict, 'Take control from browser…'); expect(confirm.text).toContain('Browser becomes view-only');
  await expect(page.getByTestId('connection-status')).toContainText('You control input');
  const botOwns = await click(confirm, 'Confirm take control');
  await expect(page.getByTestId('connection-status')).toContainText('Telegram controls input');
  const before = await resources(page);
  await page.locator('.xterm').hover(); await page.mouse.wheel(0, -500); await delay(100);
  expect((await resources(page)).inputMessages).toBe(before.inputMessages);
  await page.screenshot({ path: path.join(ROOT, '.runtime/evidence/telegram-mobile.png') });
  const request = await click(botOwns, 'Send prompt + Enter'), marker = path.join(backend.config.defaultCwd, 'telegram-mobile-marker');
  expect(request.text).toContain('Target: ' + row.id);
  const receipt = await botSend(`printf 'TG-mobile\\n' >> '${marker}'`, request); expect(receipt.text).toContain('Input accepted by tmux');
  await until(() => fs.existsSync(marker)); expect(fs.readFileSync(marker, 'utf8')).toBe('TG-mobile\n');
  await page.getByRole('button', { name: 'Take control', exact: true }).click(); await expect(page.getByTestId('connection-status')).toContainText('You control input');
  await typeCommand(page, `printf 'web-takeback\\n' >> '${marker}'`);
  await until(() => fs.readFileSync(marker, 'utf8') === 'TG-mobile\nweb-takeback\n');
  expect(attachmentPids(descendants(backend.backendPid))).toEqual(native); expect(ptmx()).toBe(1);
  expect((await resources(page)).liveSockets).toBe(1); expect((await resources(page)).xterms).toBe(1);
  const cdp = await context.newCDPSession(page), heap = await cdp.send('Runtime.getHeapUsage'), dom = await cdp.send('Memory.getDOMCounters'); await cdp.detach();
  expect(heap.usedSize).toBeLessThan(64 * 1024 * 1024);
  expect(procMemory(job.pid).startTicks).toBe(job.startTicks);
  evidence.push({ test: 'mobile-confirm-input-takeback', resources: await resources(page), heap, dom, nativeAttachments: native.length, ptmx: ptmx(), jobIdentityPreserved: true, exactlyOnceMarkers: true });
});

test('Telegram disable + mobile background/logout: stale bound reply never runs; job survives with zero native attachments after disposal', async ({ page }) => {
  await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Telegram disable fixture');
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  const job = procMemory(pane(row.id));
  const requestTake = await botSend('/take ' + row.id), selected = await click(requestTake, 'Confirm take control');
  const pending = await click(selected, 'Send prompt + Enter');
  await expect(page.getByTestId('connection-status')).toContainText('Telegram controls input');
  state.disable();
  await expect(page.getByTestId('connection-status')).toContainText('You control input');
  await until(() => fake.active === 0, 3000);
  const marker = path.join(backend.config.defaultCwd, 'MUST_NOT_EXIST');
  fake.enqueue(message(sequence++, `touch '${marker}'`, { reply_to_message: pending }));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('.xterm')).toHaveCount(0);
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptmx() === 0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByTestId('connection-status')).toContainText('You control input');
  expect((await resources(page)).liveSockets).toBe(1); expect((await resources(page)).xterms).toBe(1);
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptmx() === 0);
  expect(fs.existsSync(marker)).toBe(false); expect(procMemory(job.pid).startTicks).toBe(job.startTicks);
  const final = await resources(page); expect(final.liveSockets).toBe(0); expect(final.xterms).toBe(0); expect(final.createdSockets).toBe(final.closedSockets);
  evidence.push({ test: 'disable-background-logout', resources: final, actualAttachments: 0, ptmx: 0, staleInputNotRun: true, jobIdentityPreserved: true });
});
