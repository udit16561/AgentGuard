import type { Ctx } from '../../context';
import { operationDef } from '../catalog';
import { StoredRules, type StoredRule } from './rules';
import { checkPreferences, type PreferenceReport } from './check';

export interface PreferenceRow { id: string; user_id: string; tool: string; text: string; rules: string; updated_at: number }

export const preferenceRow = (ctx: Ctx, userId: string, tool: string) =>
  ctx.db.prepare('SELECT * FROM tool_preferences WHERE user_id = ? AND tool = ?').get(userId, tool) as PreferenceRow | undefined;

/** The confirmed rules for one tool. Throws if the stored rules cannot be read, so callers fail closed. */
export function confirmedRules(ctx: Ctx, userId: string, tool: string): StoredRule[] {
  const row = preferenceRow(ctx, userId, tool);
  return row ? StoredRules.parse(JSON.parse(row.rules)) as StoredRule[] : [];
}

/**
 * The preference check for one proposed action: null for reads or when the tool has no rules,
 * otherwise what was followed and what was broken. Any error becomes `error: true` (fail closed).
 */
export function evaluatePreferences(ctx: Ctx, a: { userId: string; timeZone: string; tool: string; operation: string; payload: Record<string, unknown>; knownRecipients: string[] }): PreferenceReport | null {
  if (!operationDef(a.tool, a.operation)?.write) return null;
  try {
    const rules = confirmedRules(ctx, a.userId, a.tool);
    if (!rules.length) return null;
    return checkPreferences(rules, { tool: a.tool, operation: a.operation, payload: a.payload, now: ctx.clock.now(), timeZone: a.timeZone, knownRecipients: a.knownRecipients });
  } catch {
    return { followed: [], broken: [], error: true };
  }
}
