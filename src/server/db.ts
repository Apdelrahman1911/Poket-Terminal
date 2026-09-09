import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { APPLICATION_ID, MIGRATIONS, SCHEMA_V1 } from './schema.js';

export function secureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) throw new Error('Unsafe state directory');
  fs.chmodSync(dir, 0o700);
}
function secureFile(file: string) {
  if (!fs.existsSync(file)) return;
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.nlink !== 1) throw new Error('Unsafe state file');
  fs.chmodSync(file, 0o600);
}
function schema(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
}
export function validateSchema(db: DatabaseSync) {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const id = Number((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id);
  if (version !== 1 || id !== APPLICATION_ID) throw new Error('Unsupported database identity/version; preserved without reset');
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(SCHEMA_V1);
    if (schema(db) !== schema(reference)) throw new Error('Unexpected schema; preserved without reset');
    const check = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') throw new Error('Database integrity failure; preserved without reset');
  } finally { reference.close(); }
}
export function migrate(db: DatabaseSync, afterMigration?: () => void) {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current === 0) {
    const identity = Number(db.prepare('PRAGMA application_id').get()!.application_id);
    if (identity !== 0) throw new Error('Unrecognized database identity; preserved without reset');
    if (schema(db) !== '[]') throw new Error('Unrecognized nonempty database; preserved without reset');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of MIGRATIONS) { db.exec(m.sql); afterMigration?.(); db.exec(`PRAGMA user_version = ${m.version}`); }
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  validateSchema(db);
}
export class Store {
  readonly db: DatabaseSync;
  readonly file: string;
  constructor(readonly dir: string) {
    secureDir(dir);
    this.file = path.join(dir, 'pocketterminal.sqlite');
    for (const suffix of ['', '-wal', '-shm']) secureFile(this.file + suffix);
    // Creating an empty app-owned file is permitted; an existing corrupt file is never deleted/reset.
    if (!fs.existsSync(this.file)) fs.closeSync(fs.openSync(this.file, 'wx', 0o600));
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      migrate(this.db);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=100; PRAGMA journal_size_limit=1048576;');
      for (const suffix of ['', '-wal', '-shm']) secureFile(this.file + suffix);
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  async backupTo(destination: string) {
    secureDir(path.dirname(destination));
    if (fs.existsSync(destination)) throw new Error('Backup destination already exists');
    fs.closeSync(fs.openSync(destination, 'wx', 0o600));
    await backup(this.db, destination);
    secureFile(destination);
    const check = new DatabaseSync(destination, { readOnly: true });
    try { validateSchema(check); } finally { check.close(); }
  }
}
