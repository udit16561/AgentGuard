import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError } from '../http';
import { requireCsrf, requireUser } from '../middleware/auth';
import { newId } from '../services/canonical';
import { pushEnabled, sendToUser } from '../services/notify';

const MAX_DEVICES = 10;
// Only real push services: the server posts to this URL, so anything else would be an SSRF hole
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_SUFFIXES = ['.notify.windows.com', '.push.apple.com'];

export function isPushEndpoint(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443')
    && (PUSH_HOSTS.includes(host) || PUSH_SUFFIXES.some(s => host.endsWith(s)));
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const Subscription = z.object({
  endpoint: z.string().max(1000).refine(isPushEndpoint, 'Not a push service endpoint'),
  keys: z.object({ p256dh: z.string().min(80).max(100).regex(B64URL), auth: z.string().min(16).max(30).regex(B64URL) }),
  expirationTime: z.number().nullable().optional()
});

/** /api/push: Web Push devices for the signed-in user. Agent keys get 401. */
export function pushRoutes(ctx: Ctx) {
  const r = Router();
  const { db, clock, audit } = ctx;
  r.use(requireUser);
  const log = (userId: string, eventType: string, endpoint: string) =>
    audit.append({ userId, actorType: 'USER', actorId: userId, eventType, data: { host: new URL(endpoint).host } });

  r.get('/key', (req, res) => {
    if (!pushEnabled(ctx)) { res.json({ enabled: false, publicKey: null }); return; }
    // phone alerts are a plan feature; in-app and live alerts are on every plan
    const lock = ctx.entitlements.lock(req.user!.id, { feature: 'pushAlerts' });
    res.json(lock ? { enabled: false, publicKey: null, locked: true, upgradeTo: lock.upgradeTo } : { enabled: true, publicKey: ctx.config.vapidPublicKey });
  });

  r.get('/subscriptions', (req, res) => {
    const rows = db.prepare('SELECT id, endpoint, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(req.user!.id) as { id: string; endpoint: string; created_at: number }[];
    res.json({ subscriptions: rows.map(s => ({ id: s.id, host: new URL(s.endpoint).host, createdAt: new Date(s.created_at).toISOString() })) });
  });

  r.post('/subscriptions', requireCsrf, (req, res) => {
    if (!pushEnabled(ctx)) throw new AppError(409, 'PUSH_DISABLED', 'Phone alerts are not set up on this server (VAPID keys missing)');
    const userId = req.user!.id;
    ctx.entitlements.require(userId, { feature: 'pushAlerts' });
    const body = Subscription.parse(req.body);
    // one row per endpoint: re-subscribing the same device updates it (and moves it to this user)
    db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(newId('psh'), userId, body.endpoint, body.keys.p256dh, body.keys.auth, clock.now());
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`).run(userId, userId);
    log(userId, 'PUSH_SUBSCRIBED', body.endpoint);
    res.status(201).json({ ok: true });
  });

  r.delete('/subscriptions', requireCsrf, (req, res) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    const out = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user!.id, endpoint);
    if (out.changes && isPushEndpoint(endpoint)) log(req.user!.id, 'PUSH_UNSUBSCRIBED', endpoint);
    res.json({ ok: true });
  });

  // a test alert for setting up a phone; it opens the Review list, not any action
  r.post('/test', requireCsrf, async (req, res) => {
    if (!pushEnabled(ctx)) throw new AppError(409, 'PUSH_DISABLED', 'Phone alerts are not set up on this server (VAPID keys missing)');
    ctx.entitlements.require(req.user!.id, { feature: 'pushAlerts' });
    const sent = await sendToUser(ctx, req.user!.id, { title: 'AgentGuard', body: 'Test alert: phone alerts are working.', url: '/#/review', tag: 'test', actions: [{ action: 'review', title: 'Review' }] });
    res.json({ sent });
  });

  return r;
}
