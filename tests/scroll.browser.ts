import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { foreground } from './foreground.js';
import { browserLogin, createShell, installCounters, resources, selectSession, typeCommand } from './browser-tools.js';
import { until } from './helpers.js';
import { attachmentPids, descendants } from '../scripts/memory.js';
import { ROOT } from '../src/server/config.js';

test.use({ hasTouch: true });
let backend: Awaited<ReturnType<typeof foreground>>;
const evidence: object[] = [];
const tmux = (args: string[]) => execFileSync('tmux', ['-L', backend.config.tmuxSocket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pane = (id: string, format: string) => tmux(['display-message', '-p', '-t', `=pt_${id}:0.0`, format]);
const ptyFds = () => fs.readdirSync(`/proc/${backend.backendPid}/fd`).filter(fd => {
  try { return /^\/dev\/pts\/ptmx$|^\/dev\/ptmx$/.test(fs.readlinkSync(`/proc/${backend.backendPid}/fd/${fd}`)); } catch { return false; }
});
async function instrument(context: BrowserContext) {
  await installCounters(context);
  await context.addInitScript(() => {
    const state = { watch: false, inputMessages: 0, inputAcks: 0, nonMouseInputs: 0, mouseReports: 0, errors: 0,
      listeners: { wheel: 0, touchstart: 0, touchmove: 0, touchend: 0, touchcancel: 0 } };
    (window as any).__scroll = state;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); (window as any).__scrollSocket = this;
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const message = JSON.parse(event.data);
          if (message.type === 'input_ack') state.inputAcks++;
          if (message.type === 'error') state.errors++;
        });
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string' && data.startsWith('{"type":"input"')) {
          const value = JSON.parse(data).data as string; state.inputMessages++;
          if (state.watch) {
            const mouse = value.match(/\x1b\[<\d+;\d+;\d+[Mm]/g) || [];
            state.mouseReports += mouse.length;
            if (value.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '')) state.nonMouseInputs++;
          }
        }
        super.send(data);
      }
    };
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (this instanceof HTMLElement && this.classList.contains('terminal-host') && type in state.listeners && (options === true || typeof options === 'object' && options.capture)) state.listeners[type as keyof typeof state.listeners]++;
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      if (this instanceof HTMLElement && this.classList.contains('terminal-host') && type in state.listeners && (options === true || typeof options === 'object' && options.capture)) state.listeners[type as keyof typeof state.listeners]--;
      return remove.call(this, type, listener, options);
    };
  });
}
const counters = (page: Page) => page.evaluate(() => (window as any).__scroll);
async function settle(page: Page, rejectedInputs = 0) {
  await expect.poll(async () => { const s = await counters(page); return s.inputMessages === s.inputAcks + rejectedInputs; }).toBe(true);
}
async function wheel(page: Page, deltaY: number, rejectedInputs = 0) {
  await page.locator('.xterm-screen').hover(); await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(35); await settle(page, rejectedInputs);
}
async function swipe(page: Page, older = true) {
  const cdp = await page.context().newCDPSession(page), box = (await page.locator('.xterm-screen').boundingBox())!;
  const x = box.x + box.width / 2, step = Math.min(24, (box.height - 40) / 8), y = older ? box.y + 20 : box.y + box.height - 20;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (older ? 1 : -1) * step * i }] });
      await page.waitForTimeout(25);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(page);
  } finally { await cdp.detach(); }
}
async function historyFixture(page: Page, label: string, legacy = false) {
  await browserLogin(page, backend.config.origin); const row = await createShell(page, label);
  if (legacy) tmux(['set-option', '-t', `pt_${row.id}`, 'mouse', 'off']);
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  await expect(page.locator('.xterm')).toHaveClass(/enable-mouse-events/);
  await typeCommand(page, "python3 -c \"for i in range(150): print('HISTORY_ROW_%03d'%i)\"");
  await expect(page.locator('.xterm-rows')).toContainText('HISTORY_ROW_149'); await settle(page);
  expect(Number(pane(row.id, '#{history_size}'))).toBeGreaterThan(50);
  await page.evaluate(() => { (window as any).__scroll.watch = true; });
  return row;
}
async function firstRow(page: Page) {
  const values = [...(await page.locator('.xterm-rows').innerText()).matchAll(/HISTORY_ROW_(\d{3})/g)].map(match => Number(match[1]));
  expect(values.length).toBeGreaterThan(0); return Math.min(...values);
}
test.beforeAll(async () => { backend = await foreground('scroll-browser'); });
test.beforeEach(async ({ context }) => { await instrument(context); });
test.afterEach(async ({ page }) => {
  await page.close();
  await until(() => attachmentPids(descendants(backend.backendPid)).length === 0 && ptyFds().length === 0, 7000, 'Scrolling fixture leaked native attachment/fd');
});
test.afterAll(async () => {
  if (!backend) return;
  const close = await backend.close();
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence/scroll-browser.json'), JSON.stringify({ at: new Date().toISOString(), fixtureOnly: true, productionBuild: true, minimalEnvironment: true, tests: evidence, close }, null, 2), { mode: 0o600 });
  expect(close.graceful).toBe(true);
});

test('Scroll: wheel reaches real tmux history in an existing mouse-off session; sticky modifiers and no-mouse fallback never inject keys', async ({ page }) => {
  const row = await historyFixture(page, 'Existing history fixture', true), before = await firstRow(page);
  const pid = pane(row.id, '#{pane_pid}');
  expect(tmux(['show-options', '-v', '-t', `pt_${row.id}`, 'mouse'])).toBe('on');
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click(); await page.getByRole('button', { name: 'Alt', exact: true }).click();
  for (let i = 0; i < 5; i++) await wheel(page, -80);
  await expect.poll(() => pane(row.id, '#{pane_mode}')).toBe('copy-mode');
  await expect.poll(() => firstRow(page)).toBeLessThan(before);
  expect((await counters(page)).mouseReports).toBeGreaterThan(0); expect((await counters(page)).nonMouseInputs).toBe(0);
  await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Alt', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Exit history', exact: true }).click();
  await expect.poll(() => pane(row.id, '#{pane_in_mode}')).toBe('0'); await expect(page.locator('.xterm-rows')).toContainText('HISTORY_ROW_149');
  tmux(['set-option', '-t', `pt_${row.id}`, 'mouse', 'off']);
  await expect(page.locator('.xterm')).not.toHaveClass(/enable-mouse-events/);
  const inputs = (await counters(page)).inputMessages;
  await wheel(page, -400); await wheel(page, 400); await swipe(page);
  await page.getByRole('button', { name: 'Exit history', exact: true }).click(); await page.waitForTimeout(100);
  expect((await counters(page)).inputMessages).toBe(inputs); expect(pane(row.id, '#{pane_in_mode}')).toBe('0');
  expect(pane(row.id, '#{pane_pid}')).toBe(pid);
  expect((await resources(page)).xterms).toBe(1); expect((await resources(page)).liveSockets).toBe(1);
  evidence.push({ test: 'wheel-existing-history-and-fallback', priorOutputReached: true, explicitExistingMouseOffOverridden: true, stickyModifiersPreserved: true, fallbackInputMessages: 0, exitOutsideCopyModeInputMessages: 0, paneIdentityPreserved: true });
});

test('Scroll: real mobile touch gesture scrolls history and returns live; background/disconnect removes every added handler', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const row = await historyFixture(page, 'Touch history fixture'), before = await firstRow(page), pid = pane(row.id, '#{pane_pid}');
  await swipe(page); await expect.poll(() => pane(row.id, '#{pane_mode}')).toBe('copy-mode');
  await expect.poll(() => firstRow(page)).toBeLessThan(before);
  const offset = Number(pane(row.id, '#{scroll_position}')); expect(offset).toBeGreaterThan(0);
  await swipe(page, false); expect(Number(pane(row.id, '#{scroll_position}') || 0)).toBeLessThan(offset);
  await page.getByRole('button', { name: 'Exit history', exact: true }).click(); await expect.poll(() => pane(row.id, '#{pane_in_mode}')).toBe('0');
  expect((await counters(page)).nonMouseInputs).toBe(0);
  expect(Object.values((await counters(page)).listeners)).toEqual([1, 1, 1, 1, 1]);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('.xterm')).toHaveCount(0); expect(Object.values((await counters(page)).listeners)).toEqual([0, 0, 0, 0, 0]);
  await until(() => ptyFds().length === 0 && attachmentPids(descendants(backend.backendPid)).length === 0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByTestId('connection-status')).toContainText('You control input');
  expect(Object.values((await counters(page)).listeners)).toEqual([1, 1, 1, 1, 1]);
  expect((await resources(page)).xterms).toBe(1); expect((await resources(page)).liveSockets).toBe(1);
  await page.evaluate(() => { (window as any).__scroll.watch = false; });
  await typeCommand(page, "printf 'once\\n' >> touch-return-marker");
  await until(() => fs.existsSync(path.join(backend.config.defaultCwd, 'touch-return-marker')));
  expect(fs.readFileSync(path.join(backend.config.defaultCwd, 'touch-return-marker'), 'utf8')).toBe('once\n');
  expect(pane(row.id, '#{pane_pid}')).toBe(pid);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(page.locator('.xterm')).toHaveCount(0);
  expect(Object.values((await counters(page)).listeners)).toEqual([0, 0, 0, 0, 0]);
  evidence.push({ test: 'touch-history-lifecycle', priorOutputReached: true, directionReversed: true, paneIdentityPreserved: true, commandAfterReturnExecutedOnce: true, handlersActive: 5, handlersDisposed: 5 });
});

test('Scroll: native full-screen TUI receives mouse wheels/touch, never guessed keys; view-only UI and forged messages cannot scroll or exit history', async ({ page, browser }) => {
  const script = path.join(backend.config.defaultCwd, 'scroll-tui.py'), stats = path.join(backend.config.defaultCwd, 'tui-scroll.json');
  fs.writeFileSync(script, `import os,tty,termios,json,re\nfd=0; old=termios.tcgetattr(fd); tty.setraw(fd)\ns={'up':0,'down':0,'unexpected':0}; pending=b''\ntry:\n os.write(1,b'\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HTUI_SCROLL_READY')\n with open('tui-scroll.json','w') as f: json.dump(s,f)\n while True:\n  data=os.read(fd,1024)\n  if data==b'\\x03': break\n  pending+=data\n  while pending:\n   match=re.match(rb'\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])',pending)\n   if match:\n    button=int(match[1]); s['up']+=int(button==64); s['down']+=int(button==65); pending=pending[match.end():]\n   elif pending.startswith(b'\\x1b[<') and len(pending)<32: break\n   else: s['unexpected']+=len(pending); pending=b''\n  with open('tui-scroll.json','w') as f: json.dump(s,f)\n  os.write(1,('\\x1b[H TUI_SCROLL_READY up=%d down=%d'%(s['up'],s['down'])).encode())\nfinally:\n os.write(1,b'\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l'); termios.tcsetattr(fd,termios.TCSANOW,old)\n`);
  const read = () => { try { return JSON.parse(fs.readFileSync(stats, 'utf8')); } catch { return { up: 0, down: 0, unexpected: 0 }; } };
  await page.setViewportSize({ width: 390, height: 844 }); await browserLogin(page, backend.config.origin);
  const row = await createShell(page, 'Synthetic mouse-aware TUI'); await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, row.id);
  await typeCommand(page, 'python3 scroll-tui.py'); await expect(page.locator('.xterm-rows')).toContainText('TUI_SCROLL_READY'); await settle(page);
  await page.evaluate(() => { (window as any).__scroll.watch = true; });
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click(); await page.getByRole('button', { name: 'Alt', exact: true }).click();
  await wheel(page, -80); await expect.poll(() => read().up).toBeGreaterThan(0);
  await wheel(page, 80); await expect.poll(() => read().down).toBeGreaterThan(0);
  const up = read().up; await swipe(page); await expect.poll(() => read().up).toBeGreaterThan(up);
  expect(pane(row.id, '#{pane_in_mode}')).toBe('0');
  await page.getByRole('button', { name: 'Exit history', exact: true }).click(); await page.waitForTimeout(100);
  expect(read().unexpected).toBe(0); expect((await counters(page)).nonMouseInputs).toBe(0);
  const viewerContext = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: true, viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  try {
    await instrument(viewerContext); const viewer = await viewerContext.newPage(); await viewer.goto(backend.config.origin);
    await viewer.locator(`[data-session-id="${row.id}"]`).click(); await expect(viewer.getByTestId('connection-status')).toContainText('View only');
    await expect(viewer.getByRole('button', { name: 'Exit history', exact: true })).toBeDisabled();
    const before = read(); await wheel(viewer, -80); await swipe(viewer); expect(read()).toEqual(before);
    tmux(['copy-mode', '-t', `=pt_${row.id}:0.0`]); expect(pane(row.id, '#{pane_in_mode}')).toBe('1');
    const position = pane(row.id, '#{scroll_position}'), errors = (await counters(viewer)).errors;
    await viewer.evaluate(() => { const ws = (window as any).__scrollSocket; ws.send(JSON.stringify({ type: 'exit_history' })); ws.send(JSON.stringify({ type: 'input', data: '\x1b[<64;1;1M' })); });
    await expect.poll(async () => (await counters(viewer)).errors).toBe(errors + 2);
    expect(pane(row.id, '#{pane_in_mode}')).toBe('1'); expect(pane(row.id, '#{scroll_position}')).toBe(position);
    await page.getByRole('button', { name: 'Exit history', exact: true }).click(); await expect.poll(() => pane(row.id, '#{pane_in_mode}')).toBe('0');
    await viewer.getByRole('button', { name: 'Take control', exact: true }).click(); await expect(viewer.getByTestId('connection-status')).toContainText('You control input');
    await expect(page.getByTestId('connection-status')).toContainText('View only');
    // The explicitly forged view-only input above was rejected, not input-ACKed.
    const prior = read().up; await wheel(viewer, -80, 1); await expect.poll(() => read().up).toBeGreaterThan(prior);
    expect(read().unexpected).toBe(0);
    evidence.push({ test: 'native-tui-controller-boundary', nativeWheelUp: read().up, nativeWheelDown: read().down, unexpectedTuiInputBytes: 0, forgedViewerActionsRejected: 2, controlTransferWorks: true });
  } finally { await viewerContext.close(); }
});
