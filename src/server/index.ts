import { configFromEnv } from './config.js';
import { createApp } from './app.js';
import fs from 'node:fs';

async function main() {
  process.umask(0o077);
  const config = configFromEnv();
  const service = await createApp(config, config.testMode && process.env.PT_TEST_TELEGRAM_API ? { telegram: { endpoint: process.env.PT_TEST_TELEGRAM_API } } : undefined);
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    try { await service.close(); if (process.connected) process.disconnect(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  // Test instrumentation exists only over the parent's private IPC fd in isolated test mode, never an HTTP endpoint.
  if (config.testMode && process.send) process.on('message', (m: unknown) => {
    if (m && typeof m === 'object' && (m as { type: string }).type === 'measure') {
      const handles = (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles().reduce<Record<string, number>>((out, h) => { const name = h.constructor.name; out[name] = (out[name] || 0) + 1; return out; }, {});
      const ptyFds = fs.readdirSync('/proc/self/fd').filter(fd => {
        try { return /^\/dev\/(pts\/)?ptmx$/.test(fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { return false; }
      }).length;
      process.send?.({ type: 'measurement', ...service.stats(), handles, ptyFds });
    }
  });
  await service.app.listen({ host: config.host, port: config.port });
  process.stdout.write(JSON.stringify({ event: 'ready', pid: process.pid, bind: config.host, port: config.port, ownerInitialized: service.auth.initialized() }) + '\n');
}
main().catch(() => { process.stderr.write('{"event":"startup_failed","detail":"Check app state/schema/config; no destructive recovery attempted"}\n'); process.exitCode = 1; });
