import type { AgentRow, Ctx } from '../context';
import { AppError } from '../http';
import { modelTier, type ModelTier, type Role } from '../models/catalog';
import { PLANS, type PlanId } from './plans';

/**
 * EntitlementService (docs/PLANS_AND_ENTITLEMENTS.md): every plan check in the app goes through here, reading the
 * entitlements JSON on the user's plan row. Plans unlock features and limits; they never grant tool access, and
 * these are never locked on any plan: approvals, the kill switch, alerts (in-app and live) and the audit log.
 * A downgrade pauses what no longer fits (agents, tools) and keeps everything; an upgrade resumes it.
 */
export interface Entitlements {
  maxAgents: number;
  maxConnectedTools: number | null;
  toolCatalog: string[];
  auditRetentionDays: number;
  auditExport: string[];
  pushAlerts: string[];
  modelRoles: { roles: Role[]; guardTiers: ModelTier[] };
  [key: string]: unknown;
}

export const NEVER_LOCKED = ['approvals', 'killSwitch', 'alerts', 'liveAlerts', 'audit', 'auditVerify'];

export type Check =
  | { feature: 'agents' }
  | { feature: 'tool'; tool: string }
  | { feature: 'auditExport'; format: string }
  | { feature: 'pushAlerts' }
  | { feature: 'liveIntegrations' }
  | { feature: 'modelRole'; role: Role; model: { provider: string; model_id: string; base_url: string | null } };

const LABEL: Record<Check['feature'], string> = {
  agents: 'more agents', tool: 'this tool', auditExport: 'this audit export', pushAlerts: 'phone alerts', liveIntegrations: 'live integrations', modelRole: 'this model role'
};

interface ConnRow { tool: string; status: string; connected_at: number }

export function entitlementService(ctx: Ctx) {
  const { db } = ctx;
  const planOf = (userId: string) => (db.prepare('SELECT plan_id FROM users WHERE id = ?').get(userId) as { plan_id: string }).plan_id;
  const entitlementsOfPlan = (planId: string) =>
    JSON.parse((db.prepare('SELECT entitlements FROM plans WHERE id = ?').get(planId) as { entitlements: string }).entitlements) as Entitlements;
  const activeAgents = (userId: string) => (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE user_id = ? AND status = 'ACTIVE'").get(userId) as { n: number }).n;
  const connectedTools = (userId: string) => (db.prepare("SELECT COUNT(*) AS n FROM tool_connections WHERE user_id = ? AND status = 'CONNECTED'").get(userId) as { n: number }).n;

  /** Pure check against one set of entitlements (used for the user's plan, and to find the plan that unlocks a feature). */
  function allows(e: Entitlements, c: Check, usage?: { agents: number; tools: number }): boolean {
    switch (c.feature) {
      case 'agents': return (usage?.agents ?? 0) < e.maxAgents;
      case 'tool': return e.toolCatalog.includes(c.tool) && (e.maxConnectedTools == null || (usage?.tools ?? 0) < e.maxConnectedTools);
      case 'auditExport': return e.auditExport.includes(c.format);
      case 'pushAlerts': return e.pushAlerts.includes('push');
      case 'liveIntegrations': return e.liveIntegrations === true;
      case 'modelRole': return e.modelRoles.roles.includes(c.role) && (c.role !== 'guard' || e.modelRoles.guardTiers.includes(modelTier(c.model)));
    }
  }

  /** The cheapest plan that would allow this (for "Upgrade to unlock"). */
  function upgradeTo(c: Check, usage?: { agents: number; tools: number }): PlanId | null {
    const plans = (Object.keys(PLANS) as PlanId[]).sort((a, b) => PLANS[a].priceInr - PLANS[b].priceInr);
    return plans.find(p => allows(entitlementsOfPlan(p), c, usage)) ?? null;
  }

  function usageFor(userId: string, c: Check) {
    return { agents: activeAgents(userId), tools: c.feature === 'tool' && isConnected(userId, c.tool) ? connectedTools(userId) - 1 : connectedTools(userId) };
  }
  const isConnected = (userId: string, tool: string) =>
    !!db.prepare("SELECT 1 FROM tool_connections WHERE user_id = ? AND tool = ? AND status = 'CONNECTED'").get(userId, tool);

  const can = (userId: string, c: Check) => allows(entitlementsOfPlan(planOf(userId)), c, usageFor(userId, c));

  /** Throws 402 ENTITLEMENT_REQUIRED ("Upgrade to unlock …") when the user's plan does not allow it. */
  function require(userId: string, c: Check) {
    if (can(userId, c)) return;
    const usage = usageFor(userId, c);
    const to = upgradeTo(c, usage);
    const why = c.feature === 'agents' ? 'your plan’s agent limit is reached' : c.feature === 'tool' && entitlementsOfPlan(planOf(userId)).toolCatalog.includes(c.tool) ? 'your plan’s connected-tool limit is reached' : 'not included in your plan';
    throw new AppError(402, 'ENTITLEMENT_REQUIRED', `Upgrade to unlock ${LABEL[c.feature]}: ${why}${to ? ` (available on ${PLANS[to].name})` : ''}.`, undefined, { upgradeTo: to });
  }

  /** What switching to `planId` would pause (agents beyond the limit, newest first; tools outside the catalog or limit). */
  function previewChange(userId: string, planId: PlanId) {
    const e = entitlementsOfPlan(planId);
    // built-in Assistant last, then oldest first: the oldest external agents stay on
    const agents = db.prepare("SELECT * FROM agents WHERE user_id = ? AND status = 'ACTIVE' ORDER BY (kind = 'assistant'), created_at").all(userId) as AgentRow[];
    const pauseAgents = agents.slice(e.maxAgents);
    const conns = db.prepare("SELECT tool, status, connected_at FROM tool_connections WHERE user_id = ? AND status = 'CONNECTED' ORDER BY connected_at").all(userId) as ConnRow[];
    const inCatalog = conns.filter(c => e.toolCatalog.includes(c.tool));
    const keep = new Set(inCatalog.slice(0, e.maxConnectedTools ?? undefined).map(c => c.tool));
    return { pauseAgents, pauseTools: conns.filter(c => !keep.has(c.tool)).map(c => c.tool) };
  }

  /** Switch plan (mock billing): pause what no longer fits, resume plan-paused items that fit again. Nothing is deleted. */
  function changePlan(userId: string, planId: PlanId) {
    const from = planOf(userId);
    const run = db.transaction(() => {
      db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(planId, userId);
      const e = entitlementsOfPlan(planId);
      // resume first (oldest first), up to the new limits
      const resumedAgents: string[] = [], resumedTools: string[] = [];
      for (const a of db.prepare("SELECT * FROM agents WHERE user_id = ? AND status = 'PAUSED' AND paused_by_plan = 1 ORDER BY created_at").all(userId) as AgentRow[]) {
        if (activeAgents(userId) >= e.maxAgents) break;
        db.prepare("UPDATE agents SET status = 'ACTIVE', paused_by_plan = 0 WHERE id = ?").run(a.id);
        resumedAgents.push(a.id);
      }
      for (const c of db.prepare("SELECT tool, status, connected_at FROM tool_connections WHERE user_id = ? AND status = 'PAUSED_PLAN' ORDER BY connected_at").all(userId) as ConnRow[]) {
        if (!e.toolCatalog.includes(c.tool) || (e.maxConnectedTools != null && connectedTools(userId) >= e.maxConnectedTools)) continue;
        db.prepare("UPDATE tool_connections SET status = 'CONNECTED' WHERE user_id = ? AND tool = ?").run(userId, c.tool);
        resumedTools.push(c.tool);
      }
      const { pauseAgents, pauseTools } = previewChange(userId, planId);
      for (const a of pauseAgents) db.prepare("UPDATE agents SET status = 'PAUSED', paused_by_plan = 1 WHERE id = ?").run(a.id);
      for (const t of pauseTools) db.prepare("UPDATE tool_connections SET status = 'PAUSED_PLAN' WHERE user_id = ? AND tool = ?").run(userId, t);
      return { pausedAgents: pauseAgents.map(a => a.id), pausedTools: pauseTools, resumedAgents, resumedTools };
    });
    const out = run();
    ctx.audit.append({ userId, actorType: 'USER', actorId: userId, eventType: 'PLAN_CHANGED', data: { from, to: planId, ...out, billing: 'mock' } });
    return { from, ...out };
  }

  /** For the UI: null when allowed, else the plan that unlocks it ("Upgrade to unlock"). */
  const lock = (userId: string, c: Check) => (can(userId, c) ? null : { upgradeTo: upgradeTo(c, usageFor(userId, c)) });

  return {
    planOf, can, require, lock, previewChange, changePlan,
    entitlements: (userId: string) => entitlementsOfPlan(planOf(userId)),
    usage: (userId: string) => ({ agents: activeAgents(userId), connectedTools: connectedTools(userId) })
  };
}
export type EntitlementService = ReturnType<typeof entitlementService>;
