import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AGENT_LIMITS, agentRequest } from './agent-notices.js';
import { agentArguments, notifyLocal } from './agent-notify-client.js';

const usage = `Usage: pocketterminal-notify progress|blocked|question|done|error "short message"
       pocketterminal-notify question --stdin
Options: --session EXACT_SESSION_ID, or --unlinked (no target controls).
Uses the bound Telegram owner on this VPS. No tokens or recipients are accepted.
Messages: <=2000 UTF-8 bytes; important, non-secret updates only. No automatic retries.
Success means Telegram accepted the message, not that the phone read it.
`;
async function readStdin() {
  return new Promise<string>((resolve, reject) => {
    const buffer = Buffer.alloc(AGENT_LIMITS.textBytes); let used = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer); process.stdin.pause(); process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', fail);
      if (error) reject(error); else resolve(buffer.subarray(0, used).toString('utf8').replace(/\r\n/g, '\n'));
    };
    const data = (chunk: Buffer) => { if (used + chunk.length > buffer.length) { finish(new Error('message_too_large')); return; } chunk.copy(buffer, used); used += chunk.length; };
    const end = () => finish();
    const fail = () => finish(new Error('stdin_unavailable'));
    const timer = setTimeout(fail, 5000); timer.unref();
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', fail);
  });
}
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') { process.stdout.write(usage); return; }
  const parsed = agentArguments(process.argv.slice(2), process.env, process.cwd());
  if (parsed.stdin) parsed.request.text = await readStdin();
  agentRequest(parsed.request);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const socket = process.env.PT_NOTIFY_SOCKET || path.join(process.env.PT_DATA_DIR || path.join(root, '.runtime/production'), 'agent-notify.sock');
  const receipt = await notifyLocal(socket, parsed.request);
  if (receipt.status === 'sent') process.stdout.write('Telegram accepted the agent update (not a read receipt).\n');
  else {
    process.stderr.write(receipt.status === 'uncertain' ? 'Delivery unknown. Do not automatically retry.\n' : `Update not sent: ${receipt.code}. Do not automatically retry; report this in the terminal.\n`);
    process.exitCode = receipt.status === 'uncertain' ? 2 : 1;
  }
}
main().catch(() => { process.stderr.write('Notification unavailable or invalid input; no message/credentials logged. Use pocketterminal-notify --help. Do not automatically retry.\n'); process.exitCode = 1; });
