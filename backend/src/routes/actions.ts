import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireAgent, requireUser } from '../middleware/auth';
import { newId, payloadHash } from '../services/canonical';
import { checkPolicy } from '../services/policy';
import { classify, type ModelClassifier } from '../services/intent';
import { actionView, expireDueForUser, expireIfDue, OPEN, type ActionRow } from '../services/actions';
import { AUTO_ALLOW_INTENTS } from '../services/permissions';
import { executeApproved } from '../services/execution';
import type { Adapter } from '../adapters/types';

const MAX_PAYLOAD_BYTES = 32 * 1024;
const RATE_LIMIT = { max: 20, windowMs: 60_000 };   // per agent key (SEC-23)

const Proposal = z.object({
  tool: z.string().trim().min(1).max(64),
  operation: z.string().trim().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  /** id of this agent's earlier action that this proposal revises */
  replaces: z.string().max(64).optional()
}).strict();

const ListFilters = z.object({
  status: z.string().max(32).optional(),
  tool: z.string().max(64).optional(),
  agent: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export function actionRoutes(ctx: Ctx, opts: { classifier?: ModelClassifier; adapters?: Partial<Record<string, Adapter>> } = {}) {
  const r = Router();
  const { db, clock, config, audit } = ctx;
  const recent = new Map<string, number[]>();

  function rateLimited(agentId: string) {
    const now = clock.now();
    const hits = (recent.get(agentId) ?? []).filter(t => now - t < RATE_LIMIT.windowMs);
    hits.push(now);
    recent.set(agentId, hits);
    return hits.length > RATE_LIMIT.max;
  }

  // agents propose; they can never approve, execute, or see anything beyond their own action status
  r.post('/', requireAgent, async (req, res) => {
    const agent = req.agent!;
    if (rateLimited(agent.id)) throw new AppError(429, 'RATE_LIMITED', 'Too many proposals from this agent. Slow down.');
    const body = Proposal.parse(req.body);
    if (Buffer.byteLength(JSON.stringify(body.payload)) > MAX_PAYLOAD_BYTES) throw new AppError(400, 'VALIDATION_ERROR', 'Payload is too large');

    // a re-proposal names the agent's own earlier action for the same tool; the old version can then no longer run
    const replaced = body.replaces
      ? db.prepare('SELECT * FROM actions WHERE id = ? AND agent_id = ?').get(body.replaces, agent.id) as ActionRow | undefined
      : undefined;
    if (body.replaces && (!replaced || replaced.tool !== body.tool)) throw new AppError(400, 'VALIDATION_ERROR', 'replaces must be one of this agent’s own actions for the same tool');

    const now = clock.now();
    const id = newId('act');
    const { replaces: _replaces, ...proposal } = body;   // the hash covers the proposal only
    const hash = payloadHash(agent.id, proposal.tool, proposal.operation, proposal.payload);
    const policy = checkPolicy(ctx, { userId: agent.user_id, agentId: agent.id, ...proposal, phase: 'propose' });
    const c = await classify({ ...proposal, context: policy.ok ? policy.context : {} }, { model: policy.ok ? opts.classifier : undefined });
    // auto-allow: only if the user switched it on for this read or alarm, and only while the risk stays LOW (docs/SECURITY_AND_APPROVALS.md §3)
    const autoAllowed = policy.ok && !!policy.limits.autoAllow && AUTO_ALLOW_INTENTS.includes(c.intent) && c.riskLevel === 'LOW' && !c.needsReview;
    const status = !policy.ok ? 'BLOCKED' : autoAllowed ? 'APPROVED' : c.needsReview ? 'NEEDS_REVIEW' : 'PENDING_REVIEW';

    const row: ActionRow = {
      id, user_id: agent.user_id, agent_id: agent.id, tool: proposal.tool, operation: proposal.operation,
      payload: JSON.stringify(proposal.payload), payload_hash: hash,
      intent: c.intent, risk_level: c.riskLevel, risk_score: c.riskScore, confidence: c.confidence,
      risk_reasons: JSON.stringify(c.reasons), flags: JSON.stringify(c.flags),
      status, block_reason: policy.ok ? null : policy.reason, replaces_id: replaced?.id ?? null,
      preference_check: policy.preferences ? JSON.stringify(policy.preferences) : null,
      created_at: now, expires_at: now + config.approvalTtlMinutes * 60_000, updated_at: now
    };
    db.prepare(`INSERT INTO actions (id, user_id, agent_id, tool, operation, payload, payload_hash, intent, risk_level, risk_score, confidence, risk_reasons, flags, status, block_reason, replaces_id, preference_check, created_at, expires_at, updated_at)
      VALUES (@id, @user_id, @agent_id, @tool, @operation, @payload, @payload_hash, @intent, @risk_level, @risk_score, @confidence, @risk_reasons, @flags, @status, @block_reason, @replaces_id, @preference_check, @created_at, @expires_at, @updated_at)`).run(row);

    const base = { agentId: agent.id, tool: proposal.tool, operation: proposal.operation, payloadHash: hash };
    audit.append({ userId: agent.user_id, actorType: 'AGENT', actorId: agent.id, eventType: 'ACTION_PROPOSED', actionId: id,
      data: { ...base, payload: proposal.payload, intent: c.intent, riskLevel: c.riskLevel, riskScore: c.riskScore, reasons: c.reasons, flags: c.flags, replaces: replaced?.id ?? null, preferencesBroken: policy.preferences?.broken.map(b => b.id) ?? [] } });

    if (replaced && OPEN.includes(replaced.status)) {
      db.prepare("UPDATE actions SET status = 'BLOCKED', block_reason = 'REPLACED', updated_at = ? WHERE id = ?").run(now, replaced.id);
      audit.append({ userId: agent.user_id, actorType: 'AGENT', actorId: agent.id, eventType: 'ACTION_REPLACED', actionId: replaced.id, data: { agentId: agent.id, tool: replaced.tool, replacedBy: id } });
    }

    if (autoAllowed) {
      const approvalId = newId('apr');
      db.prepare(`INSERT INTO approvals (id, action_id, user_id, decision, payload_hash, reauth_used, reason, decided_at, expires_at) VALUES (?, ?, ?, 'APPROVED', ?, 0, 'AUTO_ALLOWED', ?, ?)`)
        .run(approvalId, id, agent.user_id, hash, now, now + config.approvalTtlMinutes * 60_000);
      audit.append({ userId: agent.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_AUTO_APPROVED', actionId: id, data: { ...base, rule: 'autoAllow', riskLevel: c.riskLevel } });
      const final = await executeApproved(ctx, id, approvalId, opts.adapters);
      const exe = db.prepare('SELECT result FROM executions WHERE action_id = ?').get(id) as { result: string | null } | undefined;
      res.status(201).json({ id, status: final, riskLevel: c.riskLevel, ...(final === 'COMPLETED' && exe?.result ? { result: JSON.parse(exe.result) } : {}) });
      return;
    }

    if (!policy.ok) {
      audit.append({ userId: agent.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_BLOCKED', actionId: id, data: { ...base, reason: policy.reason } });
      throw new AppError(policy.status, policy.code, policy.message, id);
    }
    audit.append({ userId: agent.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'ALERT_SENT', actionId: id, data: { ...base, status, channel: 'in_app' } });
    res.status(201).json({ id, status, riskLevel: c.riskLevel, expiresAt: new Date(row.expires_at).toISOString() });
  });

  r.get('/', requireUser, (req, res) => {
    const f = ListFilters.parse(req.query);
    expireDueForUser(ctx, req.user!.id);
    const where = ['user_id = ?'], args: unknown[] = [req.user!.id];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.tool) { where.push('tool = ?'); args.push(f.tool); }
    if (f.agent) { where.push('agent_id = ?'); args.push(f.agent); }
    args.push(f.limit ?? 100);
    const rows = db.prepare(`SELECT * FROM actions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...args) as ActionRow[];
    res.json({ actions: rows.map(a => actionView(ctx, a)) });
  });

  // the user sees everything; an agent sees only the status of its own actions, and 404 for anyone else's (SEC-15)
  r.get('/:id', (req: Request, res) => {
    if (req.user) {
      const a = db.prepare('SELECT * FROM actions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id) as ActionRow | undefined;
      if (!a) throw notFound('Action not found');
      res.json(actionView(ctx, expireIfDue(ctx, a)));
      return;
    }
    if (req.agent) {
      const a = db.prepare('SELECT * FROM actions WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent.id) as ActionRow | undefined;
      if (!a) throw notFound('Action not found');
      const fresh = expireIfDue(ctx, a);
      // once completed, the agent may read its own result (e.g. the inbox it was allowed to read); never the payload or hash
      const exe = fresh.status === 'COMPLETED' ? db.prepare('SELECT result FROM executions WHERE action_id = ?').get(fresh.id) as { result: string | null } | undefined : undefined;
      res.json({ id: fresh.id, status: fresh.status, riskLevel: fresh.risk_level, ...(exe?.result ? { result: JSON.parse(exe.result) } : {}) });
      return;
    }
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in or use an agent key');
  });

  return r;
}
