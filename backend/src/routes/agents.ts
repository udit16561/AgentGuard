import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AgentRow, Ctx } from '../context';
import { notFound } from '../http';
import { requireCsrf, requireUser } from '../middleware/auth';
import { newId, sha256 } from '../services/canonical';

const newKey = () => `ag_${crypto.randomBytes(32).toString('base64url')}`;
const view = (a: AgentRow) => ({ id: a.id, name: a.name, model: a.model, status: a.status, createdAt: new Date(a.created_at).toISOString() });

export function agentRoutes(ctx: Ctx) {
  const r = Router();
  const { db, clock, audit } = ctx;
  r.use(requireUser);

  const owned = (req: Request) => {
    const a = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.id) as AgentRow | undefined;
    if (!a) throw notFound('Agent not found');
    return a;
  };
  const log = (req: Request, eventType: string, agentId: string, data: Record<string, unknown> = {}) =>
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType, data: { agentId, ...data } });

  r.get('/', (req, res) => {
    res.json({ agents: (db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at').all(req.user!.id) as AgentRow[]).map(view) });
  });

  // the plain key is returned exactly once; only its hash is stored (AUTH-03)
  r.post('/', requireCsrf, (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(60), model: z.string().trim().max(80).optional() }).parse(req.body);
    const apiKey = newKey();
    const agent: AgentRow = { id: newId('agt'), user_id: req.user!.id, name: body.name, model: body.model ?? null, api_key_hash: sha256(apiKey), status: 'ACTIVE', created_at: clock.now() };
    db.prepare('INSERT INTO agents (id, user_id, name, model, api_key_hash, status, created_at) VALUES (@id, @user_id, @name, @model, @api_key_hash, @status, @created_at)').run(agent);
    log(req, 'AGENT_CREATED', agent.id, { name: agent.name });
    res.status(201).json({ ...view(agent), apiKey });
  });

  r.patch('/:id', requireCsrf, (req, res) => {
    const a = owned(req);
    const body = z.object({ name: z.string().trim().min(1).max(60).optional(), model: z.string().trim().max(80).nullable().optional() }).parse(req.body);
    const next = { ...a, name: body.name ?? a.name, model: body.model === undefined ? a.model : body.model };
    db.prepare('UPDATE agents SET name = ?, model = ? WHERE id = ?').run(next.name, next.model, a.id);
    log(req, 'AGENT_UPDATED', a.id, { name: next.name, model: next.model });
    res.json(view(next));
  });

  r.post('/:id/pause', requireCsrf, (req, res) => {
    const a = owned(req);
    const { paused } = z.object({ paused: z.boolean().default(true) }).parse(req.body ?? {});
    const status = paused ? 'PAUSED' : 'ACTIVE';
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, a.id);
    log(req, paused ? 'AGENT_PAUSED' : 'AGENT_RESUMED', a.id);
    res.json(view({ ...a, status }));
  });

  // the old key stops working immediately (AUTH-04)
  r.post('/:id/rotate-key', requireCsrf, (req, res) => {
    const a = owned(req);
    const apiKey = newKey();
    db.prepare('UPDATE agents SET api_key_hash = ? WHERE id = ?').run(sha256(apiKey), a.id);
    log(req, 'AGENT_KEY_ROTATED', a.id);
    res.json({ ...view(a), apiKey });
  });

  return r;
}

/** POST /api/kill-switch { on }: pauses every agent of this user at once, including actions already pending (J7). */
export function killSwitchRoutes(ctx: Ctx) {
  const r = Router();
  r.post('/', requireUser, requireCsrf, (req, res) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    ctx.db.prepare('UPDATE users SET kill_switch = ? WHERE id = ?').run(on ? 1 : 0, req.user!.id);
    ctx.audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: on ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF' });
    res.json({ killSwitch: on });
  });
  return r;
}
