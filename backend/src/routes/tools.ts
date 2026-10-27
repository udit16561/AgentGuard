import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AgentRow, Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireCsrf, requireUser } from '../middleware/auth';
import { CATALOG, operationDef } from '../services/catalog';
import { newId } from '../services/canonical';
import { encrypt } from '../services/secrets';
import { AUTO_ALLOW_INTENTS, getPermission, Limits, permissionMatrix } from '../services/permissions';
import { liveStatus } from '../integrations/live';
import { revokeAtGoogle } from '../integrations/google/oauth';

interface ConnectionRow { tool: string; status: string; mode: string; connected_at: number }

export function toolRoutes(ctx: Ctx) {
  const r = Router();
  const { db, clock, config, audit } = ctx;
  r.use(requireUser);

  const knownTool = (req: Request) => {
    const tool = String(req.params.tool);
    if (!Object.prototype.hasOwnProperty.call(CATALOG, tool)) throw notFound('Unknown tool');
    return tool;
  };

  r.get('/', (req, res) => {
    const conns = new Map((db.prepare('SELECT tool, status, mode, connected_at FROM tool_connections WHERE user_id = ?').all(req.user!.id) as ConnectionRow[]).map(c => [c.tool, c]));
    res.json({ tools: Object.entries(CATALOG).map(([tool, def]) => {
      const c = conns.get(tool);
      return {
        tool, name: def.name,
        connected: c?.status === 'CONNECTED',
        // kept, not deleted, after a downgrade; reconnecting needs a plan that includes it
        pausedByPlan: c?.status === 'PAUSED_PLAN',
        locked: c?.status === 'CONNECTED' ? null : ctx.entitlements.lock(req.user!.id, { feature: 'tool', tool }),
        mode: c?.status === 'CONNECTED' ? c.mode : 'MOCK',
        live: liveStatus(ctx, req.user!.id, tool),
        connectedAt: c?.status === 'CONNECTED' ? new Date(c.connected_at).toISOString() : null,
        operations: Object.entries(def.operations).map(([operation, o]) => ({ operation, label: o.label, intent: o.intent, write: o.write }))
      };
    }) });
  });

  // mock OAuth: stores an encrypted placeholder token. Live mode is a separate, confirmed step (routes/oauth.ts).
  r.post('/:tool/connect', requireCsrf, (req, res) => {
    const tool = knownTool(req);
    const existing = db.prepare('SELECT status, mode FROM tool_connections WHERE user_id = ? AND tool = ?').get(req.user!.id, tool) as { status: string; mode: string } | undefined;
    // already live: "Connect" never quietly drops the Google sign-in
    if (existing?.status === 'CONNECTED' && existing.mode === 'LIVE') { res.json({ tool, connected: true, mode: 'LIVE' }); return; }
    ctx.entitlements.require(req.user!.id, { feature: 'tool', tool });
    const token = encrypt(config.tokenEncryptionKey, `mock-token-${crypto.randomBytes(12).toString('hex')}`);
    db.prepare(`INSERT INTO tool_connections (id, user_id, tool, status, encrypted_token, scopes, mode, connected_at) VALUES (?, ?, ?, 'CONNECTED', ?, '[]', 'MOCK', ?)
      ON CONFLICT(user_id, tool) DO UPDATE SET status = 'CONNECTED', encrypted_token = excluded.encrypted_token, mode = 'MOCK', connected_at = excluded.connected_at`)
      .run(newId('con'), req.user!.id, tool, token, clock.now());
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: 'TOOL_CONNECTED', data: { tool, mode: 'MOCK' } });
    res.json({ tool, connected: true, mode: 'MOCK' });
  });

  // one-tap revoke: switches off every permission for the tool and blocks its pending actions (PRM-03, J7)
  r.delete('/:tool', requireCsrf, async (req, res) => {
    const tool = knownTool(req);
    const userId = req.user!.id;
    // a live sign-in is revoked at Google too (best effort), and the tokens are removed here either way
    const revoked = await revokeAtGoogle(ctx, userId, tool);
    const disconnect = db.transaction(() => {
      db.prepare("UPDATE tool_connections SET status = 'DISCONNECTED', encrypted_token = NULL, mode = 'MOCK', live_state = NULL, live_since = NULL WHERE user_id = ? AND tool = ?").run(userId, tool);
      const perms = db.prepare(`SELECT p.agent_id, p.operation FROM permissions p JOIN agents a ON a.id = p.agent_id WHERE a.user_id = ? AND p.tool = ? AND p.allowed = 1`).all(userId, tool) as { agent_id: string; operation: string }[];
      db.prepare('UPDATE permissions SET allowed = 0, updated_at = ? WHERE tool = ? AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)').run(clock.now(), tool, userId);
      for (const p of perms) audit.append({ userId, actorType: 'SYSTEM', actorId: null, eventType: 'PERMISSION_CHANGED', data: { agentId: p.agent_id, tool, operation: p.operation, allowed: false, reason: 'TOOL_DISCONNECTED' } });
      const pending = db.prepare("SELECT id, agent_id FROM actions WHERE user_id = ? AND tool = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW')").all(userId, tool) as { id: string; agent_id: string }[];
      db.prepare("UPDATE actions SET status = 'BLOCKED', block_reason = 'TOOL_DISCONNECTED', updated_at = ? WHERE user_id = ? AND tool = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW')").run(clock.now(), userId, tool);
      for (const a of pending) audit.append({ userId, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_BLOCKED', actionId: a.id, data: { agentId: a.agent_id, tool, reason: 'TOOL_DISCONNECTED' } });
      audit.append({ userId, actorType: 'USER', actorId: userId, eventType: 'TOOL_DISCONNECTED', data: { tool, permissionsDisabled: perms.length, actionsBlocked: pending.length, ...(revoked ? { revokedAtGoogle: true } : {}) } });
    });
    disconnect();
    res.json({ tool, connected: false });
  });

  return r;
}

const PermissionChange = z.object({
  tool: z.string().max(64),
  operation: z.string().max(64),
  allowed: z.boolean(),
  limits: Limits.optional()
});

/** GET/PUT /api/agents/:id/permissions. User session only; an agent key gets 401 (SEC-14). */
export function permissionRoutes(ctx: Ctx) {
  const r = Router({ mergeParams: true });
  const { db, clock, audit } = ctx;
  r.use(requireUser);

  const owned = (req: Request) => {
    const a = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.id) as AgentRow | undefined;
    if (!a) throw notFound('Agent not found');
    return a;
  };

  r.get('/', (req, res) => { res.json({ permissions: permissionMatrix(db, owned(req).id) }); });

  // each write operation is its own toggle; every change is audited (PRM-02)
  r.put('/', requireCsrf, (req, res) => {
    const agent = owned(req);
    const { permissions } = z.object({ permissions: z.array(PermissionChange).min(1).max(100) }).parse(req.body);
    for (const p of permissions) {
      const def = operationDef(p.tool, p.operation);
      if (!def) throw new AppError(400, 'VALIDATION_ERROR', `Unknown operation ${p.tool}.${p.operation}`);
      // auto-allow exists only for reads and alarms; anything that sends, posts, pays or deletes always asks (AUTO-04)
      if (p.limits?.autoAllow && !AUTO_ALLOW_INTENTS.includes(def.intent)) throw new AppError(400, 'VALIDATION_ERROR', `${p.tool}.${p.operation} can never be auto-allowed`);
    }
    const save = db.transaction(() => {
      for (const p of permissions) {
        const before = getPermission(db, agent.id, p.tool, p.operation);
        const limits = p.limits ?? before.limits;   // leaving limits out keeps the existing ones
        if (before.allowed === p.allowed && JSON.stringify(before.limits) === JSON.stringify(limits)) continue;
        db.prepare(`INSERT INTO permissions (id, agent_id, tool, operation, allowed, limits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, tool, operation) DO UPDATE SET allowed = excluded.allowed, limits = excluded.limits, updated_at = excluded.updated_at`)
          .run(newId('prm'), agent.id, p.tool, p.operation, p.allowed ? 1 : 0, JSON.stringify(limits), clock.now());
        audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: 'PERMISSION_CHANGED', data: { agentId: agent.id, tool: p.tool, operation: p.operation, allowed: p.allowed, limits } });
      }
    });
    save();
    res.json({ permissions: permissionMatrix(db, agent.id) });
  });

  return r;
}
