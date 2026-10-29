import type { AgentRow, Ctx, UserRow } from '../context';
import type { ErrorCode } from '../http';
import type { Db } from '../db';
import { operationDef } from './catalog';
import { getPermission, type Limits } from './permissions';
import type { ClassifyContext } from './intent';
import { outsideWindow, zonedParts } from './time';
import { evaluatePreferences } from './preferences/store';
import { categoryHit } from './categories';
import type { PreferenceReport } from './preferences/check';
import { liveGate } from '../integrations/live';
import type { LiveConn } from '../integrations/google/oauth';

/**
 * Gate 1, permission (docs/SECURITY_AND_APPROVALS.md §1): kill switch off, agent active, tool connected,
 * operation allowed, limits satisfied, no broken "hard" preference. Checked when an action is proposed,
 * again on approval, and again by the execution service right before the adapter call.
 */
export type PolicyResult =
  | { ok: true; limits: Limits; context: ClassifyContext; preferences: PreferenceReport | null }
  | { ok: false; status: number; code: ErrorCode; reason: string; message: string; preferences?: PreferenceReport | null };

// money that may already have moved counts towards the caps
const SPENDING = "('APPROVED', 'SUBMITTED', 'COMPLETED', 'UNKNOWN')";

const deny = (status: number, code: ErrorCode, reason: string, message: string, preferences?: PreferenceReport | null): PolicyResult =>
  ({ ok: false, status, code, reason, message: `${reason}: ${message}`, ...(preferences !== undefined ? { preferences } : {}) });
const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string');
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Sum of amounts an agent has (or may have) paid with a tool since `from`, optionally to one payee. */
export function spentSince(db: Db, agentId: string, tool: string, from: number, opts: { payee?: string; excludeActionId?: string } = {}) {
  const rows = db.prepare(`SELECT payload FROM actions WHERE agent_id = ? AND tool = ? AND status IN ${SPENDING} AND created_at >= ? AND id != ?`)
    .all(agentId, tool, from, opts.excludeActionId ?? '') as { payload: string }[];
  return rows.reduce((sum, r) => {
    const p = JSON.parse(r.payload);
    if (opts.payee && !same(String(p.payee ?? p.to ?? ''), opts.payee)) return sum;
    return sum + (typeof p.amount === 'number' ? p.amount : 0);
  }, 0);
}

export function checkPolicy(ctx: Ctx, a: { userId: string; agentId: string; tool: string; operation: string; payload: Record<string, unknown>; excludeActionId?: string; phase?: 'propose' | 'decide' }): PolicyResult {
  const { db, clock } = ctx;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(a.userId) as UserRow;
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(a.agentId) as AgentRow | undefined;

  if (user.kill_switch) return deny(423, 'AGENT_PAUSED', 'KILL_SWITCH', 'All agents are paused');
  if (!agent || agent.status !== 'ACTIVE') return deny(423, 'AGENT_PAUSED', 'AGENT_PAUSED', 'This agent is paused');
  if (!operationDef(a.tool, a.operation)) return deny(403, 'PERMISSION_DENIED', 'UNKNOWN_OPERATION', `${a.tool}.${a.operation} is not a known operation`);

  const conn = db.prepare('SELECT status, mode, live_state, live_since, encrypted_token FROM tool_connections WHERE user_id = ? AND tool = ?').get(a.userId, a.tool) as LiveConn | undefined;
  // paused by a downgrade: kept, and unlocked again by an upgrade
  if (conn?.status === 'PAUSED_PLAN') return deny(402, 'ENTITLEMENT_REQUIRED', 'TOOL_PAUSED_BY_PLAN', `Upgrade to unlock ${a.tool}: it was paused when your plan changed`);
  if (conn?.status !== 'CONNECTED') return deny(403, 'PERMISSION_DENIED', 'TOOL_NOT_CONNECTED', `${a.tool} is not connected`);
  // an approval covers the mode the action was proposed in: never MOCK-approved then run live, or the reverse
  if (a.excludeActionId) {
    const proposedIn = (db.prepare('SELECT adapter_mode FROM actions WHERE id = ?').get(a.excludeActionId) as { adapter_mode: string } | undefined)?.adapter_mode;
    if (proposedIn && proposedIn !== conn.mode) return deny(409, 'MODE_CHANGED', 'MODE_CHANGED', `${a.tool} was switched to ${conn.mode} after this was proposed in ${proposedIn}`);
  }
  if (conn.mode === 'LIVE') {
    const live = liveGate(ctx, a.userId, a.tool, a.operation, a.payload, conn);
    if (live) return deny(live.status, live.code, live.reason, live.message);
  }

  const perm = getPermission(db, a.agentId, a.tool, a.operation);
  if (!perm.allowed) return deny(403, 'PERMISSION_DENIED', 'PERMISSION_NOT_GRANTED', `This agent may not use ${a.tool}.${a.operation}`);
  const limits = perm.limits;

  const now = clock.now();
  const { startOfDay, startOfWeek, startOfMonth, minuteOfDay } = zonedParts(now, user.timezone);
  const amount = typeof a.payload.amount === 'number' ? a.payload.amount : undefined;
  const payee = list(a.payload.payee ?? a.payload.to)[0];
  const spent = (from: number, payeeName?: string) => spentSince(db, a.agentId, a.tool, from, { payee: payeeName, excludeActionId: a.excludeActionId });

  if (limits.currency && typeof a.payload.currency === 'string' && a.payload.currency.toUpperCase() !== limits.currency)
    return deny(403, 'PERMISSION_DENIED', 'CURRENCY_NOT_ALLOWED', `Only ${limits.currency} is allowed`);
  if (limits.maxAmount != null && amount != null && amount > limits.maxAmount)
    return deny(403, 'PERMISSION_DENIED', 'LIMIT_EXCEEDED', `Amount ${amount} is over the per-action limit of ${limits.maxAmount}`);

  let spentToday = 0;
  if (limits.dailyCap != null) {
    spentToday = spent(startOfDay);
    if (amount != null && spentToday + amount > limits.dailyCap)
      return deny(403, 'PERMISSION_DENIED', 'LIMIT_EXCEEDED', `This would take today's total to ${spentToday + amount}, over the daily cap of ${limits.dailyCap}`);
  }
  if (limits.weeklyCap != null && amount != null) {
    const week = spent(startOfWeek);
    if (week + amount > limits.weeklyCap) return deny(403, 'PERMISSION_DENIED', 'WEEKLY_LIMIT_EXCEEDED', `This would take this week's total to ${week + amount}, over the weekly cap of ${limits.weeklyCap}`);
  }
  if (limits.monthlyCap != null && amount != null) {
    const month = spent(startOfMonth);
    if (month + amount > limits.monthlyCap) return deny(403, 'PERMISSION_DENIED', 'MONTHLY_LIMIT_EXCEEDED', `This would take this month's total to ${month + amount}, over the monthly cap of ${limits.monthlyCap}`);
  }

  if (limits.allowedRecipients?.length) {
    const allowed = new Set(limits.allowedRecipients.map(s => s.toLowerCase()));
    const outside = [...list(a.payload.to), ...list(a.payload.cc), ...list(a.payload.bcc), ...list(a.payload.attendees), ...list(a.payload.payee)]
      .filter(r => !allowed.has(r.toLowerCase()) && !['you', 'me', 'self'].includes(r.toLowerCase()));
    if (outside.length) return deny(403, 'PERMISSION_DENIED', 'RECIPIENT_NOT_ALLOWED', `Not on the allowed list: ${outside.slice(0, 3).join(', ')}`);
  }

  if (limits.allowedPayees?.length) {
    if (payee && !limits.allowedPayees.some(p => same(p, payee)))
      return deny(403, 'PERMISSION_DENIED', 'PAYEE_NOT_ALLOWED', `${payee} is not on the allowed payee list`);
  }
  const knownPayees = [...(limits.knownPayees ?? []), ...(limits.allowedPayees ?? [])];
  if (payee && limits.newPayees === 'block' && !knownPayees.some(p => same(p, payee)))
    return deny(403, 'PERMISSION_DENIED', 'NEW_PAYEE_BLOCKED', `${payee} is a new payee, and new payees are blocked`);
  if (payee && amount != null && limits.payeeCaps) {
    const capKey = Object.keys(limits.payeeCaps).find(k => same(k, payee));
    if (capKey) {
      const toPayee = spent(startOfMonth, payee);
      if (toPayee + amount > limits.payeeCaps[capKey])
        return deny(403, 'PERMISSION_DENIED', 'PAYEE_LIMIT_EXCEEDED', `This would take ${payee}'s total this month to ${toPayee + amount}, over their cap of ${limits.payeeCaps[capKey]}`);
    }
  }

  const method = typeof a.payload.method === 'string' ? a.payload.method.toLowerCase().replace(/[\s_-]/g, '') : undefined;
  if (limits.allowedMethods && method && !limits.allowedMethods.includes(method as never))
    return deny(403, 'PERMISSION_DENIED', 'METHOD_NOT_ALLOWED', `Paying by ${a.payload.method} is switched off`);

  const category = typeof a.payload.category === 'string' ? a.payload.category : undefined;
  if (category && limits.blockedCategories?.some(c => same(c, category) || categoryHit(c, category)))
    return deny(403, 'PERMISSION_DENIED', 'CATEGORY_BLOCKED', `Payments for ${category} are blocked`);

  if (limits.maxRecipients != null) {
    const count = new Set([...list(a.payload.to), ...list(a.payload.cc), ...list(a.payload.bcc), ...list(a.payload.recipients), ...list(a.payload.attendees)]
      .filter(r => !['you', 'me', 'self'].includes(r.toLowerCase()))).size;
    if (count > limits.maxRecipients) return deny(403, 'PERMISSION_DENIED', 'BULK_LIMIT_EXCEEDED', `${count} recipients is over the limit of ${limits.maxRecipients}`);
  }

  const outsideHours = limits.timeWindow ? outsideWindow(minuteOfDay, limits.timeWindow) : false;
  if (outsideHours && limits.enforceHours)
    return deny(403, 'PERMISSION_DENIED', 'OUTSIDE_ALLOWED_HOURS', `Only allowed between ${limits.timeWindow!.start} and ${limits.timeWindow!.end}`);

  // tool preferences: a broken hard rule blocks; soft ones only raise the risk (in the classifier)
  const knownRecipients = [...(limits.knownRecipients ?? []), ...(limits.allowedRecipients ?? [])];
  const preferences = evaluatePreferences(ctx, { userId: a.userId, timeZone: user.timezone, tool: a.tool, operation: a.operation, payload: a.payload, knownRecipients });
  const hard = preferences?.broken.filter(b => b.hard) ?? [];
  if (hard.length) return deny(403, 'PERMISSION_DENIED', 'PREFERENCE_VIOLATION', `Breaks your rule: ${hard.map(b => b.label).join('; ')}`, preferences);
  // at decision time an unreadable preference can no longer be shown to the user, so it stops the action (fail closed)
  if (preferences?.error && a.phase === 'decide') return deny(403, 'PERMISSION_DENIED', 'PREFERENCE_CHECK_FAILED', 'Your preferences for this tool could not be checked. Save them again.', preferences);

  return {
    ok: true, limits, preferences,
    context: {
      knownRecipients, knownPayees,
      dailyCap: limits.dailyCap,
      spentToday,
      outsideAllowedHours: outsideHours,
      blockedCategories: limits.blockedCategories,
      methodMissing: !!limits.allowedMethods && !method,
      reauthAbove: limits.reauthAbove,
      preferenceViolations: preferences?.broken.map(b => ({ label: b.label, flag: b.flag })) ?? [],
      preferenceError: !!preferences?.error
    }
  };
}
