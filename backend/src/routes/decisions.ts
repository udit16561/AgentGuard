import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireCsrf, requireUser } from '../middleware/auth';
import { newId, payloadHash } from '../services/canonical';
import { checkPolicy } from '../services/policy';
import { actionView, expireIfDue, needsReauth, OPEN, type ActionRow } from '../services/actions';
import { executeApproved } from '../services/execution';
import type { Adapter } from '../adapters/types';

/**
 * POST /api/actions/:id/approve and /reject. User session plus CSRF only; an agent key gets 401 (SEC-13).
 * There is deliberately no route that executes without an approval (SEC-03).
 */
export function decisionRoutes(ctx: Ctx, opts: { adapters?: Partial<Record<string, Adapter>> } = {}) {
  const r = Router();
  const { db, clock, config, audit } = ctx;
  // per route, not r.use: this router shares the /api/actions mount with the agent's proposal route
  const userWrite = [requireUser, requireCsrf];

  const owned = (req: Request) => {
    const a = db.prepare('SELECT * FROM actions WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.id) as ActionRow | undefined;
    if (!a) throw notFound('Action not found');
    return a;
  };
  const stillOpen = (a: ActionRow) => {
    if (a.status === 'EXPIRED') throw new AppError(410, 'APPROVAL_EXPIRED', 'This action expired. Ask the agent to propose it again.', a.id);
    if (!OPEN.includes(a.status)) throw new AppError(409, 'ALREADY_DECIDED', `This action is already ${a.status}`, a.id);
    const fresh = expireIfDue(ctx, a);
    if (fresh.status === 'EXPIRED') throw new AppError(410, 'APPROVAL_EXPIRED', 'This action expired. Ask the agent to propose it again.', a.id);
    return fresh;
  };
  const log = (req: Request, a: ActionRow, eventType: string, data: Record<string, unknown> = {}) =>
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType, actionId: a.id, data: { agentId: a.agent_id, tool: a.tool, operation: a.operation, ...data } });

  // check order is fixed by docs/DECISIONS.md F
  r.post('/:id/approve', ...userWrite, async (req: Request, res) => {
    const { payloadHash: shown } = z.object({ payloadHash: z.string().min(1).max(128) }).parse(req.body);
    const a = stillOpen(owned(req));                                                       // 404, 409, 410

    const recomputed = payloadHash(a.agent_id, a.tool, a.operation, JSON.parse(a.payload));
    if (shown !== a.payload_hash || recomputed !== a.payload_hash) {                       // 409
      log(req, a, 'APPROVAL_REFUSED', { reason: 'PAYLOAD_CHANGED' });
      throw new AppError(409, 'PAYLOAD_CHANGED', 'The details you approved are not the details of this action. Review it again.', a.id);
    }

    const policy = checkPolicy(ctx, { userId: a.user_id, agentId: a.agent_id, tool: a.tool, operation: a.operation, payload: JSON.parse(a.payload), excludeActionId: a.id, phase: 'decide' });
    if (!policy.ok) {                                                                      // 423, 403
      log(req, a, 'APPROVAL_REFUSED', { reason: policy.reason });
      throw new AppError(policy.status, policy.code, policy.message, a.id);
    }

    const now = clock.now();
    const reauthed = !!req.session!.reauth_at && now - req.session!.reauth_at <= config.reauthWindowMinutes * 60_000;
    if (needsReauth(a) && !reauthed) throw new AppError(401, 'REAUTH_REQUIRED', 'Confirm your password to approve this action', a.id);   // 401

    const approvalId = newId('apr');
    const approve = db.transaction(() => {
      const moved = db.prepare(`UPDATE actions SET status = 'APPROVED', updated_at = ? WHERE id = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW')`).run(now, a.id);
      if (moved.changes !== 1) throw new AppError(409, 'ALREADY_DECIDED', 'This action was decided in the meantime', a.id);
      db.prepare(`INSERT INTO approvals (id, action_id, user_id, decision, payload_hash, reauth_used, decided_at, expires_at) VALUES (?, ?, ?, 'APPROVED', ?, ?, ?, ?)`)
        .run(approvalId, a.id, req.user!.id, a.payload_hash, reauthed ? 1 : 0, now, now + config.approvalTtlMinutes * 60_000);
      log(req, a, 'ACTION_APPROVED', { payloadHash: a.payload_hash, reauthUsed: reauthed, riskLevel: a.risk_level });
    });
    approve();

    try {
      await executeApproved(ctx, a.id, approvalId, opts.adapters);
    } catch (err) {
      // a gate closed between approval and execution: nothing ran, so record it as blocked
      if (err instanceof AppError) {
        db.prepare("UPDATE actions SET status = 'BLOCKED', block_reason = ?, updated_at = ? WHERE id = ? AND status = 'APPROVED'").run(err.code, clock.now(), a.id);
        audit.append({ userId: a.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_BLOCKED', actionId: a.id, data: { agentId: a.agent_id, tool: a.tool, reason: err.code } });
      }
      throw err;
    }
    res.json(actionView(ctx, db.prepare('SELECT * FROM actions WHERE id = ?').get(a.id) as ActionRow));
  });

  r.post('/:id/reject', ...userWrite, (req: Request, res) => {
    const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    const a = stillOpen(owned(req));
    const now = clock.now();
    const reject = db.transaction(() => {
      const moved = db.prepare(`UPDATE actions SET status = 'REJECTED', updated_at = ? WHERE id = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW')`).run(now, a.id);
      if (moved.changes !== 1) throw new AppError(409, 'ALREADY_DECIDED', 'This action was decided in the meantime', a.id);
      db.prepare(`INSERT INTO approvals (id, action_id, user_id, decision, payload_hash, reauth_used, reason, decided_at, expires_at) VALUES (?, ?, ?, 'REJECTED', ?, 0, ?, ?, ?)`)
        .run(newId('apr'), a.id, req.user!.id, a.payload_hash, reason ?? null, now, now);
      log(req, a, 'ACTION_REJECTED', { reason: reason ?? null });
    });
    reject();
    res.json(actionView(ctx, db.prepare('SELECT * FROM actions WHERE id = ?').get(a.id) as ActionRow));
  });

  return r;
}
