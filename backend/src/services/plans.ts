import type { Db } from '../db';

/**
 * Plan entitlements (docs/PLANS_AND_ENTITLEMENTS.md). Stored as JSON on the plan row; enforcement is milestone M3.
 * Safety features (approvals, kill switch, basic audit, alerts) are never listed here, because they are never paywalled.
 */
export const PLANS = {
  starter: { name: 'Starter', entitlements: { maxAgents: 1, maxConnectedTools: 3, toolCatalog: ['gmail', 'calendar', 'clock'], riskExplanations: 'basic', customPolicies: 'none', auditRetentionDays: 30, auditExport: [], pushAlerts: ['in_app'], liveIntegrations: false } },
  plus: { name: 'Plus', entitlements: { maxAgents: 3, maxConnectedTools: 6, toolCatalog: ['gmail', 'calendar', 'clock', 'whatsapp', 'linkedin', 'payments'], riskExplanations: 'detailed', customPolicies: 'limits', auditRetentionDays: 180, auditExport: ['csv'], pushAlerts: ['in_app', 'push'], liveIntegrations: true } },
  pro: { name: 'Pro', entitlements: { maxAgents: 10, maxConnectedTools: null, toolCatalog: ['gmail', 'calendar', 'clock', 'whatsapp', 'linkedin', 'payments', 'instagram', 'x', 'blog', 'custom'], riskExplanations: 'detailed_tone', customPolicies: 'full', auditRetentionDays: 730, auditExport: ['csv', 'json', 'integrity'], pushAlerts: ['in_app', 'push', 'email_digest'], liveIntegrations: true } }
} as const;

export type PlanId = keyof typeof PLANS;
export const DEFAULT_PLAN: PlanId = 'plus';   // docs/DECISIONS.md A

export function seedPlans(db: Db) {
  const upsert = db.prepare('INSERT INTO plans (id, name, entitlements) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, entitlements = excluded.entitlements');
  for (const [id, plan] of Object.entries(PLANS)) upsert.run(id, plan.name, JSON.stringify(plan.entitlements));
}
