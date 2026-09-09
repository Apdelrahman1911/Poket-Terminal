// Schema v1 is also exported verbatim in docs/schema-v1.sql. Future changes require a new migration.
export const APPLICATION_ID = 0x50544d31;
export const SCHEMA_V1 = `
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 20 AND 512),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX auth_expiry ON auth_sessions(expires_at);
CREATE TABLE terminals (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^a-f0-9]*'),
  tmux_name TEXT NOT NULL UNIQUE CHECK (length(tmux_name) = 35 AND tmux_name = 'pt_' || id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('shell', 'codex')),
  cwd TEXT NOT NULL CHECK (length(cwd) BETWEEN 1 AND 4096 AND substr(cwd, 1, 1) = '/'),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopped')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stopped_reason TEXT CHECK (length(stopped_reason) <= 80)
) STRICT;
CREATE INDEX terminal_state ON terminals(state);
CREATE INDEX terminal_catalog ON terminals(created_at DESC, id);
CREATE TABLE metadata (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (length(value) <= 256)
) STRICT;
`;
export const MIGRATIONS = [{ version: 1, sql: SCHEMA_V1 }] as const;
