import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { requireUser } from '../middleware/auth';
import { canonicalJSON, sha256 } from '../services/canonical';

const time = z.union([z.coerce.number(), z.string().datetime().transform(s => Date.parse(s))]).optional();
const Filters = z.object({
  from: time, to: time,
  agent: z.string().max(64).optional(),
  tool: z.string().max(64).optional(),
  eventType: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional()
});
const DAY = 86_400_000;

const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // quote everything; neutralise spreadsheet formulas in agent-supplied text
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/**
 * Read-only by design: only GET routes exist, so PUT/PATCH/DELETE fall through to 404 (SEC-16).
 * The audit log is never locked; the plan only sets how far back it is shown (older events are kept, and the chain
 * check always covers everything) and which export formats are offered.
 */
export function auditRoutes(ctx: Ctx) {
  const r = Router();
  const cutoff = (userId: string) => ctx.clock.now() - ctx.entitlements.entitlements(userId).auditRetentionDays * DAY;

  r.get('/', requireUser, (req, res) => {
    const userId = req.user!.id;
    const f = Filters.parse(req.query);
    const since = cutoff(userId);
    const hiddenOlder = (ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND created_at < ?').get(userId, since) as { n: number }).n;
    res.json({
      events: ctx.audit.list(userId, { ...f, from: Math.max(f.from ?? 0, since) }),
      retentionDays: ctx.entitlements.entitlements(userId).auditRetentionDays, hiddenOlder
    });
  });

  r.get('/verify', requireUser, (_req, res) => {
    res.json(ctx.audit.verify());
  });

  // export: CSV, JSON, or (Pro) an integrity report; every export is itself audited
  r.get('/export', requireUser, (req, res) => {
    const userId = req.user!.id;
    const { format } = z.object({ format: z.enum(['csv', 'json', 'integrity']) }).parse(req.query);
    ctx.entitlements.require(userId, { feature: 'auditExport', format });
    const events = ctx.audit.list(userId, { from: cutoff(userId), limit: 2000 });
    const stamp = new Date(ctx.clock.now()).toISOString().slice(0, 10);
    ctx.audit.append({ userId, actorType: 'USER', actorId: userId, eventType: 'AUDIT_EXPORTED', data: { format, count: events.length } });
    if (format === 'csv') {
      const rows = events.map(e => [e.seq, e.createdAt, e.actorType, e.actorId, e.eventType, e.actionId, e.data, e.hash].map(csvCell).join(','));
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="agentguard-audit-${stamp}.csv"` });
      res.send(['seq,createdAt,actorType,actorId,eventType,actionId,data,hash', ...rows].join('\n'));
      return;
    }
    const exported = { count: events.length, firstSeq: events[0]?.seq ?? null, lastSeq: events.at(-1)?.seq ?? null, sha256: sha256(canonicalJSON(events)) };
    if (format === 'json') {
      res.set('Content-Disposition', `attachment; filename="agentguard-audit-${stamp}.json"`);
      res.json({ generatedAt: new Date(ctx.clock.now()).toISOString(), events, exported });
      return;
    }
    // integrity report: the whole chain re-verified, the head hash to compare later, and a digest of what was exported
    const head = ctx.db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get() as { hash: string };
    res.set('Content-Disposition', `attachment; filename="agentguard-audit-integrity-${stamp}.json"`);
    res.json({ generatedAt: new Date(ctx.clock.now()).toISOString(), chain: ctx.audit.verify(), headHash: head.hash, exported,
      howToCheck: 'Keep headHash. Later, /api/audit/verify must still report ok, and the exported events must hash to exported.sha256 (canonical JSON, SHA-256).' });
  });
  return r;
}
