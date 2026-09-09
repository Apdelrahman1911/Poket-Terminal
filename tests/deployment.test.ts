import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { ROOT } from '../src/server/config.js';
import { Auth } from '../src/server/auth.js';
import { Store } from '../src/server/db.js';
import { testConfig, configEnv, cleanupTmux, until, delay, TEST_PASSWORD } from './helpers.js';
import { procMemory } from '../scripts/memory.js';

const req = (origin: string, route: string, method = 'GET', body?: object, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
  const r = https.request(origin + route, { method, rejectUnauthorized: false, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => { let data = ''; res.on('data', b => data += b); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers })); }); r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
});
async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; }

test('Deployment: explicit minimal environment resolves tools without sourcing private profiles', async () => {
  const config = await testConfig('minimal-env');
  const home = path.join(config.dataDir, 'home');
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true, mode: 0o700 });
  const codex = path.join(home, '.local/bin/codex');
  fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); // resolution only; no model invocation
  const env = { HOME: home, PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', JAVA_HOME: '/synthetic/jdk', ANDROID_HOME: '/synthetic/android', ANDROID_SDK_ROOT: '/synthetic/android' };
  const result = JSON.parse(execFileSync('/bin/bash', ['-c', `source scripts/runtime-env.sh; node -e 'console.log(JSON.stringify({node:process.execPath,JAVA_HOME:process.env.JAVA_HOME,ANDROID_HOME:process.env.ANDROID_HOME,ANDROID_SDK_ROOT:process.env.ANDROID_SDK_ROOT,path:process.env.PATH}))'`], { cwd: ROOT, env }).toString());
  assert.equal(result.node, fs.realpathSync(process.execPath));
  assert.equal(result.JAVA_HOME, env.JAVA_HOME); assert.equal(result.ANDROID_HOME, env.ANDROID_HOME); assert.equal(result.ANDROID_SDK_ROOT, env.ANDROID_SDK_ROOT);
  for (const dir of [path.join(home, '.local/bin'), path.join(home, '.npm-global/bin')]) assert.ok(result.path.split(':').includes(dir));
  assert.equal(execFileSync('/bin/bash', ['-c', 'source scripts/runtime-env.sh; command -v codex'], { cwd: ROOT, env }).toString().trim(), codex);
  const source = fs.readFileSync(path.join(ROOT, 'scripts/runtime-env.sh'), 'utf8');
  assert.doesNotMatch(source, /source .*profile|\/etc\/profile\.d|\/opt\/node/);
  fs.mkdirSync(path.join(ROOT, '.runtime/evidence'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ROOT, '.runtime/evidence/minimal-boot-env.json'), JSON.stringify({ ...result, syntheticTool: codex, noOwnerProfileRead: true }, null, 2), { mode: 0o600 });
});
test('Deployment: actual minimal-env service restart/stop preserves a live job; lock reusable and no tmux lock inheritance', async () => {
  const config = await testConfig('actual-service'); const store = new Store(config.dataDir); await new Auth(store).setPassword(TEST_PASSWORD, 'init'); store.close();
  const env = Object.fromEntries(Object.entries(configEnv(config)).filter(([key, value]) => (key.startsWith('PT_') || key === 'TMUX_TMPDIR') && value !== undefined)) as Record<string, string>;
  env.HOME = path.join(config.dataDir, 'home'); fs.mkdirSync(env.HOME, { mode: 0o700 });
  env.PATH = path.dirname(process.execPath) + ':/usr/bin:/bin';
  env.JAVA_HOME = '/synthetic/jdk'; env.ANDROID_HOME = '/synthetic/android';
  const launch = () => spawn(path.join(ROOT, 'scripts/service.sh'), [], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = async () => { await until(async () => { try { return (await req(config.origin, '/health')).status === 200; } catch { return false; } }, 10000); };
  let service = launch(); let job = '', panePid = '';
  const measurements: object[] = [];
  try {
    await ready();
    const firstBackend = Number(fs.readFileSync(path.join(config.dataDir, 'web.pid'), 'utf8'));
    measurements.push({ phase: 'initial', supervisor: procMemory(service.pid!), node: procMemory(firstBackend) });
    const login = await req(config.origin, '/api/login', 'POST', { password: TEST_PASSWORD }); assert.equal(login.status, 200);
    const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': login.body.csrf };
    const created = await req(config.origin, '/api/sessions', 'POST', { kind: 'shell' }, headers); assert.equal(created.status, 201); job = created.body.session.id;
    panePid = execFileSync('tmux', ['-L', config.tmuxSocket, 'display-message', '-p', '-t', `=pt_${job}:0.0`, '#{pane_pid}']).toString().trim(); assert.match(panePid, /^\d+$/);
    const w = new WebSocket(config.origin.replace('https:', 'wss:') + `/api/terminal/${job}`, ['pocketterminal.v1', `csrf.${login.body.csrf}`], { rejectUnauthorized: false, headers: { Origin: config.origin, Cookie: headers.Cookie } });
    let received = 0; w.on('message', (d, b) => { if (b && w.readyState === WebSocket.OPEN) { received += d.length; w.send(JSON.stringify({ type: 'ack', bytes: received })); } });
    await new Promise<void>(resolve => w.once('open', resolve));
    w.send(JSON.stringify({ type: 'input', data: 'printf "%s\\n" "$JAVA_HOME" "$ANDROID_HOME" > inherited-env\r' })); await until(() => fs.existsSync(path.join(config.defaultCwd, 'inherited-env')));
    assert.equal(fs.readFileSync(path.join(config.defaultCwd, 'inherited-env'), 'utf8'), '/synthetic/jdk\n/synthetic/android\n');
    // Standard SSH/tmux prefix detach sequence also works through a browser attachment.
    w.send(JSON.stringify({ type: 'input', data: '\x02d' })); await until(() => w.readyState === WebSocket.CLOSED);
    service.kill('SIGHUP'); await until(() => fs.existsSync(path.join(config.dataDir, 'web.pid')) && Number(fs.readFileSync(path.join(config.dataDir, 'web.pid'), 'utf8')) !== firstBackend); await ready();
    const secondBackend = Number(fs.readFileSync(path.join(config.dataDir, 'web.pid'), 'utf8'));
    assert.equal(execFileSync('tmux', ['-L', config.tmuxSocket, 'display-message', '-p', '-t', `=pt_${job}:0.0`, '#{pane_pid}']).toString().trim(), panePid);
    assert.equal((await req(config.origin, '/api/sessions', 'GET', undefined, headers)).body.sessions.find((s: any) => s.id === job).state, 'running');
    // A killed backend is recovered by the supervisor, not by a benchmark process restart.
    process.kill(secondBackend, 'SIGKILL'); await until(() => fs.existsSync(path.join(config.dataDir, 'web.pid')) && Number(fs.readFileSync(path.join(config.dataDir, 'web.pid'), 'utf8')) !== secondBackend, 7000); await ready();
    measurements.push({ phase: 'after_explicit_reliability_restarts', supervisor: procMemory(service.pid!), node: procMemory(Number(fs.readFileSync(path.join(config.dataDir, 'web.pid'), 'utf8'))) });
    const tmuxPid = Number(execFileSync('tmux', ['-L', config.tmuxSocket, 'display-message', '-p', '#{pid}']).toString());
    for (const pid of [tmuxPid, Number(panePid)]) {
      const targets = fs.readdirSync(`/proc/${pid}/fd`).map(fd => { try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ''; } });
      assert.ok(!targets.some(target => target.endsWith('/service.lock')), 'Persistent tmux/shell inherited the supervisor lock');
    }
    await stop(service); assert.equal(service.exitCode, 0);
    execFileSync('tmux', ['-L', config.tmuxSocket, 'has-session', '-t', `=pt_${job}`]);
    service = launch(); await ready(); assert.ok(service.pid);
    assert.equal(execFileSync('tmux', ['-L', config.tmuxSocket, 'display-message', '-p', '-t', `=pt_${job}:0.0`, '#{pane_pid}']).toString().trim(), panePid);
    fs.writeFileSync(path.join(ROOT, '.runtime/evidence/service-reliability.json'), JSON.stringify({ result: 'PASS', minimalEnvironment: true, jobSurvivedHupKillAndStop: true, noPersistentJobLockFds: true, lockReused: true, standardTmuxDetach: true, measuredOutsideBenchmark: true, measurements }, null, 2), { mode: 0o600 });
  } finally { await stop(service); cleanupTmux(config); }
});
