import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { createApp } from '../src/server/app.js';
import { FleetState, FleetLocalState, validateFleet, FLEET_LIMITS } from '../src/server/telegram-fleet-state.js';
import { initializeFleet, addFleetWorker, joinFleet, removeFleetWorker } from '../src/server/telegram-fleet-setup.js';
import { fleetRoute, TelegramFleetHub } from '../src/server/telegram-fleet-hub.js';
import { FleetRemoteTransport } from '../src/server/telegram-fleet-client.js';
import { FleetLinkState, validateFleetLink } from '../src/server/telegram-fleet-link.js';
import { testConfig, until, delay, cleanupTmux, freePort } from './helpers.js';
import { fakeTelegram, dummyState, message, OWNER, BOT_ID } from './telegram-fake.js';
import { TelegramState } from '../src/server/telegram-state.js';
import { notifyLocal } from '../src/server/agent-notify-client.js';
process.umask(0o077);

test('private fleet configuration refuses public/wildcard addresses and unsafe TLS files', async () => {
  const config = await testConfig('fl-link-state'); dummyState(config, false);
  const state = new FleetLinkState(config), valid = { version: 1, role: 'worker', address: '10.10.0.2', port: 3443 };
  try {
    assert.deepEqual(validateFleetLink(valid), valid);
    for (const address of ['0.0.0.0', '8.8.8.8', '127.0.0.1', '10.0.0.999', 'private.example', '::1']) assert.throws(() => validateFleetLink({ ...valid, address }));
    for (const port of [443, 0, 65536, '3443']) assert.throws(() => validateFleetLink({ ...valid, port }));
    assert.throws(() => validateFleetLink({ ...valid, insecure: true }));
    state.save(validateFleetLink(valid)); assert.deepEqual(state.load('worker'), valid); assert.throws(() => state.load('controller'));
    assert.throws(() => state.materials('worker'));
    const ca = path.join(state.dir, 'fleet-controller-ca.pem');
    fs.copyFileSync(config.tls!.cert, ca); fs.chmodSync(ca, 0o600); assert(state.materials('worker').cert);
    fs.chmodSync(ca, 0o644); assert.throws(() => state.materials('worker'));
    fs.unlinkSync(ca); fs.symlinkSync(config.tls!.cert, ca); assert.throws(() => state.materials('worker'));
    fs.unlinkSync(ca); fs.writeFileSync(ca, 'not a certificate', { mode: 0o600 }); assert.throws(() => state.materials('worker'));
    state.save(undefined); assert.equal(state.load('worker'), undefined);
  } finally { cleanupTmux(config); }
});

test('private TLS uses pinned CA plus original hostname/Host, isolates routes and cleans repeated connections', async () => {
  const config = await testConfig('fl-private'), fake = await fakeTelegram(); dummyState(config, true);
  await initializeFleet(config, 'Controller'); config.telegramFleet = new FleetState(config).load();
  let grant: any; await addFleetWorker(config, 'Worker', x => { grant = x; });
  const state = new FleetLinkState(config), port = await freePort();
  for (const [source, name] of [[config.tls!.key, 'fleet-tls-key.pem'], [config.tls!.cert, 'fleet-tls-cert.pem']]) {
    fs.copyFileSync(source!, path.join(state.dir, name!)); fs.chmodSync(path.join(state.dir, name!), 0o600);
  }
  state.save({ version: 1, role: 'controller', address: '127.0.0.1', port });
  const worker = await testConfig('fl-private-w'); dummyState(worker, false); await joinFleet(worker, grant); worker.telegramFleet = new FleetState(worker).load();
  const workerState = new FleetLinkState(worker), ca = path.join(workerState.dir, 'fleet-controller-ca.pem');
  fs.copyFileSync(config.tls!.cert, ca); fs.chmodSync(ca, 0o600);
  workerState.save({ version: 1, role: 'worker', address: '127.0.0.1', port });
  const service = await createApp(config, { telegram: { endpoint: fake.endpoint } });
  const transports: FleetRemoteTransport[] = [];
  const client = (value = grant) => { const c = new FleetRemoteTransport(value, worker); transports.push(c); return c; };
  const request = (url: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, servername: 'localhost', ca: fs.readFileSync(config.tls!.cert), agent: false,
      path: url, method: 'POST', headers: { Host: new URL(config.origin).host, 'Content-Type': 'application/json', 'Content-Length': '2',
        'X-PocketTerminal-Node': grant.node.id, Authorization: 'Bearer ' + grant.key, ...headers } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end('{}');
  });
  try {
    await service.app.listen({ host: config.host, port: config.port }); await until(() => service.fleet!.isReady(), 6000);
    for (let i = 0; i < 6; i++) {
      const c = client(); assert.equal((await c.call<any>('getMe', {})).id, BOT_ID);
      const poll = c.call('getUpdates', { offset: 0, limit: 1, timeout: 3, allowed_updates: ['message', 'callback_query'] });
      const rejected = assert.rejects(poll);
      await until(() => service.fleet!.stats().nodes.find(n => n.id === grant.node.id)?.requests === 1);
      c.close(); await rejected;
      await until(() => service.fleet!.stats().nodes.find(n => n.id === grant.node.id)?.requests === 0);
    }
    const c = client(); await c.call('getMe', {});
    const result = await c.call<any>('sendMessage', { chat_id: OWNER, text: 'Private synthetic route', protect_content: true, link_preview_options: { is_disabled: true } });
    assert.match(result.text, /Private synthetic route/); c.close();
    assert.equal(await request('/api/sessions'), 404); assert.equal(await request('/api/login'), 404);
    assert.equal(await request('/api/telegram-fleet', { Host: 'wrong.example' }), 401);
    assert.equal(await request('/api/telegram-fleet', { cookie: 'anything' }), 401);
    assert.equal(await request('/api/telegram-fleet', { Authorization: 'Bearer ' + 'a'.repeat(64) }), 401);
    const wrongName = client({ ...grant, controller: 'https://wrong.invalid' }); await assert.rejects(wrongName.call('getMe', {})); wrongName.close();
    fs.writeFileSync(ca, rootCertificates[0]!);
    const wrongCA = client(); await assert.rejects(wrongCA.call('getMe', {})); wrongCA.close();
    fs.copyFileSync(config.tls!.cert, ca);
    await service.close();
    let fallbacks = 0;
    const fallback = https.createServer({ key: fs.readFileSync(config.tls!.key), cert: fs.readFileSync(config.tls!.cert) }, (_req, res) => { fallbacks++; res.end('{"ok":true,"result":{}}'); });
    await new Promise<void>(resolve => fallback.listen(config.port, '127.0.0.1', resolve));
    try {
      await assert.rejects(client().call('getMe', {}), 'Private link must not silently fall back to reachable public HTTPS');
      assert.equal(fallbacks, 0);
    } finally { await new Promise<void>(resolve => fallback.close(() => resolve())); }
  } finally { for (const c of transports) c.close(); await service.close(); cleanupTmux(config); cleanupTmux(worker); await fake.close(); }
});

test('an idle Telegram long poll never blocks a worker reply; both lanes stay bounded and close', async () => {
  const config = await testConfig('fl-latency'), fake = await fakeTelegram();
  dummyState(config, true); await initializeFleet(config, 'Controller');
  let grant: any; await addFleetWorker(config, 'Worker', x => { grant = x; });
  const hub = new TelegramFleetHub(config, new FleetState(config).load() as any, { endpoint: fake.endpoint }); hub.start();
  try {
    await until(() => hub.isReady() && fake.calls.some(c => c.method === 'setChatMenuButton'), 6000);
    const signal = new AbortController().signal, instance = 'd'.repeat(32);
    await hub.rpc(grant.node.id, { instance, seq: 1, method: 'getMe', body: {} }, signal);
    // Real Telegram keeps an empty getUpdates request open for three seconds.
    fake.delay = 3000;
    const polls = fake.calls.filter(c => c.method === 'getUpdates').length;
    await until(() => fake.calls.filter(c => c.method === 'getUpdates').length > polls && fake.activePolls === 1, 6000);
    const started = performance.now();
    await hub.rpc(grant.node.id, { instance, seq: 2, method: 'sendMessage', body: {
      chat_id: OWNER, text: 'Synthetic latency probe', protect_content: true, link_preview_options: { is_disabled: true },
    } }, signal);
    const elapsedMs = performance.now() - started;
    fs.mkdirSync(path.join(config.root, '.runtime/evidence'), { recursive: true });
    fs.writeFileSync(path.join(config.root, '.runtime/evidence/telegram-fleet-latency.json'), JSON.stringify({ synthetic: true, pollDelayMs: 3000, replyMs: elapsedMs, maxPolls: fake.maxPolls, maxOutgoing: fake.maxOutgoing, maxActive: fake.maxActive }));
    assert(elapsedMs < 800, `Worker reply waited ${Math.round(elapsedMs)}ms behind polling`);
    assert.equal(fake.activePolls, 1, 'Sending must not abort/restart the long poll');
    assert.equal(fake.maxPolls, 1); assert.equal(fake.maxOutgoing, 1); assert(fake.maxActive <= 2);
  } finally {
    await hub.close(); await until(() => fake.active === 0, 1500); cleanupTmux(config); await fake.close();
  }
});

test('fleet liveness follows authenticated RPCs, not completed reverse-proxy HTTP hop closures', async () => {
  const config = await testConfig('fl-proxy'), fake = await fakeTelegram();
  dummyState(config, true); await initializeFleet(config, 'Controller');
  let grant: any; await addFleetWorker(config, 'Worker', x => { grant = x; });
  config.telegramFleet = new FleetState(config).load();
  const service = await createApp(config, { telegram: { endpoint: fake.endpoint } });
  const instance = 'c'.repeat(32); let seq = 0;
  const rpc = (method: string, body: object) => {
    let request: import('node:http').ClientRequest;
    const done = new Promise<void>((resolve, reject) => {
      const data = JSON.stringify({ instance, seq: ++seq, method, body });
      // A fresh, explicitly closed HTTP hop models normal proxy pool churn.
      request = https.request(new URL('/api/telegram-fleet', config.origin), { method: 'POST', agent: false, ca: fs.readFileSync(config.tls!.cert),
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close',
          'X-PocketTerminal-Node': grant.node.id, Authorization: 'Bearer ' + grant.key } }, response => {
        response.resume(); response.once('end', () => response.statusCode === 200 ? resolve() : reject(new Error('RPC refused')));
      });
      request.on('error', reject); request.end(data);
    });
    return { done, abort: () => request.destroy() };
  };
  const peer = () => service.fleet!.stats().nodes.find(n => n.id === grant.node.id)!;
  try {
    await service.app.listen({ host: config.host, port: config.port });
    await until(() => service.fleet!.isReady(), 6000);
    await rpc('getMe', {}).done;
    const poll = { offset: 0, limit: 1, timeout: 0, allowed_updates: ['message', 'callback_query'] };
    for (let i = 0; i < 4; i++) {
      await rpc('getUpdates', poll).done; await delay(30);
      assert.equal(peer().online, true, 'Completed proxy-hop closure must not mark a healthy worker offline');
    }
    const active = rpc('getUpdates', { ...poll, timeout: 3 });
    const aborted = assert.rejects(active.done);
    await until(() => peer().requests === 1); active.abort(); await aborted;
    await until(() => !peer().online && peer().requests === 0, 5000, 'Aborted in-flight RPC must detach promptly');
  } finally { await service.close(); cleanupTmux(config); await fake.close(); }
});

test('fleet RPC rejects duplicate sequences, arbitrary methods, concurrent peer requests and revoked credentials', async () => {
  const config = await testConfig('fl-rpc'), fake = await fakeTelegram();
  dummyState(config, true); await initializeFleet(config, 'Controller');
  let grant: any; await addFleetWorker(config, 'Worker', x => { grant = x; });
  const hub = new TelegramFleetHub(config, new FleetState(config).load() as any, { endpoint: fake.endpoint }); hub.start();
  try {
    await until(() => hub.isReady(), 6000);
    assert(hub.authorize(grant.node.id, 'Bearer ' + grant.key));
    assert(!hub.authorize(grant.node.id, 'Bearer ' + 'f'.repeat(64)));
    const abort = new AbortController(), instance = 'a'.repeat(32);
    const first = { instance, seq: 1, method: 'getMe', body: {} };
    assert.equal((await hub.rpc(grant.node.id, first, abort.signal) as any).id, BOT_ID);
    await assert.rejects(hub.rpc(grant.node.id, first, abort.signal));
    await assert.rejects(hub.rpc(grant.node.id, { instance, seq: 2, method: 'exec', body: { command: 'not-executed' } }, abort.signal));
    const pending = hub.rpc(grant.node.id, { instance, seq: 3, method: 'getUpdates', body: { offset: 0, limit: 1, timeout: 3, allowed_updates: ['message', 'callback_query'] } }, abort.signal);
    const rejected = assert.rejects(pending);
    await assert.rejects(hub.rpc(grant.node.id, { instance, seq: 4, method: 'getMe', body: {} }, abort.signal));
    abort.abort(); await rejected;
    assert(hub.stats().nodes.every(n => n.requests === 0 && n.mailboxes === 0));
    await removeFleetWorker(config, grant.node.id); assert(!hub.authorize(grant.node.id, 'Bearer ' + grant.key));
    assert.equal(fake.calls.filter(c => c.method === 'exec').length, 0);
  } finally { await hub.close(); cleanupTmux(config); await fake.close(); }
});

test('fleet private metadata validation, isolated cursors, bounded immutable callback routes and safe enrollment', async () => {
  const config = await testConfig('fl-state');
  const state = dummyState(config, true);
  try {
    await initializeFleet(config, 'VPS 1');
    const fleet = new FleetState(config).load()!;
    assert.equal(fleet.role, 'controller');
    assert.throws(() => validateFleet({ ...fleet, extra: 'reject' }));
    assert.throws(() => validateFleet({ ...fleet, local: { id: 'a'.repeat(16), label: 'VPS\nspoof' } }));
    const local = new FleetLocalState(config), epoch = state.control()!.epoch;
    state.claim(epoch, 123); local.claim(epoch, 11);
    assert.equal(state.cursor(epoch), 123); assert.equal(local.cursor(epoch), 11);
    let invitation: any;
    await addFleetWorker(config, 'VPS 2', x => { invitation = x; });
    assert.equal(invitation.key.length, 64); assert(!JSON.stringify(invitation).includes('synthetic_dummy_credentials'));
    assert.throws(() => validateFleet({ ...invitation, controller: 'http://insecure.example' }));
    assert.throws(() => validateFleet({ ...invitation, controller: 'https://secret@host.example' }));
    assert.throws(() => validateFleet({ ...invitation, key: 'weak' }));
    await assert.rejects(addFleetWorker(config, 'VPS 2', () => {}));
    const worker = await testConfig('fl-state-w'); dummyState(worker, false);
    await joinFleet(worker, invitation);
    await assert.rejects(joinFleet(worker, invitation));
    const data = `f:${invitation.node.id}:n:select:${'b'.repeat(32)}`;
    assert(Buffer.byteLength(data) <= 64); assert.deepEqual(fleetRoute(data), { node: invitation.node.id, data: 'n:select:' + 'b'.repeat(32) });
    assert.equal(fleetRoute(`f:${invitation.node.id}:exec:rm`), undefined);
    assert.equal(fleetRoute(`f:${invitation.node.id}:h:use:${'b'.repeat(16)}`), undefined);
    await removeFleetWorker(config, invitation.node.id);
    assert.equal((new FleetState(config).load() as any).workers.length, 0);
    const file = path.join(state.dir, 'fleet.json'); fs.chmodSync(file, 0o644);
    assert.throws(() => new FleetState(config).load()); fs.chmodSync(file, 0o600);
  } finally { cleanupTmux(config); }
});

test('five VPSs share ONE bot: all-server alerts, exact-target replies/buttons, private RPC auth, reconnection and bounded resources', { timeout: 180000 }, async () => {
  const fake = await fakeTelegram();
  const configs: Awaited<ReturnType<typeof testConfig>>[] = [];
  const services: Awaited<ReturnType<typeof createApp>>[] = [];
  const grants: any[] = [];
  let sequence = 1;
  try {
    const config = await testConfig('fl-hub'); configs.push(config); dummyState(config, true);
    await initializeFleet(config, 'VPS 1'); config.telegramFleet = new FleetState(config).load();
    let hub = await createApp(config, { telegram: { endpoint: fake.endpoint } }); services.push(hub);
    await hub.app.listen({ host: config.host, port: config.port });
    await until(() => hub.fleet?.isReady() === true, 6000);
    for (let i = 2; i <= 5; i++) {
      let grant: any; await addFleetWorker(config, 'VPS ' + i, x => { grant = x; }); grants.push(grant);
      const worker = await testConfig('fl-w' + i); configs.push(worker);
      const state = dummyState(worker, false); fs.unlinkSync(path.join(state.dir, 'token'));
      await joinFleet(worker, grant); worker.telegramFleet = new FleetState(worker).load();
      const service = await createApp(worker, { telegram: { endpoint: fake.endpoint } }); services.push(service);
      await service.app.listen({ host: worker.host, port: worker.port });
    }
    await until(() => hub.fleet!.stats().nodes.length === 5 && hub.fleet!.stats().nodes.every(n => n.online), 12000, 'All five nodes should connect');
    const rows = [];
    for (let i = 0; i < services.length; i++) rows.push(await services[i]!.sessions.create({ kind: 'shell', label: 'Synthetic VPS ' + (i + 1) }));
    const last = () => fake.sent.at(-1)?.message_id || 0;
    const waitMessage = async (after: number, match: (m: any) => boolean = () => true) => {
      let value: any; await until(() => !!(value = fake.sent.find(m => m.message_id > after && match(m))), 15000, 'Expected fleet response'); return value;
    };
    const push = (value: object) => { const id = sequence++; fake.enqueue({ ...value, update_id: id }); return id; };
    const send = async (text: string, extra: object = {}, match?: (m: any) => boolean) => {
      const after = last(); push(message(1, text, extra)); return waitMessage(after, match);
    };
    const click = async (original: any, name: string, match?: (m: any) => boolean) => {
      const b = original.reply_markup.inline_keyboard.flat().find((x: any) => x.text === name); assert(b?.callback_data, 'Missing ' + name);
      const after = last(); push({ callback_query: { id: 'q_' + sequence, from: { id: OWNER, is_bot: false }, message: original, data: b.callback_data } }); return waitMessage(after, match);
    };
    const choose = async (number: number) => { const list = await send('/servers'); return click(list, '🟢 VPS ' + number, m => m.text.startsWith('[VPS ' + number + ']')); };

    // Root machine endpoint never accepts browser cookies/Origin or a different
    // worker's credential. All other web API routes keep cookie+CSRF protection.
    const bad = await hub.app.inject({ method: 'POST', url: '/api/telegram-fleet', headers: { host: new URL(config.origin).host, 'content-type': 'application/json' }, payload: {} });
    assert.equal(bad.statusCode, 401);
    for (const headers of [{ origin: config.origin }, { cookie: 'pocketterminal=anything' }, { 'sec-fetch-site': 'same-origin' }]) {
      const denied = await hub.app.inject({ method: 'POST', url: '/api/telegram-fleet', headers: { host: new URL(config.origin).host, 'content-type': 'application/json', authorization: 'Bearer ' + grants[0].key, 'x-pocketterminal-node': grants[0].node.id, ...headers }, payload: {} });
      assert.equal(denied.statusCode, 401);
    }
    const mismatch = await hub.app.inject({ method: 'POST', url: '/api/telegram-fleet', headers: { host: new URL(config.origin).host, 'content-type': 'application/json', authorization: 'Bearer ' + grants[0].key, 'x-pocketterminal-node': grants[1].node.id }, payload: {} });
    assert.equal(mismatch.statusCode, 401);
    const bypass = await hub.app.inject({ method: 'GET', url: '/api/sessions', headers: { host: new URL(config.origin).host, authorization: 'Bearer ' + grants[0].key, 'x-pocketterminal-node': grants[0].node.id } }); assert.equal(bypass.statusCode, 401);
    await choose(2);
    const request = await send('/prompt ' + rows[1]!.id);
    assert(request.text.startsWith('[VPS 2]')); assert(request.reply_markup.force_reply);
    await choose(3);
    const receipt = await send("printf 'once\\n' >> fleet-marker", { reply_to_message: request });
    assert(receipt.text.startsWith('[VPS 2]'));
    const marker = path.join(configs[1]!.defaultCwd, 'fleet-marker'); await until(() => fs.existsSync(marker));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n'); assert(!fs.existsSync(path.join(configs[2]!.defaultCwd, 'fleet-marker')));
    await send("printf 'once\\n' >> fleet-marker", { reply_to_message: request }); assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
    const remoteOutput = await click(receipt, 'Recent output'); assert(remoteOutput.text.startsWith('[VPS 2]'));
    const stopped = await click(receipt, 'Stop…'); assert(stopped.text.startsWith('[VPS 2]'));
    await click(stopped, 'Confirm stop'); assert.equal(services[1]!.sessions.get(rows[1]!.id).state, 'stopped'); assert.equal(services[2]!.sessions.get(rows[2]!.id).state, 'running');
    await click(stopped, 'Confirm stop'); assert.equal(services[2]!.sessions.get(rows[2]!.id).state, 'running');
    rows[1] = await services[1]!.sessions.create({ kind: 'shell', label: 'Synthetic replacement VPS 2' });

    // Explicit agent updates also arrive from every VPS while selection stays
    // on VPS 3. The root-local ingress cannot create another upstream client.
    await until(() => services.every(s => s.telegram.stats().status === 'polling'), 12000);
    const beforeAgents = last();
    const agentReceipts = await Promise.all(services.map((s, i) => notifyLocal(s.agentNotify!.path, { kind: 'progress', text: 'Synthetic agent milestone', session: rows[i]!.id })));
    assert(agentReceipts.every(r => r.status === 'sent'));
    const agentWave = fake.sent.filter(m => m.message_id > beforeAgents && m.text.includes('Synthetic agent milestone'));
    assert.equal(agentWave.length, 5);
    for (let i = 0; i < 5; i++) {
      const sent = agentWave.find(m => m.text.startsWith(`[VPS ${i + 1}]`)); assert(sent); assert(sent.text.includes(rows[i]!.id));
      assert.match(sent.reply_markup.inline_keyboard[0][0].callback_data, new RegExp('n:select:' + rows[i]!.id + '$'));
    }
    assert(services.every(s => s.telegram.stats().agentUpdates.textBytes === 0));

    // Simulated native activity transitions, no Codex/model request. Selection
    // remains VPS 3 for the entire wave. All five independent observers notify.
    let activity = 'working';
    const originalDescriptions = services.map(s => s.sessions.describe.bind(s.sessions));
    services.forEach((s, i) => { s.sessions.describe = row => ({ ...originalDescriptions[i]!(row), activity: row.state === 'running' ? activity as any : 'not_reported' }); });
    await delay(5000); const beforeWave = last(); activity = 'awaiting_input';
    await until(() => [1, 2, 3, 4, 5].every(n => fake.sent.some(m => m.message_id > beforeWave && m.text.startsWith(`[VPS ${n}]`) && m.text.includes('Native Codex reports input/action required.'))), 18000, 'Alerts from all five servers without switching');
    assert.equal(fake.maxPolls, 1, 'Exactly one upstream poller');
    assert.equal(fake.maxOutgoing, 1, 'Outgoing Telegram requests remain serialized');
    assert(fake.maxActive <= 2, 'Only one poll plus one outgoing request');
    const wave = fake.sent.filter(m => m.message_id > beforeWave && m.text.includes('Native Codex reports input/action required.')).map(m => m.text.slice(0, 7));
    services.forEach((s, i) => { s.sessions.describe = originalDescriptions[i]!; });

    // Repeated worker disconnect/reconnect with unchanged managed job/pane. Old
    // state cannot cause a second upstream poller or duplicate input delivery.
    const heapSamples: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      await until(() => hub.fleet!.stats().nodes.find(n => n.id === grants[3].node.id)?.requests === 1, 6000);
      await services[4]!.close();
      await until(() => !hub.fleet!.stats().nodes.find(n => n.id === grants[3].node.id)?.online, 5000);
      services[4] = await createApp(configs[4]!, { telegram: { endpoint: fake.endpoint } });
      await services[4]!.app.listen({ host: configs[4]!.host, port: configs[4]!.port });
      await until(() => hub.fleet!.stats().nodes.find(n => n.id === grants[3].node.id)?.online === true, 10000);
      (globalThis as { gc?: () => void }).gc?.(); heapSamples.push(process.memoryUsage().heapUsed);
      const stats = hub.fleet!.stats();
      assert(stats.queuedApiRequests <= FLEET_LIMITS.nodes + 1);
      assert(stats.nodes.every(n => n.mailboxes <= 1 && n.replies <= FLEET_LIMITS.replies && n.callbacks <= FLEET_LIMITS.callbacks && n.requests <= 1));
      assert.equal(services[4]!.sessions.get(rows[4]!.id).state, 'running');
    }
    await hub.close();
    fake.enqueue(message(0, '/old-backlog')); sequence = 1; // Telegram can randomize IDs after long idle.
    hub = await createApp(config, { telegram: { endpoint: fake.endpoint } }); services[0] = hub;
    await hub.app.listen({ host: config.host, port: config.port });
    await until(() => hub.fleet?.isReady() === true && hub.fleet.stats().nodes.every(n => n.online), 15000, 'Workers reconnect after controller restart');
    const afterRestart = await send('/sessions'); assert.match(afterRestart.text, /^PocketTerminal VPS servers/);
    await choose(2);
    const afterIdReset = await send('/output ' + rows[1]!.id); assert(afterIdReset.text.startsWith('[VPS 2]'));
    // Authenticated owner is still enforced before routing. Group/foreign chat
    // commands cannot select a node, create work or return terminal output.
    const beforeUnauthorized = last();
    const foreign = push(message(1, '/servers', { from: { id: OWNER + 1, is_bot: false } }));
    const group = push(message(1, '/servers', { chat: { id: OWNER, type: 'group' } }));
    const state = new TelegramState(config);
    await until(() => state.cursor(state.control()!.epoch) > Math.max(foreign, group)); await delay(200);
    assert.equal(last(), beforeUnauthorized);
    const states = services.map(s => ({ bot: s.telegram.stats(), bridge: s.bridges.stats(), sessions: s.sessions.stats() }));
    assert(states.every(s => s.bridge.created === 0 && s.bridge.telegramInput.transientBuffers === 0));
    assert.equal(fake.maxPolls, 1); assert.equal(fake.maxOutgoing, 1); assert(fake.maxActive <= 2);
    await removeFleetWorker(config, grants[3].node.id);
    await until(() => !hub.fleet!.stats().nodes.some(n => n.id === grants[3].node.id), 5000);
    assert.equal(services[4]!.sessions.get(rows[4]!.id).state, 'running');
    const report = { synthetic: true, realTelegram: false, vpsCount: 5, notificationSourcesWithoutSwitching: wave, agentNotificationSourcesWithoutSwitching: agentWave.map(m => m.text.slice(0, 7)), maxConcurrentUpstreamRequests: fake.maxActive, maxPolls: fake.maxPolls, maxOutgoing: fake.maxOutgoing,
      reconnectCycles: 6, controllerRestarts: 1, heapSamples, beforeDisconnect: process.memoryUsage(), fleet: hub.fleet!.stats(), nativeAttachmentsCreated: states.reduce((n, s) => n + s.bridge.created, 0), privateInputReplayed: false };
    for (const service of services.slice(1)) await service.close();
    await delay(100); (globalThis as { gc?: () => void }).gc?.();
    Object.assign(report, { afterWorkersDisconnected: process.memoryUsage(), disconnectedFleet: hub.fleet!.stats() });
    fs.mkdirSync(path.join(config.root, '.runtime/evidence'), { recursive: true });
    fs.writeFileSync(path.join(config.root, '.runtime/evidence/telegram-fleet.json'), JSON.stringify(report, null, 2));
  } finally { for (const s of services.reverse()) await s.close(); for (const c of configs) cleanupTmux(c); await fake.close(); }
});
