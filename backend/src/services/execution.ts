import type { Ctx } from '../context';
import { AppError } from '../http';
import type { Adapter } from '../adapters/types';
import { resolveAdapter } from '../adapters';
import { newId, payloadHash } from './canonical';
import { checkPolicy } from './policy';
import type { ActionRow } from './actions';

/** A gate closed between approval and the provider call: nothing was sent, so the action is BLOCKED. */
export class GateClosed extends Error {
  constructor(public code: string) { super(code); }
}

interface ApprovalRow { id: string; action_id: string; user_id: string; decision: string; payload_hash: string; used_at: number | null; expires_at: number }

/**
 * Runs an approved action. Re-checks gate 2 (this exact approval, unused, unexpired, hash still matching)
 * and gate 1 (permission, limits, kill switch) right before the adapter call, then records gate 3:
 * COMPLETED only with a provider reference, UNKNOWN without one, FAILED on an error. A live adapter also calls
 * recheck() right before its provider request; a gate closed by then means BLOCKED, with nothing sent.
 */
export async function executeApproved(ctx: Ctx, actionId: string, approvalId: string, adapters: Partial<Record<string, Adapter>> = {}) {
  const { db, clock, audit } = ctx;
  const a = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as ActionRow;
  const ap = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
  const payload = JSON.parse(a.payload) as Record<string, unknown>;

  // gate 2
  if (!ap || ap.action_id !== a.id || ap.decision !== 'APPROVED' || a.status !== 'APPROVED') throw new AppError(409, 'APPROVAL_REQUIRED', 'No valid approval for this action', a.id);
  if (ap.used_at) throw new AppError(409, 'ALREADY_DECIDED', 'This approval was already used', a.id);
  if (clock.now() > ap.expires_at) throw new AppError(410, 'APPROVAL_EXPIRED', 'The approval has expired', a.id);
  const current = payloadHash(a.agent_id, a.tool, a.operation, payload);
  if (ap.payload_hash !== a.payload_hash || current !== a.payload_hash) throw new AppError(409, 'PAYLOAD_CHANGED', 'The action changed after approval', a.id);

  // gate 1, again
  const policy = checkPolicy(ctx, { userId: a.user_id, agentId: a.agent_id, tool: a.tool, operation: a.operation, payload, excludeActionId: a.id, phase: 'decide' });
  if (!policy.ok) throw new AppError(policy.status, policy.code, policy.message, a.id);

  // single use: only one caller can claim the approval (SEC-26)
  const claimed = db.prepare('UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL').run(clock.now(), ap.id);
  if (claimed.changes !== 1) throw new AppError(409, 'ALREADY_DECIDED', 'This approval was already used', a.id);

  const live = a.adapter_mode === 'LIVE';
  const adapter = resolveAdapter(a.tool, adapters, live ? { ctx, userId: a.user_id } : undefined);
  const executionId = newId('exe');
  db.prepare("UPDATE actions SET status = 'SUBMITTED', updated_at = ? WHERE id = ?").run(clock.now(), a.id);
  db.prepare('INSERT INTO executions (id, action_id, approval_id, adapter_mode) VALUES (?, ?, ?, ?)').run(executionId, a.id, ap.id, adapter.mode);
  const base = { agentId: a.agent_id, tool: a.tool, operation: a.operation, adapterMode: adapter.mode };
  audit.append({ userId: a.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_SUBMITTED', actionId: a.id, data: base });

  // gates 1 and 2 once more, as they stand at the moment of the provider call
  const recheck = () => {
    const cur = db.prepare('SELECT * FROM actions WHERE id = ?').get(a.id) as ActionRow;
    const apNow = db.prepare('SELECT * FROM approvals WHERE id = ?').get(ap.id) as ApprovalRow;
    if (apNow.decision !== 'APPROVED' || !apNow.used_at || cur.status !== 'SUBMITTED') throw new GateClosed('APPROVAL_REQUIRED');
    if (clock.now() > apNow.expires_at) throw new GateClosed('APPROVAL_EXPIRED');
    const curPayload = JSON.parse(cur.payload) as Record<string, unknown>;
    if (cur.payload_hash !== apNow.payload_hash || payloadHash(cur.agent_id, cur.tool, cur.operation, curPayload) !== apNow.payload_hash) throw new GateClosed('PAYLOAD_CHANGED');
    const p = checkPolicy(ctx, { userId: cur.user_id, agentId: cur.agent_id, tool: cur.tool, operation: cur.operation, payload: curPayload, excludeActionId: cur.id, phase: 'decide' });
    if (!p.ok) throw new GateClosed(p.code);
  };

  let status: 'COMPLETED' | 'UNKNOWN' | 'FAILED';
  try {
    const out = await adapter.execute(a.operation, payload, { actionId: a.id, recheck });
    status = out.providerRef ? 'COMPLETED' : 'UNKNOWN';
    db.prepare('UPDATE executions SET provider_ref = ?, result = ?, finished_at = ? WHERE id = ?').run(out.providerRef ?? null, JSON.stringify(out.result ?? {}), clock.now(), executionId);
    audit.append({ userId: a.user_id, actorType: 'SYSTEM', actorId: null, eventType: status === 'COMPLETED' ? 'ACTION_COMPLETED' : 'ACTION_UNVERIFIED', actionId: a.id, data: { ...base, providerRef: out.providerRef ?? null } });
  } catch (err) {
    if (err instanceof GateClosed) {
      db.prepare('UPDATE executions SET error = ?, finished_at = ? WHERE id = ?').run(`Stopped before the provider call: ${err.code}`, clock.now(), executionId);
      db.prepare("UPDATE actions SET status = 'BLOCKED', block_reason = ?, updated_at = ? WHERE id = ?").run(err.code, clock.now(), a.id);
      audit.append({ userId: a.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_BLOCKED', actionId: a.id, data: { ...base, reason: err.code, stage: 'BEFORE_PROVIDER' } });
      return 'BLOCKED' as const;
    }
    status = 'FAILED';
    const message = (err instanceof Error ? err.message : 'Provider error').slice(0, 300);
    db.prepare('UPDATE executions SET error = ?, finished_at = ? WHERE id = ?').run(message, clock.now(), executionId);
    audit.append({ userId: a.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_FAILED', actionId: a.id, data: { ...base, error: message } });
  }
  db.prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?').run(status, clock.now(), a.id);
  return status;
}
