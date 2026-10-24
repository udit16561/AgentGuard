/**
 * Acceptance tests for the three gates (docs/TEST_CASES.md, section 1).
 * Written before the implementation (TDD): they fail until M1 is built.
 * Do NOT weaken these tests to make them pass. Fix the code instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, paymentsReady, propose, approve, getAction, reauth, Ctx } from '../helpers';

let ctx: Ctx;
beforeEach(async () => { ctx = await setup(); });

const smallPay = { amount: 500, currency: 'INR', payee: 'Ravi' };

describe('Gate 1: permission', () => {
  it('SEC-01 blocks a proposal when permission is OFF', async () => {
    await ctx.user.post('/api/tools/payments/connect').set('X-CSRF-Token', ctx.csrf).send({}).expect(200);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    const audit = (await ctx.user.get('/api/audit').expect(200)).body.events;
    expect(audit.some((e: any) => e.eventType === 'ACTION_BLOCKED')).toBe(true);
  });

  it('SEC-02 stores an allowed proposal as PENDING_REVIEW without executing', async () => {
    await paymentsReady(ctx);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_REVIEW');
    const action = await getAction(ctx, res.body.id);
    expect(action.execution ?? null).toBeNull();
  });

  it('SEC-10 refuses execution if permission is revoked after approval', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const action = await getAction(ctx, body.id);
    await ctx.user.put(`/api/agents/${ctx.agentId}/permissions`).set('X-CSRF-Token', ctx.csrf)
      .send({ permissions: [{ tool: 'payments', operation: 'pay', allowed: false }] }).expect(200);
    const res = await approve(ctx, body.id, action.payloadHash);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('SEC-21 blocks a payment over the daily cap', async () => {
    await paymentsReady(ctx);
    const res = await propose(ctx, 'payments', 'pay', { ...smallPay, amount: 15000 });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/LIMIT_EXCEEDED/);
  });
});

describe('Gate 2: approval', () => {
  it('SEC-03 never executes without approval', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const res = await ctx.user.post(`/api/actions/${body.id}/execute`).set('X-CSRF-Token', ctx.csrf).send({});
    expect([404, 405, 409]).toContain(res.status); // there must be no "execute without approval" path
    expect((await getAction(ctx, body.id)).status).toBe('PENDING_REVIEW');
  });

  it('SEC-04 approve with the correct hash executes via the mock adapter', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const action = await getAction(ctx, body.id);
    if (['HIGH', 'CRITICAL'].includes(action.riskLevel)) await reauth(ctx);
    const res = await approve(ctx, body.id, action.payloadHash);
    expect(res.status).toBe(200);
    const after = await getAction(ctx, body.id);
    expect(after.status).toBe('COMPLETED');
    expect(after.execution.adapterMode).toBe('MOCK'); // SEC-27
  });

  it('SEC-05 rejects approval with a wrong payload hash', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const res = await approve(ctx, body.id, 'deadbeef'.repeat(8));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYLOAD_CHANGED');
    expect((await getAction(ctx, body.id)).status).toBe('PENDING_REVIEW');
  });

  it('SEC-06 a changed amount produces a different hash, so the old approval cannot be reused', async () => {
    await paymentsReady(ctx);
    const a = await getAction(ctx, (await propose(ctx, 'payments', 'pay', smallPay)).body.id);
    const b = await getAction(ctx, (await propose(ctx, 'payments', 'pay', { ...smallPay, amount: 900 })).body.id);
    expect(a.payloadHash).not.toBe(b.payloadHash);
    const res = await approve(ctx, b.id, a.payloadHash);
    expect(res.status).toBe(409);
  });

  it('SEC-07 approvals after the TTL are refused', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const action = await getAction(ctx, body.id);
    ctx.clock.advanceMinutes(11);
    const res = await approve(ctx, body.id, action.payloadHash);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('APPROVAL_EXPIRED');
    expect((await getAction(ctx, body.id)).status).toBe('EXPIRED');
  });

  it('SEC-08 / SEC-09 HIGH risk requires recent re-auth', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', { amount: 6000, currency: 'INR', payee: 'Ravi' });
    const action = await getAction(ctx, body.id);
    expect(['HIGH', 'CRITICAL']).toContain(action.riskLevel);
    const first = await approve(ctx, body.id, action.payloadHash);
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe('REAUTH_REQUIRED');
    await reauth(ctx);
    expect((await approve(ctx, body.id, action.payloadHash)).status).toBe(200);
  });

  it('SEC-26 an approval cannot be replayed', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const action = await getAction(ctx, body.id);
    await reauth(ctx);
    await approve(ctx, body.id, action.payloadHash).expect(200);
    const again = await approve(ctx, body.id, action.payloadHash);
    expect(again.status).toBe(409);
  });
});

describe('Kill switch', () => {
  it('SEC-11 refuses new proposals when paused', async () => {
    await paymentsReady(ctx);
    await ctx.user.post('/api/kill-switch').set('X-CSRF-Token', ctx.csrf).send({ on: true }).expect(200);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('AGENT_PAUSED');
  });

  it('SEC-12 pending actions cannot execute after the kill switch', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const action = await getAction(ctx, body.id);
    await ctx.user.post('/api/kill-switch').set('X-CSRF-Token', ctx.csrf).send({ on: true }).expect(200);
    const res = await approve(ctx, body.id, action.payloadHash);
    expect(res.status).toBe(423);
  });
});

describe('Agent isolation', () => {
  it('SEC-13 an agent key cannot approve', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const action = await getAction(ctx, body.id);
    const res = await ctx.asAgent().post(`/api/actions/${body.id}/approve`).set(ctx.auth).send({ payloadHash: action.payloadHash });
    expect([401, 403]).toContain(res.status);
    expect((await getAction(ctx, body.id)).status).toBe('PENDING_REVIEW');
  });

  it('SEC-14 an agent key cannot read audit or change permissions', async () => {
    expect([401, 403]).toContain((await ctx.asAgent().get('/api/audit').set(ctx.auth)).status);
    const res = await ctx.asAgent().put(`/api/agents/${ctx.agentId}/permissions`).set(ctx.auth)
      .send({ permissions: [{ tool: 'payments', operation: 'pay', allowed: true }] });
    expect([401, 403]).toContain(res.status);
  });

  it('SEC-22 user writes without a CSRF token are refused', async () => {
    const res = await ctx.user.post('/api/kill-switch').send({ on: true });
    expect(res.status).toBe(403);
  });
});

describe('Audit log', () => {
  it('SEC-16 has no update or delete routes', async () => {
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await (ctx.user as any)[method]('/api/audit').set('X-CSRF-Token', ctx.csrf).send({});
      expect([404, 405]).toContain(res.status);
    }
  });

  it('SEC-17 chain verifies after normal activity', async () => {
    await paymentsReady(ctx);
    await propose(ctx, 'payments', 'pay', smallPay);
    const res = await ctx.user.get('/api/audit/verify').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('SEC-18 detects tampering', async () => {
    await paymentsReady(ctx);
    await propose(ctx, 'payments', 'pay', smallPay);
    ctx.db.prepare("UPDATE audit_events SET data = '{\"tampered\":true}' WHERE seq = 2").run();
    const res = await ctx.user.get('/api/audit/verify').expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(2);
  });

  it('SEC-24 redacts secrets in audit data', async () => {
    await paymentsReady(ctx);
    await propose(ctx, 'payments', 'pay', { ...smallPay, cardNumber: '4111111111111111' });
    const events = (await ctx.user.get('/api/audit').expect(200)).body.events;
    expect(JSON.stringify(events)).not.toContain('4111111111111111');
  });
});

describe('Fail closed', () => {
  it('SEC-19 a classifier error yields NEEDS_REVIEW', async () => {
    ctx = await setup({ classifier: async () => { throw new Error('model down'); } });
    await paymentsReady(ctx);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.body.status).toBe('NEEDS_REVIEW');
  });

  it('SEC-20 low confidence yields NEEDS_REVIEW', async () => {
    ctx = await setup({ classifier: async () => ({ intent: 'MAKE_PAYMENT', confidence: 0.3, riskScore: 10, reasons: [], flags: [] }) });
    await paymentsReady(ctx);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.body.status).toBe('NEEDS_REVIEW');
  });
});
