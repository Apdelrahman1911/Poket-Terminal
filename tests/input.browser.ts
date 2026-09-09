import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { foreground } from './foreground.js';
import { delayedNetwork } from './network-tools.js';
import { browserLogin, createShell, installCounters, selectSession, typeCommand } from './browser-tools.js';
import { until } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';
import { ROOT } from '../src/server/config.js';

let backend: Awaited<ReturnType<typeof foreground>>;
const evidence: object[] = [];
const markerLines = (name: string) => fs.existsSync(path.join(backend.config.defaultCwd, name)) ? fs.readFileSync(path.join(backend.config.defaultCwd, name), 'utf8').trim().split('\n').length : 0;
const tmux = (args: string[]) => execFileSync('tmux', ['-L', backend.config.tmuxSocket, ...args], { encoding: 'utf8' }).trim();
const ptyFds = () => fs.readdirSync(`/proc/${backend.backendPid}/fd`).filter(fd => { try { return /^\/dev\/pts\/ptmx$|^\/dev\/ptmx$/.test(fs.readlinkSync(`/proc/${backend.backendPid}/fd/${fd}`)); } catch { return false; } });
async function settleInput(page: Page) {
  // Proxy forwarding is not browser dispatch. Let xterm's initial automatic queries
  // and queued onData callbacks finish before choosing which ACK the fixture drops.
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => (window as any).__inputDeadlineTimers.size), { timeout: 6000 }).toBe(0);
}
test.beforeAll(async () => { backend = await foreground('input-network'); });
test.afterAll(async () => {
  if (!backend) return;
  const close = await backend.close();
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence/input-network-regressions.json'), JSON.stringify({ at: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), fixtureOnly: true, minimalEnvironment: true, httpBehindTLS: true, productionBuild: true, tests: evidence, close }, null, 2), { mode: 0o600 });
  expect(close.graceful).toBe(true);
});
test.beforeEach(async ({ context }) => {
  await installCounters(context);
  await context.addInitScript(() => {
    const timers = new Set<number>(), set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    (window as any).__inputDeadlineTimers = timers;
    window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: any[]) => {
      const id = set(typeof callback === 'function' ? () => { timers.delete(id); callback(...args); } : callback, ms);
      if (ms === 5000) timers.add(id); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id?: number) => { timers.delete(id!); clear(id); };
  });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0, 7000, 'Actual native attachment/fd leaked');
});

test('Input: mobile 2300 ms RTT accepts an already-written command exactly once, including automatic xterm query replies', async ({ page }) => {
  const network = await delayedNetwork(page);
  await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Delayed input'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  const input = page.locator('.xterm-helper-textarea'), beforeFill = network.stats.inputs;
  await input.fill("printf 'once\\n' >> delayed-marker"); await until(() => network.stats.inputs > beforeFill);
  await settleInput(page);
  expect(attachmentPids(descendants(backend.backendPid))).toHaveLength(1); expect(ptyFds()).toHaveLength(1);
  const start = performance.now(), acks = network.stats.deliveredAcks;
  network.policy.upMs = 800; network.policy.downMs = 1500;
  await input.press('Enter'); await until(() => markerLines('delayed-marker') === 1);
  await page.waitForTimeout(1300); await expect(page.getByTestId('connection-status')).toContainText('You control input');
  await until(() => network.stats.deliveredAcks > acks);
  const acknowledgedMs = performance.now() - start;
  expect(acknowledgedMs).toBeGreaterThanOrEqual(2300); expect(markerLines('delayed-marker')).toBe(1);
  // A real tmux passthrough query produces onData without any browser typing/paste.
  tmux(['set-option', '-t', `=pt_${row.id}:0`, 'allow-passthrough', 'on']);
  const replies = network.stats.terminalReplies, repliesAcked = network.stats.deliveredAcks;
  tmux(['send-keys', '-t', `=pt_${row.id}:0.0`, "printf '\\033Ptmux;\\033\\033[6n\\033\\\\'", 'Enter']);
  await until(() => network.stats.terminalReplies > replies, 6000, 'Fixture did not cause an automatic xterm cursor-position response');
  await until(() => network.stats.deliveredAcks > repliesAcked, 5000);
  await expect(page.getByTestId('connection-status')).toContainText('You control input'); expect(network.stats.overflow).toBe(false);
  evidence.push({ test: 'mobile-roundtrip-and-automatic-query', acknowledgedMs, roundtripMs: 2300, markerLines: markerLines('delayed-marker'), ...network.stats });
});

test('Input: bounded slow downlink output FIFO can delay an ACK beyond 2 s without losing or replaying input', async ({ page }) => {
  const network = await delayedNetwork(page); await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Output FIFO'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  const producer = path.join(backend.config.defaultCwd, 'burst.py');
  fs.writeFileSync(producer, "import os,time,random\ntime.sleep(2)\nr=random.Random(47)\nfor i in range(64): os.write(1, ('%04d '%i+''.join(r.choice('abcdefghijk0123456789') for _ in range(65))+'\\r\\n').encode())\n", { mode: 0o600 });
  await typeCommand(page, 'python3 burst.py &'); await settleInput(page);
  const input = page.locator('.xterm-helper-textarea'), beforeFill = network.stats.inputs;
  await input.fill("printf 'once\\n' >> fifo-marker"); await until(() => network.stats.inputs > beforeFill); await settleInput(page);
  network.policy.upMs = 100; network.policy.downMs = 2200; network.policy.downBytesPerSecond = 8192;
  await until(() => network.stats.queuedBytes >= 1024, 6000);
  const acks = network.stats.deliveredAcks, start = performance.now(); await input.press('Enter');
  await until(() => markerLines('fifo-marker') === 1); await until(() => network.stats.deliveredAcks > acks, 5000);
  const acknowledgedMs = performance.now() - start;
  expect(acknowledgedMs).toBeGreaterThan(2000); expect(acknowledgedMs).toBeLessThan(5000);
  await expect(page.getByTestId('connection-status')).toContainText('You control input'); expect(markerLines('fifo-marker')).toBe(1); expect(network.stats.overflow).toBe(false);
  evidence.push({ test: 'downlink-output-fifo', acknowledgedMs, downlinkBytesPerSecond: 8192, ...network.stats });
});

test('Input: lost ACK still expires at 5 s despite continuing output; pending input is never replayed after reconnect', async ({ page }) => {
  const network = await delayedNetwork(page); await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Lost ACK'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  const panePid = tmux(['display-message', '-p', '-t', `=pt_${row.id}:0.0`, '#{pane_pid}']);
  fs.writeFileSync(path.join(backend.config.defaultCwd, 'progress.py'), "import os,time\nfor i in range(70):\n time.sleep(.1)\n os.write(1,b'fixture-output-progress\\r\\n')\n", { mode: 0o600 });
  await typeCommand(page, 'python3 progress.py &'); await settleInput(page);
  const input = page.locator('.xterm-helper-textarea'), beforeFill = network.stats.inputs;
  await input.fill("printf 'once\\n' >> lost-marker"); await until(() => network.stats.inputs > beforeFill); await settleInput(page);
  network.policy.dropInputAcks = true; const sent = network.stats.inputs, received = network.stats.deliveredBinaryBytes;
  await page.evaluate(() => {
    const start = performance.now(); (window as any).__inputFailureMs = null;
    const observer = new MutationObserver(() => { if (document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('Input was not acknowledged')) { (window as any).__inputFailureMs = performance.now() - start; observer.disconnect(); } });
    observer.observe(document.querySelector('[data-testid="connection-status"]')!, { childList: true, subtree: true, characterData: true });
  });
  await input.press('Enter'); await until(() => markerLines('lost-marker') === 1);
  await input.fill('printf replayed >> replay-marker'); await input.press('Enter');
  await expect(page.getByTestId('connection-status')).toContainText('Input was not acknowledged', { timeout: 7000 });
  const failedMs = await page.evaluate(() => (window as any).__inputFailureMs);
  expect(failedMs).toBeGreaterThanOrEqual(4900); expect(failedMs).toBeLessThan(6500);
  expect(network.stats.inputs - sent).toBe(1); expect(network.stats.deliveredBinaryBytes).toBeGreaterThan(received);
  expect(markerLines('lost-marker')).toBe(1); expect(markerLines('replay-marker')).toBe(0);
  await until(() => ptyFds().length === 0 && attachmentPids(descendants(backend.backendPid)).length === 0);
  expect(await page.evaluate(() => (window as any).__inputDeadlineTimers.size)).toBe(0);
  network.policy.dropInputAcks = false;
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await expect(page.getByTestId('connection-status')).toContainText('You control input');
  await page.waitForTimeout(300); expect(markerLines('lost-marker')).toBe(1); expect(markerLines('replay-marker')).toBe(0);
  expect(tmux(['display-message', '-p', '-t', `=pt_${row.id}:0.0`, '#{pane_pid}'])).toBe(panePid);
  evidence.push({ test: 'lost-ack-hard-deadline-no-replay', failedMs, markerLines: 1, replayLines: 0, jobIdentitySurvived: true, ...network.stats });
});

test('Input: switch, background, disconnect and logout cancel pending deadlines and discard late ACKs', async ({ page }) => {
  const network = await delayedNetwork(page); await browserLogin(page, backend.config.origin);
  const a = await createShell(page, 'Lifecycle A'), b = await createShell(page, 'Lifecycle B'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, a.id);
  await settleInput(page); network.policy.downMs = 1500;
  for (const action of ['switch', 'background', 'disconnect', 'logout']) {
    await page.locator('.xterm-helper-textarea').press('x');
    expect(await page.evaluate(() => (window as any).__inputDeadlineTimers.size)).toBe(1);
    const oldTimers = await page.evaluate(() => [...(window as any).__inputDeadlineTimers] as number[]);
    if (action === 'switch') await selectSession(page, b.id);
    if (action === 'background') {
      await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); document.dispatchEvent(new Event('freeze')); });
      await expect(page.locator('.xterm')).toHaveCount(0); expect(await page.evaluate(() => (window as any).__inputDeadlineTimers.size)).toBe(0);
      await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); document.dispatchEvent(new Event('resume')); });
    }
    if (action === 'disconnect') { await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); expect(await page.evaluate(() => (window as any).__inputDeadlineTimers.size)).toBe(0); await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); }
    if (action === 'logout') await page.getByRole('button', { name: 'Log out', exact: true }).click();
    if (action !== 'logout') await expect(page.getByTestId('connection-status')).toContainText('You control input');
    expect(await page.evaluate(ids => ids.some(id => (window as any).__inputDeadlineTimers.has(id)), oldTimers)).toBe(false);
    await settleInput(page);
  }
  await page.waitForTimeout(3500); await expect(page.locator('.xterm')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  tmux(['has-session', '-t', `=pt_${a.id}`]); tmux(['has-session', '-t', `=pt_${b.id}`]); expect(network.stats.overflow).toBe(false);
  evidence.push({ test: 'switch-background-disconnect-logout', deadlineTimers: 0, jobsSurvived: true, ...network.stats });
});

test('Security: plaintext page redirects before mounting password UI or issuing auth requests; no forwarded-header trust', async ({ page }) => {
  let passwordMounted = false; const plaintextApi: string[] = [];
  await page.exposeFunction('__plaintextPassword', () => { passwordMounted = true; });
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return;
    new MutationObserver(() => { if (document.querySelector('input[type="password"]')) (window as any).__plaintextPassword(); }).observe(document, { childList: true, subtree: true });
  });
  await page.route('https://plaintext-fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic HTTPS destination</title>' }));
  await page.route('http://plaintext-fixture.invalid/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) plaintextApi.push(pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    if (!/^(index\.html|assets\/[\w.-]+\.(js|css))$/.test(relative)) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ status: 200, contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(path.join(ROOT, 'dist/client', relative)), headers: { 'X-Forwarded-Proto': 'https' } });
  });
  await page.goto('http://plaintext-fixture.invalid/?discard-this=fixture');
  await expect(page).toHaveURL('https://plaintext-fixture.invalid/');
  expect(passwordMounted).toBe(false); expect(plaintextApi).toEqual([]); await expect(page.locator('input')).toHaveCount(0);
  evidence.push({ test: 'plaintext-client-guard', passwordMounted, plaintextApiRequests: plaintextApi.length, noPublicRequest: true, edgeRedirectVerified: false });
});
