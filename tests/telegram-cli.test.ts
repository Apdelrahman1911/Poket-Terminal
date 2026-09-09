import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { ROOT } from '../src/server/config.js';
import { testConfig, configEnv, until } from './helpers.js';
import { dummyState, fakeTelegram, message, OWNER } from './telegram-fake.js';
const exec = promisify(execFile);

test('Compiled private CLI: TTY pairing, local confirmation, status/disable/revoke, non-TTY rejection (fake API only)', async () => {
  const config = await testConfig('tg-cli'), state = dummyState(config), fake = await fakeTelegram();
  const program = path.join(ROOT, 'dist/server/telegram-cli.js');
  assert(fs.existsSync(program), 'Run this focused CLI test in the freshly compiled isolated stage, not live dist');
  const env = { ...configEnv(config), PT_TEST_TELEGRAM_API: fake.endpoint } as Record<string, string>;
  let terminal: pty.IPty | undefined;
  try {
    await assert.rejects(exec(process.execPath, [program, 'pair'], { env, timeout: 5000 }), /Command failed/);
    assert.equal(fake.calls.length, 0);
    const initial = await exec(process.execPath, [program, 'status'], { env }); assert.match(initial.stdout, /DISABLED/);
    terminal = pty.spawn(process.execPath, [program, 'pair'], { cwd: ROOT, env, cols: 120, rows: 40 });
    let output = '', paired = false, bound = false, sentCode = false, exited: number | undefined;
    const subscription = terminal.onData(chunk => {
      output = (output + chunk).slice(-8192); // bounded synthetic fixture only
      if (!paired && output.includes('Type exactly PAIR:')) { paired = true; terminal!.write('PAIR\r'); }
      const code = /\/pair ([A-Za-z0-9_-]{43})/.exec(output)?.[1];
      if (code && !sentCode) { sentCode = true; fake.enqueue(message(100, '/pair ' + code)); }
      if (!bound && output.includes(`Type exactly BIND ${OWNER} ${OWNER}:`)) { bound = true; terminal!.write(`BIND ${OWNER} ${OWNER}\r`); }
    });
    const exit = terminal.onExit(event => { exited = event.exitCode; });
    await until(() => exited !== undefined, 10000);
    subscription.dispose(); exit.dispose(); terminal = undefined;
    assert.equal(exited, 0); assert(paired && sentCode && bound); assert.equal(state.control()!.enabled, true);
    const status = await exec(process.execPath, [program, 'status'], { env }); assert.match(status.stdout, /enabled configuration/);
    await exec(process.execPath, [program, 'disable'], { env }); assert.equal(state.control()!.enabled, false); assert.equal(state.control()!.owner!.userId, OWNER);
    await exec(process.execPath, [program, 'revoke'], { env }); assert.equal(state.control()!.owner, undefined);
  } finally { if (terminal) { try { terminal.kill('SIGKILL'); } catch {} } await fake.close(); }
});
