import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { foreground } from './foreground.js';
import { browserApi, browserLogin, createShell, installCounters, resources, selectSession } from './browser-tools.js';
import { until } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';
import { ROOT } from '../src/server/config.js';

let backend: Awaited<ReturnType<typeof foreground>>;
const evidence: object[] = [];
const ptyFds = () => fs.readdirSync(`/proc/${backend.backendPid}/fd`).filter(fd => {
  try { return /^\/dev\/pts\/ptmx$|^\/dev\/ptmx$/.test(fs.readlinkSync(`/proc/${backend.backendPid}/fd/${fd}`)); } catch { return false; }
});
async function deletionDialog(page: Page, accept: boolean) {
  const waiting = page.waitForEvent('dialog'), clicking = page.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = await waiting;
  expect(dialog.message()).toContain('Remove entry only; project files/Codex history kept.');
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await clicking;
}
test.beforeAll(async () => { backend = await foreground('delete-browser'); });
test.beforeEach(async ({ context }) => { await installCounters(context); });
test.afterEach(async ({ page }) => {
  await page.close();
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0, 7000, 'Synthetic attachment/fd cleanup failed');
});
test.afterAll(async () => {
  if (!backend) return;
  const close = await backend.close();
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence/delete-browser.json'), JSON.stringify({ at: new Date().toISOString(), fixtureOnly: true, productionBuild: true, minimalEnvironment: true, tests: evidence, close }, null, 2), { mode: 0o600 });
  expect(close.graceful).toBe(true);
});

test('Delete UI: stopped-only control, cancel/confirm, cleared selection and deletion survive reload', async ({ page }) => {
  await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Delete confirmation fixture');
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  expect((await browserApi(page, `/api/sessions/${row.id}/stop`, 'POST', { confirm: row.id })).status).toBe(200);
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Session stopped', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  let deletes = 0;
  page.on('request', request => { if (request.method() === 'DELETE') deletes++; });
  await deletionDialog(page, false);
  await expect(page.locator(`[data-session-id="${row.id}"]`)).toHaveAttribute('aria-current', 'true'); expect(deletes).toBe(0);
  await deletionDialog(page, true);
  await expect(page.locator(`[data-session-id="${row.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A small window into your VPS' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('pt-selected'))).toBeNull(); expect(deletes).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await expect(page.locator(`[data-session-id="${row.id}"]`)).toHaveCount(0);
  expect((await browserApi(page, '/api/sessions')).data.sessions.some((s: { id: string }) => s.id === row.id)).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('pt-selected'))).toBeNull();
  expect((await resources(page)).xterms).toBe(0);
  evidence.push({ test: 'cancel-confirm-persistence', deleteRequests: deletes, selectionCleared: true, absentAfterReload: true });
});

test('Delete UI: delayed deletion preserves a newly selected live terminal and rejects stale list resurrection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin);
  const removed = await createShell(page, 'Remove only this entry'), keep = await createShell(page, 'Keep selected job');
  expect((await browserApi(page, `/api/sessions/${removed.id}/stop`, 'POST', { confirm: removed.id })).status).toBe(200);
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await page.locator(`[data-session-id="${removed.id}"]`).click();
  let releaseDelete: (() => void) | undefined, releaseList: (() => void) | undefined;
  let staleIncludesRemoved = false, staleFinished = false;
  try {
    await page.route(`**/api/sessions/${removed.id}`, async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await new Promise<void>(resolve => { releaseDelete = resolve; }); await route.continue();
    });
    await deletionDialog(page, true); await until(() => !!releaseDelete);
    await selectSession(page, keep.id);
    await page.route(/\/api\/sessions(?:\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      if (releaseList) return route.fulfill({ response }); // only the initiating catalog response is delayed
      staleIncludesRemoved = (await response.json()).sessions.some((s: { id: string }) => s.id === removed.id);
      await new Promise<void>(resolve => { releaseList = resolve; });
      try { await route.fulfill({ response }); } catch { /* obsolete catalog fetch was aborted on mutation */ } finally { staleFinished = true; }
    });
    // Foreground refresh is independent of action busy state, as on a real mobile page.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('.xterm')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await until(() => !!releaseList); expect(staleIncludesRemoved).toBe(true);
    await expect(page.getByTestId('connection-status')).toContainText('You control input');
    await until(() => attachmentPids(descendants(backend.backendPid)).length === 1 && ptyFds().length === 1);
    const before = await resources(page), nativeBefore = attachmentPids(descendants(backend.backendPid));
    await page.evaluate(() => { (window as any).__keptTerminal = document.querySelector('.xterm'); });
    releaseDelete!();
    await expect(page.locator(`[data-session-id="${removed.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-session-id="${keep.id}"]`)).toHaveAttribute('aria-current', 'true');
    releaseList!(); await until(() => staleFinished); // cancellation and generation rejection both prevent resurrection
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(`[data-session-id="${removed.id}"]`)).toHaveCount(0);
    await expect(page.locator('.session-header h1')).toHaveText('Keep selected job');
    await expect(page.getByTestId('connection-status')).toContainText('You control input');
    expect(await page.evaluate(() => sessionStorage.getItem('pt-selected'))).toBe(keep.id);
    expect(await page.evaluate(() => document.querySelector('.xterm') === (window as any).__keptTerminal)).toBe(true);
    const after = await resources(page);
    expect(after.createdSockets).toBe(before.createdSockets); expect(after.closedSockets).toBe(before.closedSockets);
    expect(after.liveSockets).toBe(1); expect(after.xterms).toBe(1);
    expect(attachmentPids(descendants(backend.backendPid))).toEqual(nativeBefore); expect(ptyFds()).toHaveLength(1);
    await page.unrouteAll({ behavior: 'wait' });
    await page.reload(); await expect(page.getByTestId('connection-status')).toContainText('You control input');
    await expect(page.locator('.session-header h1')).toHaveText('Keep selected job');
    await expect(page.locator(`[data-session-id="${removed.id}"]`)).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('pt-selected'))).toBe(keep.id);
    evidence.push({ test: 'delayed-selection-and-stale-list', staleListContainedDeletedRow: true, staleListDiscarded: true, selectedTerminalAndNativePidUnchanged: true, selectedAfterReload: true });
  } finally { releaseDelete?.(); releaseList?.(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});
