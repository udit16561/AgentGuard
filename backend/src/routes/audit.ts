import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { requireUser } from '../middleware/auth';

const time = z.union([z.coerce.number(), z.string().datetime().transform(s => Date.parse(s))]).optional();
const Filters = z.object({
  from: time, to: time,
  agent: z.string().max(64).optional(),
  tool: z.string().max(64).optional(),
  eventType: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional()
});

/** Read-only by design: only GET routes exist, so PUT/PATCH/DELETE fall through to 404 (SEC-16). */
export function auditRoutes(ctx: Ctx) {
  const r = Router();
  r.get('/', requireUser, (req, res) => {
    res.json({ events: ctx.audit.list(req.user!.id, Filters.parse(req.query)) });
  });
  r.get('/verify', requireUser, (_req, res) => {
    res.json(ctx.audit.verify());
  });
  return r;
}
