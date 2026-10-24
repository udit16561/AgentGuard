/** SEC cases from docs/TEST_CASES.md §1 that gates.test.ts does not cover. */
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, paymentsReady, propose, getAction, Ctx } from '../helpers';

let ctx: Ctx;
beforeEach(async () => { ctx = await setup(); });

const smallPay = { amount: 500, currency: 'INR', payee: 'Ravi' };

describe('agent isolation and abuse', () => {
  it('SEC-15 agent A cannot read agent B’s action', async () => {
    await paymentsReady(ctx);
    const { body } = await propose(ctx, 'payments', 'pay', smallPay);
    const b = await ctx.user.post('/api/agents').set('X-CSRF-Token', ctx.csrf).send({ name: 'Other' }).expect(201);
    const res = await ctx.asAgent().get(`/api/actions/${body.id}`).set({ Authorization: `Bearer ${b.body.apiKey}` });
    expect(res.status).toBe(404);
    // the owning agent sees its status only, never the payload or hash
    const own = await ctx.asAgent().get(`/api/actions/${body.id}`).set(ctx.auth).expect(200);
    expect(Object.keys(own.body).sort()).toEqual(['id', 'riskLevel', 'status']);
  });

  it('SEC-23 more than 20 proposals a minute from one key get 429', async () => {
    await paymentsReady(ctx);
    for (let i = 0; i < 20; i++) expect((await propose(ctx, 'payments', 'pay', smallPay)).status).toBe(201);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.status).toBe(429);
    ctx.clock.advanceMinutes(1.1);
    expect((await propose(ctx, 'payments', 'pay', smallPay)).status).toBe(201);
  });

  it('PROP-01 blocked proposals are stored as BLOCKED with the reason, never as pending', async () => {
    await paymentsReady(ctx);
    const res = await propose(ctx, 'gmail', 'send', { to: ['a@b.c'], body: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error.actionId).toBeTruthy();
    const a = await getAction(ctx, res.body.error.actionId);
    expect(a.status).toBe('BLOCKED');
    expect(a.blockReason).toBe('TOOL_NOT_CONNECTED');
  });

  it('PROP-02 a paused agent cannot propose', async () => {
    await paymentsReady(ctx);
    await ctx.user.post(`/api/agents/${ctx.agentId}/pause`).set('X-CSRF-Token', ctx.csrf).send({ paused: true }).expect(200);
    const res = await propose(ctx, 'payments', 'pay', smallPay);
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('AGENT_PAUSED');
  });

  it('PROP-03 malformed and oversized proposals are rejected', async () => {
    await paymentsReady(ctx);
    expect((await ctx.asAgent().post('/api/actions').set(ctx.auth).send({ tool: 'payments' })).status).toBe(400);
    expect((await propose(ctx, 'payments', 'pay', { note: 'x'.repeat(40_000), ...smallPay })).status).toBe(400);
  });

  it('PROP-04 the user list shows pending actions with risk and expiry', async () => {
    await paymentsReady(ctx);
    await propose(ctx, 'payments', 'pay', smallPay);
    const { actions } = (await ctx.user.get('/api/actions?status=PENDING_REVIEW').expect(200)).body;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tool: 'payments', operation: 'pay', intent: 'MAKE_PAYMENT', requiresReauth: true, execution: null });
    expect(actions[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
