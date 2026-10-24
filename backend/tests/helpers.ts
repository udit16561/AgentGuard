/**
 * Black-box test helpers. They talk to the API only through HTTP (supertest),
 * so the tests stay valid however the services are implemented.
 *
 * Contract the backend must provide:
 *   src/app.ts exports createApp(options) -> { app: Express, clock: TestClock, db }
 *     options.dbPath     ':memory:' for tests
 *     options.clock      injectable clock so tests can jump past the approval TTL
 *     options.classifier optional override for IntentService's model layer
 */
import request from 'supertest';
import { createApp } from '../src/app';

export type Ctx = Awaited<ReturnType<typeof setup>>;

export async function setup(opts: Record<string, unknown> = {}) {
  const { app, clock, db } = await createApp({ dbPath: ':memory:', ...opts });
  const user = request.agent(app); // keeps the session cookie

  await user.post('/api/auth/signup').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(201);
  const csrf = (await user.get('/api/auth/csrf').expect(200)).body.token as string;

  const agentRes = await user.post('/api/agents').set('X-CSRF-Token', csrf).send({ name: 'Helper' }).expect(201);
  const agentId = agentRes.body.id as string;
  const agentKey = agentRes.body.apiKey as string;

  const asAgent = () => request(app);
  const auth = { Authorization: `Bearer ${agentKey}` };

  return { app, clock, db, user, csrf, agentId, agentKey, asAgent, auth };
}

export async function connectTool(ctx: Ctx, tool: string) {
  await ctx.user.post(`/api/tools/${tool}/connect`).set('X-CSRF-Token', ctx.csrf).send({}).expect(200);
}

export async function allow(ctx: Ctx, tool: string, operation: string, limits: Record<string, unknown> = {}) {
  await ctx.user
    .put(`/api/agents/${ctx.agentId}/permissions`)
    .set('X-CSRF-Token', ctx.csrf)
    .send({ permissions: [{ tool, operation, allowed: true, limits }] })
    .expect(200);
}

export function propose(ctx: Ctx, tool: string, operation: string, payload: Record<string, unknown>) {
  return ctx.asAgent().post('/api/actions').set(ctx.auth).send({ tool, operation, payload });
}

export async function getAction(ctx: Ctx, id: string) {
  return (await ctx.user.get(`/api/actions/${id}`).expect(200)).body;
}

export function approve(ctx: Ctx, id: string, payloadHash: string) {
  return ctx.user.post(`/api/actions/${id}/approve`).set('X-CSRF-Token', ctx.csrf).send({ payloadHash });
}

export async function reauth(ctx: Ctx) {
  await ctx.user.post('/api/auth/reauth').set('X-CSRF-Token', ctx.csrf).send({ password: 'Owner#12345' }).expect(200);
}

/** Standard payment setup: Payments connected, `pay` allowed with a ₹10,000 daily cap, Ravi a known payee. */
export async function paymentsReady(ctx: Ctx) {
  await connectTool(ctx, 'payments');
  await allow(ctx, 'payments', 'pay', { dailyCap: 10000, currency: 'INR', knownPayees: ['Ravi'] });
}
