import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { testConfig, until, delay } from './helpers.js';
import { production } from './production.js';
import { browserLogin, installCounters, browserApi } from './browser-tools.js';

async function backend() {
  const config = await testConfig('desktop-browser');
  config.desktop = { assetsDir: '/opt/pocketdesktop/current/client', socketPath: '/run/pocketdesktop-test/rfb.sock', uid: fs.statSync('/var/lib/pocketdesktop-test').uid, startCommand: 'test-start' };
  return production('desktop-browser', config);
}
const synthetic = () => JSON.parse(fs.readFileSync('/run/pocketdesktop-test/synthetic.json', 'utf8'));
const service = () => JSON.parse(execFileSync('/usr/local/bin/pocketdesktop', ['test-status'], { encoding: 'utf8' }));
const connected = async (page: Page) => { await expect(page.locator('#status')).toHaveAttribute('data-connected', 'true'); await expect(page.locator('#screen canvas')).toHaveCount(1); };
const detached = async (page: Page) => { await expect(page.locator('#screen canvas')).toHaveCount(0); await page.waitForFunction(() => (window as any).__testResources.liveSockets === 0); };

test('noVNC real synthetic desktop: cookie auth, one renderer/socket, mouse/keyboard/manual clipboard and full-page link', async ({ page, context }) => {
  const app = await backend(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await installCounters(context);
    await page.goto(app.config.origin + '/desktop/');
    await expect(page.locator('#screen canvas')).toHaveCount(0);
    expect((await app.measure()).desktop.created).toBe(0);
    await browserLogin(page, app.config.origin);
    const desktopRequests: string[] = [];
    page.on('request', r => { desktopRequests.push(new URL(r.url()).pathname); });
    await page.getByRole('link', { name: 'Desktop', exact: true }).click(); await connected(page);
    expect(await page.locator('.xterm').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__testResources.liveSockets)).toBe(1);
    expect(desktopRequests.some(p => p.startsWith('/assets/'))).toBe(false);
    const before = synthetic();
    await page.locator('#screen canvas').click({ position: { x: 250, y: 150 } }); await page.keyboard.press('a');
    await until(() => synthetic().aKeys > before.aKeys && synthetic().clicks > before.clicks);
    await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
    await page.locator('#type-text').fill('aaa'); await page.getByRole('button', { name: 'Send keys' }).click();
    await until(() => synthetic().aKeys >= before.aKeys + 4);
    await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
    await page.locator('#clipboard-text').fill('Synthetic clipboard only'); await page.getByRole('button', { name: 'Send to clipboard' }).click();
    await expect(page.locator('#clipboard-text')).toHaveValue(''); await expect(page.locator('#status')).toContainText('Text sent');
    await page.locator('#clipboard-text').fill('漢'); await page.getByRole('button', { name: 'Send to clipboard' }).click();
    await expect(page.locator('#status')).toContainText('Latin-1');
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await page.getByRole('link', { name: '← Terminals' }).click(); await expect(page).toHaveURL(app.config.origin + '/');
    await until(async () => (await app.measure()).desktop.attachments === 0);
    expect(service().state).toBe('running'); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('noVNC lifecycle: repeated freeze/foreground, duplicate tab refusal and backend reload preserve GUI identities', async ({ page, context }) => {
  let app = await backend();
  try {
    await installCounters(context); await browserLogin(page, app.config.origin); await page.goto(app.config.origin + '/desktop/'); await connected(page);
    const original = service(), fixture = synthetic().pid;
    const duplicate = await context.newPage(); await duplicate.goto(app.config.origin + '/desktop/');
    await expect(duplicate.locator('#status')).toContainText('Disconnected', { timeout: 15000 });
    await connected(page); expect((await app.measure()).desktop.attachments).toBe(1); await duplicate.close();
    const cdp = await context.newCDPSession(page);
    for (let i = 0; i < 6; i++) {
      // This headless Chromium's CDP freeze emits no page freeze/visibility event
      // (verified separately). Emulate the phone's visibility notification first,
      // then actually freeze its renderer. This is not physical-phone acceptance.
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await until(async () => (await app.measure()).desktop.attachments === 0);
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await delay(75);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
      await connected(page); expect(await page.evaluate(() => (window as any).__testResources.liveSockets)).toBe(1);
      expect(service().xserver.startTicks).toBe(original.xserver.startTicks); expect(synthetic().pid).toBe(fixture);
    }
    const config = app.config; expect((await app.close()).graceful).toBe(true);
    await detached(page); expect(synthetic().pid).toBe(fixture);
    app = await production('desktop-reloaded', config, { initialize: false });
    await page.getByRole('button', { name: 'Connect', exact: true }).click(); await connected(page);
    expect(service().xserver.startTicks).toBe(original.xserver.startTicks); expect(synthetic().pid).toBe(fixture);
    await page.getByRole('button', { name: 'Log out', exact: true }).click(); await detached(page);
    expect(service().xserver.startTicks).toBe(original.xserver.startTicks); expect(synthetic().pid).toBe(fixture);
    expect((await app.measure()).desktop.upstreams).toBe(0);
  } finally { await app.close(); }
});

test('noVNC mobile emulation: controls reachable, scale/pan without native resize, manual-only clipboard and disposal mid-drag', async ({ browser }) => {
  const app = await backend();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  try {
    await installCounters(context);
    await context.addInitScript(() => {
      (window as any).__clipboardCalls = 0;
      for (const method of ['read', 'readText', 'write', 'writeText']) Object.defineProperty(navigator.clipboard, method, { value: () => { (window as any).__clipboardCalls++; throw new Error('No implicit clipboard'); } });
    });
    const page = await context.newPage(); await browserLogin(page, app.config.origin); await page.goto(app.config.origin + '/desktop/'); await connected(page);
    for (const name of ['Fit screen', 'Keyboard', 'Clipboard', 'Disconnect']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    }
    await page.getByRole('button', { name: 'Keyboard', exact: true }).tap();
    const enter = await page.getByRole('button', { name: 'Enter', exact: true }).boundingBox(); expect(enter!.y + enter!.height).toBeLessThanOrEqual(844);
    await page.getByRole('button', { name: 'Fit screen', exact: true }).tap(); await expect(page.locator('#fit')).toContainText('1:1');
    expect(service().display).toBe(':72');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).tap(); await detached(page);
    expect(await page.evaluate(() => (window as any).__clipboardCalls)).toBe(0);
    await page.getByRole('button', { name: 'Connect', exact: true }).tap(); await connected(page);
    await page.locator('#screen canvas').hover({ position: { x: 80, y: 80 } }); await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await detached(page); await page.mouse.up();
    expect(await page.locator('#noVNC_mouse_capture_elem').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).pocketDesktopStats().inputQueued)).toBe(0);
  } finally { await context.close(); await app.close(); }
});
