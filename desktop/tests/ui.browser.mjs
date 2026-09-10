import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = path.join(root, 'desktop/.runtime/candidates/client/client');
const origin = 'https://pocketdesktop-ui.test';

async function syntheticDesktop(page) {
  const sockets = { created: 0, active: 0 };
  await page.route(origin + '/**', route => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/api/auth') return route.fulfill({ json: { authenticated: true, desktop: true, csrf: 'u'.repeat(48), expiresAt: Date.now() + 600000 } });
    if (name === '/api/desktop/start' || name === '/api/logout') return route.fulfill({ json: { ok: true } });
    if (name === '/') return route.fulfill({ contentType: 'text/html', body: '<h1>Root terminal tools</h1>' });
    const files = { '/desktop/': ['index.html', 'text/html'], '/desktop/desktop.js': ['desktop.js', 'text/javascript'], '/desktop/desktop.css': ['desktop.css', 'text/css'] };
    const file = files[name];
    if (!file) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file[1], body: fs.readFileSync(path.join(assets, file[0])), headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    } });
  });
  await page.routeWebSocket(origin.replace('https:', 'wss:') + '/api/desktop/socket', ws => {
    sockets.created++; sockets.active++;
    let phase = 0, painted = false, closed = false;
    // A custom close handler replaces Playwright's default close response.
    // Acknowledge once so the browser actually reaches CLOSED, like real RFB.
    ws.onClose(() => { if (!closed) { closed = true; sockets.active--; ws.close(); } });
    ws.onMessage(data => {
      if (typeof data === 'string') return; // bounded-channel acknowledgements
      if (phase++ === 0) { ws.send(Buffer.from([1, 1])); return; }
      if (phase === 2) { ws.send(Buffer.alloc(4)); return; }
      if (phase === 3) {
        const name = Buffer.from('Synthetic desktop: no owner data'), init = Buffer.alloc(24);
        init.writeUInt16BE(1280, 0); init.writeUInt16BE(720, 2);
        init[4] = 32; init[5] = 24; init[7] = 1;
        for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
        init[14] = 16; init[15] = 8; init.writeUInt32BE(name.length, 20);
        ws.send(Buffer.concat([init, name])); return;
      }
      if (!painted && data[0] === 3) {
        painted = true;
        const frame = Buffer.alloc(16 + 64 * 64 * 4); frame.writeUInt16BE(1, 2);
        frame.writeUInt16BE(64, 8); frame.writeUInt16BE(64, 10);
        for (let i = 16; i < frame.length; i += 4) { frame[i] = 0x70; frame[i + 1] = 0xb8; frame[i + 2] = 0x30; }
        ws.send(frame);
      }
    });
    ws.send(Buffer.from('RFB 003.008\n'));
  });
  await page.goto(origin + '/desktop/');
  await expect(page.locator('#status')).toHaveAttribute('data-connected', 'true');
  await expect(page.locator('#screen canvas')).toHaveCount(1);
  await page.evaluate(() => { window.__originalCanvas = document.querySelector('#screen canvas'); });
  return sockets;
}

async function sameView(page, sockets, created = 1) {
  expect(sockets.created).toBe(created); expect(sockets.active).toBe(1);
  await page.waitForFunction(() => {
    const screen = document.querySelector('#screen'), canvas = screen.querySelector('canvas');
    const scale = Math.min(screen.clientWidth / 1280, screen.clientHeight / 720), rect = canvas.getBoundingClientRect();
    return Math.abs(rect.width - 1280 * scale) < 2 && Math.abs(rect.height - 720 * scale) < 2;
  });
  const stats = await page.evaluate(() => ({ ...window.pocketDesktopStats(),
    sameCanvas: window.__originalCanvas === document.querySelector('#screen canvas'),
    width: document.querySelector('#screen canvas').width, height: document.querySelector('#screen canvas').height }));
  expect(stats.renderers).toBe(1); expect(stats.fullscreen.listeners).toBe(3);
  expect(stats.sameCanvas).toBe(true); expect(stats.width).toBe(1280); expect(stats.height).toBe(720);
}

test('native fullscreen toggles and browser exit retain one canvas/socket and fixed resolution', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const sockets = await syntheticDesktop(page);
  for (let i = 0; i < 6; i++) {
    await page.locator('#fullscreen').click();
    await expect(page.locator('html')).toHaveAttribute('data-desktop-fullscreen', 'native');
    await expect(page.locator('#fullscreen')).toHaveText('Exit full screen');
    await sameView(page, sockets);
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator('#fullscreen')).toHaveText('Full screen');
    await sameView(page, sockets);
  }
  await page.locator('#fullscreen').click();
  await expect(page.locator('html')).toHaveAttribute('data-desktop-fullscreen', 'native');
  await sameView(page, sockets);
  await page.screenshot({ path: path.join(root, '.runtime/evidence/desktop-fullscreen.png') });
  await page.locator('#fullscreen').click();
  await page.locator('#root-help summary').click();
  await expect(page.locator('#root-help')).toContainText('That shell already runs as root');
  await page.locator('#root-terminal').click();
  await expect(page.getByRole('heading', { name: 'Root terminal tools' })).toBeVisible();
  await expect.poll(() => sockets.active).toBe(0);
  expect(errors).toEqual([]);
});

test('mobile fallback, keyboard, small landscape, Escape and cached-page restoration stay bounded', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new Error('Fullscreen unavailable on this browser')) });
    });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const sockets = await syntheticDesktop(page);
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 390, height: 360 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#fullscreen').tap();
      await expect(page.locator('html')).toHaveAttribute('data-desktop-fullscreen', 'page');
      await expect(page.locator('#fullscreen')).toHaveText('Exit expanded view');
      await page.locator('#keyboard').tap();
      for (const selector of ['#fullscreen', '[data-key="65293"]']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const screen = await page.locator('#screen').boundingBox(); expect(screen.height).toBeGreaterThan(0);
      await sameView(page, sockets);
      await page.locator('#keyboard').tap();
      await page.keyboard.press('Escape');
      await expect(page.locator('#fullscreen')).toHaveText('Full screen');
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('#fullscreen').tap();
    await sameView(page, sockets);
    await page.screenshot({ path: path.join(root, '.runtime/evidence/desktop-mobile-expanded.png') });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('#screen canvas')).toHaveCount(0);
    await expect.poll(() => sockets.active).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('#status')).toHaveAttribute('data-connected', 'true');
    expect(sockets.created).toBe(2); expect(sockets.active).toBe(1);
    await page.evaluate(() => { window.__originalCanvas = document.querySelector('#screen canvas'); });
    await page.locator('#fullscreen').tap(); await sameView(page, sockets, 2);
    await page.locator('#disconnect').tap();
    await expect(page.locator('#screen canvas')).toHaveCount(0);
    await expect.poll(() => sockets.active).toBe(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
