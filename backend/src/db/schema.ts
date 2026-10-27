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
  kind TEXT NOT NULL DEFAULT 'external',
  paused_by_plan INTEGER NOT NULL DEFAULT 0,
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
  live_state TEXT,
  live_since INTEGER,
  connected_at INTEGER NOT NULL,
  UNIQUE (user_id, tool)
);

-- live OAuth (v0.8.0): one row per consent attempt; single use, 10 minutes, tied to the browser that started it
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tool TEXT NOT NULL,
  verifier_enc TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
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
  replaces_id TEXT,
  preference_check TEXT,
  adapter_mode TEXT NOT NULL DEFAULT 'MOCK',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_user_status ON actions (user_id, status);

CREATE TABLE IF NOT EXISTS tool_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tool TEXT NOT NULL,
  text TEXT NOT NULL,
  rules TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, tool)
);

-- bring your own model (docs/MODEL_PROVIDERS.md): keys are AES-256-GCM encrypted; only the last 4 characters are kept in clear
CREATE TABLE IF NOT EXISTS model_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  api_key_enc TEXT,
  key_last4 TEXT,
  last_test_at INTEGER,
  last_test_ok INTEGER,
  guard_capable INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  model_config_id TEXT REFERENCES model_configs(id),
  monthly_cap_usd REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT,
  model_config_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_usage_user ON model_usage (user_id, role, created_at);

-- Web Push devices (v0.6.0): one row per push-service endpoint
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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
