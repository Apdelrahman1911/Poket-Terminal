import { fork, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Config, ROOT } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { Auth } from '../src/server/auth.js';
import { cleanupTmux, configEnv, delay, TEST_PASSWORD, testConfig } from './helpers.js';

export async function production(name: string, supplied?: Config, options: { initialize?: boolean } = {}) {
  const config = supplied || await testConfig(name);
  const store = new Store(config.dataDir); if (options.initialize !== false) await new Auth(store).setPassword(TEST_PASSWORD, 'init'); store.close();
  const log = fs.createWriteStream(path.join(config.dataDir, 'backend.log'), { mode: 0o600 });
  const child = fork(path.join(ROOT, 'dist/server/index.js'), [], { cwd: ROOT, env: configEnv(config), execArgv: ['--max-old-space-size=96'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.pipe(log); child.stderr!.pipe(log, { end: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Production test backend startup timed out; inspect private backend.log')); }, 10000);
    const ready = (data: Buffer) => { if (data.toString().includes('"event":"ready"')) { clearTimeout(timer); child.stdout!.off('data', ready); resolve(); } };
    child.stdout!.on('data', ready); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Production backend exited ${code}`)); });
  });
  let measuring = false;
  const measure = async (): Promise<any> => {
    if (measuring) throw new Error('Only one measurement IPC request may be pending'); measuring = true;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', listener); reject(new Error('IPC measurement timeout')); }, 4000);
        const listener = (m: any) => { if (m.type === 'measurement') { clearTimeout(timer); child.off('message', listener); resolve(m); } };
        child.on('message', listener); child.send({ type: 'measure' });
      });
    } finally { measuring = false; }
  };
  let closure: Promise<{ graceful: boolean; exitCode: number | null; signal: NodeJS.Signals | null; durationMs: number }> | undefined;
  const close = () => closure ??= (async () => {
    const start = Date.now(); let forced = false;
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM');
      const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000); await exit; clearTimeout(timer);
    }
    log.end(); cleanupTmux(config);
    const result = { graceful: !forced && child.exitCode === 0 && child.signalCode === null, exitCode: child.exitCode, signal: child.signalCode, durationMs: Date.now() - start };
    fs.writeFileSync(path.join(config.dataDir, 'backend-close.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  })();
  return { config, child, measure, close };
}
