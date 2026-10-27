import type { Ctx } from '../context';
import { canonicalJSON } from './canonical';

export interface ActionRow {
  id: string; user_id: string; agent_id: string; tool: string; operation: string; payload: string; payload_hash: string;
  intent: string | null; risk_level: string | null; risk_score: number | null; confidence: number | null;
  risk_reasons: string; flags: string; status: string; block_reason: string | null; replaces_id?: string | null; preference_check?: string | null; adapter_mode?: string;
  created_at: number; expires_at: number; updated_at: number;
}

/** Field-by-field "what changed" between a re-proposal and the action it replaces (top-level payload fields). */
export function payloadChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...Object.keys(after), ...Object.keys(before).filter(k => !(k in after))];
  return keys
    .filter(k => canonicalJSON(before[k] ?? null) !== canonicalJSON(after[k] ?? null))
    .map(k => ({ field: k, before: before[k] ?? null, after: after[k] ?? null }));
}

export const OPEN = ['PENDING_REVIEW', 'NEEDS_REVIEW'];

/** HIGH/CRITICAL, NEEDS_REVIEW and payments above the re-auth threshold need a recent password check before approval (DECISIONS C). */
export const needsReauth = (a: ActionRow) => a.risk_level === 'HIGH' || a.risk_level === 'CRITICAL' || a.status === 'NEEDS_REVIEW'
  || (JSON.parse(a.flags) as string[]).includes('REAUTH_THRESHOLD');   // payments above the user's PIN threshold

/** The approval window runs from the proposal (DECISIONS D). Expiry is applied lazily, whenever an action is read or decided. */
export function expireIfDue(ctx: Ctx, a: ActionRow): ActionRow {
  if (!OPEN.includes(a.status) || ctx.clock.now() < a.expires_at) return a;
  ctx.db.prepare("UPDATE actions SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(ctx.clock.now(), a.id);
  ctx.audit.append({ userId: a.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_EXPIRED', actionId: a.id, data: { agentId: a.agent_id, tool: a.tool } });
  return { ...a, status: 'EXPIRED' };
}

export function expireDueForUser(ctx: Ctx, userId: string) {
  const due = ctx.db.prepare(`SELECT * FROM actions WHERE user_id = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW') AND expires_at <= ?`).all(userId, ctx.clock.now()) as ActionRow[];
  for (const a of due) expireIfDue(ctx, a);
}

/** Everything the review screen needs. The agent never gets this view. */
export function actionView(ctx: Ctx, a: ActionRow) {
  const approval = ctx.db.prepare('SELECT decision, payload_hash, reauth_used, reason, decided_at FROM approvals WHERE action_id = ? ORDER BY decided_at DESC LIMIT 1').get(a.id) as
    { decision: string; payload_hash: string; reauth_used: number; reason: string | null; decided_at: number } | undefined;
  const execution = ctx.db.prepare('SELECT adapter_mode, provider_ref, result, error, finished_at FROM executions WHERE action_id = ?').get(a.id) as
    { adapter_mode: string; provider_ref: string | null; result: string | null; error: string | null; finished_at: number | null } | undefined;
  const agent = ctx.db.prepare('SELECT name FROM agents WHERE id = ?').get(a.agent_id) as { name: string } | undefined;
  const prev = a.replaces_id ? ctx.db.prepare('SELECT id, status, payload, created_at FROM actions WHERE id = ?').get(a.replaces_id) as { id: string; status: string; payload: string; created_at: number } | undefined : undefined;
  return {
    replaces: prev ? { id: prev.id, status: prev.status, payload: JSON.parse(prev.payload), createdAt: new Date(prev.created_at).toISOString() } : null,
    changes: prev ? payloadChanges(JSON.parse(prev.payload), JSON.parse(a.payload)) : [],
    id: a.id, agentId: a.agent_id, agentName: agent?.name ?? null, tool: a.tool, operation: a.operation,
    payload: JSON.parse(a.payload), payloadHash: a.payload_hash,
    intent: a.intent, riskLevel: a.risk_level, riskScore: a.risk_score, confidence: a.confidence,
    reasons: JSON.parse(a.risk_reasons), flags: JSON.parse(a.flags),
    status: a.status, blockReason: a.block_reason, requiresReauth: needsReauth(a),
    // the mode it was proposed in, and the only mode it can run in (a LIVE action never falls back to MOCK)
    adapterMode: a.adapter_mode ?? 'MOCK',
    preferenceCheck: a.preference_check ? JSON.parse(a.preference_check) : null,
    createdAt: new Date(a.created_at).toISOString(), expiresAt: new Date(a.expires_at).toISOString(),
    approval: approval ? { decision: approval.decision, payloadHash: approval.payload_hash, reauthUsed: !!approval.reauth_used, reason: approval.reason, decidedAt: new Date(approval.decided_at).toISOString() } : null,
    execution: execution ? { adapterMode: execution.adapter_mode, providerRef: execution.provider_ref, result: execution.result ? JSON.parse(execution.result) : null, error: execution.error, finishedAt: execution.finished_at ? new Date(execution.finished_at).toISOString() : null } : null
  };
}
