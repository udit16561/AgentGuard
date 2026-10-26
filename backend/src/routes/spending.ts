import { Router } from 'express';
import type { AgentRow, Ctx } from '../context';
import { requireUser } from '../middleware/auth';
import { spentSince } from '../services/policy';
import { zonedParts } from '../services/time';
import type { Limits } from '../services/permissions';

/** GET /api/me/spending: spent today / this week / this month against each agent's payment caps (dashboard). */
export function spendingRoutes(ctx: Ctx) {
  const r = Router();
  r.get('/', requireUser, (req, res) => {
    const user = req.user!;
    const { startOfDay, startOfWeek, startOfMonth } = zonedParts(ctx.clock.now(), user.timezone);
    const agents = ctx.db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at').all(user.id) as AgentRow[];
    let currency = 'INR';
    const rows = agents.flatMap(agent => {
      const perms = ctx.db.prepare("SELECT limits FROM permissions WHERE agent_id = ? AND tool = 'payments' AND allowed = 1 ORDER BY operation = 'pay' DESC").all(agent.id) as { limits: string }[];
      if (!perms.length) return [];
      const limits = JSON.parse(perms[0].limits) as Limits;
      if (limits.currency) currency = limits.currency;
      return [{
        agentId: agent.id, agentName: agent.name,
        today: spentSince(ctx.db, agent.id, 'payments', startOfDay),
        week: spentSince(ctx.db, agent.id, 'payments', startOfWeek),
        month: spentSince(ctx.db, agent.id, 'payments', startOfMonth),
        caps: { daily: limits.dailyCap ?? null, weekly: limits.weeklyCap ?? null, monthly: limits.monthlyCap ?? null }
      }];
    });
    res.json({ currency, agents: rows });
  });
  return r;
}
