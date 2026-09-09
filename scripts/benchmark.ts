import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, Page, CDPSession } from '@playwright/test';
import { WebSocket } from 'ws';
import { ROOT, LIMITS } from '../src/server/config.js';
import { production } from '../tests/production.js';
import { browserLogin, browserApi, createShell, installCounters, resources, selectSession, typeCommand } from '../tests/browser-tools.js';
import { delay, until } from '../tests/helpers.js';
import { procMemory, descendants, attachmentPids, sumMemory, summary } from './memory.js';
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, '.runtime/browsers');
const { chromium } = await import('@playwright/test');
process.umask(0o077);
const smoke = process.argv.includes('--smoke');
const soakSeconds = smoke ? 20 : 1800, cooldownSeconds = 180;
const run = `${smoke ? 'smoke' : 'memory'}-${new Date().toISOString().replaceAll(':', '-')}`;
const evidence = path.join(ROOT, '.runtime/evidence', run); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const samplesFile = path.join(evidence, 'samples.jsonl');
const samples: any[] = []; // Bounded instrumentation only: <2,000 small measurement records, no terminal bytes.
let backend: Awaited<ReturnType<typeof production>> | undefined, browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, cdp: CDPSession | undefined, browserCdp: CDPSession | undefined;
let phase = 'starting', started = Date.now(), lastStatus = 0, tmuxPid = 0;
const commit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unfrozen-development'; } })();
let baseStartTicks: string | undefined;
function artifactHashes(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, artifactHashes(file));
    else result[path.relative(ROOT, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return result;
}
function status(extra: object = {}) {
  const progress = { run, phase, driverPid: process.pid, backendPid: backend?.child.pid, elapsedSeconds: (Date.now() - started) / 1000, samples: samples.length, at: new Date().toISOString(), ...extra };
  fs.writeFileSync(path.join(evidence, 'progress.json'), JSON.stringify(progress, null, 2));
  if (Date.now() - lastStatus > 30000 || extra['final' as keyof typeof extra]) {
    lastStatus = Date.now();
    const file = path.join(ROOT, 'IMPLEMENTATION_STATUS.md'); let text = fs.readFileSync(file, 'utf8');
    const block = `<!-- BENCHMARK_STATUS_START -->\n## Live memory benchmark\n\n- Run: \`${run}\`; phase: **${phase}**; updated ${progress.at}.\n- Driver PID: ${process.pid}; backend PID: ${backend?.child.pid ?? 'pending'}; no benchmark backend restarts or forced GC.\n- Elapsed: ${progress.elapsedSeconds.toFixed(1)} s; samples: ${samples.length}; raw evidence: \`${path.relative(ROOT, evidence)}\`.\n- Real production-build browser/xterm, mobile viewport 390×844. ${smoke ? 'SMOKE ONLY: abbreviated output/cycles, NOT acceptance evidence; full 180 s native-cleanup cooldown.' : 'FULL ACCEPTANCE CANDIDATE; completion alone is not trend/leak acceptance.'} The full run requires 1,800 s sustained output and at least 120 s detached cooldown (configured: 180 s); no forced GC or backend restarts.\n<!-- BENCHMARK_STATUS_END -->`;
    text = /<!-- BENCHMARK_STATUS_START -->[\s\S]*?<!-- BENCHMARK_STATUS_END -->/.test(text) ? text.replace(/<!-- BENCHMARK_STATUS_START -->[\s\S]*?<!-- BENCHMARK_STATUS_END -->/, block) : text + '\n' + block + '\n';
    fs.writeFileSync(file, text);
    process.stdout.write(JSON.stringify(progress) + '\n');
  }
}
async function sample(extra: object = {}) {
  const stats = await backend!.measure(), node = procMemory(stats.pid);
  if (baseStartTicks === undefined) baseStartTicks = node.startTicks;
  assert.equal(node.startTicks, baseStartTicks, 'Benchmark backend restarted');
  let browserMetrics: any = null;
  if (page && !page.isClosed() && cdp) {
    const performance = await cdp.send('Performance.getMetrics');
    const metrics = Object.fromEntries(performance.metrics.map(x => [x.name, x.value]));
    const counters = await cdp.send('Memory.getDOMCounters');
    const processInfo = await browserCdp!.send('SystemInfo.getProcessInfo');
    const rendererPids = processInfo.processInfo.filter(p => p.type === 'renderer').map(p => p.id);
    browserMetrics = { heapUsed: metrics.JSHeapUsedSize, heapTotal: metrics.JSHeapTotalSize, counters, resources: await resources(page), renderer: sumMemory(rendererPids) };
  }
  if (!tmuxPid) {
    try { tmuxPid = Number(execFileSync('tmux', ['-L', backend!.config.tmuxSocket, 'display-message', '-p', '#{pid}']).toString().trim()); } catch { /* empty server may have no target */ }
  }
  const childPids = descendants(stats.pid);
  const record = { at: new Date().toISOString(), seconds: (Date.now() - started) / 1000, phase, stats, node,
    tmux: tmuxPid ? procMemory(tmuxPid) : null, tmuxJobs: tmuxPid ? sumMemory(descendants(tmuxPid)) : null,
    attachProcesses: sumMemory(attachmentPids(childPids)), backendChildren: sumMemory(childPids), browser: browserMetrics, ...extra };
  samples.push(record); fs.appendFileSync(samplesFile, JSON.stringify(record) + '\n');
  assert.ok(stats.bridges.outstandingBytes <= LIMITS.outstanding * LIMITS.attachments);
  assert.ok(stats.bridges.peakOutstandingBytes <= LIMITS.outstanding);
  status(); return record;
}
async function period(name: string, seconds: number, verify?: (sample: any) => void) {
  phase = name; lastStatus = 0; const end = Date.now() + seconds * 1000;
  do { const row = await sample(); verify?.(row); await delay(Math.min(5000, Math.max(0, end - Date.now()))); } while (Date.now() < end);
  const row = await sample(); verify?.(row);
}
async function setupPage(mobile: boolean) {
  context = await browser!.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await installCounters(context); page = await context.newPage(); cdp = await context.newCDPSession(page); await cdp.send('Performance.enable'); await browserLogin(page, backend!.config.origin);
}
function requestLogin() {
  return new Promise<number>((resolve, reject) => {
    const body = JSON.stringify({ password: 'synthetic-invalid-for-burst' });
    const request = https.request(backend!.config.origin + '/api/login', { method: 'POST', rejectUnauthorized: false, headers: { Origin: backend!.config.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    request.on('error', reject); request.end(body);
  });
}
function active(row: any) {
  assert.equal(row.stats.bridges.ptys, 1); assert.equal(row.stats.bridges.retiringPtys, 0);
  assert.equal(row.stats.bridges.attachments, 1); assert.equal(row.browser.resources.xterms, 1); assert.equal(row.browser.resources.liveSockets, 1);
  assert.equal(row.stats.ptyFds, 1, 'Known active terminal must own an actual ptmx fd');
  assert.equal(row.stats.handles.ReadStream, 1, 'Known active terminal must own one native ReadStream');
  assert.equal(row.attachProcesses.processes.length, 1, 'Classifier must observe the known active native tmux client');
}
function detached(row: any) {
  for (const field of ['connections', 'attachments', 'ptys', 'retiringPtys', 'controllers', 'subscriptions', 'outstandingBytes', 'pendingInputBytes', 'transportBytes', 'inputTimers', 'resizeJobs']) assert.equal(row.stats.bridges[field], 0, `Retained bridge ${field}`);
  assert.equal(row.stats.bridges.created, row.stats.bridges.disposed);
  assert.equal(row.stats.ptyFds, 0, 'Retained native ptmx fd');
  assert.equal(row.stats.handles.ReadStream || 0, 0, 'Retained native ReadStream');
  assert.equal(row.attachProcesses.processes.length, 0, 'Actual native attach process survived detach');
  if (row.browser) { assert.equal(row.browser.resources.xterms, 0); assert.equal(row.browser.resources.liveSockets, 0); assert.equal(row.browser.resources.createdSockets, row.browser.resources.closedSockets); }
}
async function main() {
  if (!smoke) {
    const sourcePaths = ['src', 'tests', 'scripts', 'package.json', 'package-lock.json'];
    execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', ...sourcePaths], { cwd: ROOT });
    assert.equal(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...sourcePaths], { cwd: ROOT }).toString(), '', 'Unfrozen source files');
  }
  backend = await production('benchmark');
  fs.writeFileSync(path.join(evidence, 'manifest.json'), JSON.stringify({ run, commit, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT }).toString().trim(), buildHashes: artifactHashes(path.join(ROOT, 'dist')), lockfileSha256: createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).digest('hex'), smoke, nativeCleanupVersion: 2, attachmentClassifier: 'Real tmux executable + /dev/pts/N stdin, verified against active list-clients PID; all descendants retained separately; independent ptmx-fd and ReadStream checks', backendPid: backend.child.pid, driverPid: process.pid, origin: backend.config.origin, state: backend.config.dataDir, tmuxSocket: backend.config.tmuxSocket, soakSeconds, cooldownSeconds, outputRateBytesPerSecond: 4096, naturalGC: true, backendFlags: ['--max-old-space-size=96'], browser: 'Chromium production build; desktop then mobile viewport emulation, not physical phone', startedAt: new Date().toISOString() }, null, 2));
  await period('backend_idle_cold', smoke ? 2 : 30, detached);
  await period('backend_idle_warm_no_browser', smoke ? 2 : 30, detached);
  browser = await chromium.launch({ executablePath: path.join(ROOT, 'desktop/tests/browser-launcher.py'), chromiumSandbox: true, headless: true }); browserCdp = await browser.newBrowserCDPSession();
  await setupPage(false);
  const sessions = [await createShell(page!, 'Measured shell 0')];
  await page!.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page!, sessions[0].id); await typeCommand(page!, "printf 'DESKTOP-READY\\n'");
  await period('one_shell_active_desktop', smoke ? 2 : 30, active);
  const knownClient = Number(execFileSync('tmux', ['-L', backend.config.tmuxSocket, 'list-clients', '-t', `=pt_${sessions[0].id}`, '-F', '#{client_pid}']).toString().trim());
  const activeEvidence = await sample(); active(activeEvidence);
  assert.deepEqual(activeEvidence.attachProcesses.processes.map((p: any) => p.pid), [knownClient], 'Active classifier must match the independently queried real tmux client PID');
  fs.writeFileSync(path.join(evidence, 'active-native-cross-check.json'), JSON.stringify({ result: 'PASS', knownTmuxClientPid: knownClient, sample: activeEvidence }, null, 2));
  await page!.getByRole('button', { name: 'Disconnect', exact: true }).click(); await until(async () => (await backend!.measure()).bridges.ptys === 0);
  await period('one_shell_detached_desktop', smoke ? 2 : 30, detached);
  for (let i = 1; i < 20; i++) sessions.push(await createShell(page!, `Measured shell ${i}`));
  await page!.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page!, sessions[1].id);
  await period('twenty_shells_one_desktop', smoke ? 2 : 30, active);
  await page!.screenshot({ path: path.join(evidence, 'desktop.png') });
  await context!.close(); page = undefined; cdp = undefined; context = undefined;
  await until(async () => (await backend!.measure()).bridges.ptys === 0);
  await period('twenty_shells_detached', smoke ? 2 : 30, detached);
  await setupPage(true); await selectSession(page!, sessions[0].id);
  await period('mobile_before_cycles', smoke ? 2 : 30, active);
  phase = '100_connect_disconnect_cycles';
  const cycles = smoke ? 3 : 100;
  for (let i = 1; i <= cycles; i++) {
    await page!.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page!.waitForFunction(() => document.querySelectorAll('.xterm').length === 0 && (window as any).__testResources.liveSockets === 0);
    await until(async () => (await backend!.measure()).bridges.ptys === 0);
    await page!.getByRole('button', { name: 'Reconnect', exact: true }).click(); await page!.getByTestId('connection-status').filter({ hasText: 'You control input' }).waitFor();
    if (i % 10 === 0 || i === cycles) active(await sample({ cycle: i }));
  }
  phase = '200_session_switches';
  const switches = smoke ? 4 : 200;
  for (let i = 1; i <= switches; i++) { await selectSession(page!, sessions[i % 20].id); if (i % 10 === 0 || i === switches) active(await sample({ switch: i })); }
  phase = '50_mobile_hidden_frozen_visible_cycles';
  const freezes = smoke ? 2 : 50;
  for (let i = 1; i <= freezes; i++) {
    await page!.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await cdp!.send('Page.setWebLifecycleState', { state: 'frozen' });
    await until(async () => (await backend!.measure()).bridges.ptys === 0);
    await cdp!.send('Page.setWebLifecycleState', { state: 'active' }); await page!.bringToFront();
    await page!.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); document.dispatchEvent(new Event('resume')); });
    await page!.getByTestId('connection-status').filter({ hasText: 'You control input' }).waitFor();
    if (i % 10 === 0 || i === freezes) active(await sample({ freeze: i }));
  }
  await selectSession(page!, sessions[0].id);
  await period('mobile_warm_baseline_after_cycles', smoke ? 2 : 60, active);
  const producerStats = path.join(backend.config.dataDir, 'soak-producer.json');
  await typeCommand(page!, `python3 -u ${ROOT}/scripts/synthetic-output.py --rate 4096 --seconds ${soakSeconds + 15} --stats ${producerStats}`);
  await until(() => fs.existsSync(producerStats));
  await page!.getByTestId('terminal-host').filter({ hasText: 'PT-SOAK' }).waitFor();
  const soakStart = Date.now();
  await period('soak_real_mobile_xterm_4096_Bps', soakSeconds, active);
  const actualSoakSeconds = (Date.now() - soakStart) / 1000;
  await page!.screenshot({ path: path.join(evidence, 'mobile-soak.png') });
  assert.ok(actualSoakSeconds >= soakSeconds);
  const soakProducer = JSON.parse(fs.readFileSync(producerStats, 'utf8'));
  assert.ok(soakProducer.elapsedSeconds >= soakSeconds - 6, 'Producer progress sample is stale');
  assert.ok(soakProducer.bytesWritten >= soakProducer.elapsedSeconds * 4096 * 0.99, 'Producer did not sustain the configured rate');
  // True browser freeze during output: immediate lifecycle teardown, not transport-only buffering.
  phase = 'output_frozen_browser_detach'; await page!.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page!.waitForFunction(() => document.querySelectorAll('.xterm').length === 0 && (window as any).__testResources.liveSockets === 0);
  await until(async () => (await backend!.measure()).bridges.ptys === 0);
  const browserTeardown = await sample(); detached(browserTeardown);
  fs.writeFileSync(path.join(evidence, 'browser-teardown.json'), JSON.stringify(browserTeardown, null, 2));
  await cdp!.send('Page.setWebLifecycleState', { state: 'frozen' }); await until(async () => (await backend!.measure()).bridges.ptys === 0);
  await cdp!.send('Page.setWebLifecycleState', { state: 'active' });
  await context!.close(); context = undefined; page = undefined; cdp = undefined;
  await delay(smoke ? 1000 : 16000);
  // Separate deliberately non-consuming client at a much higher fixed producer rate.
  phase = 'high_rate_non_ack_client';
  const authResponse = await new Promise<any>((resolve, reject) => {
    // New synthetic login uses private isolated state only; response credential is never logged.
    const body = JSON.stringify({ password: 'Isolated-Synthetic-Only!47' });
    const req = https.request(backend!.config.origin + '/api/login', { method: 'POST', rejectUnauthorized: false, headers: { Origin: backend!.config.origin, 'Content-Type': 'application/json' } }, res => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ ...JSON.parse(data), cookie: res.headers['set-cookie']![0]!.split(';')[0] })); }); req.on('error', reject); req.end(body);
  });
  const slow = new WebSocket(`${backend.config.origin.replace('https:', 'wss:')}/api/terminal/${sessions[1].id}`, ['pocketterminal.v1', `csrf.${authResponse.csrf}`], { rejectUnauthorized: false, headers: { Origin: backend.config.origin, Cookie: authResponse.cookie } });
  await new Promise<void>((resolve, reject) => { slow.once('open', resolve); slow.once('error', reject); });
  const highStats = path.join(backend.config.dataDir, 'high-producer.json');
  slow.send(JSON.stringify({ type: 'input', data: `python3 -u ${ROOT}/scripts/synthetic-output.py --rate 1048576 --seconds 15 --stats ${highStats}\r` }));
  const highStart = Date.now(), highSamples: any[] = [];
  while (Date.now() - highStart < (smoke ? 8000 : 16000)) {
    const m = await backend.measure(), children = descendants(m.pid);
    highSamples.push({ seconds: (Date.now() - highStart) / 1000, node: procMemory(m.pid), tmux: procMemory(tmuxPid), bridges: m.bridges, ptyFds: m.ptyFds, handles: m.handles, attachProcesses: sumMemory(attachmentPids(children)), backendChildren: sumMemory(children), producer: fs.existsSync(highStats) ? JSON.parse(fs.readFileSync(highStats, 'utf8')) : null }); await delay(100);
  }
  fs.writeFileSync(path.join(evidence, 'high-rate-stress.json'), JSON.stringify(highSamples, null, 2));
  assert.equal(slow.readyState, WebSocket.CLOSED); assert.ok(highSamples.some(m => m.bridges.detachReasons.slow_client_reconnect || m.bridges.detachReasons.output_limit_reconnect));
  assert.ok(highSamples.every(m => m.bridges.peakOutstandingBytes <= LIMITS.outstanding));
  assert.ok(highSamples.some(m => m.ptyFds === 1 && m.handles.ReadStream === 1 && m.attachProcesses.processes.length === 1), 'Stress must exercise a real native PTY');
  assert.equal(highSamples.at(-1).attachProcesses.processes.length, 0, 'Non-ACK native child survived stress');
  assert.equal(highSamples.at(-1).ptyFds, 0); assert.equal(highSamples.at(-1).handles.ReadStream || 0, 0);
  assert.equal(highSamples.at(-1).bridges.created, highSamples.at(-1).bridges.disposed);
  const browserPids = [browserTeardown.browser.renderer.processes.map((p: any) => p.pid)].flat();
  await browser.close(); browser = undefined; browserCdp = undefined;
  await until(() => browserPids.every((pid: number) => !fs.existsSync(`/proc/${pid}`)), 5000, 'Browser renderer survived context/browser close');
  phase = 'login_kdf_burst';
  const before = await sample(); let done = false;
  const burst = Promise.all(Array.from({ length: 80 }, () => requestLogin())).then(results => { done = true; return results; });
  const kdf: any[] = [];
  while (!done) { const m = await backend.measure(); kdf.push({ at: Date.now(), memory: m.memory, proc: procMemory(m.pid), verifying: m.auth.verifying }); await delay(5); }
  const responses = await burst;
  const verified = responses.filter(s => s === 401).length, rejected = responses.filter(s => s === 429).length;
  assert.ok(verified >= 1 && verified <= 5); assert.equal(verified + rejected, 80); assert.ok(kdf.every(m => m.verifying <= 2));
  fs.writeFileSync(path.join(evidence, 'kdf-burst.json'), JSON.stringify({ before, responses: { rejected, verified }, kernelHighWaterBefore: before.node.highWaterRss, kernelHighWaterAfter: procMemory(backend.child.pid!).highWaterRss, highWaterNote: 'Kernel lifetime VmHWM; only an increase over pre-burst value is attributable to this phase. Sampled phase peaks are recorded independently.', peakVerifying: Math.max(...kdf.map(m => m.verifying)), samples: kdf }, null, 2));
  await period('cooldown_no_browser_clients', cooldownSeconds, row => { detached(row); assert.equal(row.stats.sessions.managedRunning, 20); });
  // A reconciliation subprocess may appear transiently in a sample. The final audit additionally
  // requires ALL actual backend descendants (not only classified attachments) to be gone.
  await until(() => descendants(backend!.child.pid!).length === 0, 3000, 'Backend retains an actual child process after cooldown');
  const finalAudit = await sample(); detached(finalAudit);
  assert.equal(finalAudit.backendChildren.processes.length, 0, 'Actual child present in final native-cleanup audit');
  assert.equal(execFileSync('tmux', ['-L', backend.config.tmuxSocket, 'list-clients', '-F', '#{client_pid}']).toString().trim(), '', 'tmux still reports an attached client');
  fs.writeFileSync(path.join(evidence, 'final-native-cleanup.json'), JSON.stringify({ result: 'PASS', allBackendChildrenGone: true, noTmuxClients: true, sample: finalAudit }, null, 2));
  const byPhase: Record<string, any> = {};
  for (const name of new Set(samples.map(s => s.phase))) {
    const rows = samples.filter(s => s.phase === name), mb = (v: number) => v / 1048576;
    byPhase[name] = { samples: rows.length, duration: rows.at(-1).seconds - rows[0].seconds, nodeRssMiB: summary(rows.map(s => mb(s.node.rss))), nodePssMiB: summary(rows.map(s => mb(s.node.pss))), heapUsedMiB: summary(rows.map(s => mb(s.stats.memory.heapUsed))), externalMiB: summary(rows.map(s => mb(s.stats.memory.external))), arrayBuffersMiB: summary(rows.map(s => mb(s.stats.memory.arrayBuffers))), tmuxRssMiB: summary(rows.map(s => mb(s.tmux?.rss || 0))), jobsRssMiB: summary(rows.map(s => mb(s.tmuxJobs?.rss || 0))), attachRssMiB: summary(rows.map(s => mb(s.attachProcesses.rss))), browserHeapMiB: summary(rows.filter(s => s.browser).map(s => mb(s.browser.heapUsed))), rendererRssMiB: summary(rows.filter(s => s.browser).map(s => mb(s.browser.renderer.rss))), firstResources: rows[0].browser?.resources, finalResources: rows.at(-1).browser?.resources, finalServer: rows.at(-1).stats };
  }
  const report = { result: 'MEASURED_RESOURCE_GATES_PASS_TRENDS_REQUIRE_REVIEW', smoke, actualSoakSeconds, configuredSoakSeconds: soakSeconds, cooldownSeconds, cycles, switches, freezes, backendRestarts: 0, forcedGC: false, producer: soakProducer, phases: byPhase, evidence };
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(report, null, 2));
}
let failed = false;
function failure(error: any) {
  const failedPhase = phase; phase = 'FAILED'; failed = true;
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, failedPhase, samples: samples.length }, null, 2)); status({ final: true, error: String(error) }); process.exitCode = 1;
}
try { await main(); } catch (error) { failure(error); }
finally {
  try {
    if (browser) await browser.close();
    if (backend) {
      const shutdown = await backend.close(); fs.writeFileSync(path.join(evidence, 'backend-shutdown.json'), JSON.stringify(shutdown, null, 2));
      assert.ok(shutdown.graceful, 'Backend required forced termination or exited abnormally after measurement');
    }
  } catch (error) { failure(error); }
}
if (!failed) {
  phase = smoke ? 'SMOKE_COMPLETE' : 'FULL_BENCHMARK_COMPLETE'; status({ final: true });
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence', smoke ? 'latest-smoke.txt' : 'latest-memory.txt'), evidence + '\n');
}
