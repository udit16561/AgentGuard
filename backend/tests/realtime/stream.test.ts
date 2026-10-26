/**
 * Live alerts over SSE (v0.6.0, written first). The stream only says *what changed* (event type and action id);
 * the page then fetches details through the normal authenticated API, so nothing sensitive rides on the stream.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { setup, propose, paymentsReady, Ctx } from '../helpers';

const servers: http.Server[] = [];
afterEach(() => { servers.splice(0).forEach(s => s.close()); });

/** Opens /api/stream with the user's cookie and collects parsed SSE events. */
async function openStream(ctx: Ctx, headers: Record<string, string> = {}) {
  const server = http.createServer(ctx.app);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  // a second session for the same owner, through a plain request, so the cookie can be read
  const login = await request(ctx.app).post('/api/auth/login').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(200);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let raw = '';
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Cookie: cookie, Accept: 'text/event-stream', ...headers } }, resolve);
    req.on('error', reject);
  });
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    raw += chunk;
    let i;
    while ((i = raw.indexOf('\n\n')) >= 0) {
      const block = raw.slice(0, i); raw = raw.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (data) events.push({ event, data: JSON.parse(data) });
    }
  });
  const waitFor = async (pred: (e: { event: string; data: Record<string, unknown> }) => boolean, ms = 2000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`no matching event; got ${JSON.stringify(events)}`);
  };
  return { res, events, waitFor, close: () => res.destroy() };
}

describe('SSE stream', () => {
  it('RT-01 only a signed-in user can open the stream; agent keys and anonymous callers get 401', async () => {
    const ctx = await setup();
    expect((await request(ctx.app).get('/api/stream')).status).toBe(401);
    expect((await ctx.asAgent().get('/api/stream').set(ctx.auth)).status).toBe(401);
  });

  it('RT-02 a new proposal is pushed to the dashboard at once, with only the event type and action id', async () => {
    const ctx = await setup();
    await paymentsReady(ctx);
    const s = await openStream(ctx);
    expect(s.res.statusCode).toBe(200);
    expect(s.res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(s.res.headers['cache-control']).toMatch(/no-store|no-cache/);
    await s.waitFor(e => e.event === 'ready');
    const p = await propose(ctx, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi', note: 'secret note' });
    const alert = await s.waitFor(e => e.data.eventType === 'ALERT_SENT', 500);
    expect(alert.event).toBe('change');
    expect(alert.data).toEqual({ eventType: 'ALERT_SENT', actionId: p.body.id });
    expect(JSON.stringify(s.events)).not.toContain('secret note');
    s.close();
  });

  it('RT-03 a user only receives their own events', async () => {
    const a = await setup();
    const b = await setup();
    await paymentsReady(b);
    const s = await openStream(a);
    await s.waitFor(e => e.event === 'ready');
    await propose(b, 'payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi' });
    await new Promise(r => setTimeout(r, 100));
    expect(s.events.filter(e => e.event === 'change')).toEqual([]);
    s.close();
  });

  it('RT-04 the kill switch and decisions are streamed too', async () => {
    const ctx = await setup();
    const s = await openStream(ctx);
    await s.waitFor(e => e.event === 'ready');
    await ctx.user.post('/api/kill-switch').set('X-CSRF-Token', ctx.csrf).send({ on: true }).expect(200);
    await s.waitFor(e => e.data.eventType === 'KILL_SWITCH_ON', 500);
    s.close();
  });

  it('RT-05 closing the page releases the stream listener', async () => {
    const ctx = await setup();
    const s = await openStream(ctx);
    await s.waitFor(e => e.event === 'ready');
    const events = (ctx as unknown as { app: { locals: { events?: { listenerCount: () => number } } } }).app.locals.events!;
    expect(events.listenerCount()).toBe(1);
    s.close();
    await new Promise(r => setTimeout(r, 50));
    expect(events.listenerCount()).toBe(0);
  });
});
