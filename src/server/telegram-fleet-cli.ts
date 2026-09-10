import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { configFromEnv } from './config.js';
import { FleetState, fleetRecord } from './telegram-fleet-state.js';
import { initializeFleet, addFleetWorker, joinFleet, enableFleetWorker, removeFleetWorker } from './telegram-fleet-setup.js';

async function main() {
  process.umask(0o077);
  const [mode, arg, file, ...extra] = process.argv.slice(2), config = configFromEnv();
  if (extra.length || !['init', 'add', 'join', 'enable', 'remove', 'status'].includes(mode || '')) throw new Error('usage');
  if (mode === 'status') {
    if (arg || file) throw new Error('usage');
    const fleet = new FleetState(config).load();
    process.stdout.write(!fleet ? 'Standalone bot. No fleet configured.\n' : fleet.role === 'worker'
      ? `Worker ${fleet.node.label} (${fleet.node.id}); controller ${fleet.controller}. No Telegram token/poller required.\n`
      : `Controller ${fleet.local.label} (${fleet.local.id}); ${fleet.workers.length} linked workers.\n${fleet.workers.map(w => `${w.label}: ${w.id}`).join('\n')}\n`);
    if (fleet?.role === 'controller') {
      const sample = new FleetState(config).status();
      if (fleetRecord(sample) && typeof sample.at === 'number' && Date.now() - sample.at < 20000 && Array.isArray(sample.nodes)) {
        process.stdout.write(`Recent controller sample: ${sample.status}; Telegram pollers: ${sample.telegramPollers}.\n`);
        for (const node of sample.nodes) if (fleetRecord(node)) process.stdout.write(`${node.label}: ${node.online === true ? 'online' : 'offline/reconnecting'}\n`);
      } else process.stdout.write('No recent runtime sample; configuration alone is not proof of connectivity.\n');
    }
    return;
  }
  if ((mode === 'add' && (!arg || !file)) || (['init', 'join', 'remove'].includes(mode!) && (!arg || file)) || (mode === 'enable' && (arg || file))) throw new Error('usage');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Private root SSH TTY required');
  const io = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('Fleet linking grants the controller\'s already-paired PRIVATE Telegram owner ROOT terminal control on linked VPSs. Invitations contain a private per-VPS credential, NOT a Telegram bot token. Do not paste invitations into chats/logs.\n');
    if (await io.question('Type exactly FLEET to confirm: ') !== 'FLEET') throw new Error('cancelled');
  } finally { io.close(); }
  if (mode === 'init') {
    await initializeFleet(config, arg!); process.stdout.write('Controller configured. Reload the web backend only; existing jobs stay running.\n');
  } else if (mode === 'add') {
    if (!path.isAbsolute(file!)) throw new Error('Private absolute invitation filename required');
    const parent = fs.lstatSync(path.dirname(file!));
    if (!parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error('Private invitation parent required');
    const node = await addFleetWorker(config, arg!, worker => {
      const fd = fs.openSync(file!, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(worker) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    });
    process.stdout.write(`Linked registry entry ${node.label} (${node.id}). Transfer the invitation privately to ONLY that VPS, run fleet join there, then remove transfer copies. The controller notices within one second.\n`);
  } else if (mode === 'join') {
    if (!path.isAbsolute(arg!)) throw new Error('Private absolute invitation filename required');
    const fd = fs.openSync(arg!, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let text: string;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.geteuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 4096) throw new Error('Unsafe invitation');
      const bytes = Buffer.alloc(4097), n = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (n > 4096) throw new Error('Invitation too large'); text = bytes.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
    const node = await joinFleet(config, JSON.parse(text));
    process.stdout.write(`Worker ${node.label} (${node.id}) configured. Reload ONLY the web backend, then delete invitation copies. Notifications from all workers are independent of /servers selection.\n`);
  } else if (mode === 'enable') { await enableFleetWorker(config); process.stdout.write('Worker enabled; connection/identity still verified by the controller. Jobs preserved.\n'); }
  else if (mode === 'remove') { await removeFleetWorker(config, arg!); process.stdout.write('Worker credential revoked on this controller. In-flight effects may have occurred; nothing retried. Jobs preserved.\n'); }
}
main().catch(() => { process.stderr.write('Fleet setup refused/cancelled. Check private TTY, safe files, paired owner, role and arguments. No credentials/errors were logged.\nUsage: npm run fleet -- init LABEL | add LABEL /private/invite.json | join /private/invite.json | enable | remove NODE_ID | status\n'); process.exitCode = 1; });
