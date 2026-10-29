import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireCsrf, requireReauth, requireUser } from '../middleware/auth';
import { newId } from '../services/canonical';
import { encrypt } from '../services/secrets';
import { CATALOG, priceOf, PROVIDERS, providerInfo, ROLES, type Role } from '../models/catalog';
import { checkBaseUrl } from '../models/baseUrl';
import { testModel } from '../models/guard';
import { ensureAssistant, getModel, listModels, modelView, roleRow, rolesView, setRole, type ModelRow } from '../models/store';

const ApiKey = z.string().trim().min(8).max(500).regex(/^\S+$/, 'An API key has no spaces');
const AddBody = z.object({
  provider: z.enum(PROVIDERS),
  modelId: z.string().trim().min(1).max(120).regex(/^[\w.:/@+-]+$/, 'Letters, digits and . : / @ + - _ only'),
  apiKey: ApiKey.optional(),
  baseUrl: z.string().trim().max(300).optional(),
  label: z.string().trim().min(1).max(60)
}).strict();
const Cap = z.number().positive().max(10_000).nullable();
const RolesBody = z.object({
  agent: z.string().max(64).nullable(),
  guard: z.string().max(64).nullable(),
  caps: z.object({ agent: Cap.optional(), guard: Cap.optional() }).strict().optional()
}).strict();

const last4 = (key: string) => key.slice(-4);

/**
 * /api/models (docs/MODEL_PROVIDERS.md §6). Owner only: agent keys get 401 everywhere here. Adding, testing,
 * rotating and deleting keys need CSRF and a fresh password check; every change is audited without the key.
 */
export function modelRoutes(ctx: Ctx) {
  const r = Router();
  const { db, clock, audit, config } = ctx;
  r.use(requireUser);
  const reauth = requireReauth(ctx);

  const owned = (req: Request): ModelRow => {
    const m = getModel(ctx, req.user!.id, String(req.params.id));
    if (!m) throw notFound('Model not found');
    return m;
  };
  const log = (req: Request, eventType: string, data: Record<string, unknown>) =>
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType, data });
  const about = (m: ModelRow) => ({ modelConfigId: m.id, provider: m.provider, model: m.model_id, label: m.label });
  const listing = (userId: string) => ({ models: listModels(ctx, userId).map(modelView), ...rolesView(ctx, userId) });

  r.get('/catalog', (_req, res) => { res.json(CATALOG); });
  r.get('/', (req, res) => { res.json(listing(req.user!.id)); });

  r.post('/', requireCsrf, reauth, (req, res) => {
    const body = AddBody.parse(req.body);
    const info = providerInfo(body.provider);
    // native providers use their own endpoints: no custom URL (this is also what keeps Anthropic off its OpenAI-compat endpoint)
    if (info.kind !== 'openai-compatible' && body.baseUrl) throw new AppError(400, 'VALIDATION_ERROR', `${info.name} uses its own endpoint; a base URL is not allowed`);
    if (info.needsKey && !body.apiKey) throw new AppError(400, 'VALIDATION_ERROR', `${info.name} needs an API key`);
    let baseUrl: string | null = null;
    if (info.kind === 'openai-compatible') {
      const raw = body.baseUrl || info.defaultBaseUrl;
      if (!raw) throw new AppError(400, 'VALIDATION_ERROR', 'A base URL is required for this provider');
      const check = checkBaseUrl(raw);
      if (!check.ok) throw new AppError(400, 'VALIDATION_ERROR', `Base URL refused: ${check.reason}`);
      baseUrl = check.url;
    }
    const m: ModelRow = {
      id: newId('mdl'), user_id: req.user!.id, provider: body.provider, model_id: body.modelId, label: body.label, base_url: baseUrl,
      api_key_enc: body.apiKey ? encrypt(config.tokenEncryptionKey, body.apiKey) : null, key_last4: body.apiKey ? last4(body.apiKey) : null,
      last_test_at: null, last_test_ok: null, guard_capable: null, created_at: clock.now()
    };
    db.prepare(`INSERT INTO model_configs (id, user_id, provider, model_id, label, base_url, api_key_enc, key_last4, last_test_at, last_test_ok, guard_capable, created_at)
      VALUES (@id, @user_id, @provider, @model_id, @label, @base_url, @api_key_enc, @key_last4, @last_test_at, @last_test_ok, @guard_capable, @created_at)`).run(m);
    log(req, 'MODEL_KEY_ADDED', { ...about(m), baseUrl, hasKey: !!body.apiKey });
    res.status(201).json(modelView(m));
  });

  r.post('/:id/test', requireCsrf, reauth, async (req, res) => {
    const m = owned(req);
    const out = await testModel(ctx, req.user!.id, m);
    db.prepare('UPDATE model_configs SET last_test_at = ?, last_test_ok = ?, guard_capable = ? WHERE id = ?')
      .run(clock.now(), out.ok ? 1 : 0, out.guard ? (out.guard.passed ? 1 : 0) : 0, m.id);
    res.json(out);
  });

  r.put('/roles', requireCsrf, (req, res) => {
    const body = RolesBody.parse(req.body);
    const userId = req.user!.id;
    const next = {} as Record<Role, { model: ModelRow | null; cap: number | null }>;
    for (const role of ROLES) {
      const id = body[role];
      const model = id ? getModel(ctx, userId, id) ?? null : null;
      if (id && !model) throw new AppError(400, 'VALIDATION_ERROR', `Unknown model for the ${role} role`);
      if (model && model.last_test_ok !== 1) throw new AppError(400, 'VALIDATION_ERROR', `Run a successful Test connection for “${model.label}” first`);
      if (model) ctx.entitlements.require(userId, { feature: 'modelRole', role, model });
      if (role === 'guard' && model?.provider === 'offline') throw new AppError(400, 'VALIDATION_ERROR', 'The offline assistant is not AI, so it cannot be the guard; the built-in rules already check every action');
      if (role === 'guard' && model && model.guard_capable !== 1) throw new AppError(400, 'VALIDATION_ERROR', `“${model.label}” failed the structured-output test, so it cannot be the guard`);
      const cap = body.caps?.[role] === undefined ? roleRow(ctx, userId, role).monthly_cap_usd : body.caps[role]!;
      if (model && cap != null && !priceOf(model.provider, model.model_id)) throw new AppError(400, 'VALIDATION_ERROR', `A spend cap needs a known price, and “${model.label}” is not in the catalog`);
      next[role] = { model, cap };
    }
    for (const role of ROLES) {
      const before = roleRow(ctx, userId, role);
      const { model, cap } = next[role];
      if (before.model_config_id === (model?.id ?? null) && before.monthly_cap_usd === cap) continue;
      setRole(ctx, userId, role, model?.id ?? null, cap);
      log(req, 'MODEL_ROLE_CHANGED', { role, from: before.model_config_id, to: model?.id ?? null, provider: model?.provider ?? null, model: model?.model_id ?? null, capUsd: cap });
    }
    if (next.agent.model) ensureAssistant(ctx, userId);
    res.json(listing(userId));
  });

  r.put('/:id/key', requireCsrf, reauth, (req, res) => {
    const m = owned(req);
    const { apiKey } = z.object({ apiKey: ApiKey }).strict().parse(req.body);
    db.prepare('UPDATE model_configs SET api_key_enc = ?, key_last4 = ? WHERE id = ?').run(encrypt(config.tokenEncryptionKey, apiKey), last4(apiKey), m.id);
    log(req, 'MODEL_KEY_ADDED', { ...about(m), rotated: true });
    res.json(modelView({ ...m, key_last4: last4(apiKey) }));
  });

  r.delete('/:id', requireCsrf, reauth, (req, res) => {
    const m = owned(req);
    for (const role of ROLES) {
      const row = roleRow(ctx, req.user!.id, role);
      if (row.model_config_id !== m.id) continue;
      setRole(ctx, req.user!.id, role, null, row.monthly_cap_usd);
      log(req, 'MODEL_ROLE_CHANGED', { role, from: m.id, to: null, reason: 'MODEL_REMOVED' });
    }
    db.prepare('DELETE FROM model_configs WHERE id = ?').run(m.id);
    log(req, 'MODEL_KEY_REMOVED', about(m));
    res.json({ ok: true });
  });

  return r;
}
