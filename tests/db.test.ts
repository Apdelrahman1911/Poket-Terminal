import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, migrate, validateSchema } from '../src/server/db.js';
import { SCHEMA_V1 } from '../src/server/schema.js';
import { ROOT } from '../src/server/config.js';
import { testConfig } from './helpers.js';
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

test('SQLite: fresh schema equals exported schema, version and root-only DB/WAL/SHM permissions', async () => {
  const config = await testConfig('db-fresh'), store = new Store(config.dataDir), reference = new DatabaseSync(':memory:');
  try {
    assert.equal(fs.readFileSync(path.join(ROOT, 'docs/schema-v1.sql'), 'utf8'), SCHEMA_V1);
    reference.exec(SCHEMA_V1); assert.deepEqual(schema(store.db), schema(reference)); validateSchema(store.db);
    store.db.prepare("INSERT INTO metadata VALUES('sample','synthetic')").run();
    assert.equal(fs.statSync(config.dataDir).mode & 0o777, 0o700);
    for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.statSync(store.file + suffix).mode & 0o777, 0o600);
  } finally { reference.close(); store.close(); }
});
test('SQLite: synthetic rows and constraints survive reopen/migration', async () => {
  const config = await testConfig('db-preserve'); let store = new Store(config.dataDir);
  store.db.exec("INSERT INTO owner VALUES(1,'synthetic-not-a-real-hash',1,0); INSERT INTO metadata VALUES('fixture','kept')");
  assert.throws(() => store.db.exec("INSERT INTO owner VALUES(2,'synthetic-not-a-real-hash',1,0)"));
  assert.throws(() => store.db.exec("INSERT INTO auth_sessions VALUES('plaintext',1,1,2)"));
  assert.throws(() => store.db.exec("INSERT INTO terminals VALUES('bad','bad','x','shell','/a','running',1,1,NULL)"));
  store.close(); store = new Store(config.dataDir);
  try { assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='fixture'").get()!.value, 'kept'); assert.equal(store.db.prepare('SELECT count(*) n FROM owner').get()!.n, 1); } finally { store.close(); }
});
test('SQLite: injected transactional migration failure rolls back every DDL/version change', () => {
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => migrate(db, () => { throw new Error('injected'); }), /injected/); assert.deepEqual(schema(db), []); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0); migrate(db); validateSchema(db); } finally { db.close(); }
});
test('SQLite: corrupt database is rejected without deletion or destructive recovery', async () => {
  const config = await testConfig('db-corrupt'), file = path.join(config.dataDir, 'pocketterminal.sqlite');
  fs.writeFileSync(file, 'NOT A SQLITE DATABASE\0synthetic recovery evidence', { mode: 0o600 }); const before = digest(file);
  assert.throws(() => new Store(config.dataDir)); assert.equal(digest(file), before);
});
test('SQLite: unrecognized nonempty schema and unexpected version rejected intact', async () => {
  for (const sql of ['CREATE TABLE unrelated(x TEXT)', 'PRAGMA user_version=9', 'PRAGMA application_id=42', SCHEMA_V1 + '; PRAGMA user_version=1; PRAGMA application_id=1347702065; ALTER TABLE metadata ADD COLUMN surprise TEXT;']) {
    const config = await testConfig('db-unexpected'), file = path.join(config.dataDir, 'pocketterminal.sqlite');
    const db = new DatabaseSync(file); db.exec(sql); db.close(); const before = digest(file);
    assert.throws(() => new Store(config.dataDir)); assert.equal(digest(file), before);
  }
});
test('SQLite: online WAL backup is consistent, private, recoverable and never overwrites', async () => {
  const config = await testConfig('db-backup'), store = new Store(config.dataDir);
  try {
    store.transaction(() => { for (let i = 0; i < 100; i++) store.db.prepare('INSERT INTO metadata VALUES(?,?)').run(`row-${i}`, `value-${i}`); });
    const file = path.join(config.dataDir, 'backups/consistent.sqlite'); await store.backupTo(file);
    const restoredDir = path.join(config.dataDir, 'restore'); fs.mkdirSync(restoredDir, { mode: 0o700 }); fs.copyFileSync(file, path.join(restoredDir, 'pocketterminal.sqlite'));
    const restored = new Store(restoredDir);
    try { validateSchema(restored.db); assert.deepEqual(restored.db.prepare('SELECT * FROM metadata ORDER BY key').all(), store.db.prepare('SELECT * FROM metadata ORDER BY key').all()); } finally { restored.close(); }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    await assert.rejects(store.backupTo(file), /already exists/);
  } finally { store.close(); }
});
test('SQLite: representative query plans use bounded metadata/auth indexes; no transcript schema', async () => {
  const config = await testConfig('db-indexes'), store = new Store(config.dataDir);
  try {
    const queries = ["SELECT * FROM auth_sessions WHERE token_hash='x'", 'DELETE FROM auth_sessions WHERE expires_at<=1', "SELECT count(*) FROM terminals WHERE state IN ('starting','running')", 'SELECT * FROM terminals ORDER BY created_at DESC,id LIMIT 100'];
    const plans = queries.map(sql => ({ sql, plan: store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all() }));
    assert.match(JSON.stringify(plans), /sqlite_autoindex_auth_sessions_1/); assert.match(JSON.stringify(plans), /auth_expiry/); assert.match(JSON.stringify(plans), /terminal_state/); assert.match(JSON.stringify(plans), /terminal_catalog/);
    assert.doesNotMatch(SCHEMA_V1, /transcript|terminal_output|scrollback/i);
    fs.writeFileSync(path.join(ROOT, '.runtime/evidence/query-plans.json'), JSON.stringify(plans, null, 2), { mode: 0o600 });
  } finally { store.close(); }
});
