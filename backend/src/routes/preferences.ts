import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError, notFound } from '../http';
import { requireAgent, requireCsrf, requireUser } from '../middleware/auth';
import { CATALOG } from '../services/catalog';
import { newId } from '../services/canonical';
import { MAX_RULES, MAX_TEXT, Rules, withLabels, type StoredRule } from '../services/preferences/rules';
import { parsePreferences } from '../services/preferences/parse';
import { confirmedRules, preferenceRow } from '../services/preferences/store';

const knownTool = (req: Request) => {
  const tool = String(req.params.tool);
  if (!Object.prototype.hasOwnProperty.call(CATALOG, tool)) throw notFound('Unknown tool');
  return tool;
};
const Text = z.string().max(MAX_TEXT);

/**
 * /api/tools/:tool/preferences: the user writes free text, sees what was understood, and confirms.
 * Only a confirmed save stores anything (both the text and the rules), and every save is audited.
 */
export function preferenceRoutes(ctx: Ctx) {
  const r = Router({ mergeParams: true });
  const { db, clock, audit } = ctx;
  r.use(requireUser);

  r.get('/', (req, res) => {
    const tool = knownTool(req);
    const row = preferenceRow(ctx, req.user!.id, tool);
    let rules: StoredRule[] = [], unreadable = false;
    try { rules = confirmedRules(ctx, req.user!.id, tool); } catch { unreadable = true; }
    res.json({ tool, text: row?.text ?? '', rules: withLabels(rules, tool), updatedAt: row ? new Date(row.updated_at).toISOString() : null, ...(unreadable ? { error: 'UNREADABLE' } : {}) });
  });

  // parse only: nothing is saved until the user confirms (CSRF because it may call the optional model)
  r.post('/parse', requireCsrf, async (req, res) => {
    const tool = knownTool(req);
    const { text } = z.object({ text: Text }).strict().parse(req.body);
    const out = await parsePreferences(text, tool, { model: ctx.preferenceModel, timeoutMs: ctx.preferenceModelTimeoutMs });
    res.json({ ...out, rules: withLabels(out.rules, tool) });
  });

  r.put('/', requireCsrf, (req, res) => {
    const tool = knownTool(req);
    const body = z.object({
      text: Text,
      // labels and ids come back from the confirm screen; ids are reassigned and labels recomputed, never stored
      rules: z.array(z.unknown()).max(MAX_RULES).transform(xs => xs.map(x => {
        if (!x || typeof x !== 'object') return x;
        const { label: _label, id: _id, ...rest } = x as Record<string, unknown>;
        return rest;
      })).pipe(Rules),
      confirmed: z.literal(true, { message: 'Confirm the rules before saving' })
    }).strict().parse(req.body);
    const before = preferenceRow(ctx, req.user!.id, tool);
    const rules: StoredRule[] = body.rules.map((rule, i) => ({ ...rule, id: `r${i + 1}` }));
    db.prepare(`INSERT INTO tool_preferences (id, user_id, tool, text, rules, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, tool) DO UPDATE SET text = excluded.text, rules = excluded.rules, updated_at = excluded.updated_at`)
      .run(newId('pref'), req.user!.id, tool, body.text, JSON.stringify(rules), clock.now());
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: 'PREFERENCE_CHANGED',
      data: { tool, oldText: before?.text ?? '', newText: body.text, rules: rules.length, hardRules: rules.filter(x => x.hard).length } });
    res.json({ tool, text: body.text, rules: withLabels(rules, tool), updatedAt: new Date(clock.now()).toISOString() });
  });

  return r;
}

/**
 * /api/agents/me/preferences: an agent may read the confirmed rules (never the raw text) for the tools it is
 * allowed to use, so it can follow them up front. Agents can never write preferences.
 */
export function agentSelfRoutes(ctx: Ctx) {
  const r = Router();
  r.get('/preferences', requireAgent, (req, res) => {
    const agent = req.agent!;
    const { tool } = z.object({ tool: z.string().max(64).optional() }).parse(req.query);
    const tools = (ctx.db.prepare('SELECT DISTINCT tool FROM permissions WHERE agent_id = ? AND allowed = 1').all(agent.id) as { tool: string }[])
      .map(t => t.tool).filter(t => !tool || t === tool);
    const preferences = tools.flatMap(t => {
      const row = preferenceRow(ctx, agent.user_id, t);
      if (!row) return [];
      try {
        const rules = confirmedRules(ctx, agent.user_id, t);
        return rules.length ? [{ tool: t, rules: withLabels(rules, t), updatedAt: new Date(row.updated_at).toISOString() }] : [];
      } catch { return []; }
    });
    res.json({ preferences });
  });
  r.all('/preferences', () => { throw new AppError(403, 'PERMISSION_DENIED', 'Agents can read preferences, never change them'); });
  return r;
}
