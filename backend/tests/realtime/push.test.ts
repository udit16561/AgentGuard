/**
 * Web Push alerts (v0.6.0, written first). A fake sender stands in for the push service, so no test reaches the
 * network. A notification only ever opens the Review screen: there is no approve action, and approving still needs
 * the signed-in app (with re-auth for HIGH risk).
 */
import { describe, it, expect } from 'vitest';
import { setup, connectTool, allow, propose, paymentsReady, getAction, Ctx } from '../helpers';
import { notificationFor } from '../../src/services/notify';

const PUBLIC = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' } };

function pushApp(opts: { status?: number; fail?: boolean } = {}) {
  const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  const pushSender = async (sub: { endpoint: string }, payload: string) => {
    if (opts.fail) throw new Error('push service down');
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: opts.status ?? 201 };
  };
  return { sent, opts: { pushSender, config: { vapidPublicKey: PUBLIC, vapidPrivateKey: 'test-private', vapidSubject: 'mailto:owner@test.dev' } } };
}
const subscribe = (ctx: Ctx, body: unknown = SUB) => ctx.user.post('/api/push/subscriptions').set('X-CSRF-Token', ctx.csrf).send(body as object);
const settle = () => new Promise(r => setTimeout(r, 30));

describe('subscriptions', () => {
  it('PUSH-01 the public VAPID key is offered to the signed-in user; push is off without VAPID keys', async () => {
    const { opts } = pushApp();
    const on = await setup(opts);
    expect((await on.user.get('/api/push/key').expect(200)).body).toEqual({ enabled: true, publicKey: PUBLIC });
    const off = await setup({ config: { vapidPublicKey: null, vapidPrivateKey: null } });
    expect((await off.user.get('/api/push/key').expect(200)).body).toEqual({ enabled: false, publicKey: null });
    expect((await on.asAgent().get('/api/push/key').set(on.auth)).status).toBe(401);
  });

  it('PUSH-02 subscribing needs CSRF and a real push-service endpoint (no SSRF), and is audited', async () => {
    const { opts } = pushApp();
    const ctx = await setup(opts);
    expect((await ctx.user.post('/api/push/subscriptions').send(SUB)).status).toBe(403);
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://10.0.0.5/push', 'https://evil.example.com/push', 'https://localhost/push', 'https://fcm.googleapis.com.evil.com/x']) {
      expect((await subscribe(ctx, { ...SUB, endpoint })).status, endpoint).toBe(400);
    }
    expect((await subscribe(ctx, { ...SUB, keys: { p256dh: 'short', auth: 'x' } })).status).toBe(400);
    for (const endpoint of [SUB.endpoint, 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://web.push.apple.com/QGx']) {
      expect((await subscribe(ctx, { ...SUB, endpoint })).status, endpoint).toBe(201);
    }
    expect((await subscribe(ctx)).status).toBe(201);   // the same endpoint again is an update, not a duplicate
    expect((await ctx.user.get('/api/push/subscriptions').expect(200)).body.subscriptions).toHaveLength(4);
    const audit = (await ctx.user.get('/api/audit?eventType=PUSH_SUBSCRIBED').expect(200)).body.events;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(SUB.keys.auth);
  });

  it('PUSH-03 an agent key can neither subscribe nor unsubscribe', async () => {
    const { opts } = pushApp();
    const ctx = await setup(opts);
    expect((await ctx.asAgent().post('/api/push/subscriptions').set(ctx.auth).send(SUB)).status).toBe(401);
    expect((await ctx.asAgent().delete('/api/push/subscriptions').set(ctx.auth).send({ endpoint: SUB.endpoint })).status).toBe(401);
  });

  it('PUSH-04 unsubscribing removes the endpoint', async () => {
    const { opts, sent } = pushApp();
    const ctx = await setup(opts);
    await subscribe(ctx).expect(201);
    await ctx.user.delete('/api/push/subscriptions').set('X-CSRF-Token', ctx.csrf).send({ endpoint: SUB.endpoint }).expect(200);
    await paymentsReady(ctx);
    await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' });
    await settle();
    expect(sent).toEqual([]);
  });
});

describe('alerts', () => {
  it('PUSH-05 a new pending payment sends "Helper wants to pay ₹500 to Ravi" that opens its Review screen, with no approve action', async () => {
    const { opts, sent } = pushApp();
    const ctx = await setup(opts);
    await subscribe(ctx).expect(201);
    await paymentsReady(ctx);
    const p = await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi', note: 'private lunch note' });
    await settle();
    expect(sent).toHaveLength(1);
    const n = sent[0].payload;
    expect(n.body).toBe('Helper wants to pay ₹500 to Ravi — Review');
    expect(n).toMatchObject({ actionId: p.body.id, url: `/#/review/${p.body.id}`, tag: p.body.id });
    expect(n.actions).toEqual([{ action: 'review', title: 'Review' }]);
    expect(JSON.stringify(n)).not.toMatch(/approve/i);
    expect(JSON.stringify(n)).not.toContain('private lunch note');
    expect((await getAction(ctx, p.body.id)).status).toBe('PENDING_REVIEW');   // a push never decides anything
  });

  it('PUSH-06 NEEDS_REVIEW alerts too; blocked proposals and auto-allowed reads do not', async () => {
    const { opts, sent } = pushApp();
    const ctx = await setup(opts);
    await subscribe(ctx).expect(201);
    await connectTool(ctx, 'payments');
    await allow(ctx, 'payments', 'pay', { dailyCap: 1000, currency: 'INR', knownPayees: ['Ravi'] });
    await propose(ctx, 'payments', 'pay', { amount: 5000, currency: 'INR', payee: 'Ravi', method: 'upi' });   // over the cap: BLOCKED
    await propose(ctx, 'payments', 'pay', { currency: 'INR', payee: 'Ravi' });                                // no amount: NEEDS_REVIEW
    await connectTool(ctx, 'gmail');
    await allow(ctx, 'gmail', 'read', { autoAllow: true });
    await propose(ctx, 'gmail', 'read', { query: 'from:boss' });                                              // auto-allowed read
    await settle();
    expect(sent).toHaveLength(1);
    expect(String(sent[0].payload.title)).toMatch(/needs review/i);
  });

  it('PUSH-07 the push service failing never breaks a proposal, and a gone (410) subscription is removed', async () => {
    const down = pushApp({ fail: true });
    const a = await setup(down.opts);
    await subscribe(a).expect(201);
    await paymentsReady(a);
    expect((await propose(a, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' })).status).toBe(201);

    const gone = pushApp({ status: 410 });
    const b = await setup(gone.opts);
    await subscribe(b).expect(201);
    await paymentsReady(b);
    await propose(b, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' });
    await settle();
    expect((await b.user.get('/api/push/subscriptions').expect(200)).body.subscriptions).toEqual([]);
  });

  it('PUSH-08 without VAPID keys nothing is sent and proposals still work', async () => {
    const sent: unknown[] = [];
    const ctx = await setup({ pushSender: async () => { sent.push(1); return { statusCode: 201 }; }, config: { vapidPublicKey: null, vapidPrivateKey: null } });
    expect((await subscribe(ctx)).status).toBe(409);
    await paymentsReady(ctx);
    expect((await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' })).status).toBe(201);
    await settle();
    expect(sent).toEqual([]);
  });

  it('PUSH-09 notification text: agent-supplied parts are short plain text, and message bodies are never included', () => {
    const base = { id: 'act_1', status: 'PENDING_REVIEW', riskLevel: 'HIGH' };
    const pay = notificationFor({ ...base, tool: 'payments', operation: 'pay', payload: { amount: 2500, currency: 'INR', payee: 'Ravi' } }, 'Helper');
    expect(pay.body).toBe('Helper wants to pay ₹2,500 to Ravi — Review');
    expect(pay.title).toMatch(/high risk/i);
    const mail = notificationFor({ ...base, tool: 'gmail', operation: 'send', payload: { to: ['asha@example.com'], subject: 'Contract', body: 'the secret body' } }, 'Helper');
    expect(mail.body).toBe('Helper wants to email asha@example.com — Review');
    expect(JSON.stringify(mail)).not.toContain('secret body');
    const long = notificationFor({ ...base, tool: 'payments', operation: 'pay', payload: { amount: 1, currency: 'INR', payee: `${'A'.repeat(200)}\u0007\n<b>x</b>` } }, 'Helper');
    expect(long.body.length).toBeLessThan(120);
    expect(long.body).not.toMatch(/\p{Cc}/u);
    const other = notificationFor({ ...base, tool: 'x', operation: 'post', payload: { text: 'hello world' } }, 'Helper');
    expect(other.body).toBe('Helper wants to post on X (Twitter) — Review');
  });
});
