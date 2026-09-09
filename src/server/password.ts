import { createInterface } from 'node:readline';
import { configFromEnv } from './config.js';
import { Store } from './db.js';
import { Auth } from './auth.js';

function hidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(value); value = '';
    };
    const onData = (data: string) => {
      for (const char of data) {
        if (char === '\u0003' || char === '\u0004') return finish(new Error('Cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ' && char !== '\u001b' && Buffer.byteLength(value + char) <= 256) value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function main() {
  process.umask(0o077);
  const mode = process.argv[2];
  if (!['init', 'reset'].includes(mode || '') || process.argv.length !== 3 || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use a private interactive SSH TTY: npm run password -- init|reset. No password arguments or environment variables.');
  const store = new Store(configFromEnv().dataDir);
  try {
    process.stdout.write('Root terminal access: use a unique, strong password (16+ characters; 3 character classes, or a 24+ character varied passphrase). Input is hidden.\n');
    const first = await hidden('New owner password: '), second = await hidden('Confirm password: ');
    if (first !== second) throw new Error('Passwords do not match; unchanged.');
    await new Auth(store).setPassword(first, mode as 'init' | 'reset');
    process.stdout.write('Owner password updated privately. All web logins revoked; jobs preserved. Running service detects reset within one second.\n');
  } finally { store.close(); }
}
main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Password update failed') + '\n'); process.exitCode = 1; });
