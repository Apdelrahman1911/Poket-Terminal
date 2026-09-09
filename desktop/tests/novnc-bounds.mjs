// Executes actual patched noVNC classes in a sandboxed non-root browser, using
// deliberately synthetic pending images/raw channels. No remote desktop needed.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
const { chromium } = await import('@playwright/test');
const root = path.resolve(import.meta.dirname, '..');
const candidate = path.resolve(process.argv[2] || path.join(root, '.runtime/candidates/client'));
const source = `
import Websock from ${JSON.stringify(path.join(candidate, 'source/vendor/novnc/core/websock.js'))};
import Display from ${JSON.stringify(path.join(candidate, 'source/vendor/novnc/core/display.js'))};
import Inflate from ${JSON.stringify(path.join(candidate, 'source/vendor/novnc/core/inflator.js'))};
import RFB from ${JSON.stringify(path.join(candidate, 'source/vendor/novnc/core/rfb.js'))};
import { initLogging } from ${JSON.stringify(path.join(candidate, 'source/vendor/novnc/core/util/logging.js'))};
initLogging('none');
window.checkBounds = () => {
  const checks = [];
  const ok = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  const rejects = (work, name) => { let rejected = false; try { work(); } catch { rejected = true; } ok(rejected, name); };
  const raw = () => ({ readyState: 1, protocol: 'pocketdesktop.v1', binaryType: 'arraybuffer', bufferedAmount: 0,
    onmessage: null, onopen: null, onclose: null, onerror: null, send() {}, close() { this.readyState = 3; } });
  const w = new Websock(), channel = raw(); w.attach(channel);
  ok(w._rQbufferSize === 128 * 1024, '128 KiB initial receive capacity');
  for (let i = 0; i < 64; i++) w._recvMessage({ data: new ArrayBuffer(65536) });
  ok(w.rQlen() === 4 * 1024 * 1024 && w._rQbufferSize === 4 * 1024 * 1024, '4 MiB hard receive capacity');
  rejects(() => w._recvMessage({ data: new ArrayBuffer(1) }), 'receive overflow refused before copy');
  channel.bufferedAmount = 65536; w.sQpush8(1); rejects(() => w.flush(), 'send transport hard cap');
  w.dispose(); ok(w._rQ.length === 0 && w._sQ.length === 0, 'receive/send storage released');
  const inflate = new Inflate(); rejects(() => inflate.inflate(4 * 1024 * 1024 + 1), 'inflate allocation hard cap');
  const canvas = document.createElement('canvas'), display = new Display(canvas); display.resize(1280, 720);
  rejects(() => display.resize(1281, 720), 'framebuffer geometry hard cap');
  // Seed one pending asynchronous image, then exercise actual queue push paths.
  const img = new Image(); display._renderQ.push({ type: 'img', img, cost: 64 });
  for (let i = 0; i < 127; i++) display.fillRect(0, 0, 1, 1, [0,0,0]);
  rejects(() => display.fillRect(0, 0, 1, 1, [0,0,0]), '128-action render cap');
  display.dispose(); ok(display.queueStats.actions === 0 && canvas.width === 0 && display._backbuffer.width === 0, 'display/images/two framebuffers disposed');
  const large = new Display(document.createElement('canvas')); large.resize(1280,720);
  large._renderQ.push({ type: 'img', img: new Image(), cost: 64 });
  const pixels = new Uint8Array(1280*720*4);
  large.blitImage(0,0,1280,720,pixels,0); large.blitImage(0,0,1280,720,pixels,0);
  rejects(() => large.blitImage(0,0,1280,720,pixels,0), '8 MiB queued-pixel budget checked before allocation');
  large.dispose();
  const encoded = new Display(document.createElement('canvas')); encoded.resize(1280,720);
  rejects(() => encoded.imageRect(0,0,1280,720,'image/jpeg',new Uint8Array(1600000)), 'UTF-16 base64 charged at 3x encoded size plus decoded pixels');
  encoded.dispose();
  const target = document.createElement('div'); document.body.appendChild(target);
  const unopened = raw(); unopened.readyState = 0;
  const rfb = new RFB(target, unopened);
  rfb.dispose(); rfb.dispose();
  ok(target.childNodes.length === 0 && rfb._disconnTimer === null && rfb._sock._rQ.length === 0 && Object.keys(rfb._decoders).length === 0, 'public idempotent RFB disposal clears DOM/timers/decoders/transport');
  return checks;
};`;
const result = await build({ stdin: { contents: source, resolveDir: root }, bundle: true, format: 'iife', target: 'es2022', write: false });
const browser = await chromium.launch({ executablePath: path.join(root, 'tests/browser-launcher.py'), chromiumSandbox: true, headless: true });
try {
  const page = await browser.newPage(); await page.goto('about:blank');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const checks = await page.evaluate(() => window.checkBounds());
  const report = { passed: true, checks, browser: 'Chrome for Testing 153.0.8010.12, sandbox enabled, non-root test UID' };
  fs.writeFileSync(path.join(root, '.runtime/evidence/novnc-bounds.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
