import type { Db } from './db';
import type { Clock } from './clock';
import type { Config } from './config';
import type { AuditService } from './services/audit';

/** Everything a route or service needs, built once per app in createApp. */
export interface Ctx {
  db: Db;
  clock: Clock;
  config: Config;
  audit: AuditService;
}

export interface UserRow {
  id: string; email: string; password_hash: string; plan_id: string; timezone: string;
  kill_switch: number; failed_logins: number; locked_until: number | null; created_at: number;
}
export interface SessionRow {
  id: string; token_hash: string; user_id: string; csrf_token: string; reauth_at: number | null; expires_at: number; created_at: number;
}
export interface AgentRow {
  id: string; user_id: string; name: string; model: string | null; api_key_hash: string; status: 'ACTIVE' | 'PAUSED' | 'REVOKED'; created_at: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
    session?: SessionRow;
    agent?: AgentRow;
  }
}
