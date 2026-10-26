import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { requireCsrf, requireUser } from '../middleware/auth';
import { NEVER_LOCKED } from '../services/entitlements';
import { PLAN_IDS, PLANS } from '../services/plans';

/** GET /api/plans: the comparison for the Plans screen (public data; prices are mock). */
export function planRoutes(_ctx: Ctx) {
  const r = Router();
  r.get('/', (_req, res) => {
    res.json({ plans: PLAN_IDS.map(id => ({ id, name: PLANS[id].name, priceInr: PLANS[id].priceInr, entitlements: PLANS[id].entitlements })), neverLocked: NEVER_LOCKED, billing: 'mock' });
  });
  return r;
}

/** /api/me/entitlements, /api/me/plan/preview and POST /api/me/plan (mock upgrade/downgrade). Signed-in user only. */
export function mePlanRoutes(ctx: Ctx) {
  const r = Router();
  const Plan = z.enum(PLAN_IDS);
  const pausedNow = (userId: string) => ({
    agents: (ctx.db.prepare("SELECT id, name FROM agents WHERE user_id = ? AND paused_by_plan = 1 AND status = 'PAUSED'").all(userId) as { id: string; name: string }[]),
    tools: (ctx.db.prepare("SELECT tool FROM tool_connections WHERE user_id = ? AND status = 'PAUSED_PLAN'").all(userId) as { tool: string }[]).map(t => t.tool)
  });

  r.get('/entitlements', requireUser, (req, res) => {
    const userId = req.user!.id;
    res.json({ plan: ctx.entitlements.planOf(userId), entitlements: ctx.entitlements.entitlements(userId), usage: ctx.entitlements.usage(userId), paused: pausedNow(userId), neverLocked: NEVER_LOCKED });
  });

  // what a switch would pause, for the confirm dialog
  r.get('/plan/preview', requireUser, (req, res) => {
    const plan = Plan.parse(req.query.plan);
    const { pauseAgents, pauseTools } = ctx.entitlements.previewChange(req.user!.id, plan);
    res.json({ plan, pauseAgents: pauseAgents.map(a => ({ id: a.id, name: a.name })), pauseTools });
  });

  r.post('/plan', requireUser, requireCsrf, (req, res) => {
    const { plan } = z.object({ plan: Plan }).strict().parse(req.body);
    const userId = req.user!.id;
    if (ctx.entitlements.planOf(userId) === plan) { res.json({ plan, unchanged: true }); return; }
    const out = ctx.entitlements.changePlan(userId, plan);
    res.json({ plan, ...out, paused: pausedNow(userId) });
  });
  return r;
}
