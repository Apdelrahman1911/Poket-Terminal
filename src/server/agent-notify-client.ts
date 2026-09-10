import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LIMITS, agentRequest, type AgentRequest, type AgentReceipt } from './agent-notices.js';

// No config/token/SQLite reads and no HTTP client. This helper can only speak
// the small local protocol; the running bot chooses its existing bound owner.
export function notifyLocal(socketPath: string, request: AgentRequest): Promise<AgentReceipt> {
  agentRequest(request);
  const payload = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(payload) > AGENT_LIMITS.requestBytes) return Promise.reject(new Error('request_too_large'));
  const dir = fs.lstatSync(path.dirname(socketPath)), file = fs.lstatSync(socketPath);
  if (!path.isAbsolute(socketPath) || !dir.isDirectory() || dir.uid !== process.geteuid?.() || (dir.mode & 0o777) !== 0o700
    || !file.isSocket() || file.uid !== process.geteuid?.() || (file.mode & 0o777) !== 0o600) throw new Error('unsafe_socket');
  return new Promise(resolve => {
    let done = false, written = false, used = 0;
    const buffer = Buffer.alloc(AGENT_LIMITS.replyBytes);
    const socket = new net.Socket();
    const finish = (receipt: AgentReceipt) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(receipt); };
    const lost = () => finish(written ? { status: 'uncertain', code: 'delivery_unknown' } : { status: 'rejected', code: 'not_connected' });
    const timer = setTimeout(lost, AGENT_LIMITS.clientMs); timer.unref();
    socket.once('connect', () => { written = true; socket.write(payload); });
    socket.on('error', lost); socket.once('close', lost);
    socket.on('data', (chunk: Buffer) => {
      if (used + chunk.length > buffer.length) { lost(); return; }
      chunk.copy(buffer, used); used += chunk.length;
      const end = buffer.subarray(0, used).indexOf(10);
      if (end < 0) return;
      if (end !== used - 1) { lost(); return; }
      try {
        const result = JSON.parse(buffer.subarray(0, end).toString('utf8')) as AgentReceipt;
        if (!result || !['sent', 'rejected', 'uncertain'].includes(result.status) || typeof result.code !== 'string' || !/^[a-z_]{1,80}$/.test(result.code)
          || (result.status === 'sent' && result.code !== 'telegram_accepted')) throw new Error('invalid_receipt');
        finish({ status: result.status, code: result.code });
      } catch { lost(); }
    });
    socket.connect(socketPath);
  });
}

export function agentArguments(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  let session: string | undefined, unlinked = false, stdin = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--session' && !session && !unlinked) { session = args[++i]; if (!session) throw new Error('usage'); }
    else if (arg === '--unlinked' && !unlinked && !session) unlinked = true;
    else if (arg === '--stdin' && !stdin) stdin = true;
    else if (arg.startsWith('--')) throw new Error('usage');
    else positional.push(arg);
  }
  if (positional.length !== (stdin ? 1 : 2)) throw new Error('usage');
  const request: Record<string, unknown> = { kind: positional[0], text: stdin ? '(stdin)' : positional[1] };
  if (session) request.session = session;
  // Verify full tmux identity for inherited live terminals, including old jobs.
  else if (!unlinked && env.TMUX && env.TMUX_PANE) {
    const match = /^(\/[^\n\t]+),(\d+),\d+$/.exec(env.TMUX);
    if (!match) throw new Error('invalid_terminal_context');
    request.tmux = { socket: match[1], pid: Number(match[2]), pane: env.TMUX_PANE };
  } else if (!unlinked && env.PT_SESSION_ID) request.session = env.PT_SESSION_ID;
  else request.project = path.basename(cwd).slice(0, 80) || 'root';
  return { request: agentRequest(request), stdin };
}
