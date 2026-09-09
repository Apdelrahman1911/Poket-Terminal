import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { production } from './production.js';
import { browserLogin, createShell, installCounters, selectSession, typeCommand, browserApi, resources } from './browser-tools.js';
import { until } from './helpers.js';
let backend: Awaited<ReturnType<typeof production>>;
test.beforeAll(async () => { backend = await production('browser-suite'); });
test.afterAll(async () => { await backend.close(); });
test.beforeEach(async ({ context }) => { await installCounters(context); });
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) {
    const auth = await page.request.get(backend.config.origin + '/api/auth');
    if ((await auth.json()).authenticated) {
      const { data } = await browserApi(page, '/api/sessions');
      for (const s of data.sessions || []) if (s.state !== 'stopped') await browserApi(page, `/api/sessions/${s.id}/stop`, 'POST', { confirm: s.id });
    }
  }
});

test('Production UI: login, create/rename, Unicode/ANSI, alternate screen, reconnect and confirmed target Stop', async ({ page }) => {
  await browserLogin(page, backend.config.origin);
  await page.getByRole('button', { name: 'New session' }).click(); await page.getByLabel('Label', { exact: true }).fill('Browser shell'); await page.getByLabel('Kind').selectOption('shell'); await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toContainText('You control input');
  await typeCommand(page, "printf '\\033[31mUNICODE-✓-界-é\\033[0m\\n'");
  await expect(page.locator('.xterm-rows')).toContainText('UNICODE-✓-界-é');
  await expect.poll(() => page.locator('.xterm-rows span').evaluateAll(elements => elements.some(e => { const color = getComputedStyle(e).color.match(/\d+/g)?.map(Number); return e.textContent?.includes('UNICODE-') && color && color[0] > color[1] * 1.5 && color[0] > color[2] * 1.5; }))).toBe(true);
  await typeCommand(page, "printf '\\033[?1049h\\033[2J\\033[HAltScreen-界'; sleep 2; printf '\\033[?1049lNORMAL-RETURN\\n'");
  await expect(page.locator('.xterm-rows')).toContainText('AltScreen-界'); await expect(page.locator('.xterm-rows')).not.toContainText('UNICODE-'); await expect(page.locator('.xterm-rows')).toContainText('NORMAL-RETURN');
  await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByLabel('New session label').fill('Renamed ✓'); await page.getByRole('button', { name: 'Save name' }).click(); await expect(page.locator('.session-header h1')).toHaveText('Renamed ✓');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(page.locator('.xterm')).toHaveCount(0); await until(async () => (await backend.measure()).bridges.ptys === 0);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await expect(page.locator('.xterm')).toHaveCount(1); await expect(page.locator('.xterm-rows')).toContainText('NORMAL-RETURN');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.locator('.xterm')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.locator('.xterm')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Session stopped' })).toBeVisible();
});
test('Production UI: 20 metadata entries but only one mounted xterm/WebSocket; switches and no hidden output cache', async ({ page }) => {
  await browserLogin(page, backend.config.origin); const sessions = [];
  for (let i = 0; i < 20; i++) sessions.push(await createShell(page, `Session ${i}`));
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await expect(page.locator('.session-item').filter({ hasText: 'shell · running' })).toHaveCount(20);
  await selectSession(page, sessions[0].id); await selectSession(page, sessions[19].id);
  const counts = await resources(page); expect(counts.xterms).toBe(1); expect(counts.liveSockets).toBe(1);
  const stats = await backend.measure(); expect(stats.bridges.ptys).toBe(1); expect(stats.sessions.managedRunning).toBe(20);
  expect((await browserApi(page, '/api/sessions', 'POST', { kind: 'shell' })).status).toBe(409);
});
test('Mobile UI: rotation, Ctrl/Alt/Esc/Tab, pagehide/freeze disposal and exactly-once resume', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin); const session = await createShell(page); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, session.id);
  await typeCommand(page, "printf 'MOBILE-READY\\n'"); await expect(page.locator('.xterm-rows')).toContainText('MOBILE-READY');
  await page.setViewportSize({ width: 844, height: 390 }); await expect(page.locator('.xterm')).toHaveCount(1);
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click(); await page.locator('.xterm-helper-textarea').press('c'); await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Esc', exact: true }).click(); await page.getByRole('button', { name: 'Tab', exact: true }).click();
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); document.dispatchEvent(new Event('freeze')); });
  await expect(page.locator('.xterm')).toHaveCount(0); await until(async () => (await backend.measure()).bridges.ptys === 0);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); document.dispatchEvent(new Event('resume')); });
  await expect(page.locator('.xterm')).toHaveCount(1); await expect(page.getByTestId('connection-status')).toContainText('You control input'); expect((await resources(page)).liveSockets).toBe(1);
});
test('Regression: delayed clipboard read is single-flight and cannot paste into a switched/reconnected terminal', async ({ page }) => {
  await browserLogin(page, backend.config.origin); const a = await createShell(page, 'Clipboard A'), b = await createShell(page, 'Clipboard B'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, a.id);
  await page.evaluate(() => {
    (window as any).__clipboardCalls = 0;
    Object.defineProperty(navigator.clipboard, 'readText', { configurable: true, value: () => { (window as any).__clipboardCalls++; return new Promise<string>(resolve => { (window as any).__clipboardResolve = resolve; }); } });
  });
  await page.getByRole('button', { name: 'Paste', exact: true }).click(); await page.getByRole('button', { name: 'Paste', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__clipboardCalls)).toBe(1);
  await selectSession(page, b.id); const before = (await resources(page)).inputMessages;
  await page.evaluate(() => (window as any).__clipboardResolve('echo CROSS_SESSION_ERROR > clipboard-race\r'));
  await page.waitForTimeout(200); expect((await resources(page)).inputMessages).toBe(before); expect(fs.existsSync(path.join(backend.config.defaultCwd, 'clipboard-race'))).toBe(false);
  await page.getByRole('button', { name: 'Paste', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await expect(page.getByTestId('connection-status')).toContainText('You control input'); const next = (await resources(page)).inputMessages;
  await page.evaluate(() => (window as any).__clipboardResolve('echo RECONNECT_ERROR > clipboard-race\r')); await page.waitForTimeout(100); expect((await resources(page)).inputMessages).toBe(next);
});
test('Regression: a stale successful foreground auth response cannot resurrect a logged-out page', async ({ page }) => {
  await browserLogin(page, backend.config.origin); const row = await createShell(page); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  let release: (() => Promise<void>) | undefined;
  await page.route('**/api/auth', async route => { const response = await route.fetch(); await new Promise<void>(resolve => { release = async () => { await route.fulfill({ response }); resolve(); }; }); });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('.xterm')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await until(() => !!release);
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await release!(); await page.waitForTimeout(200); await expect(page.locator('.xterm')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.unroute('**/api/auth');
});
test('Production UI: labels render as text, not HTML; logout disposes active renderer/socket', async ({ page }) => {
  await browserLogin(page, backend.config.origin); const row = await createShell(page, '<img src=x onerror=alert(1)>'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  expect(await page.locator('.session-header img').count()).toBe(0); await expect(page.locator('.session-header h1')).toHaveText('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page.locator('.xterm')).toHaveCount(0); await until(async () => (await backend.measure()).bridges.ptys === 0);
});

test('Mobile keyboard regression: visualViewport-only shrink coalesces layout and keeps terminal keys above the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin); const row = await createShell(page, 'Keyboard fixture'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  const layoutHeight = await page.evaluate(() => window.innerHeight);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 360 });
    for (let i = 0; i < 50; i++) window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-pt-compact', 'true');
  await expect.poll(() => page.locator('.workspace').evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(360);
  expect(await page.evaluate(() => window.innerHeight)).toBe(layoutHeight);
  expect(await page.locator('.keys').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(361);
  expect((await resources(page)).xterms).toBe(1); expect((await resources(page)).liveSockets).toBe(1);
  await typeCommand(page, "printf 'KEYBOARD-OK\\n'"); await expect(page.locator('.xterm-rows')).toContainText('KEYBOARD-OK');
  await page.evaluate(() => { delete (window.visualViewport as any).height; window.visualViewport!.dispatchEvent(new Event('resize')); });
  await expect(page.locator('html')).toHaveAttribute('data-pt-compact', 'false'); await expect(page.locator('.xterm')).toHaveCount(1);
});
