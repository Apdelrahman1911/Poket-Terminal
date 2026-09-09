import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { ROOT } from '../src/server/config.js';
import { testConfig, delay, until } from './helpers.js';

function start(dir: string, code: string, args: string[] = []) {
  return spawn('python3', ['-I', path.join(ROOT, 'scripts/supervisor.py'), dir, 'python3', '-u', '-c', code, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 12000); await done; clearTimeout(timer);
}
const events = (dir: string) => fs.readFileSync(path.join(dir, 'service.log'), 'utf8').trim().split('\n').filter(s => s.startsWith('{')).map(s => JSON.parse(s));

test('Supervisor: foreground single-instance lock is idempotent; SIGTERM forwarded, graceful exit and private files', async () => {
  const { dataDir } = await testConfig('supervisor-signals');
  const code = `import signal,time,sys,pathlib\np=pathlib.Path(sys.argv[1])\ndef term(s,f):\n p.write_text(str(s));sys.exit(0)\nsignal.signal(signal.SIGTERM,term)\nprint('synthetic-ready',flush=True)\nwhile True: time.sleep(.1)`;
  const marker = path.join(dataDir, 'signal.txt'), first = start(dataDir, code, [marker]);
  try {
    await until(() => fs.existsSync(path.join(dataDir, 'web.pid')) && fs.readFileSync(path.join(dataDir, 'service.log'), 'utf8').includes('synthetic-ready'));
    const pid = fs.readFileSync(path.join(dataDir, 'web.pid'), 'utf8');
    const duplicate = start(dataDir, code, [marker]); const exit = await new Promise<number | null>(resolve => duplicate.once('exit', resolve)); assert.equal(exit, 0);
    assert.equal(fs.readFileSync(path.join(dataDir, 'web.pid'), 'utf8'), pid);
    assert.equal(fs.statSync(path.join(dataDir, 'service.log')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'service.lock')).mode & 0o777, 0o600);
    await stop(first); assert.equal(first.exitCode, 0); assert.equal(fs.readFileSync(marker, 'utf8'), '15'); assert.equal(fs.existsSync(path.join(dataDir, 'web.pid')), false);
    assert.equal(events(dataDir).filter(e => e.event === 'child_start').length, 1);
  } finally { await stop(first); }
});
test('Supervisor: crash backoff, normal-exit restart, SIGHUP restart and no restart on intentional shutdown', async () => {
  const { dataDir } = await testConfig('supervisor-backoff');
  const code = `import pathlib,sys,time\np=pathlib.Path(sys.argv[1]);n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))\nif n<3: sys.exit(7 if n==1 else 0)\nwhile True: time.sleep(.1)`;
  const child = start(dataDir, code, [path.join(dataDir, 'count')]);
  try {
    await until(() => fs.existsSync(path.join(dataDir, 'count')) && Number(fs.readFileSync(path.join(dataDir, 'count'), 'utf8')) >= 3, 7000);
    const waits = events(dataDir).filter(e => e.event === 'restart_wait'); assert.deepEqual(waits.map(e => e.seconds), [1, 2]);
    child.kill('SIGHUP'); await until(() => Number(fs.readFileSync(path.join(dataDir, 'count'), 'utf8')) >= 4);
    await stop(child); const count = Number(fs.readFileSync(path.join(dataDir, 'count'), 'utf8')); await delay(200); assert.equal(Number(fs.readFileSync(path.join(dataDir, 'count'), 'utf8')), count);
    assert.equal(events(dataDir).at(-1).event, 'supervisor_stop');
  } finally { await stop(child); }
});
test('Supervisor: bounded log rotation keeps at most three 1 MiB files', async () => {
  const { dataDir } = await testConfig('supervisor-logs');
  const code = `import sys,time\nfor _ in range(400): print('synthetic-log-'+'x'*8192,flush=True)\nwhile True: time.sleep(.1)`;
  const child = start(dataDir, code);
  try {
    await until(() => fs.existsSync(path.join(dataDir, 'service.log.2'))); await delay(200); await stop(child);
    const logs = fs.readdirSync(dataDir).filter(n => /^service\.log/.test(n)); assert.equal(logs.length, 3);
    for (const file of logs) { assert.ok(fs.statSync(path.join(dataDir, file)).size <= 1024 * 1024); assert.equal(fs.statSync(path.join(dataDir, file)).mode & 0o777, 0o600); }
  } finally { await stop(child); }
});
test('Supervisor: parent death terminates backend; inherited lock prevents a duplicate during teardown', async () => {
  const { dataDir } = await testConfig('supervisor-parent-death');
  const code = `import signal,time,pathlib,sys\ndef term(s,f): pathlib.Path(sys.argv[1]).write_text('parent-death');sys.exit(0)\nsignal.signal(signal.SIGTERM,term)\nprint('ready',flush=True)\nwhile True: time.sleep(.1)`;
  const marker = path.join(dataDir, 'death'), child = start(dataDir, code, [marker]);
  try {
    await until(() => fs.existsSync(path.join(dataDir, 'service.log')) && fs.readFileSync(path.join(dataDir, 'service.log'), 'utf8').includes('ready'));
    const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await done;
    await until(() => fs.existsSync(marker)); assert.equal(fs.readFileSync(marker, 'utf8'), 'parent-death');
    const next = start(dataDir, 'import time; print("new-ready",flush=True); time.sleep(30)');
    try { await until(() => fs.readFileSync(path.join(dataDir, 'service.log'), 'utf8').includes('new-ready')); } finally { await stop(next); }
  } finally { await stop(child); }
});
