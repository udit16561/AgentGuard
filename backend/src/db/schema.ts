/**
 * SQLite schema, written to port to PostgreSQL: TEXT ids, INTEGER epoch-millisecond times, JSON stored as TEXT.
 * audit_events has no blocking trigger in the prototype (docs/DECISIONS.md B); append-only is enforced by the
 * absence of update/delete routes and by the hash chain.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entitlements TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  kill_switch INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  reauth_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  model TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  encrypted_token TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'MOCK',
  connected_at INTEGER NOT NULL,
  UNIQUE (user_id, tool)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  tool TEXT NOT NULL,
  operation TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  limits TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, tool, operation)
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  tool TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  intent TEXT,
  risk_level TEXT,
  risk_score INTEGER,
  confidence REAL,
  risk_reasons TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_user_status ON actions (user_id, status);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  reauth_used INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  used_at INTEGER,
  decided_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  adapter_mode TEXT NOT NULL,
  provider_ref TEXT,
  result TEXT,
  error TEXT,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  action_id TEXT,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_events (user_id, seq);
`;
