import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireAgent, requireUser } from '../middleware/auth';
import { actionView, expireDueForUser, expireIfDue, type ActionRow } from '../services/actions';
import { createProposal, type ProposalOptions } from '../services/proposals';

const ListFilters = z.object({
  status: z.string().max(32).optional(),
  tool: z.string().max(64).optional(),
  agent: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export function actionRoutes(ctx: Ctx, opts: ProposalOptions = {}) {
  const r = Router();
  const { db } = ctx;

  // agents propose; they can never approve, execute, or see anything beyond their own action status
  r.post('/', requireAgent, async (req, res) => {
    res.status(201).json(await createProposal(ctx, req.agent!, req.body, opts));
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
