import type { AgentRow, Ctx, UserRow } from '../context';
import type { ErrorCode } from '../http';
import { operationDef } from './catalog';
import { getPermission, type Limits } from './permissions';
import type { ClassifyContext } from './intent';
import { outsideWindow, zonedParts } from './time';

/**
 * Gate 1, permission (docs/SECURITY_AND_APPROVALS.md §1): kill switch off, agent active, tool connected,
 * operation allowed, limits satisfied. Checked when an action is proposed, again on approval,
 * and again by the execution service right before the adapter call.
 */
export type PolicyResult =
  | { ok: true; limits: Limits; context: ClassifyContext }
  | { ok: false; status: number; code: ErrorCode; reason: string; message: string };

// money that may already have moved counts towards the daily cap
const SPENDING = "('APPROVED', 'SUBMITTED', 'COMPLETED', 'UNKNOWN')";

const deny = (status: number, code: ErrorCode, reason: string, message: string): PolicyResult => ({ ok: false, status, code, reason, message: `${reason}: ${message}` });
const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string');

export function checkPolicy(ctx: Ctx, a: { userId: string; agentId: string; tool: string; operation: string; payload: Record<string, unknown>; excludeActionId?: string }): PolicyResult {
  const { db, clock } = ctx;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(a.userId) as UserRow;
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(a.agentId) as AgentRow | undefined;

  if (user.kill_switch) return deny(423, 'AGENT_PAUSED', 'KILL_SWITCH', 'All agents are paused');
  if (!agent || agent.status !== 'ACTIVE') return deny(423, 'AGENT_PAUSED', 'AGENT_PAUSED', 'This agent is paused');
  if (!operationDef(a.tool, a.operation)) return deny(403, 'PERMISSION_DENIED', 'UNKNOWN_OPERATION', `${a.tool}.${a.operation} is not a known operation`);

  const conn = db.prepare("SELECT 1 FROM tool_connections WHERE user_id = ? AND tool = ? AND status = 'CONNECTED'").get(a.userId, a.tool);
  if (!conn) return deny(403, 'PERMISSION_DENIED', 'TOOL_NOT_CONNECTED', `${a.tool} is not connected`);

  const perm = getPermission(db, a.agentId, a.tool, a.operation);
  if (!perm.allowed) return deny(403, 'PERMISSION_DENIED', 'PERMISSION_NOT_GRANTED', `This agent may not use ${a.tool}.${a.operation}`);
  const limits = perm.limits;

  const now = clock.now();
  const { startOfDay, minuteOfDay } = zonedParts(now, user.timezone);
  const amount = typeof a.payload.amount === 'number' ? a.payload.amount : undefined;

  if (limits.currency && typeof a.payload.currency === 'string' && a.payload.currency.toUpperCase() !== limits.currency)
    return deny(403, 'PERMISSION_DENIED', 'CURRENCY_NOT_ALLOWED', `Only ${limits.currency} is allowed`);
  if (limits.maxAmount != null && amount != null && amount > limits.maxAmount)
    return deny(403, 'PERMISSION_DENIED', 'LIMIT_EXCEEDED', `Amount ${amount} is over the per-action limit of ${limits.maxAmount}`);

  let spentToday = 0;
  if (limits.dailyCap != null) {
    const rows = db.prepare(`SELECT payload FROM actions WHERE agent_id = ? AND tool = ? AND status IN ${SPENDING} AND created_at >= ? AND id != ?`)
      .all(a.agentId, a.tool, startOfDay, a.excludeActionId ?? '') as { payload: string }[];
    spentToday = rows.reduce((sum, r) => { const v = JSON.parse(r.payload).amount; return sum + (typeof v === 'number' ? v : 0); }, 0);
    if (amount != null && spentToday + amount > limits.dailyCap)
      return deny(403, 'PERMISSION_DENIED', 'LIMIT_EXCEEDED', `This would take today's total to ${spentToday + amount}, over the daily cap of ${limits.dailyCap}`);
  }

  if (limits.allowedRecipients?.length) {
    const allowed = new Set(limits.allowedRecipients.map(s => s.toLowerCase()));
    const outside = [...list(a.payload.to), ...list(a.payload.cc), ...list(a.payload.bcc), ...list(a.payload.attendees), ...list(a.payload.payee)]
      .filter(r => !allowed.has(r.toLowerCase()) && !['you', 'me', 'self'].includes(r.toLowerCase()));
    if (outside.length) return deny(403, 'PERMISSION_DENIED', 'RECIPIENT_NOT_ALLOWED', `Not on the allowed list: ${outside.slice(0, 3).join(', ')}`);
  }

  if (limits.allowedPayees?.length) {
    const payee = list(a.payload.payee ?? a.payload.to)[0];
    if (payee && !limits.allowedPayees.some(p => p.toLowerCase() === payee.toLowerCase()))
      return deny(403, 'PERMISSION_DENIED', 'PAYEE_NOT_ALLOWED', `${payee} is not on the allowed payee list`);
  }

  if (limits.maxRecipients != null) {
    const count = new Set([...list(a.payload.to), ...list(a.payload.cc), ...list(a.payload.bcc), ...list(a.payload.recipients), ...list(a.payload.attendees)]
      .filter(r => !['you', 'me', 'self'].includes(r.toLowerCase()))).size;
    if (count > limits.maxRecipients) return deny(403, 'PERMISSION_DENIED', 'BULK_LIMIT_EXCEEDED', `${count} recipients is over the limit of ${limits.maxRecipients}`);
  }

  const outsideHours = limits.timeWindow ? outsideWindow(minuteOfDay, limits.timeWindow) : false;
  if (outsideHours && limits.enforceHours)
    return deny(403, 'PERMISSION_DENIED', 'OUTSIDE_ALLOWED_HOURS', `Only allowed between ${limits.timeWindow!.start} and ${limits.timeWindow!.end}`);

  return {
    ok: true, limits,
    context: {
      knownRecipients: [...(limits.knownRecipients ?? []), ...(limits.allowedRecipients ?? [])],
      knownPayees: [...(limits.knownPayees ?? []), ...(limits.allowedPayees ?? [])],
      dailyCap: limits.dailyCap,
      spentToday,
      outsideAllowedHours: outsideHours
    }
  };
}
