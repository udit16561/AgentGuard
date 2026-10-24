import Database from 'better-sqlite3';
import { SCHEMA } from './schema';

export type Db = Database.Database;

/** Opens the database and creates any missing tables. ':memory:' is used by the tests. */
export function openDb(dbPath: string): Db {
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
