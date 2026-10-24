/** Gate 3 (verification), decisions and lifecycle: docs/TEST_CASES.md §1 plus DECISIONS C, D and F. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { setup, paymentsReady, propose, approve, getAction, reauth, connectTool, allow } from '../helpers';

const smallPay = { amount: 500, currency: 'INR', payee: 'Ravi' };
afterEach(() => { vi.restoreAllMocks(); });

async function approveFully(ctx: Awaited<ReturnType<typeof setup>>, id: string) {
  const a = await getAction(ctx, id);
  await reauth(ctx);
  const res = await approve(ctx, id, a.payloadHash);
  expect(res.status).toBe(200);
  return res;
}

describe('verification (gate 3)', () => {
  it('SEC-25 no provider reference means UNKNOWN, not COMPLETED', async () => {
    const ctx = await setup({ adapters: { payments: { mode: 'MOCK', execute: async () => ({ result: { note: 'sent?' } }) } } });
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    await approveFully(ctx, body.id);
    const a = await getAction(ctx, body.id);
    expect(a.status).toBe('UNKNOWN');
    expect(a.execution.providerRef).toBeNull();
  });

  it('SEC-27 mock mode records MOCK and makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = await setup();
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    await approveFully(ctx, body.id);
    const a = await getAction(ctx, body.id);
    expect(a.execution.adapterMode).toBe('MOCK');
    expect(a.execution.providerRef).toMatch(/^mock_payments_/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('EXE-01 a provider error is FAILED, and is never retried automatically', async () => {
    const execute = vi.fn(async () => { throw new Error('Bank declined'); });
    const ctx = await setup({ adapters: { payments: { mode: 'MOCK', execute } } });
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    await approveFully(ctx, body.id);
    const a = await getAction(ctx, body.id);
    expect(a.status).toBe('FAILED');
    expect(a.execution.error).toBe('Bank declined');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('decisions', () => {
  it('DEC-01 reject stores the reason, and the action cannot be approved afterwards', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const a = await getAction(ctx, body.id);
    await ctx.user.post(`/api/actions/${body.id}/reject`).set('X-CSRF-Token', ctx.csrf).send({ reason: 'Wrong invoice' }).expect(200);
    const after = await getAction(ctx, body.id);
    expect(after).toMatchObject({ status: 'REJECTED', approval: { decision: 'REJECTED', reason: 'Wrong invoice' }, execution: null });
    await reauth(ctx);
    const res = await approve(ctx, body.id, a.payloadHash);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_DECIDED');
  });

  it('DEC-02 NEEDS_REVIEW actions can be approved, but only after re-auth (DECISIONS C)', async () => {
    const ctx = await setup();
    await connectTool(ctx, 'gmail');
    await allow(ctx, 'gmail', 'send', { knownRecipients: ['asha@example.com'] });
    const { body } = await propose(ctx, 'gmail', 'send', { subject: 'No recipient', body: 'hi' });   // missing recipient
    expect(body.status).toBe('NEEDS_REVIEW');
    const a = await getAction(ctx, body.id);
    expect(a.riskLevel).toBe('MEDIUM');
    expect((await approve(ctx, body.id, a.payloadHash)).status).toBe(401);
    await reauth(ctx);
    expect((await approve(ctx, body.id, a.payloadHash)).status).toBe(200);
  });

  it('DEC-03 re-auth only lasts the configured window', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const a = await getAction(ctx, body.id);
    await reauth(ctx);
    ctx.clock.advanceMinutes(6);
    const res = await approve(ctx, body.id, a.payloadHash);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('DEC-04 an expired action shows EXPIRED when read, without anyone trying to approve it (DECISIONS D)', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    ctx.clock.advanceMinutes(10.5);
    expect((await getAction(ctx, body.id)).status).toBe('EXPIRED');
    const types = (await ctx.user.get('/api/audit').expect(200)).body.events.map((e: any) => e.eventType);
    expect(types).toContain('ACTION_EXPIRED');
  });

  it('DEC-05 approved payments count towards the daily cap', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const first = await propose(ctx, 'payments', 'pay', { ...smallPay, amount: 6000 });
    await approveFully(ctx, first.body.id);
    const second = await propose(ctx, 'payments', 'pay', { ...smallPay, amount: 5000 });
    expect(second.status).toBe(403);
    expect(second.body.error.message).toMatch(/LIMIT_EXCEEDED/);
  });

  it('DEC-06 the audit timeline records the full lifecycle in order, and the chain verifies', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    await approveFully(ctx, body.id);
    const events = (await ctx.user.get('/api/audit').expect(200)).body.events.filter((e: any) => e.actionId === body.id).map((e: any) => e.eventType);
    expect(events).toEqual(['ACTION_PROPOSED', 'ALERT_SENT', 'ACTION_APPROVED', 'ACTION_SUBMITTED', 'ACTION_COMPLETED']);
    expect((await ctx.user.get('/api/audit/verify').expect(200)).body.ok).toBe(true);
  });

  it('DEC-07 another user cannot approve or reject my action', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const a = await getAction(ctx, body.id);
    // a second user on the same app and database
    const other = request.agent(ctx.app);
    await other.post('/api/auth/signup').send({ email: 'intruder@test.dev', password: 'Intruder#12345' }).expect(201);
    const csrf = (await other.get('/api/auth/csrf').expect(200)).body.token;
    await other.post('/api/auth/reauth').set('X-CSRF-Token', csrf).send({ password: 'Intruder#12345' }).expect(200);
    expect((await other.get(`/api/actions/${body.id}`)).status).toBe(404);
    expect((await other.post(`/api/actions/${body.id}/approve`).set('X-CSRF-Token', csrf).send({ payloadHash: a.payloadHash })).status).toBe(404);
    expect((await other.post(`/api/actions/${body.id}/reject`).set('X-CSRF-Token', csrf).send({})).status).toBe(404);
    expect((await getAction(ctx, body.id)).status).toBe('PENDING_REVIEW');
  });
});
