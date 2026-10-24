/** Agent keys (docs/TEST_CASES.md §4) and agent management. */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { setup, Ctx } from '../helpers';

let ctx: Ctx;
beforeEach(async () => { ctx = await setup(); });

const pay = { tool: 'payments', operation: 'pay', payload: { amount: 500, currency: 'INR', payee: 'Ravi' } };

describe('agents', () => {
  it('AUTH-03 only the key hash is stored, and the key is never shown again', async () => {
    expect(ctx.agentKey).toMatch(/^ag_/);
    const stored = JSON.stringify(ctx.db.prepare('SELECT * FROM agents').all());
    expect(stored).not.toContain(ctx.agentKey);
    const listed = JSON.stringify((await ctx.user.get('/api/agents').expect(200)).body);
    expect(listed).not.toContain(ctx.agentKey);
    expect(listed).not.toContain('apiKey');
  });

  it('AUTH-04 rotating the key makes the old key fail with 401', async () => {
    const rotated = await ctx.user.post(`/api/agents/${ctx.agentId}/rotate-key`).set('X-CSRF-Token', ctx.csrf).send({}).expect(200);
    const oldRes = await ctx.asAgent().post('/api/actions').set(ctx.auth).send(pay);
    expect(oldRes.status).toBe(401);
    const newRes = await ctx.asAgent().post('/api/actions').set({ Authorization: `Bearer ${rotated.body.apiKey}` }).send(pay);
    expect(newRes.status).not.toBe(401);
  });

  it('AGT-01 agent management is audited and needs CSRF', async () => {
    await ctx.user.patch(`/api/agents/${ctx.agentId}`).send({ name: 'X' }).expect(403);
    await ctx.user.patch(`/api/agents/${ctx.agentId}`).set('X-CSRF-Token', ctx.csrf).send({ name: 'Renamed' }).expect(200);
    await ctx.user.post(`/api/agents/${ctx.agentId}/pause`).set('X-CSRF-Token', ctx.csrf).send({}).expect(200);
    const types = (await ctx.user.get('/api/audit').expect(200)).body.events.map((e: any) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['AGENT_CREATED', 'AGENT_UPDATED', 'AGENT_PAUSED']));
  });

  it('AGT-02 another user cannot see or change my agent', async () => {
    // a second user on the same app and database
    const intruder = request.agent(ctx.app);
    await intruder.post('/api/auth/signup').send({ email: 'intruder@test.dev', password: 'Intruder#12345' }).expect(201);
    const csrf = (await intruder.get('/api/auth/csrf').expect(200)).body.token;
    await intruder.patch(`/api/agents/${ctx.agentId}`).set('X-CSRF-Token', csrf).send({ name: 'mine now' }).expect(404);
    await intruder.get(`/api/agents/${ctx.agentId}/permissions`).expect(404);
    await intruder.put(`/api/agents/${ctx.agentId}/permissions`).set('X-CSRF-Token', csrf).send({ permissions: [{ tool: 'payments', operation: 'pay', allowed: true }] }).expect(404);
    const listed = (await intruder.get('/api/agents').expect(200)).body.agents;
    expect(listed).toEqual([]);
  });
});
