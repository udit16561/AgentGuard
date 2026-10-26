import { z } from 'zod';
import type { Db } from '../db';
import { CATALOG } from './catalog';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const names = z.array(z.string().trim().min(1).max(254)).max(500);
export const PAYMENT_METHODS = ['upi', 'card', 'netbanking', 'wallet'] as const;

/** Limits a user can attach to one permission (docs/ARCHITECTURE_AND_API.md §2). Unknown keys are refused. */
export const Limits = z.object({
  maxAmount: z.number().positive().optional(),
  dailyCap: z.number().positive().optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  knownPayees: names.optional(),
  knownRecipients: names.optional(),
  allowedRecipients: names.optional(),
  /** payments: only these payees may be paid at all */
  allowedPayees: names.optional(),
  /** messaging, email, calendar: more recipients than this is blocked as bulk */
  maxRecipients: z.number().int().min(1).max(1000).optional(),
  timeWindow: z.object({ start: hhmm, end: hhmm }).optional(),
  /** true: outside timeWindow is blocked; otherwise it only raises the risk */
  enforceHours: z.boolean().optional(),
  /** LOW-risk reads and alarms only (see AUTO_ALLOW_INTENTS); still fully audited */
  autoAllow: z.boolean().optional(),
  // payments (v0.4.0): caps are per agent and tool, in the limit's currency; going over one is BLOCKED
  weeklyCap: z.number().positive().optional(),
  monthlyCap: z.number().positive().optional(),
  /** most one payee may receive in a calendar month, by payee name (case-insensitive) */
  payeeCaps: z.record(z.string().trim().min(1).max(254), z.number().positive()).refine(o => Object.keys(o).length <= 200, 'At most 200 payees').optional(),
  /** a payee not in knownPayees/allowedPayees: "approve" (default) raises the risk, "block" refuses it */
  newPayees: z.enum(['approve', 'block']).optional(),
  allowedMethods: z.array(z.enum(PAYMENT_METHODS)).max(4).optional(),
  /** a named category here is BLOCKED; the same words in the payee or note only raise the risk */
  blockedCategories: names.optional(),
  /** above this amount the password (PIN) is always required, whatever the risk */
  reauthAbove: z.number().positive().optional()
}).strict();

/** The only intents a user may auto-allow (docs/SECURITY_AND_APPROVALS.md §3). */
export const AUTO_ALLOW_INTENTS = ['READ_DATA', 'SET_REMINDER'];
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
