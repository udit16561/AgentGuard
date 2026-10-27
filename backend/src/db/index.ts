import Database from 'better-sqlite3';
import { SCHEMA } from './schema';

export type Db = Database.Database;

/** Opens the database and creates any missing tables. ':memory:' is used by the tests. */
export function openDb(dbPath: string): Db {
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive column migrations for databases created by an earlier version. */
function migrate(db: Db) {
  const has = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
  if (!has('actions', 'replaces_id')) db.exec('ALTER TABLE actions ADD COLUMN replaces_id TEXT');   // v0.3.0: re-proposals
  if (!has('actions', 'preference_check')) db.exec('ALTER TABLE actions ADD COLUMN preference_check TEXT');   // v0.4.0: tool preferences
  if (!has('agents', 'kind')) db.exec("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'external'");   // v0.5.0: the built-in Assistant
  if (!has('agents', 'paused_by_plan')) db.exec('ALTER TABLE agents ADD COLUMN paused_by_plan INTEGER NOT NULL DEFAULT 0');   // v0.7.0: plans
  if (!has('tool_connections', 'live_state')) db.exec('ALTER TABLE tool_connections ADD COLUMN live_state TEXT');   // v0.8.0: live Calendar
  if (!has('tool_connections', 'live_since')) db.exec('ALTER TABLE tool_connections ADD COLUMN live_since INTEGER');
  if (!has('actions', 'adapter_mode')) db.exec("ALTER TABLE actions ADD COLUMN adapter_mode TEXT NOT NULL DEFAULT 'MOCK'");
}
