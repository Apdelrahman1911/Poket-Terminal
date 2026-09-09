import { configFromEnv } from './config.js';
import { TelegramState } from './telegram-state.js';
import { TelegramApi } from './telegram-api.js';
import { privateSetup } from './telegram-pair.js';

function confirmation(prompt: string, expected: string, signal: AbortSignal): Promise<boolean> {
  process.stdout.write(`${prompt}\nType exactly ${expected}: `);
  return new Promise((resolve, reject) => {
    let value = '', done = false;
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const finish = (cancel = false) => {
      if (done) return; done = true;
      process.stdin.off('data', data); signal.removeEventListener('abort', cancelRead);
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (cancel) reject(new Error('Setup cancelled/expired.')); else resolve(value === expected);
      value = '';
    };
    const data = (text: string) => {
      for (const c of text) {
        if (c === '\u0003' || c === '\u0004') return finish(true);
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ' && c <= '~' && value.length < 128) value += c;
      }
    };
    const cancelRead = () => finish(true);
    process.stdin.on('data', data); signal.addEventListener('abort', cancelRead, { once: true });
    if (signal.aborted) cancelRead();
  });
}
async function main() {
  process.umask(0o077);
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['pair', 'enable', 'status', 'disable', 'revoke'].includes(mode || '')) throw new Error('Usage: npm run telegram -- pair|enable|status|disable|revoke');
  const config = configFromEnv(), state = new TelegramState(config);
  if (mode === 'status') {
    const c = state.control();
    process.stdout.write(`Bot @${config.telegramBot?.username ?? '(not configured)'}: ${c?.enabled ? 'enabled configuration (not a live connectivity claim)' : 'DISABLED'}. ${c?.owner ? `Verified numeric user ${c.owner.userId}, private chat ${c.owner.chatId}.` : 'UNPAIRED; root controls unavailable.'}\n`);
    return;
  }
  if (mode === 'disable' || mode === 'revoke') {
    await state.withControlLock(() => state.disable(mode === 'revoke'));
    process.stdout.write(`Telegram DISABLED${mode === 'revoke' ? '; binding revoked' : ''}. Service cancels polling/pending actions and releases control within one second; already-committed effects may have occurred. Jobs are NOT stopped.\n`);
    return;
  }
  const endpoint = process.env.PT_TEST_TELEGRAM_API;
  if (config.testMode && !endpoint) throw new Error('Test setup requires a loopback fake Telegram API.');
  if (endpoint && !config.testMode) throw new Error('Fake Telegram API requires isolated test mode.');
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await privateSetup(state, mode as 'pair' | 'enable', {
      interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
      showCode: code => process.stdout.write(`PRIVATE, expires in five minutes. In your PRIVATE chat with @${config.telegramBot?.username ?? '(not configured)'}, send:\n/pair ${code}\nWaiting for matching private message; never paste this into a report.\n`),
      confirm: confirmation,
    }, token => new TelegramApi(token, endpoint ? { testMode: config.testMode, endpoint } : undefined), abort.signal);
    process.stdout.write('Verified binding saved; Telegram enabled. Use /sessions privately. Old/backlog buttons and commands will not run.\n');
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
main().catch(() => { process.stderr.write('Telegram setup unavailable/cancelled. Check private TTY, exact confirmation, secure app-owned files and expected bot; no credentials/errors were logged. Controls not newly enabled.\n'); process.exitCode = 1; });
