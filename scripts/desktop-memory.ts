// Focused ~4-minute real changing-screen run. Isolated TLS backend/auth, sandboxed
// non-root browser and synthetic desktop. No GC forcing, owner app, paid model or
// backend restart during measurement. Only non-sensitive counters/metrics stored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { WebSocket } from 'ws';
import { production } from '../tests/production.js';
import { testConfig, delay, until, TEST_PASSWORD } from '../tests/helpers.js';
import { browserLogin, installCounters } from '../tests/browser-tools.js';
import { DESKTOP_LIMITS as L } from '../src/server/desktop-rfb.js';

const PD = path.resolve(import.meta.dirname, '../desktop');
const out = path.join(PD, '.runtime/evidence/desktop-memory.json');
const processMetrics = (profile: string) => JSON.parse(execFileSync('/usr/bin/python3', ['-I', path.join(PD, 'scripts/measure-processes.py'), profile], { encoding: 'utf8', timeout: 5000 }));
const nativeStatus = () => JSON.parse(execFileSync('/usr/local/bin/pocketdesktop', ['test-status'], { encoding: 'utf8', timeout: 5000 }));
const synthetic = () => JSON.parse(fs.readFileSync('/run/pocketdesktop-test/synthetic.json', 'utf8'));
const config = await testConfig('desktop-memory');
config.desktop = { assetsDir: '/opt/pocketdesktop/current/client', socketPath: '/run/pocketdesktop-test/rfb.sock', uid: fs.statSync('/var/lib/pocketdesktop-test').uid, startCommand: 'test-start' };
const app = await production('desktop-memory', config);
const browser = await chromium.launch({ executablePath: path.join(PD, 'tests/browser-launcher.py'), headless: true, chromiumSandbox: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await installCounters(context);
const page = await context.newPage(); const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
const browserCdp = await browser.newBrowserCDPSession();
const start = Date.now(), original = nativeStatus(), fixture = synthetic();
const report: any = { startedAt: new Date(start).toISOString(), durationTargetSeconds: 237,
  methodology: 'Real 1280x720 TigerVNC/XFCE synthetic screen changes at ~12fps; TigerVNC capped 15fps. Isolated production Node --max-old-space-size=96, fresh synthetic Auth, non-root sandboxed Chrome 153.0.8010.12 at 390x844. Visibility notifications emulated before actual CDP freeze because this headless build emits no freeze/visibility DOM event for Page.setWebLifecycleState. Natural GC only; no process restart during run. RSS/PSS include every process of the fixed desktop/test accounts; renderer RSS is all renderer processes (including browser spares), not JS heap or physical-phone RAM. Independent owner/Codex jobs and test-driver memory excluded.',
  nativeBefore: original, syntheticBefore: { pid: fixture.pid, frames: fixture.frames }, samples: [], checks: [], passed: false };
let slow: WebSocket | undefined;
function save() { fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
async function sample(phase: string) {
  const node = await app.measure();
  const testDesktop = processMetrics('test'), privateDesktop = processMetrics('desktop'), browserProcesses = processMetrics('browser');
  const info = await browserCdp.send('SystemInfo.getProcessInfo');
  const rendererIds = info.processInfo.filter((p: any) => p.type === 'renderer').map((p: any) => p.id);
  const renderers = browserProcesses.processes.filter((p: any) => rendererIds.includes(p.pid));
  const performance = await cdp.send('Performance.getMetrics');
  const metrics = Object.fromEntries(performance.metrics.map((m: any) => [m.name, m.value]));
  const client = await page.evaluate(() => ({ counters: (window as any).__testResources, desktop: (window as any).pocketDesktopStats?.(), canvases: document.querySelectorAll('#screen canvas').length, xterms: document.querySelectorAll('.xterm').length }));
  const row = { seconds: (Date.now() - start) / 1000, phase, node: { pid: node.pid, memory: node.memory, desktop: node.desktop, terminal: node.bridges }, client,
    browser: { jsHeapUsedBytes: metrics.JSHeapUsedSize, jsHeapTotalBytes: metrics.JSHeapTotalSize,
      rendererRssBytes: renderers.reduce((n: number, p: any) => n + (p.rssBytes || 0), 0), rendererPssBytes: renderers.reduce((n: number, p: any) => n + (p.pssBytes || 0), 0), rendererCount: renderers.length,
      totalRssBytes: browserProcesses.rssBytes, totalPssBytes: browserProcesses.pssBytes, liveProcesses: browserProcesses.liveProcesses,
      allUnprivileged: browserProcesses.processes.every((p: any) => p.uid !== 0), sandbox: 'enabled; launcher rejects disabling flags; Linux user namespaces available' },
    privateDesktop, testDesktop, synthetic: { pid: synthetic().pid, frames: synthetic().frames } };
  assert.ok(node.desktop.attachments <= 2 && node.desktop.outstandingBytes <= 2 * L.outstanding && node.desktop.transportBytes <= 2 * L.transport);
  assert.ok(client.canvases <= 1 && (client.desktop?.renderers || 0) <= 1);
  assert.equal(row.synthetic.pid, fixture.pid);
  if (client.desktop?.queues) { assert.ok(client.desktop.queues.receiveCapacity <= 4 * 1024 * 1024); assert.ok(client.desktop.queues.render.actions <= 128 && client.desktop.queues.render.bytes <= 8 * 1024 * 1024); }
  report.samples.push(row); save(); return row;
}
async function stage(name: string, seconds: number, interval = 5) {
  const untilAt = Date.now() + seconds * 1000;
  do { await sample(name); await delay(Math.min(interval * 1000, Math.max(0, untilAt - Date.now()))); } while (Date.now() < untilAt);
}
async function attached() {
  await page.waitForFunction(() => document.getElementById('status')?.dataset.connected === 'true' && (window as any).__testResources.liveSockets === 1);
}
async function detached() { await until(async () => (await app.measure()).desktop.connections === 0); await page.waitForFunction(() => (window as any).__testResources.liveSockets === 0); }
async function slowReader() {
  const login: any = await new Promise((resolve, reject) => {
    const req = https.request(config.origin + '/api/login', { method: 'POST', rejectUnauthorized: false, headers: { origin: config.origin, 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', data => { if (body.length + data.length > 2048) { res.destroy(); reject(new Error('synthetic login bound')); } else body += data; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('synthetic login rejected')); resolve({ cookie: res.headers['set-cookie']![0]!.split(';')[0], csrf: JSON.parse(body).csrf }); });
    }); req.on('error', reject); req.end(JSON.stringify({ password: TEST_PASSWORD }));
  });
  slow = new WebSocket(config.origin.replace('https:', 'wss:') + '/api/desktop/socket', ['pocketdesktop.v1', 'csrf.' + login.csrf], { rejectUnauthorized: false, headers: { cookie: login.cookie, origin: config.origin } });
  let buffer = Buffer.alloc(0), phase = 0, paused = false, receivedBytes = 0;
  slow.on('error', () => {});
  slow.on('message', (raw, binary) => {
    if (!binary || !Buffer.isBuffer(raw)) return;
    receivedBytes += raw.length;
    if (phase === 4) return; // discard raw framebuffer; never store a screenshot
    buffer = Buffer.concat([buffer, raw]); assert.ok(buffer.length <= 65536);
    for (;;) {
      if (phase === 0) { if (buffer.length < 12) return; assert.equal(buffer.subarray(0,12).toString(), 'RFB 003.008\n'); buffer = buffer.subarray(12); slow!.send(Buffer.from('RFB 003.008\n')); phase = 1; }
      else if (phase === 1) { if (!buffer.length || buffer.length < 1 + buffer[0]!) return; assert.ok(buffer.subarray(1, 1 + buffer[0]!).includes(1)); buffer = buffer.subarray(1 + buffer[0]!); slow!.send(Buffer.from([1])); phase = 2; }
      else if (phase === 2) { if (buffer.length < 4) return; assert.equal(buffer.readUInt32BE(), 0); buffer = buffer.subarray(4); slow!.send(Buffer.from([1])); phase = 3; }
      else if (phase === 3) {
        if (buffer.length < 24) return; const nameLength = buffer.readUInt32BE(20); assert.ok(nameLength <= 4096); if (buffer.length < 24 + nameLength) return;
        const width = buffer.readUInt16BE(0), height = buffer.readUInt16BE(2); assert.equal(width, 1280); assert.equal(height, 720);
        buffer = Buffer.alloc(0); phase = 4;
        const pixel = Buffer.from([0,0,0,0,32,24,0,1,0,255,0,255,0,255,0,8,16,0,0,0]);
        const encodings = Buffer.from([2,0,0,1,0,0,0,0]);
        const request = Buffer.from([3,0,0,0,0,0,5,0,2,208]);
        slow!.send(pixel); slow!.send(encodings); slow!.send(request); slow!.pause(); paused = true; return;
      } else return;
    }
  });
  await until(() => paused, 5000);
  const began = Date.now(); await stage('slow-reader-plus-one-viewer', 6.5, .5);
  const stats = (await app.measure()).desktop;
  assert.equal(stats.attachments, 1); assert.ok(stats.detachReasons.slow_client > 0);
  slow.resume(); await until(() => slow!.readyState === WebSocket.CLOSED, 2000);
  report.slowReader = { realTigerVNC: true, rawFramebufferRequested: '1280x720x32', nativeReadsPausedAtBound: true, clientTransportPaused: true, clientACKs: 0,
    receivedBytes, observationMs: Date.now() - began, remainingNormalViewers: stats.attachments, peakOutstandingBytes: stats.peakOutstandingBytes, peakTransportBytes: stats.peakTransportBytes, detachReasons: stats.detachReasons };
  slow = undefined;
}
try {
  await browserLogin(page, config.origin); await stage('node-baseline-no-desktop-viewer', 5);
  await page.goto(config.origin + '/desktop/'); await attached(); await stage('first-viewer-warm', 30);
  await slowReader();
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await detached(); await sample('cycle-detached-' + i);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); await delay(1200); await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await attached(); await sample('cycle-attached-' + i); await delay(1200);
  }
  await stage('steady-one-viewer', 60);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await detached(); await stage('warm-detached', 30);
  await page.getByRole('button', { name: 'Connect', exact: true }).click(); await attached(); await stage('warm-reconnected', 45);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await detached(); await stage('final-warm-detached', 30);
  const final = await sample('final'); report.nativeAfter = nativeStatus();
  assert.equal(report.nativeAfter.xserver.startTicks, original.xserver.startTicks);
  assert.equal(final.node.desktop.connections, 0); assert.equal(final.node.desktop.upstreams, 0); assert.equal(final.node.desktop.helperProcesses, 0);
  assert.equal(final.client.desktop.renderers, 0); assert.equal(final.client.desktop.closeWaiters, 0); assert.equal(final.client.desktop.inputTimers, 0); assert.equal(final.client.counters.liveSockets, 0);
  const base = report.samples[0], one = report.samples.filter((s: any) => s.phase === 'first-viewer-warm').at(-1);
  const warm = report.samples.find((s: any) => s.phase === 'warm-detached');
  report.summary = { elapsedSeconds: (Date.now() - start) / 1000, changingFrames: synthetic().frames - fixture.frames,
    privateIdleDesktopRssBytes: final.privateDesktop.rssBytes, privateIdleDesktopPssBytes: final.privateDesktop.pssBytes,
    nodeBaselineRssBytes: base.node.memory.rss, nodeOneViewerRssBytes: one.node.memory.rss, nodeOneViewerDeltaBytes: one.node.memory.rss - base.node.memory.rss,
    nodePeakRssBytes: Math.max(...report.samples.map((s: any) => s.node.memory.rss)),
    browserOneViewerJsHeapUsedBytes: one.browser.jsHeapUsedBytes, browserOneViewerRendererRssBytes: one.browser.rendererRssBytes,
    browserPeakJsHeapUsedBytes: Math.max(...report.samples.map((s: any) => s.browser.jsHeapUsedBytes)), browserPeakRendererRssBytes: Math.max(...report.samples.map((s: any) => s.browser.rendererRssBytes)),
    warmNodeRssDeltaBytes: final.node.memory.rss - warm.node.memory.rss, warmBrowserJsHeapDeltaBytes: final.browser.jsHeapUsedBytes - warm.browser.jsHeapUsedBytes,
    warmBrowserRendererRssDeltaBytes: final.browser.rendererRssBytes - warm.browser.rendererRssBytes,
    finalResidualDesktopConnections: final.node.desktop.connections, finalResidualBrowserSockets: final.client.counters.liveSockets };
  // A warm plateau gate, not an unmeasured claim about physical-phone RAM.
  assert.ok(report.summary.warmNodeRssDeltaBytes < 24 * 1024 * 1024);
  assert.ok(report.summary.warmBrowserJsHeapDeltaBytes < 24 * 1024 * 1024);
  assert.ok(report.summary.warmBrowserRendererRssDeltaBytes < 64 * 1024 * 1024);
  report.checks = ['real changing screen throughout', 'real raw slow reader paused and detached', 'native PID/start-time persistence', 'ten foreground cycles, one view', 'all queue/client/renderer bounds', 'natural-GC warm plateau gates', 'zero residual attachments/connections/input timers'];
  report.passed = true; save(); console.log(JSON.stringify(report.summary, null, 2));
} catch (error) { report.error = error instanceof Error ? error.message : 'measurement_failed'; save(); throw error; }
finally { slow?.terminate(); await context.close(); await browser.close(); await app.close(); }
