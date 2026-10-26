import type { Db } from '../db';

/**
 * Plan entitlements (docs/PLANS_AND_ENTITLEMENTS.md), stored as JSON on the plan row and read only through
 * EntitlementService (services/entitlements.ts). This is the one place plan names appear.
 * Safety features (approvals, kill switch, in-app alerts, the audit log) are never listed here: they are never paywalled.
 * Prices are mock values for the prototype.
 */
export const PLANS = {
  starter: { name: 'Starter', priceInr: 0, entitlements: {
    maxAgents: 1, maxConnectedTools: 3, toolCatalog: ['gmail', 'calendar', 'clock'], riskExplanations: 'basic', customPolicies: 'none',
    auditRetentionDays: 30, auditExport: [], pushAlerts: ['in_app'], liveIntegrations: false,
    modelRoles: { roles: ['guard'], guardTiers: ['local', 'small'] }
  } },
  plus: { name: 'Plus', priceInr: 299, entitlements: {
    maxAgents: 3, maxConnectedTools: 6, toolCatalog: ['gmail', 'calendar', 'clock', 'whatsapp', 'linkedin', 'payments'], riskExplanations: 'detailed', customPolicies: 'limits',
    auditRetentionDays: 180, auditExport: ['csv'], pushAlerts: ['in_app', 'push'], liveIntegrations: true,
    modelRoles: { roles: ['agent', 'guard'], guardTiers: ['local', 'small', 'frontier', 'unknown'] }
  } },
  pro: { name: 'Pro', priceInr: 799, entitlements: {
    maxAgents: 10, maxConnectedTools: null, toolCatalog: ['gmail', 'calendar', 'clock', 'whatsapp', 'linkedin', 'payments', 'instagram', 'x', 'blog', 'custom'], riskExplanations: 'detailed_tone', customPolicies: 'full',
    auditRetentionDays: 730, auditExport: ['csv', 'json', 'integrity'], pushAlerts: ['in_app', 'push', 'email_digest'], liveIntegrations: true,
    modelRoles: { roles: ['agent', 'guard'], guardTiers: ['local', 'small', 'frontier', 'unknown'] }
  } }
} as const;

export type PlanId = keyof typeof PLANS;
export const PLAN_IDS = Object.keys(PLANS) as [PlanId, ...PlanId[]];
export const DEFAULT_PLAN: PlanId = 'plus';   // docs/DECISIONS.md A

export function seedPlans(db: Db) {
  const upsert = db.prepare('INSERT INTO plans (id, name, entitlements) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, entitlements = excluded.entitlements');
  for (const [id, plan] of Object.entries(PLANS)) upsert.run(id, plan.name, JSON.stringify(plan.entitlements));
}
