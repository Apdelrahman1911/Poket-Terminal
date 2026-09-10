import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const origin = 'https://pocketterminal.invalid';
async function fixture(page: Page) {
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: (index + 1).toString(16).padStart(32, '0'), label: `Synthetic Codex ${index + 1}`, kind: index === 19 ? 'shell' : 'codex', cwd: '/synthetic/project', state: 'running', lifecycle: 'running', activity: 'ready', stopped_reason: null, updated_at: 100 + index, ssh: 'synthetic SSH hint', codexResumeAvailable: false }));
  const requests: { id: string; body: any }[] = [];
  let hold = false, release: (() => void) | undefined;
  await page.addInitScript(() => {
    const counters = { live: 0, created: 0, closed: 0, maxLive: 0, sentInputs: 0 };
    (window as any).__restartResources = counters;
    class Socket {
      static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
      readyState = 0; bufferedAmount = 0; binaryType = '';
      onopen: any; onmessage: any; onclose: any; onerror: any;
      constructor(_url: string, _protocols: string[]) {
        counters.created++; counters.live++; counters.maxLive = Math.max(counters.maxLive, counters.live);
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1; this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: 'control', controller: true }) });
          this.onmessage?.({ data: new TextEncoder().encode('Synthetic terminal only\r\n').buffer });
        });
      }
      send(value: string) { if (value.startsWith('{"type":"input"')) counters.sentInputs++; }
      close() { if (this.readyState === 3) return; this.readyState = 3; counters.live--; counters.closed++; queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' })); }
    }
    (window as any).WebSocket = Socket;
  });
  await page.route(origin + '/**', async route => {
    const url = new URL(route.request().url()), body = () => route.request().postDataJSON();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/auth') return json({ authenticated: true, csrf: 'synthetic-csrf', expiresAt: Date.now() + 3600000, defaultCwd: '/synthetic/project' });
    if (url.pathname === '/api/projects') return json({ projects: [{ name: 'Synthetic', path: '/synthetic/project' }], defaultCwd: '/synthetic/project' });
    if (url.pathname === '/api/sessions') return json({ sessions: rows, selectedSession: rows.find(r => r.id === url.searchParams.get('selected')) || null, nextOffset: null, runningCount: rows.filter(r => r.state === 'running').length });
    if (url.pathname.endsWith('/restart-codex')) {
      const id = url.pathname.split('/')[3]!, value = body(), row = rows.find(r => r.id === id)!;
      requests.push({ id, body: value });
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      row.state = 'running'; row.updated_at++; row.codexResumeAvailable = true;
      return json({ session: row });
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css))$/.test(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.resolve('dist/client', file)) });
  });
  await page.goto(origin); await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await page.locator(`[data-session-id="${rows[0]!.id}"]`).click();
  await expect(page.locator('.xterm')).toHaveCount(1);
  return { rows, requests, hold: () => { hold = true; }, release: () => { hold = false; release?.(); } };
}
const resources = (page: Page) => page.evaluate(() => ({ ...(window as any).__restartResources, xterms: document.querySelectorAll('.xterm').length }));
async function confirmRestart(page: Page, accept: boolean) {
  const dialog = page.waitForEvent('dialog'), click = page.getByRole('button', { name: 'Restart & resume', exact: true }).click();
  const prompt = await dialog; expect(prompt.message()).toContain('SAME saved conversation'); expect(prompt.message()).toContain('discards unsent input');
  if (accept) await prompt.accept(); else await prompt.dismiss();
  await click;
}

test('Mobile restart: cancel is inert; pending restart releases its terminal and never switches/disposes another selected session', async ({ page }) => {
  const f = await fixture(page);
  const before = await resources(page); await confirmRestart(page, false);
  await page.screenshot({ path: '.runtime/tests/codex-restart-ui/mobile-controls.png' });
  expect(f.requests).toHaveLength(0); expect(await resources(page)).toEqual(before);
  f.hold();
  try {
    await confirmRestart(page, true); await expect(page.getByRole('heading', { name: 'Restarting Codex…' })).toBeVisible();
    await expect(page.locator('.xterm')).toHaveCount(0); expect((await resources(page)).live).toBe(0);
    await expect.poll(() => f.requests.length).toBe(1);
    expect(f.requests[0]!.body).toEqual({ confirm: f.rows[0]!.id, expectedUpdatedAt: 100 });
    await page.locator(`[data-session-id="${f.rows[1]!.id}"]`).click();
    await expect(page.locator('.xterm')).toHaveCount(1);
    await page.evaluate(() => { (window as any).__keptTerminal = document.querySelector('.xterm'); });
    const switched = await resources(page); f.release();
    await expect(page.getByRole('button', { name: 'Refresh sessions' })).toBeEnabled();
    await expect(page.locator('.session-header h1')).toHaveText(f.rows[1]!.label);
    expect(await page.evaluate(() => document.querySelector('.xterm') === (window as any).__keptTerminal)).toBe(true);
    expect((await resources(page)).created).toBe(switched.created); expect((await resources(page)).maxLive).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { f.release(); }
});

test('Mobile restart: repeated restart/switch/background cycles keep one terminal, no inactive buffers or duplicate sockets', async ({ page, context }) => {
  const f = await fixture(page), cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage'); const baseline = await cdp.send('Runtime.getHeapUsage');
  const samples: { cycle: number; usedHeapBytes: number }[] = [];
  for (let i = 0; i < 32; i++) {
    await confirmRestart(page, true);
    await expect(page.getByRole('button', { name: 'Restart & resume', exact: true })).toBeEnabled();
    await expect(page.locator('.xterm')).toHaveCount(1);
    await page.locator(`[data-session-id="${f.rows[1]!.id}"]`).click();
    await page.locator(`[data-session-id="${f.rows[0]!.id}"]`).click();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('.xterm')).toHaveCount(0); expect((await resources(page)).live).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('.xterm')).toHaveCount(1);
    if ((i + 1) % 8 === 0) { await cdp.send('HeapProfiler.collectGarbage'); samples.push({ cycle: i + 1, usedHeapBytes: (await cdp.send('Runtime.getHeapUsage')).usedSize }); }
  }
  expect(f.requests).toHaveLength(32); const active = await resources(page);
  expect(active.maxLive).toBe(1); expect(active.live).toBe(1); expect(active.xterms).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('.xterm')).toHaveCount(0); await cdp.send('HeapProfiler.collectGarbage');
  const after = await cdp.send('Runtime.getHeapUsage'), detached = await resources(page);
  expect(detached.live).toBe(0); expect(detached.created).toBe(detached.closed);
  fs.mkdirSync('.runtime/evidence', { recursive: true });
  fs.writeFileSync('.runtime/evidence/codex-restart-browser.json', JSON.stringify({ synthetic: true, physicalPhone: false, managedSessions: 20, cycles: 32, active, detached, baselineHeapBytes: baseline.usedSize, samples, detachedHeapBytes: after.usedSize }, null, 2));
});

test('Resume button is linked-Codex-only; ordinary shells never show restart', async ({ page }) => {
  const f = await fixture(page);
  await page.locator(`[data-session-id="${f.rows[19]!.id}"]`).click();
  await expect(page.getByRole('button', { name: 'Restart & resume', exact: true })).toHaveCount(0);
  f.rows[0]!.state = 'stopped'; f.rows[0]!.lifecycle = 'stopped'; f.rows[0]!.codexResumeAvailable = true;
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await page.locator(`[data-session-id="${f.rows[0]!.id}"]`).click();
  await expect(page.getByRole('button', { name: 'Resume Codex', exact: true })).toBeEnabled();
  await expect(page.locator('.xterm')).toHaveCount(0);
});
