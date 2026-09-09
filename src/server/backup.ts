import path from 'node:path';
import { configFromEnv } from './config.js';
import { Store } from './db.js';
async function main() {
  process.umask(0o077);
  const config = configFromEnv(), store = new Store(config.dataDir);
  try {
    const name = `pocketterminal-${new Date().toISOString().replaceAll(':', '-')}.sqlite`;
    const file = path.join(config.dataDir, 'backups', name);
    await store.backupTo(file); process.stdout.write(`Verified private SQLite backup: ${file}\n`);
  } finally { store.close(); }
}
main().catch(() => { process.stderr.write('Backup failed; existing database preserved.\n'); process.exitCode = 1; });
