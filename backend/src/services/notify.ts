import webpush from 'web-push';
import type { Ctx } from '../context';
import { CATALOG } from './catalog';
import type { ActionRow } from './actions';
import type { AuditInput } from './audit';

/**
 * Web Push alerts (v0.6.0). A notification says who wants to do what and opens that action's Review screen; it has
 * no approve action, and approving still needs the signed-in app (with re-auth for HIGH risk). Payloads are
 * end-to-end encrypted by Web Push; they still carry only a short summary, never message bodies or notes.
 */
export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }
export type PushSender = (sub: PushSubscriptionData, payload: string) => Promise<{ statusCode: number }>;

const RISK: Record<string, string> = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk', CRITICAL: 'Critical risk' };
const MESSAGING = new Set(['whatsapp.send_message', 'whatsapp.send_media', 'instagram.dm', 'linkedin.message', 'x.dm']);

/** Agent-supplied text in a notification: one line, no control characters, at most `max` characters. */
const clean = (v: unknown, max = 40) => {
  const s = String(v ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter(x => typeof x === 'string') as string[];
function money(amount: unknown, currency: unknown) {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
  if (n == null) return 'an unknown amount';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: String(currency || 'INR'), minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n); }
  catch { return `${n} ${clean(currency, 5)}`; }
}

export interface AlertAction { id: string; tool: string; operation: string; status: string; riskLevel: string; payload: Record<string, unknown> }

export function notificationFor(a: AlertAction, agentName: string) {
  const p = a.payload ?? {};
  const who = clean(agentName, 30) || 'An agent';
  const tool = CATALOG[a.tool];
  const key = `${a.tool}.${a.operation}`;
  let what: string;
  if (a.tool === 'payments' && (a.operation === 'pay' || a.operation === 'transfer')) what = `pay ${money(p.amount, p.currency)} to ${clean(p.payee ?? p.to) || 'someone'}`;
  else if (a.tool === 'payments' && a.operation === 'refund') what = `refund ${money(p.amount, p.currency)}`;
  else if (a.tool === 'gmail' && ['send', 'reply', 'forward'].includes(a.operation)) {
    const to = [...list(p.to), ...list(p.cc), ...list(p.bcc)];
    what = `email ${to.length ? clean(to[0]) : 'someone'}${to.length > 1 ? ` and ${to.length - 1} more` : ''}`;
  } else if (MESSAGING.has(key)) {
    const to = [...list(p.to), ...list(p.recipients)];
    what = `message ${to.length ? clean(to[0]) : 'someone'}${to.length > 1 ? ` and ${to.length - 1} more` : ''}`;
  } else what = `${(tool?.operations[a.operation]?.label ?? a.operation).toLowerCase()} on ${tool?.name ?? a.tool}`;
  return {
    title: a.status === 'NEEDS_REVIEW' ? 'Needs review · AgentGuard' : `${RISK[a.riskLevel] ?? 'Review'} · AgentGuard`,
    body: `${who} wants to ${what} — Review`,
    actionId: a.id, url: `/#/review/${a.id}`, tag: a.id,
    actions: [{ action: 'review', title: 'Review' }]
  };
}

/** The real sender (web-push with VAPID); tests pass a fake through createApp({ pushSender }). */
export function webPushSender(ctx: Ctx): PushSender {
  return async (sub, payload) => {
    const out = await webpush.sendNotification(sub, payload, {
      TTL: ctx.config.approvalTtlMinutes * 60, urgency: 'high',
      vapidDetails: { subject: ctx.config.vapidSubject, publicKey: ctx.config.vapidPublicKey!, privateKey: ctx.config.vapidPrivateKey! }
    });
    return { statusCode: out.statusCode };
  };
}

export const pushEnabled = (ctx: Ctx) => !!(ctx.config.vapidPublicKey && ctx.config.vapidPrivateKey);

interface SubRow { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }

/** Sends one notification to each of the user's devices; a 404/410 means the device unsubscribed, so it is removed. */
export async function sendToUser(ctx: Ctx, userId: string, payload: Record<string, unknown>) {
  if (!pushEnabled(ctx) || !ctx.pushSender) return 0;
  const subs = ctx.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as SubRow[];
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      const res = await ctx.pushSender!({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      if (res.statusCode === 404 || res.statusCode === 410) removeGone(ctx, s);
      else sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) removeGone(ctx, s);
      // anything else: the alert is still in the app and the audit log; a push failure never breaks the proposal
    }
  }));
  return sent;
}

function removeGone(ctx: Ctx, s: SubRow) {
  ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
  ctx.audit.append({ userId: s.user_id, actorType: 'SYSTEM', actorId: null, eventType: 'PUSH_UNSUBSCRIBED', data: { host: new URL(s.endpoint).host, reason: 'GONE' } });
}

/** Audit hook: a new alert (pending or needs review) goes to the user's phones, after the response, never blocking it. */
export function pushOnAlert(ctx: Ctx) {
  return (e: AuditInput) => {
    if (e.eventType !== 'ALERT_SENT' || !e.actionId || !e.userId || !pushEnabled(ctx)) return;
    const actionId = e.actionId, userId = e.userId;
    setImmediate(() => {
      const a = ctx.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as ActionRow | undefined;
      if (!a || !['PENDING_REVIEW', 'NEEDS_REVIEW'].includes(a.status)) return;
      const agent = ctx.db.prepare('SELECT name FROM agents WHERE id = ?').get(a.agent_id) as { name: string } | undefined;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(a.payload); } catch { /* summary falls back to the operation name */ }
      void sendToUser(ctx, userId, notificationFor({ id: a.id, tool: a.tool, operation: a.operation, status: a.status, riskLevel: a.risk_level ?? 'HIGH', payload }, agent?.name ?? 'An agent')).catch(() => {});
    });
  };
}
