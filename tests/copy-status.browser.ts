import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { foreground } from './foreground.js';
import { browserApi, browserLogin, createShell, installCounters, resources, selectSession, typeCommand } from './browser-tools.js';
import { until } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';
import { ROOT } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { ACTIVITY_OPTION, ACTIVITY_VERSION } from '../src/server/status.js';

test.use({ hasTouch: true });
let backend: Awaited<ReturnType<typeof foreground>>;
const evidence: object[] = [];
const tmux = (args: string[]) => execFileSync('tmux', ['-L', backend.config.tmuxSocket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ptyFds = () => fs.readdirSync(`/proc/${backend.backendPid}/fd`).filter(fd => { try { return /^\/dev\/pts\/ptmx$|^\/dev\/ptmx$/.test(fs.readlinkSync(`/proc/${backend.backendPid}/fd/${fd}`)); } catch { return false; } });
async function instrument(context: BrowserContext) {
  await installCounters(context);
  await context.addInitScript(() => {
    const s = { catalogs: 0, pending: 0, maxPending: 0, captures: 0, timers: new Set<number>(), writes: 0, last: '', mode: 'deny', inputs: 0, acks: 0 };
    (window as any).__copyStatus = s;
    const nativeFetch = window.fetch;
    window.fetch = (input, options) => {
      const url = new URL(String(input), location.href), catalog = url.pathname === '/api/sessions' && (!options?.method || options.method === 'GET');
      if (url.pathname.endsWith('/snapshot')) s.captures++;
      let done = false;
      const finish = () => { if (done) return; done = true; if (catalog) s.pending--; options?.signal?.removeEventListener('abort', finish); };
      if (catalog) { s.catalogs++; s.pending++; s.maxPending = Math.max(s.pending, s.maxPending); }
      options?.signal?.addEventListener('abort', finish, { once: true });
      return nativeFetch(input, options).finally(finish);
    };
    const nativeSet = window.setTimeout, nativeClear = window.clearTimeout;
    window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: any[]) => {
      const watch = ms === 3000 || ms === 8000;
      const id = nativeSet(() => { if (watch) s.timers.delete(id); if (typeof callback === 'function') callback(...args); }, ms);
      if (watch) s.timers.add(id); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = id => { if (id !== undefined) s.timers.delete(id); nativeClear(id); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (value: string) => {
      s.writes++; s.last = value;
      if (s.mode === 'delay') return new Promise<void>(resolve => { (window as any).__finishCopy = resolve; });
      return s.mode === 'deny' ? Promise.reject(new DOMException('Synthetic denial', 'NotAllowedError')) : Promise.resolve();
    } } });
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); this.addEventListener('message', event => { if (typeof event.data === 'string' && JSON.parse(event.data).type === 'input_ack') s.acks++; }); }
      override send(value: string | ArrayBufferLike | Blob | ArrayBufferView) { if (typeof value === 'string' && value.startsWith('{"type":"input"')) s.inputs++; super.send(value); }
    };
  });
}
const counts = (page: Page) => page.evaluate(() => { const s = (window as any).__copyStatus; return { ...s, timers: s.timers.size }; });
async function settle(page: Page) { await expect.poll(async () => { const s = await counts(page); return s.inputs - s.acks; }).toBe(0); }
async function fixture(page: Page, label: string) {
  const row = await createShell(page, label); await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await selectSession(page, row.id); return row;
}
test.beforeAll(async () => { backend = await foreground('copy-status-browser'); });
test.beforeEach(async ({ context }) => { await instrument(context); });
test.afterEach(async ({ page }) => {
  await page.close(); await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0, 7000, 'Copy/catalog native cleanup');
});
test.afterAll(async () => {
  if (!backend) return;
  const close = await backend.close();
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence/copy-status-browser.json'), JSON.stringify({ at: new Date().toISOString(), fixtureOnly: true, productionBuild: true, minimalEnvironment: true, tests: evidence, close }, null, 2), { mode: 0o600 });
  expect(close.graceful).toBe(true);
});

test('Copy: mobile visible/recent real history, denied/unavailable native-selection fallback, bounded clipboard and no shell input', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin);
  await fixture(page, 'Copy mobile fixture');
  await typeCommand(page, `python3 -c "for i in range(240): print('COPY_ROW_%03d 界🙂'%i)"`);
  await expect(page.locator('.xterm-rows')).toContainText('COPY_ROW_239'); await settle(page);
  const before = await counts(page), sockets = await resources(page);
  await page.getByRole('button', { name: 'Copy output', exact: true }).click();
  const area = page.getByLabel('Output snapshot'); await expect(area).toHaveAttribute('readonly', '');
  await expect(area).toHaveValue(/COPY_ROW_239/); await expect(area).not.toHaveValue(/COPY_ROW_100/);
  expect((await counts(page)).captures).toBe(0);
  await page.getByRole('button', { name: 'Copy recent', exact: true }).click(); await expect(area).toHaveValue(/COPY_ROW_100/);
  const recent = await area.inputValue(); expect(Buffer.byteLength(recent)).toBeLessThanOrEqual(65536); expect(recent.split('\n').length).toBeLessThanOrEqual(200);
  await page.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('Clipboard denied');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  expect(await area.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, recent.length]);
  await page.evaluate(() => { (window as any).__copyStatus.mode = 'ok'; });
  await page.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('Copied.'); expect((await counts(page)).last).toBe(recent);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.getByRole('button', { name: 'Copy text', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('Clipboard unavailable');
  await page.screenshot({ path: path.join(ROOT, '.runtime/evidence/copy-mobile.png') });
  await page.getByRole('button', { name: 'Close copy', exact: true }).click(); await expect(area).toHaveCount(0);
  expect((await counts(page)).inputs).toBe(before.inputs); expect((await resources(page)).createdSockets).toBe(sockets.createdSockets); expect((await resources(page)).xterms).toBe(1);
  evidence.push({ test: 'mobile-copy-fallback', recentBytes: Buffer.byteLength(recent), recentLines: recent.split('\n').length, nativeSelection: true, priorTmuxHistory: true, additionalInput: 0, additionalSockets: 0 });
});

test('Copy/catalog: delayed clipboard and capture cannot cross sessions; background/logout clear snapshots, timers, requests and terminal', async ({ page }) => {
  await browserLogin(page, backend.config.origin); const a = await fixture(page, 'Copy A'), b = await createShell(page, 'Copy B');
  await typeCommand(page, "echo ONLY_COPY_A"); await expect(page.locator('.xterm-rows')).toContainText('ONLY_COPY_A'); await settle(page);
  await page.evaluate(() => { (window as any).__copyStatus.mode = 'delay'; });
  await page.getByRole('button', { name: 'Copy output', exact: true }).click(); await page.getByRole('button', { name: 'Copy text', exact: true }).click();
  await page.getByRole('button', { name: 'Copy text', exact: true }).click(); expect((await counts(page)).writes).toBe(1);
  await page.getByRole('button', { name: 'Close copy', exact: true }).click(); await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await selectSession(page, b.id);
  await typeCommand(page, "echo ONLY_COPY_B"); await expect(page.locator('.xterm-rows')).toContainText('ONLY_COPY_B'); await settle(page);
  await page.getByRole('button', { name: 'Copy output', exact: true }).click(); await expect(page.getByLabel('Output snapshot')).not.toHaveValue(/ONLY_COPY_A/);
  await page.getByRole('button', { name: 'Copy text', exact: true }).click(); expect((await counts(page)).writes).toBe(1);
  await page.evaluate(() => { (window as any).__finishCopy(); (window as any).__copyStatus.mode = 'ok'; });
  await expect(page.getByRole('dialog')).not.toContainText('Copied.');
  await page.getByRole('button', { name: 'Close copy', exact: true }).click(); await selectSession(page, a.id);
  let release: (() => void) | undefined, finished = false;
  await page.route(`**/api/sessions/${a.id}/snapshot`, async route => {
    const response = await route.fetch(); await new Promise<void>(resolve => { release = resolve; });
    try { await route.fulfill({ response }); } catch { /* browser intentionally aborted the obsolete capture */ } finally { finished = true; }
  });
  try {
    await page.getByRole('button', { name: 'Copy output', exact: true }).click(); await page.getByRole('button', { name: 'Copy recent', exact: true }).click(); await until(() => !!release);
    await page.getByRole('button', { name: 'Close copy', exact: true }).click(); await selectSession(page, b.id);
    await page.getByRole('button', { name: 'Copy output', exact: true }).click(); release!(); await until(() => finished);
    await expect(page.getByLabel('Output snapshot')).not.toHaveValue(/ONLY_COPY_A/); expect((await counts(page)).writes).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.xterm')).toHaveCount(0);
    await expect.poll(async () => ({ timers: (await counts(page)).timers, pending: (await counts(page)).pending })).toEqual({ timers: 0, pending: 0 });
    const hidden = await counts(page); await page.waitForTimeout(3200); expect((await counts(page)).catalogs).toBe(hidden.catalogs);
    await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.getByTestId('connection-status')).toContainText('You control input'); await page.getByRole('button', { name: 'Copy output', exact: true }).click();
    // Revoke only this synthetic login while the modal is open; server WS expiry disposes it.
    expect((await browserApi(page, '/api/logout', 'POST', {})).status).toBe(200);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.xterm')).toHaveCount(0);
    expect((await counts(page)).timers).toBe(0); expect((await counts(page)).pending).toBe(0); expect((await counts(page)).maxPending).toBe(1);
    evidence.push({ test: 'copy-and-poll-lifecycle', singleClipboardWrite: true, staleCaptureDiscarded: true, staleWriteFeedbackDiscarded: true, backgroundCatalogRequests: 0, disposedCatalogTimers: true, maxCatalogRequests: 1, logoutSnapshotGone: true });
  } finally { release?.(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});

test('Catalog: exact activity versus lifecycle/attachment, errors/stale foreground, 20-card paging preserves selected terminal', async ({ page }) => {
  await browserLogin(page, backend.config.origin); const row = await fixture(page, 'Native status fixture'), pane = `=pt_${row.id}:0.0`;
  const card = page.locator(`[data-session-id="${row.id}"]`);
  await expect(card.getByTestId('activity')).toHaveText('Running · activity not reported');
  await expect(card.getByTestId('lifecycle')).toContainText('running'); await expect(card.getByTestId('attachment')).toHaveText('Browser: controlling');
  tmux(['set-option', '-p', '-t', pane, ACTIVITY_OPTION, ACTIVITY_VERSION]); tmux(['send-keys', '-t', pane, 'exec -a codex /bin/sleep 120', 'Enter']);
  await until(() => tmux(['display-message', '-p', '-t', pane, '#{pane_current_command}']) === 'codex');
  for (const [title, label] of [['⠋ Thinking', 'CLI: Working'], ['[ ! ] Action Required', 'CLI: Awaiting input'], ['Ready', 'CLI: Ready · awaiting prompt']]) {
    tmux(['select-pane', '-t', pane, '-T', title!]); await expect(card.getByTestId('activity')).toHaveText(label!, { timeout: 6000 });
  }
  const store = new Store(backend.config.dataDir);
  try { for (let i = 0; i < 25; i++) { const id = (200 + i).toString(16).padStart(32, '0'); store.db.prepare('INSERT INTO terminals VALUES(?,?,?,?,?,?,?,?,?)').run(id, `pt_${id}`, `Old synthetic ${i}`, 'shell', backend.config.defaultCwd, 'stopped', i, i, i === 24 ? 'start_failed' : 'owner_stopped'); } } finally { store.close(); }
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await expect(page.locator('.session-item')).toHaveCount(20);
  await expect(page.locator('.session-item').filter({ hasText: 'Old synthetic 24' }).getByTestId('lifecycle')).toContainText('error');
  await page.evaluate(() => { (window as any).__keptTerminal = document.querySelector('.xterm'); }); const before = await resources(page), native = attachmentPids(descendants(backend.backendPid));
  await page.getByRole('button', { name: 'Load older sessions', exact: true }).click(); await expect(card).toHaveCount(0); await expect(page.getByRole('button', { name: 'Newer sessions', exact: true })).toBeVisible();
  await page.waitForTimeout(3200); expect((await resources(page)).createdSockets).toBe(before.createdSockets); expect(attachmentPids(descendants(backend.backendPid))).toEqual(native);
  expect(await page.evaluate(() => document.querySelector('.xterm') === (window as any).__keptTerminal)).toBe(true); await expect(page.locator('.session-header h1')).toHaveText('Native status fixture');
  await page.getByRole('button', { name: 'Newer sessions', exact: true }).click(); await expect(card).toHaveCount(1);
  let fail = true, release: (() => void) | undefined;
  await page.route(/\/api\/sessions(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_inventory_unavailable"}' });
    await new Promise<void>(resolve => { release = resolve; }); await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await expect(card.getByTestId('lifecycle')).toContainText('unknown'); await expect(card.getByTestId('activity')).toContainText('Status stale');
    expect((await resources(page)).createdSockets).toBe(before.createdSockets); fail = false;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await expect(page.locator('.xterm')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await until(() => !!release);
    await expect(card.getByTestId('lifecycle')).toContainText('unknown'); await expect(card.getByTestId('activity')).not.toContainText('Ready');
    release!(); await page.unrouteAll({ behavior: 'wait' }); await expect(card.getByTestId('activity')).toHaveText('CLI: Ready · awaiting prompt');
    expect((await counts(page)).maxPending).toBe(1); expect((await counts(page)).captures).toBe(0); expect((await resources(page)).xterms).toBe(1); expect((await counts(page)).timers).toBe(1);
    evidence.push({ test: 'status-catalog', nativeThinkingWorking: true, nativeAwaitingInput: true, readyNotTaskSuccess: true, failedStartCard: true, cardsMax: 20, pagingKeptSameTerminalAndPid: true, staleForegroundUnknown: true, maxPollRequests: 1, pollTimers: 1, inactiveCaptures: 0 });
  } finally { release?.(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});
