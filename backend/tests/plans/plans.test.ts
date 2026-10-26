/**
 * Plans and entitlements (docs/PLANS_AND_ENTITLEMENTS.md, DECISIONS A), written first. Plans unlock features and
 * limits; they never grant tool access, and safety features (approvals, kill switch, alerts, audit) are never locked.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { setup, connectTool, allow, propose, getAction, approve, reauth, paymentsReady, Ctx } from '../helpers';
import { guardModel } from '../models/mocks';

const csrf = (ctx: Ctx) => ({ 'X-CSRF-Token': ctx.csrf });
const changePlan = (ctx: Ctx, plan: string) => ctx.user.post('/api/me/plan').set(csrf(ctx)).send({ plan });
const newAgent = (ctx: Ctx, name: string) => ctx.user.post('/api/agents').set(csrf(ctx)).send({ name });
const connect = (ctx: Ctx, tool: string) => ctx.user.post(`/api/tools/${tool}/connect`).set(csrf(ctx)).send({});
const locked = (res: { status: number; body: { error?: { code: string; message: string; upgradeTo?: string } } }) => {
  expect(res.status).toBe(402);
  expect(res.body.error!.code).toBe('ENTITLEMENT_REQUIRED');
  expect(res.body.error!.message).toMatch(/upgrade to unlock/i);
};
const DAY = 24 * 60;

describe('limits per plan', () => {
  it('PLN-01 a Starter user cannot create a 2nd agent (402, "Upgrade to unlock" with the plan that unlocks it)', async () => {
    const ctx = await setup({ plan: 'starter' });
    const res = await newAgent(ctx, 'Second');
    locked(res);
    expect(res.body.error.upgradeTo).toBe('plus');
    const plus = await setup();
    expect((await newAgent(plus, 'Second')).status).toBe(201);
    expect((await newAgent(plus, 'Third')).status).toBe(201);
    locked(await newAgent(plus, 'Fourth'));
  });

  it('PLN-02 the tool catalog: Starter cannot connect Instagram or Payments; Plus gets Payments but not X; Pro gets everything', async () => {
    const starter = await setup({ plan: 'starter' });
    locked(await connect(starter, 'instagram'));
    locked(await connect(starter, 'payments'));
    for (const t of ['gmail', 'calendar', 'clock']) expect((await connect(starter, t)).status).toBe(200);
    const plus = await setup();
    expect((await connect(plus, 'payments')).status).toBe(200);
    const x = await connect(plus, 'x');
    locked(x);
    expect(x.body.error.upgradeTo).toBe('pro');
    const pro = await setup({ plan: 'pro' });
    for (const t of ['instagram', 'x', 'blog']) expect((await connect(pro, t)).status).toBe(200);
  });

  it('PLN-03 a plan is not a permission: on Pro with no tool connected or toggled, the agent still cannot act', async () => {
    const ctx = await setup({ plan: 'pro' });
    const res = await propose(ctx, 'x', 'post', { text: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    await connectTool(ctx, 'x');
    expect((await propose(ctx, 'x', 'post', { text: 'hi' })).status).toBe(403);   // connected, but not toggled on
  });
});

describe('downgrade and upgrade', () => {
  it('PLN-04 Pro → Starter pauses the extra agents and tools without deleting anything; upgrading brings them back', async () => {
    const ctx = await setup({ plan: 'pro' });
    const b = (await newAgent(ctx, 'Second').expect(201)).body;
    for (const t of ['gmail', 'calendar', 'payments', 'x']) await connectTool(ctx, t);
    await allow(ctx, 'payments', 'pay', { dailyCap: 10000, currency: 'INR', knownPayees: ['Ravi'] });
    await allow(ctx, 'gmail', 'send', { knownRecipients: ['asha@example.com'] });

    const preview = (await ctx.user.get('/api/me/plan/preview?plan=starter').expect(200)).body;
    expect(preview.pauseAgents.map((a: { name: string }) => a.name)).toEqual(['Second']);
    expect(preview.pauseTools.sort()).toEqual(['payments', 'x']);

    const res = await changePlan(ctx, 'starter');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'starter' });
    const agents = (await ctx.user.get('/api/agents').expect(200)).body.agents as { id: string; status: string; pausedByPlan: boolean }[];
    expect(agents.find(a => a.id === ctx.agentId)).toMatchObject({ status: 'ACTIVE', pausedByPlan: false });   // the oldest agent stays on
    expect(agents.find(a => a.id === b.id)).toMatchObject({ status: 'PAUSED', pausedByPlan: true });
    const tools = (await ctx.user.get('/api/tools').expect(200)).body.tools as { tool: string; connected: boolean; pausedByPlan: boolean }[];
    expect(tools.find(t => t.tool === 'payments')).toMatchObject({ connected: false, pausedByPlan: true });
    expect(tools.find(t => t.tool === 'gmail')).toMatchObject({ connected: true, pausedByPlan: false });

    // nothing deleted: permissions and the paused agent's row are still there
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM permissions WHERE agent_id = ? AND tool = 'payments' AND allowed = 1").get(ctx.agentId)).toEqual({ n: 1 });
    // a paused tool cannot be used, and asks for an upgrade
    locked(await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' }));
    expect((await propose(ctx, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Hi', body: 'Hello' })).status).toBe(201);
    // a plan-paused agent cannot be resumed past the limit
    locked(await ctx.user.post(`/api/agents/${b.id}/pause`).set(csrf(ctx)).send({ paused: false }));

    const back = await changePlan(ctx, 'pro');
    expect(back.status).toBe(200);
    const again = (await ctx.user.get('/api/agents').expect(200)).body.agents as { id: string; status: string }[];
    expect(again.find(a => a.id === b.id)!.status).toBe('ACTIVE');
    expect((await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' })).status).toBe(201);
    const audit = (await ctx.user.get('/api/audit?eventType=PLAN_CHANGED').expect(200)).body.events;
    expect(audit.map((e: { data: { from: string; to: string } }) => [e.data.from, e.data.to])).toEqual([['pro', 'starter'], ['starter', 'pro']]);
    expect(audit[0].data).toMatchObject({ pausedAgents: [b.id], pausedTools: expect.arrayContaining(['payments', 'x']) });
  });

  it('PLN-05 on any plan, approvals, the kill switch, in-app alerts, the live stream and the audit log are never locked', async () => {
    const ctx = await setup({ plan: 'starter' });
    await connectTool(ctx, 'gmail');
    await allow(ctx, 'gmail', 'send', { knownRecipients: ['asha@example.com'] });
    const p = await propose(ctx, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Hi', body: 'Hello' });
    expect(p.body.status).toBe('PENDING_REVIEW');
    const a = await getAction(ctx, p.body.id);
    await reauth(ctx);
    expect((await approve(ctx, a.id, a.payloadHash)).status).toBe(200);
    expect((await ctx.user.get('/api/audit').expect(200)).body.events.length).toBeGreaterThan(0);
    expect((await ctx.user.get('/api/audit/verify').expect(200)).body.ok).toBe(true);
    await ctx.user.post('/api/kill-switch').set(csrf(ctx)).send({ on: true }).expect(200);
    await ctx.user.post('/api/kill-switch').set(csrf(ctx)).send({ on: false }).expect(200);
    const types = (await ctx.user.get('/api/audit').expect(200)).body.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toContain('ALERT_SENT');
    // the live stream answers (only its status is read here)
    const login = await request(ctx.app).post('/api/auth/login').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(200);
    const server = http.createServer(ctx.app).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/stream', headers: { Cookie: String(login.headers['set-cookie'][0]).split(';')[0] } }, r => { resolve(r.statusCode ?? 0); r.destroy(); }).on('error', reject);
    });
    server.close();
    expect(status).toBe(200);
  });

  it('PLN-06 plan changes need CSRF, a known plan, and a signed-in user', async () => {
    const ctx = await setup();
    expect((await ctx.user.post('/api/me/plan').send({ plan: 'pro' })).status).toBe(403);
    expect((await changePlan(ctx, 'platinum')).status).toBe(400);
    expect((await ctx.asAgent().post('/api/me/plan').set(ctx.auth).send({ plan: 'pro' })).status).toBe(401);
    expect((await changePlan(ctx, 'plus')).status).toBe(200);   // same plan: no-op, still fine
  });
});

describe('audit retention and export', () => {
  it('PLN-07 retention: Starter shows the last 30 days; older events are kept (the chain still verifies) and come back on upgrade', async () => {
    const ctx = await setup({ plan: 'starter' });
    const before = (await ctx.user.get('/api/audit').expect(200)).body;
    expect(before.retentionDays).toBe(30);
    const oldCount = before.events.length;
    ctx.clock.advanceMinutes(40 * DAY);
    await ctx.user.post('/api/auth/login').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(200);
    ctx.csrf = (await ctx.user.get('/api/auth/csrf').expect(200)).body.token;
    const after = (await ctx.user.get('/api/audit').expect(200)).body;
    expect(after.events.some((e: { eventType: string }) => e.eventType === 'USER_SIGNUP')).toBe(false);
    expect(after.hiddenOlder).toBeGreaterThanOrEqual(oldCount);
    expect((await ctx.user.get('/api/audit/verify').expect(200)).body).toMatchObject({ ok: true });
    await changePlan(ctx, 'plus').expect(200);
    expect((await ctx.user.get('/api/audit').expect(200)).body.events.some((e: { eventType: string }) => e.eventType === 'USER_SIGNUP')).toBe(true);
  });

  it('PLN-08 export: none on Starter, CSV on Plus, CSV + JSON + an integrity report on Pro; every export is audited', async () => {
    const starter = await setup({ plan: 'starter' });
    locked(await starter.user.get('/api/audit/export?format=csv'));
    const plus = await setup();
    const csv = await plus.user.get('/api/audit/export?format=csv').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment/);
    expect(csv.text.split('\n')[0]).toBe('seq,createdAt,actorType,actorId,eventType,actionId,data,hash');
    locked(await plus.user.get('/api/audit/export?format=json'));
    locked(await plus.user.get('/api/audit/export?format=integrity'));

    const pro = await setup({ plan: 'pro' });
    const json = await pro.user.get('/api/audit/export?format=json').expect(200);
    expect(json.body.events.length).toBeGreaterThan(0);
    const report = (await pro.user.get('/api/audit/export?format=integrity').expect(200)).body;
    expect(report).toMatchObject({ chain: { ok: true }, exported: { count: expect.any(Number), firstSeq: 1 }, headHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(report.exported.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await pro.asAgent().get('/api/audit/export?format=csv').set(pro.auth)).status).toBe(401);
    const exports = (await pro.user.get('/api/audit?eventType=AUDIT_EXPORTED').expect(200)).body.events;
    expect(exports.map((e: { data: { format: string } }) => e.data.format)).toEqual(['json', 'integrity']);
  });
});

describe('push alerts and model roles', () => {
  const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' } };
  const push = { config: { vapidPublicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', vapidPrivateKey: 'x' } };

  it('PLN-09 phone (push) alerts need Plus; Starter keeps in-app alerts; a downgrade stops pushes without deleting devices', async () => {
    const sent: unknown[] = [];
    const pushSender = async () => { sent.push(1); return { statusCode: 201 }; };
    const starter = await setup({ plan: 'starter', ...push, pushSender });
    locked(await starter.user.post('/api/push/subscriptions').set(csrf(starter)).send(SUB));
    expect((await starter.user.get('/api/push/key').expect(200)).body).toMatchObject({ enabled: false, locked: true });

    const ctx = await setup({ ...push, pushSender });
    expect((await ctx.user.post('/api/push/subscriptions').set(csrf(ctx)).send(SUB)).status).toBe(201);
    await paymentsReady(ctx);
    await changePlan(ctx, 'starter').expect(200);
    await connectTool(ctx, 'gmail');
    await allow(ctx, 'gmail', 'send', { knownRecipients: ['asha@example.com'] });
    await propose(ctx, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Hi', body: 'Hello' });
    await new Promise(r => setTimeout(r, 30));
    expect(sent).toEqual([]);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 1 });
  });

  it('PLN-10 model roles: Starter may only have a guard, and only a local or small model; Plus has guard and agent', async () => {
    const add = async (ctx: Ctx, body: Record<string, unknown>) => {
      await reauth(ctx);
      const m = (await ctx.user.post('/api/models').set(csrf(ctx)).send({ apiKey: 'sk-test-key-12345678', label: String(body.modelId), ...body }).expect(201)).body;
      await reauth(ctx);
      expect((await ctx.user.post(`/api/models/${m.id}/test`).set(csrf(ctx)).send({})).body.ok).toBe(true);
      return m.id as string;
    };
    const roles = (ctx: Ctx, body: Record<string, unknown>) => ctx.user.put('/api/models/roles').set(csrf(ctx)).send(body);

    const starter = await setup({ plan: 'starter', modelFactory: guardModel });
    const opus = await add(starter, { provider: 'anthropic', modelId: 'claude-opus-5-5' });
    const haiku = await add(starter, { provider: 'anthropic', modelId: 'claude-haiku-5-5' });
    const local = await add(starter, { provider: 'ollama', modelId: 'qwen3:8b' });
    locked(await roles(starter, { agent: haiku, guard: null }));
    locked(await roles(starter, { agent: null, guard: opus }));
    expect((await roles(starter, { agent: null, guard: haiku })).status).toBe(200);
    expect((await roles(starter, { agent: null, guard: local })).status).toBe(200);
    const chat = await starter.user.post('/api/assistant/chat').set(csrf(starter)).send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(409);

    const plus = await setup({ modelFactory: guardModel });
    const a = await add(plus, { provider: 'anthropic', modelId: 'claude-opus-5-5' });
    const g = await add(plus, { provider: 'openai', modelId: 'gpt-6-luna' });
    expect((await roles(plus, { agent: a, guard: g })).status).toBe(200);
    // downgrade: the agent role switches off (kept, not deleted) and says why
    await changePlan(plus, 'starter').expect(200);
    const list = (await plus.user.get('/api/models').expect(200)).body;
    expect(list.roles.agent).toMatchObject({ active: false, offReason: 'PLAN' });
    expect(list.roles.agent.model.id).toBe(a);
    expect(list.roles.guard).toMatchObject({ active: true });   // gpt-6-luna is a small model
  });
});

describe('the plans screen and the rule itself', () => {
  it('PLN-11 /api/plans compares the plans; /api/me/entitlements shows the current plan, usage and what is paused', async () => {
    const ctx = await setup();
    const plans = (await request(ctx.app).get('/api/plans').expect(200)).body.plans;
    expect(plans.map((p: { id: string }) => p.id)).toEqual(['starter', 'plus', 'pro']);
    expect(plans[0]).toMatchObject({ name: 'Starter', priceInr: 0, entitlements: { maxAgents: 1 } });
    const me = (await ctx.user.get('/api/me/entitlements').expect(200)).body;
    expect(me).toMatchObject({ plan: 'plus', usage: { agents: 1, connectedTools: 0 }, paused: { agents: [], tools: [] } });
    expect(me.entitlements.toolCatalog).toContain('payments');
    expect(me.neverLocked).toEqual(expect.arrayContaining(['approvals', 'killSwitch', 'alerts', 'audit']));
  });

  it('PLN-12 entitlements are checked through EntitlementService only: no plan names in the app logic', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter(f => f.endsWith('.ts'));
    const allowed = new Set([path.join('services', 'plans.ts'), path.join('db', 'seed.ts')]);
    for (const f of files) {
      if (allowed.has(f)) continue;
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      expect(text, f).not.toMatch(/['"](starter|plus|pro)['"]/);
    }
  });
});
