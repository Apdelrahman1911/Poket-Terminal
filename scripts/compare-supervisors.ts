import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { ROOT } from '../src/server/config.js';
import { testConfig, configEnv, cleanupTmux, delay, until } from '../tests/helpers.js';
import { descendants, procMemory, sumMemory, summary } from './memory.js';
process.umask(0o077);
const evidence = path.join(ROOT, '.runtime/evidence/supervisor-comparison'); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const healthy = (origin: string) => new Promise<boolean>(resolve => { const req = https.get(origin + '/health', { rejectUnauthorized: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); }); req.on('error', () => resolve(false)); });
const results: any[] = [];
for (const kind of ['python', 'pm2'] as const) {
  const config = await testConfig(`compare-${kind}`);
  const env = Object.fromEntries(Object.entries(configEnv(config)).filter(([k, v]) => k.startsWith('PT_') && v !== undefined)) as Record<string, string>;
  env.HOME = '/root'; env.PATH = '/usr/bin:/bin'; env.PM2_HOME = path.join(config.dataDir, 'pm2-home'); env.PM2_DISABLE_AGENT = 'true';
  const ecosystem = path.join(config.dataDir, 'ecosystem.config.cjs');
  fs.writeFileSync(ecosystem, `module.exports={apps:[{name:'pocketterminal-comparison',cwd:${JSON.stringify(ROOT)},script:'dist/server/index.js',interpreter:${JSON.stringify(process.execPath)},node_args:'--max-old-space-size=96',instances:1,exec_mode:'fork',autorestart:true,watch:false,exp_backoff_restart_delay:1000,merge_logs:true,out_file:${JSON.stringify(path.join(config.dataDir, 'pm2-app.log'))},error_file:${JSON.stringify(path.join(config.dataDir, 'pm2-error.log'))}}]};\n`, { mode: 0o600 });
  const child = kind === 'python'
    ? spawn(path.join(ROOT, 'scripts/service.sh'), [], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('/bin/bash', ['-c', 'source scripts/runtime-env.sh; exec node node_modules/pm2/bin/pm2-runtime start "$1" --raw', 'comparison', ecosystem], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(evidence, `${kind}-runtime.log`), { mode: 0o600 }); child.stdout!.pipe(log); child.stderr!.pipe(log, { end: false });
  let knownPids: number[] = [];
  try {
    await until(() => healthy(config.origin), 15000, `${kind} supervisor failed to start`);
    await delay(10000);
    const appLog = fs.readFileSync(path.join(config.dataDir, kind === 'python' ? 'service.log' : 'pm2-app.log'), 'utf8');
    const nodePid = Number([...appLog.matchAll(/"event":"ready","pid":(\d+)/g)].at(-1)?.[1]);
    if (!nodePid) throw new Error(`No application PID for ${kind}`);
    const records = [];
    for (let i = 0; i < 16; i++) {
      knownPids = [child.pid!, ...descendants(child.pid!)];
      const supervisorPids = knownPids.filter(pid => pid !== nodePid);
      const row = { at: new Date().toISOString(), supervisor: sumMemory(supervisorPids), app: procMemory(nodePid), rootPid: child.pid, appPid: nodePid };
      records.push(row); fs.appendFileSync(path.join(evidence, `${kind}-samples.jsonl`), JSON.stringify(row) + '\n'); await delay(2000);
    }
    const mb = (n: number) => n / 1048576;
    results.push({ kind, warmupSeconds: 10, measurementSeconds: 30, flags: '--max-old-space-size=96', separateFromMainBenchmark: true, supervisorRssMiB: summary(records.map(r => mb(r.supervisor.rss))), supervisorPssMiB: summary(records.map(r => mb(r.supervisor.pss))), applicationRssMiB: summary(records.map(r => mb(r.app.rss))), applicationPssMiB: summary(records.map(r => mb(r.app.pss))), supervisorProcesses: records.at(-1)!.supervisor.processes, appPid: nodePid });
  } finally {
    const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); await done; clearTimeout(timer);
    for (const pid of knownPids) { if (pid === child.pid) continue; try { process.kill(pid, 0); process.kill(pid, 'SIGTERM'); } catch { /* already reaped */ } }
    cleanupTmux(config); log.end();
  }
}
fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ result: 'MEASURED', runtime: 'Python 3.12 vs pinned PM2 7.0.4; both foreground, separate isolated state; production compiled backend and identical V8 heap cap; no forced GC', chosen: 'python', reliabilityEvidence: '../service-reliability.json and supervisor test suite', results }, null, 2));
console.log(JSON.stringify(results, null, 2));
