/** Permission cases from docs/TEST_CASES.md §3 (PRM). */
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, connectTool, allow, propose, getAction, Ctx } from '../helpers';

let ctx: Ctx;
beforeEach(async () => { ctx = await setup(); });

describe('PRM', () => {
  it('PRM-01 a new agent has every permission OFF', async () => {
    const { permissions } = (await ctx.user.get(`/api/agents/${ctx.agentId}/permissions`).expect(200)).body;
    expect(permissions.length).toBeGreaterThan(30);
    expect(permissions.every((p: any) => p.allowed === false)).toBe(true);
  });

  it('PRM-02 toggling a permission is saved and audited as PERMISSION_CHANGED', async () => {
    await allow(ctx, 'gmail', 'send', { knownRecipients: ['asha@example.com'] });
    const { permissions } = (await ctx.user.get(`/api/agents/${ctx.agentId}/permissions`).expect(200)).body;
    expect(permissions.find((p: any) => p.tool === 'gmail' && p.operation === 'send')).toMatchObject({ allowed: true, limits: { knownRecipients: ['asha@example.com'] } });
    expect(permissions.find((p: any) => p.tool === 'gmail' && p.operation === 'delete').allowed).toBe(false);   // separate toggle
    const events = (await ctx.user.get('/api/audit').expect(200)).body.events;
    expect(events.some((e: any) => e.eventType === 'PERMISSION_CHANGED' && e.data.tool === 'gmail' && e.data.operation === 'send')).toBe(true);
  });

  it('PRM-03 disconnecting a tool turns its permissions off and blocks its pending actions', async () => {
    await connectTool(ctx, 'payments');
    await allow(ctx, 'payments', 'pay', { dailyCap: 10000, knownPayees: ['Ravi'] });
    const { body } = await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi' });
    await ctx.user.delete('/api/tools/payments').set('X-CSRF-Token', ctx.csrf).expect(200);
    const { permissions } = (await ctx.user.get(`/api/agents/${ctx.agentId}/permissions`).expect(200)).body;
    expect(permissions.filter((p: any) => p.tool === 'payments').every((p: any) => !p.allowed)).toBe(true);
    expect((await getAction(ctx, body.id)).status).toBe('BLOCKED');
  });

  it('PRM-04 unknown operations and unknown limit keys are refused', async () => {
    await ctx.user.put(`/api/agents/${ctx.agentId}/permissions`).set('X-CSRF-Token', ctx.csrf)
      .send({ permissions: [{ tool: 'payments', operation: 'steal', allowed: true }] }).expect(400);
    await ctx.user.put(`/api/agents/${ctx.agentId}/permissions`).set('X-CSRF-Token', ctx.csrf)
      .send({ permissions: [{ tool: 'payments', operation: 'pay', allowed: true, limits: { approveAutomatically: true } }] }).expect(400);
  });

  it('PRM-05 tool catalog lists all nine tools, none connected at first', async () => {
    const { tools } = (await ctx.user.get('/api/tools').expect(200)).body;
    expect(tools.map((t: any) => t.tool).sort()).toEqual(['blog', 'calendar', 'clock', 'gmail', 'instagram', 'linkedin', 'payments', 'whatsapp', 'x']);
    expect(tools.every((t: any) => !t.connected && t.mode === 'MOCK')).toBe(true);
  });
});
