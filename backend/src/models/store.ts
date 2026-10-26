import crypto from 'node:crypto';
import type { LanguageModelUsage } from 'ai';
import type { AgentRow, Ctx } from '../context';
import { newId, sha256 } from '../services/canonical';
import { decrypt } from '../services/secrets';
import { zonedParts } from '../services/time';
import { costUsd, priceOf, ROLES, type Provider, type Role } from './catalog';
import type { ModelSpec } from './providers';

/**
 * The user's own models (docs/MODEL_PROVIDERS.md). Keys stay encrypted in the database and are decrypted only to
 * build a model for a call; nothing here ever returns a key to a route, a log or the audit log.
 */
export interface ModelRow {
  id: string; user_id: string; provider: Provider; model_id: string; label: string; base_url: string | null;
  api_key_enc: string | null; key_last4: string | null; last_test_at: number | null; last_test_ok: number | null; guard_capable: number | null; created_at: number;
}
interface RoleRow { user_id: string; role: Role; model_config_id: string | null; monthly_cap_usd: number | null; updated_at: number }

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const flag = (n: number | null) => (n == null ? null : n === 1);

export const modelView = (m: ModelRow) => ({
  id: m.id, provider: m.provider, modelId: m.model_id, label: m.label, baseUrl: m.base_url,
  keyHint: m.key_last4 ? `••••${m.key_last4}` : null,
  testedAt: iso(m.last_test_at), testOk: flag(m.last_test_ok), guardCapable: flag(m.guard_capable),
  price: priceOf(m.provider, m.model_id), createdAt: iso(m.created_at)
});

export const getModel = (ctx: Ctx, userId: string, id: string) =>
  ctx.db.prepare('SELECT * FROM model_configs WHERE id = ? AND user_id = ?').get(id, userId) as ModelRow | undefined;

export const listModels = (ctx: Ctx, userId: string) =>
  ctx.db.prepare('SELECT * FROM model_configs WHERE user_id = ? ORDER BY created_at').all(userId) as ModelRow[];

/** The only place a key is decrypted: straight into the spec handed to the model factory. */
export const specOf = (ctx: Ctx, m: ModelRow): ModelSpec => ({
  provider: m.provider, modelId: m.model_id, baseUrl: m.base_url,
  apiKey: m.api_key_enc ? decrypt(ctx.config.tokenEncryptionKey, m.api_key_enc) : null
});

export function roleRow(ctx: Ctx, userId: string, role: Role): RoleRow {
  return (ctx.db.prepare('SELECT * FROM model_roles WHERE user_id = ? AND role = ?').get(userId, role) as RoleRow | undefined)
    ?? { user_id: userId, role, model_config_id: null, monthly_cap_usd: null, updated_at: 0 };
}

export function setRole(ctx: Ctx, userId: string, role: Role, modelId: string | null, cap: number | null) {
  ctx.db.prepare(`INSERT INTO model_roles (user_id, role, model_config_id, monthly_cap_usd, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, role) DO UPDATE SET model_config_id = excluded.model_config_id, monthly_cap_usd = excluded.monthly_cap_usd, updated_at = excluded.updated_at`)
    .run(userId, role, modelId, cap, ctx.clock.now());
}

function monthStart(ctx: Ctx, userId: string) {
  const tz = (ctx.db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as { timezone: string } | undefined)?.timezone ?? 'Asia/Kolkata';
  return zonedParts(ctx.clock.now(), tz).startOfMonth;
}

/** Approximate USD spent by a role this calendar month (from the SDK's token counts and the catalog price). */
export function monthSpend(ctx: Ctx, userId: string, role: Role) {
  const row = ctx.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM model_usage WHERE user_id = ? AND role = ? AND created_at >= ?')
    .get(userId, role, monthStart(ctx, userId)) as { spent: number };
  return row.spent;
}

export function roleState(ctx: Ctx, userId: string, role: Role) {
  const r = roleRow(ctx, userId, role);
  const model = r.model_config_id ? getModel(ctx, userId, r.model_config_id) ?? null : null;
  const spent = monthSpend(ctx, userId, role);
  const capped = !!model && r.monthly_cap_usd != null && spent >= r.monthly_cap_usd;
  // after a downgrade the role is kept but switched off until the plan includes it again
  const planOff = !!model && !ctx.entitlements.can(userId, { feature: 'modelRole', role, model });
  return { model, cap: r.monthly_cap_usd, spent, active: !!model && !capped && !planOff, offReason: !model ? null : planOff ? 'PLAN' : capped ? 'SPEND_CAP' : null };
}

export function rolesView(ctx: Ctx, userId: string) {
  const roles = Object.fromEntries(ROLES.map(role => {
    const s = roleState(ctx, userId, role);
    return [role, { ...s, model: s.model ? modelView(s.model) : null, spent: Math.round(s.spent * 1e6) / 1e6 }];
  })) as Record<Role, ReturnType<typeof roleState> & { model: ReturnType<typeof modelView> | null }>;
  // one model checking itself is weaker: recommend a different provider for the guard
  const warnings = roles.agent.model && roles.guard.model && roles.agent.model.provider === roles.guard.model.provider ? ['SAME_PROVIDER'] : [];
  return { roles, warnings };
}

/** The model to use for a role right now, or null: no model assigned, or the monthly cap is reached (fall back to rules). */
export function activeModel(ctx: Ctx, userId: string, role: Role) {
  const s = roleState(ctx, userId, role);
  return s.active && s.model ? s.model : null;
}

/** Records token usage; when a call takes a role over its cap, the role switches off and that is audited once. */
export function recordUsage(ctx: Ctx, userId: string, role: Role | null, m: ModelRow, usage: Partial<LanguageModelUsage> | undefined) {
  const input = usage?.inputTokens ?? 0, output = usage?.outputTokens ?? 0;
  const cap = role ? roleRow(ctx, userId, role).monthly_cap_usd : null;
  const before = role ? monthSpend(ctx, userId, role) : 0;
  const cost = costUsd(priceOf(m.provider, m.model_id), input, output);
  ctx.db.prepare('INSERT INTO model_usage (id, user_id, role, model_config_id, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('use'), userId, role, m.id, input, output, cost, ctx.clock.now());
  if (role && cap != null && before < cap && before + (cost ?? 0) >= cap) {
    ctx.audit.append({ userId, actorType: 'SYSTEM', actorId: null, eventType: 'MODEL_ROLE_CHANGED',
      data: { role, reason: 'SPEND_CAP', modelConfigId: m.id, provider: m.provider, model: m.model_id, capUsd: cap, active: false } });
  }
}

/** The built-in Assistant is an ordinary agent row. Its API key is random and thrown away: nobody can use it from outside. */
export function ensureAssistant(ctx: Ctx, userId: string): AgentRow {
  const found = ctx.db.prepare("SELECT * FROM agents WHERE user_id = ? AND kind = 'assistant' AND status != 'REVOKED' LIMIT 1").get(userId) as AgentRow | undefined;
  if (found) return found;
  const agent: AgentRow = { id: newId('agt'), user_id: userId, name: 'Assistant', model: null, api_key_hash: sha256(crypto.randomBytes(32).toString('base64url')), status: 'ACTIVE', created_at: ctx.clock.now() };
  ctx.db.prepare("INSERT INTO agents (id, user_id, name, model, api_key_hash, status, kind, created_at) VALUES (@id, @user_id, @name, @model, @api_key_hash, @status, 'assistant', @created_at)").run(agent);
  ctx.audit.append({ userId, actorType: 'USER', actorId: userId, eventType: 'AGENT_CREATED', data: { agentId: agent.id, name: agent.name, kind: 'assistant' } });
  return agent;
}
