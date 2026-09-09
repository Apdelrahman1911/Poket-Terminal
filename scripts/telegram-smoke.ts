import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import type { Page, CDPSession } from '@playwright/test';
import { ROOT } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { Auth } from '../src/server/auth.js';
import { testConfig, TEST_PASSWORD, until, delay, cleanupTmux } from '../tests/helpers.js';
import { dummyState, fakeTelegram, message, OWNER } from '../tests/telegram-fake.js';
import { browserLogin, createShell, installCounters, resources, selectSession } from '../tests/browser-tools.js';
import { procMemory, descendants, attachmentPids, sumMemory, summary } from './memory.js';

// Short feature-specific measurement, NOT a replacement for historical 30-minute
// acceptance. Real compiled backend + mobile production xterm; dummy loopback bot.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, '.runtime/browsers');
const { chromium } = await import('@playwright/test');
const evidence = path.join(ROOT, '.runtime/evidence/telegram-smoke');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const config = await testConfig('telegram-ram'), fake = await fakeTelegram();
const state = dummyState(config, true);
const store = new Store(config.dataDir); await new Auth(store).setPassword(TEST_PASSWORD, 'init'); store.close();
const log = fs.createWriteStream(path.join(config.dataDir, 'backend.log'), { mode: 0o600 });
// Deliberately no inherited environment, live token, Codex home or owner config.
const child = fork(path.join(ROOT, 'dist/server/index.js'), [], { cwd: ROOT, execArgv: ['--max-old-space-size=96'],
  env: { TMUX_TMPDIR: process.env.TMUX_TMPDIR, PT_TELEGRAM_BOT_USERNAME: config.telegramBot!.username, PT_TELEGRAM_BOT_ID: String(config.telegramBot!.id), HOME: config.dataDir, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', PT_TEST_MODE: '1', PT_DATA_DIR: config.dataDir,
    PT_HOST: config.host, PT_PORT: String(config.port), PT_ORIGIN: config.origin, PT_TMUX_SOCKET: config.tmuxSocket,
    PT_TEST_TLS_KEY: config.tls!.key, PT_TEST_TLS_CERT: config.tls!.cert, PT_TEST_TELEGRAM_API: fake.endpoint },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout!.pipe(log); child.stderr!.pipe(log, { end: false });
const started = Date.now(), samples: any[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined, cdp: CDPSession | undefined;
let browserCdp: CDPSession | undefined, tmuxPid = 0, sequence = 1, measuring = false;
let identity: string | undefined, jobs: ReturnType<typeof procMemory>[] = [], renderers: number[] = [];
const result: Record<string, any> = { result: 'RUNNING', fixtureOnly: true, productionBuild: true, mobileViewport: { width: 390, height: 844 },
  realTelegram: false, naturalGC: true, backendRestarts: 0, shortRunOnly: true, enabledCooldownSeconds: 12, disabledCooldownSeconds: 10, connectDisconnectCycles: 3,
  startedAt: new Date(started).toISOString(), sourceCommit: process.env.PT_CANDIDATE_COMMIT || 'see-stage-manifest', backendPid: child.pid };
const tmux = (args: string[]) => execFileSync('tmux', ['-L', config.tmuxSocket, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 }).trim();
async function measure(): Promise<any> {
  assert(!measuring); measuring = true;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Private measurement timeout')); }, 4000);
      const listener = (m: any) => { if (m.type === 'measurement') { clearTimeout(timer); child.off('message', listener); resolve(m); } };
      child.on('message', listener); child.send({ type: 'measure' });
    });
  } finally { measuring = false; }
}
async function sample(phase: string) {
  const stats = await measure(), node = procMemory(stats.pid), children = descendants(stats.pid);
  identity ??= node.startTicks; assert.equal(node.startTicks, identity, 'Backend must not restart');
  let client: any = null;
  if (page && cdp && browserCdp) {
    const info = await browserCdp.send('SystemInfo.getProcessInfo'); renderers = info.processInfo.filter(p => p.type === 'renderer').map(p => p.id);
    client = { heap: await cdp.send('Runtime.getHeapUsage'), dom: await cdp.send('Memory.getDOMCounters'), resources: await resources(page), renderer: sumMemory(renderers) };
  }
  const row = { at: new Date().toISOString(), seconds: (Date.now() - started) / 1000, phase, stats, node,
    tmux: tmuxPid ? procMemory(tmuxPid) : null, jobs: sumMemory(jobs.map(j => j.pid)),
    attachProcesses: sumMemory(attachmentPids(children)), backendChildren: sumMemory(children), browser: client };
  assert(samples.length < 128); samples.push(row); fs.appendFileSync(path.join(evidence, 'samples.jsonl'), JSON.stringify(row) + '\n');
  assert(stats.telegram.actions <= 64 && stats.telegram.replies <= 8 && stats.telegram.baseline <= 20 && stats.telegram.pendingNotifications <= 20);
  assert(stats.bridges.telegramControllers <= 20 && stats.bridges.telegramInput.operations <= 1 && stats.bridges.telegramInput.inputBytes <= 4096);
  return row;
}
function active(row: any) {
  for (const k of ['attachments', 'ptys']) assert.equal(row.stats.bridges[k], 1);
  assert.equal(row.stats.ptyFds, 1); assert.equal(row.stats.handles.ReadStream, 1); assert.equal(row.attachProcesses.processes.length, 1);
  assert.equal(row.browser.resources.xterms, 1); assert.equal(row.browser.resources.liveSockets, 1);
  assert(row.browser.heap.usedSize < 64 * 1024 * 1024);
}
function detached(row: any) {
  for (const k of ['connections', 'attachments', 'ptys', 'retiringPtys', 'controllers', 'subscriptions', 'outstandingBytes', 'pendingInputBytes', 'transportBytes', 'inputTimers', 'resizeJobs', 'historyJobs', 'telegramControllers']) assert.equal(row.stats.bridges[k], 0, k);
  assert.deepEqual(row.stats.bridges.telegramInput, { operations: 0, inputBytes: 0, transientBuffers: 0 });
  assert.equal(row.stats.bridges.created, row.stats.bridges.disposed); assert.equal(row.stats.ptyFds, 0);
  assert.equal(row.stats.handles.ReadStream || 0, 0); assert.equal(row.attachProcesses.processes.length, 0);
  if (row.browser) { assert.equal(row.browser.resources.xterms, 0); assert.equal(row.browser.resources.liveSockets, 0); assert.equal(row.browser.resources.createdSockets, row.browser.resources.closedSockets); }
}
async function period(phase: string, seconds: number, verify: (row: any) => void) {
  const end = Date.now() + seconds * 1000;
  do { verify(await sample(phase)); await delay(Math.min(1000, Math.max(0, end - Date.now()))); } while (Date.now() < end);
  verify(await sample(phase));
}
async function waitBot(after: number) {
  await until(() => fake.sent.some(m => m.message_id > after), 8000); return fake.sent.find(m => m.message_id > after);
}
async function botSend(text: string, reply?: any) {
  const after = fake.sent.at(-1)?.message_id || 0;
  fake.enqueue(message(sequence++, text, reply ? { reply_to_message: reply } : {})); return waitBot(after);
}
async function click(original: any, label: string) {
  const b = original.reply_markup.inline_keyboard.flat().find((b: any) => b.text === label); assert(b?.callback_data);
  const after = fake.sent.at(-1)?.message_id || 0;
  fake.enqueue({ update_id: sequence++, callback_query: { id: 'ram_' + sequence, from: { id: OWNER, is_bot: false }, message: original, data: b.callback_data } });
  return waitBot(after);
}
async function shutdown() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const before = Date.now(); let forced = false;
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM');
  const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000); await ended; clearTimeout(timer);
  result.shutdown = { graceful: !forced && child.exitCode === 0, durationMs: Date.now() - before, exitCode: child.exitCode, signal: child.signalCode };
}
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.stdout!.off('data', ready); reject(new Error('Compiled fixture startup timeout')); }, 10000);
    const ready = (data: Buffer) => { if (data.toString().includes('"event":"ready"')) { clearTimeout(timer); child.stdout!.off('data', ready); resolve(); } };
    child.stdout!.on('data', ready);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Compiled fixture exited before readiness')); });
  });
  await until(async () => child.connected && (await measure()).telegram.status === 'polling', 10000);
  await period('paired_idle_no_browser', 3, detached);
  browser = await chromium.launch({ executablePath: path.join(ROOT, 'desktop/tests/browser-launcher.py'), chromiumSandbox: true, headless: true }); browserCdp = await browser.newBrowserCDPSession();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  await installCounters(context); page = await context.newPage(); cdp = await context.newCDPSession(page);
  await browserLogin(page, config.origin);
  const rows = [await createShell(page, 'Telegram RAM fixture 0')];
  await page.getByRole('button', { name: 'Refresh sessions' }).click(); await selectSession(page, rows[0].id);
  tmuxPid = Number(tmux(['display-message', '-p', '#{pid}']));
  jobs = tmux(['list-panes', '-a', '-F', '#{pane_pid}']).split('\n').map(p => procMemory(Number(p)));
  await period('one_shell_mobile', 2, active);
  for (let i = 1; i < 20; i++) rows.push(await createShell(page, 'Telegram RAM fixture ' + i));
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await page.locator(`[data-session-id="${rows[19].id}"]`).waitFor();
  assert.equal(await page.locator('[data-session-id]').count(), 20);
  jobs = tmux(['list-panes', '-a', '-F', '#{pane_pid}']).split('\n').map(p => procMemory(Number(p))); assert.equal(jobs.length, 20);
  await period('twenty_shells_one_mobile', 3, active);
  const knownClient = Number(tmux(['list-clients', '-t', '=pt_' + rows[0].id, '-F', '#{client_pid}']));
  const known = await sample('active_native_cross_check'); active(known);
  assert.deepEqual(known.attachProcesses.processes.map((p: any) => p.pid), [knownClient]);
  const marker = path.join(config.defaultCwd, 'telegram-ram-marker');
  for (let i = 0; i < 3; i++) {
    const confirm = await botSend('/take ' + rows[0].id), selected = await click(confirm, 'Confirm take control');
    await page.getByTestId('connection-status').filter({ hasText: 'Telegram controls input' }).waitFor();
    const request = await click(selected, 'Send prompt + Enter');
    const receipt = await botSend(`printf 'cycle-${i}\\n' >> '${marker}'`, request); assert.match(receipt.text, /Input accepted by tmux/);
    await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').split('\n').length === i + 2);
    const botOwns = await sample('telegram_control_cycle_' + (i + 1)); active(botOwns); assert.equal(botOwns.stats.bridges.telegramControllers, 1);
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByTestId('connection-status').filter({ hasText: 'You control input' }).waitFor();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await until(async () => (await measure()).bridges.ptys === 0); detached(await sample('disconnected_cycle_' + (i + 1)));
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByTestId('connection-status').filter({ hasText: 'You control input' }).waitFor(); active(await sample('reconnected_cycle_' + (i + 1)));
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'cycle-0\ncycle-1\ncycle-2\n');
  await page.screenshot({ path: path.join(evidence, 'mobile-twenty-sessions.png') });
  // Phone-closed lifecycle: no website catalog polling/terminal remains active,
  // but the paired bot must keep observing/long-polling with bounded metadata.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await until(async () => (await measure()).bridges.ptys === 0 && (await resources(page!)).liveSockets === 0);
  await period('paired_enabled_detached_cooldown', 12, row => {
    detached(row); assert.equal(row.stats.telegram.poller, 1); assert.equal(row.stats.telegram.enabled, true);
    assert.equal(row.stats.telegram.replies, 0); assert.equal(row.stats.telegram.pendingNotifications, 0);
    assert.equal(row.stats.telegram.monitorTimers, 1); assert(row.stats.telegram.waitTimers <= 1);
    for (const job of jobs) assert.equal(procMemory(job.pid).startTicks, job.startTicks);
  });
  const disabledAt = Date.now(); state.disable();
  await until(async () => (await measure()).telegram.poller === 0 && fake.active === 0, 4000);
  result.disableMs = Date.now() - disabledAt;
  await period('disabled_detached_cooldown', 10, row => {
    detached(row);
    for (const k of ['poller', 'actions', 'replies', 'baseline', 'pendingNotifications', 'waitTimers']) assert.equal(row.stats.telegram[k], 0, k);
    assert.equal(row.stats.telegram.enabled, false);
    for (const job of jobs) assert.equal(procMemory(job.pid).startTicks, job.startTicks);
  });
  assert(!tmux(['list-buffers', '-F', '#{buffer_name}']).includes('pocketterminal_telegram_input_v1'));
  const last = samples.at(-1), cooldown = samples.filter(s => s.phase === 'disabled_detached_cooldown');
  const enabledCooldown = samples.filter(s => s.phase === 'paired_enabled_detached_cooldown');
  result.enabledCooldown = Object.fromEntries(['rss', 'pss', 'heapUsed', 'external', 'arrayBuffers'].map(key => [key, summary(enabledCooldown.map(s => key === 'rss' || key === 'pss' ? s.node[key] : s.stats.memory[key]))]));
  result.enabledDetachedFinal = enabledCooldown.at(-1);
  result.cooldown = Object.fromEntries(['rss', 'pss', 'heapUsed', 'external', 'arrayBuffers'].map(key => [key, summary(cooldown.map(s => key === 'rss' || key === 'pss' ? s.node[key] : s.stats.memory[key]))]));
  result.browserCooldown = { heapUsed: summary(cooldown.map(s => s.browser.heap.usedSize)), nodes: summary(cooldown.map(s => s.browser.dom.nodes)), listeners: summary(cooldown.map(s => s.browser.dom.jsEventListeners)) };
  result.nodePeakBytes = { rss: Math.max(...samples.map(s => s.node.rss)), pss: Math.max(...samples.map(s => s.node.pss)), heapUsed: Math.max(...samples.map(s => s.stats.memory.heapUsed)), external: Math.max(...samples.map(s => s.stats.memory.external)) };
  result.final = { node: last.node, memory: last.stats.memory, bridges: last.stats.bridges, telegram: last.stats.telegram, browser: last.browser, ptyFds: last.stats.ptyFds, actualAttachments: last.attachProcesses.processes.length, handles: last.stats.handles };
  result.shortCooldownStable = result.cooldown.rss.max - result.cooldown.rss.min < 8 * 1024 * 1024 && result.cooldown.pss.max - result.cooldown.pss.min < 8 * 1024 * 1024;
  result.shortEnabledCooldownStable = result.enabledCooldown.rss.max - result.enabledCooldown.rss.min < 8 * 1024 * 1024 && result.enabledCooldown.pss.max - result.enabledCooldown.pss.min < 8 * 1024 * 1024;
  assert(result.shortEnabledCooldownStable, 'Investigate >8 MiB drift in short enabled detached window; not long-term leak acceptance');
  assert(result.shortCooldownStable, 'Investigate >8 MiB drift in the short detached window; not long-term leak acceptance');
  result.working120MiBTargetMet = last.node.rss <= 120 * 1024 * 1024;
  await cdp.detach(); cdp = undefined; await context.close(); page = undefined; await browser.close(); browser = undefined;
  await until(() => renderers.every(pid => !procMemory(pid).startTicks), 5000); result.renderersGone = true;
  await shutdown(); assert(result.shutdown.graceful);
  for (const job of jobs) assert.equal(procMemory(job.pid).startTicks, job.startTicks);
  result.jobsSurvivedBackendShutdown = jobs.length; result.maxConcurrentTelegramRequests = fake.maxActive; assert.equal(fake.maxActive, 1);
  result.result = 'PASS';
} catch (error) {
  result.result = 'FAIL'; result.error = error instanceof Error ? error.message : 'Synthetic measurement failed'; process.exitCode = 1;
} finally {
  await browser?.close(); await shutdown(); log.end(); cleanupTmux(config); await fake.close();
  result.durationSeconds = (Date.now() - started) / 1000; result.samples = samples.length;
  result.limitations = 'Short feature smoke only, not a new 30-minute soak or physical-phone measurement. Synthetic auth/KDF initialization is outside measured backend. No real Telegram/model calls, forced GC or backend restart; original long-soak evidence keeps its original source identity.';
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ result: result.result, error: result.error, durationSeconds: result.durationSeconds, samples: result.samples, evidence: path.relative(ROOT, evidence) }) + '\n');
}
