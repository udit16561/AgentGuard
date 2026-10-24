import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireAgent, requireUser } from '../middleware/auth';
import { newId, payloadHash } from '../services/canonical';
import { checkPolicy } from '../services/policy';
import { classify, type ModelClassifier } from '../services/intent';
import { actionView, expireDueForUser, expireIfDue, type ActionRow } from '../services/actions';

const MAX_PAYLOAD_BYTES = 32 * 1024;
const RATE_LIMIT = { max: 20, windowMs: 60_000 };   // per agent key (SEC-23)

const Proposal = z.object({
  tool: z.string().trim().min(1).max(64),
  operation: z.string().trim().min(1).max(64),
  payload: z.record(z.string(), z.unknown())
}).strict();

const ListFilters = z.object({
  status: z.string().max(32).optional(),
  tool: z.string().max(64).optional(),
  agent: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export function actionRoutes(ctx: Ctx, opts: { classifier?: ModelClassifier } = {}) {
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

    const now = clock.now();
    const id = newId('act');
    const hash = payloadHash(agent.id, body.tool, body.operation, body.payload);
    const policy = checkPolicy(ctx, { userId: agent.user_id, agentId: agent.id, ...body });
    const c = await classify({ ...body, context: policy.ok ? policy.context : {} }, { model: policy.ok ? opts.classifier : undefined });
    const status = !policy.ok ? 'BLOCKED' : c.needsReview ? 'NEEDS_REVIEW' : 'PENDING_REVIEW';

    const row: ActionRow = {
      id, user_id: agent.user_id, agent_id: agent.id, tool: body.tool, operation: body.operation,
      payload: JSON.stringify(body.payload), payload_hash: hash,
      intent: c.intent, risk_level: c.riskLevel, risk_score: c.riskScore, confidence: c.confidence,
      risk_reasons: JSON.stringify(c.reasons), flags: JSON.stringify(c.flags),
      status, block_reason: policy.ok ? null : policy.reason,
      created_at: now, expires_at: now + config.approvalTtlMinutes * 60_000, updated_at: now
    };
    db.prepare(`INSERT INTO actions (id, user_id, agent_id, tool, operation, payload, payload_hash, intent, risk_level, risk_score, confidence, risk_reasons, flags, status, block_reason, created_at, expires_at, updated_at)
      VALUES (@id, @user_id, @agent_id, @tool, @operation, @payload, @payload_hash, @intent, @risk_level, @risk_score, @confidence, @risk_reasons, @flags, @status, @block_reason, @created_at, @expires_at, @updated_at)`).run(row);

    const base = { agentId: agent.id, tool: body.tool, operation: body.operation, payloadHash: hash };
    audit.append({ userId: agent.user_id, actorType: 'AGENT', actorId: agent.id, eventType: 'ACTION_PROPOSED', actionId: id,
      data: { ...base, payload: body.payload, intent: c.intent, riskLevel: c.riskLevel, riskScore: c.riskScore, reasons: c.reasons, flags: c.flags } });

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
      res.json({ id: fresh.id, status: fresh.status, riskLevel: fresh.risk_level });
      return;
    }
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in or use an agent key');
  });

  return r;
}
