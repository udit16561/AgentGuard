import { z } from 'zod';
import type { Db } from '../db';
import { CATALOG } from './catalog';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const names = z.array(z.string().trim().min(1).max(254)).max(500);

/** Limits a user can attach to one permission (docs/ARCHITECTURE_AND_API.md §2). Unknown keys are refused. */
export const Limits = z.object({
  maxAmount: z.number().positive().optional(),
  dailyCap: z.number().positive().optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  knownPayees: names.optional(),
  knownRecipients: names.optional(),
  allowedRecipients: names.optional(),
  timeWindow: z.object({ start: hhmm, end: hhmm }).optional()
}).strict();
export type Limits = z.infer<typeof Limits>;

export interface PermissionRow { id: string; agent_id: string; tool: string; operation: string; allowed: number; limits: string; updated_at: number }

export function getPermission(db: Db, agentId: string, tool: string, operation: string) {
  const row = db.prepare('SELECT * FROM permissions WHERE agent_id = ? AND tool = ? AND operation = ?').get(agentId, tool, operation) as PermissionRow | undefined;
  return { allowed: !!row?.allowed, limits: (row ? JSON.parse(row.limits) : {}) as Limits };
}

/** The full matrix for one agent: every catalog operation, OFF unless a stored row says otherwise (PRM-01). */
export function permissionMatrix(db: Db, agentId: string) {
  const rows = db.prepare('SELECT * FROM permissions WHERE agent_id = ?').all(agentId) as PermissionRow[];
  const byKey = new Map(rows.map(r => [`${r.tool}.${r.operation}`, r]));
  return Object.entries(CATALOG).flatMap(([tool, def]) => Object.entries(def.operations).map(([operation, o]) => {
    const r = byKey.get(`${tool}.${operation}`);
    return { tool, operation, label: o.label, write: o.write, allowed: !!r?.allowed, limits: r ? JSON.parse(r.limits) : {} };
  }));
}
