/**
 * Payment limits (written first): per-transaction max, daily/weekly/monthly caps, payee rules, methods,
 * blocked categories, allowed hours, re-auth above a threshold, and spend vs. caps for the dashboard.
 * Going over a cap is BLOCKED; a new payee or a category hit only raises the risk.
 */
import { describe, it, expect } from 'vitest';
import { setup, connectTool, allow, propose, getAction, approve, reauth, Ctx } from '../helpers';
import { createClock } from '../../src/clock';

const MON_10AM = Date.parse('2026-11-02T10:00:00+05:30');   // Monday
const WED_2PM = Date.parse('2026-11-04T14:00:00+05:30');
const pay = (amount: number, payee = 'Ravi', extra: Record<string, unknown> = {}) => ({ amount, currency: 'INR', payee, method: 'upi', ...extra });

async function ready(limits: Record<string, unknown>, at = WED_2PM) {
  const ctx = await setup({ clock: createClock(at) });
  await connectTool(ctx, 'payments');
  await allow(ctx, 'payments', 'pay', { currency: 'INR', knownPayees: ['Ravi', 'Asha'], ...limits });
  return ctx;
}
/** A completed payment, so it counts towards the caps. */
async function spend(ctx: Ctx, amount: number, payee = 'Ravi') {
  const res = await propose(ctx, 'payments', 'pay', pay(amount, payee));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await reauth(ctx);
  const a = await getAction(ctx, res.body.id);
  expect((await approve(ctx, a.id, a.payloadHash)).status).toBe(200);
}
/** Jump ahead in days; the 12-hour session has expired by then, so sign in again. */
async function later(ctx: Ctx, days: number) {
  ctx.clock.advanceMinutes(days * 24 * 60);
  await ctx.user.post('/api/auth/login').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(200);
  ctx.csrf = (await ctx.user.get('/api/auth/csrf').expect(200)).body.token;
}
const reason = (res: { body: any }) => res.body.error?.message ?? '';

describe('payment caps', () => {
  it('PAY-01 a per-transaction max blocks a bigger payment', async () => {
    const ctx = await ready({ maxAmount: 1000 });
    const res = await propose(ctx, 'payments', 'pay', pay(1500));
    expect(res.status).toBe(403);
    expect(reason(res)).toMatch(/LIMIT_EXCEEDED/);
    expect((await propose(ctx, 'payments', 'pay', pay(900))).status).toBe(201);
  });

  it('PAY-02 the daily cap counts today\'s payments', async () => {
    const ctx = await ready({ dailyCap: 2000 });
    await spend(ctx, 1500);
    expect(reason(await propose(ctx, 'payments', 'pay', pay(600)))).toMatch(/LIMIT_EXCEEDED/);
    expect((await propose(ctx, 'payments', 'pay', pay(400))).status).toBe(201);
  });

  it('PAY-03 the weekly cap counts the whole week (from Monday), not just today', async () => {
    const ctx = await ready({ dailyCap: 10000, weeklyCap: 5000 }, MON_10AM);
    await spend(ctx, 3000);
    await later(ctx, 2);   // Wednesday: today is empty, the week is not
    const res = await propose(ctx, 'payments', 'pay', pay(2500));
    expect(res.status).toBe(403);
    expect(reason(res)).toMatch(/WEEKLY_LIMIT_EXCEEDED/);
    expect((await propose(ctx, 'payments', 'pay', pay(1500))).status).toBe(201);
  });

  it('PAY-04 the monthly cap counts the whole calendar month', async () => {
    const ctx = await ready({ weeklyCap: 10000, monthlyCap: 4000 }, MON_10AM);
    await spend(ctx, 3000);
    await later(ctx, 10);  // 12 November: a new week, the same month
    const res = await propose(ctx, 'payments', 'pay', pay(1500));
    expect(res.status).toBe(403);
    expect(reason(res)).toMatch(/MONTHLY_LIMIT_EXCEEDED/);
    expect((await propose(ctx, 'payments', 'pay', pay(900))).status).toBe(201);
  });
});

describe('payee rules', () => {
  it('PAY-05 a per-payee cap (per month) limits what one payee can receive', async () => {
    const ctx = await ready({ dailyCap: 10000, payeeCaps: { Ravi: 1000 } });
    await spend(ctx, 800, 'Ravi');
    const res = await propose(ctx, 'payments', 'pay', pay(300, 'ravi'));
    expect(res.status).toBe(403);
    expect(reason(res)).toMatch(/PAYEE_LIMIT_EXCEEDED/);
    expect((await propose(ctx, 'payments', 'pay', pay(300, 'Asha'))).status).toBe(201);
  });

  it('PAY-06 new payees can be blocked outright', async () => {
    const ctx = await ready({ dailyCap: 10000, newPayees: 'block' });
    const res = await propose(ctx, 'payments', 'pay', pay(100, 'Stranger'));
    expect(res.status).toBe(403);
    expect(reason(res)).toMatch(/NEW_PAYEE_BLOCKED/);
    expect((await propose(ctx, 'payments', 'pay', pay(100, 'Asha'))).status).toBe(201);
  });

  it('PAY-07 by default a new payee needs approval and raises the risk', async () => {
    const ctx = await ready({ dailyCap: 10000, newPayees: 'approve' });
    const known = await getAction(ctx, (await propose(ctx, 'payments', 'pay', pay(100))).body.id);
    const res = await propose(ctx, 'payments', 'pay', pay(100, 'Stranger'));
    expect(res.status).toBe(201);
    const a = await getAction(ctx, res.body.id);
    expect(a.flags).toContain('NEW_PAYEE');
    expect(a.riskScore).toBeGreaterThan(known.riskScore);
  });
});

describe('methods, categories and hours', () => {
  it('PAY-08 only the switched-on methods may be used; a missing method needs review', async () => {
    const ctx = await ready({ dailyCap: 10000, allowedMethods: ['upi', 'netbanking'] });
    const card = await propose(ctx, 'payments', 'pay', pay(100, 'Ravi', { method: 'card' }));
    expect(card.status).toBe(403);
    expect(reason(card)).toMatch(/METHOD_NOT_ALLOWED/);
    expect((await propose(ctx, 'payments', 'pay', pay(100, 'Ravi', { method: 'netbanking' }))).status).toBe(201);
    const none = await propose(ctx, 'payments', 'pay', { amount: 100, currency: 'INR', payee: 'Ravi' });
    expect(none.body.status).toBe('NEEDS_REVIEW');
    expect((await getAction(ctx, none.body.id)).flags).toContain('MISSING_DETAILS');
  });

  it('PAY-09 a blocked category is BLOCKED when named, and raises the risk when it only shows in the text', async () => {
    const ctx = await ready({ dailyCap: 10000, blockedCategories: ['gambling', 'crypto', 'gift cards'] });
    const named = await propose(ctx, 'payments', 'pay', pay(100, 'Ravi', { category: 'Gambling' }));
    expect(named.status).toBe(403);
    expect(reason(named)).toMatch(/CATEGORY_BLOCKED/);
    const hinted = await propose(ctx, 'payments', 'pay', pay(100, 'Lucky Star Casino', { note: 'poker chips top-up' }));
    expect(hinted.status).toBe(201);
    const a = await getAction(ctx, hinted.body.id);
    expect(a.flags).toContain('CATEGORY_MATCH');
    expect(a.riskLevel).toBe('CRITICAL');
    expect((await getAction(ctx, (await propose(ctx, 'payments', 'pay', pay(100, 'Ravi', { note: 'Lunch' }))).body.id)).flags).not.toContain('CATEGORY_MATCH');
  });

  it('PAY-10 allowed hours (08:00–22:00 IST) block payments outside them when enforced', async () => {
    const late = await ready({ dailyCap: 10000, timeWindow: { start: '08:00', end: '22:00' }, enforceHours: true }, Date.parse('2026-11-04T23:00:00+05:30'));
    const res = await propose(late, 'payments', 'pay', pay(100));
    expect(res.status).toBe(403);
    expect(reason(res)).toMatch(/OUTSIDE_ALLOWED_HOURS/);
    const day = await ready({ dailyCap: 10000, timeWindow: { start: '08:00', end: '22:00' }, enforceHours: true });
    expect((await propose(day, 'payments', 'pay', pay(100))).status).toBe(201);
  });

  it('PAY-11 above the re-auth threshold the password (PIN) is always required', async () => {
    const ctx = await ready({ dailyCap: 10000, reauthAbove: 2000 });
    const res = await propose(ctx, 'payments', 'pay', pay(2500));
    const a = await getAction(ctx, res.body.id);
    expect(a.flags).toContain('REAUTH_THRESHOLD');
    expect(a.requiresReauth).toBe(true);
    const out = await approve(ctx, a.id, a.payloadHash);
    expect(out.status).toBe(401);
    expect(out.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('PAY-12 invalid payment limits are refused', async () => {
    const ctx = await setup();
    for (const limits of [{ allowedMethods: ['bitcoin'] }, { weeklyCap: -5 }, { newPayees: 'sometimes' }, { payeeCaps: { Ravi: 0 } }, { reauthAbove: 'lots' }]) {
      const res = await ctx.user.put(`/api/agents/${ctx.agentId}/permissions`).set('X-CSRF-Token', ctx.csrf)
        .send({ permissions: [{ tool: 'payments', operation: 'pay', allowed: true, limits }] });
      expect(res.status, JSON.stringify(limits)).toBe(400);
    }
  });
});

describe('spend vs. caps', () => {
  it('PAY-13 the dashboard gets spent today / this week / this month against each cap', async () => {
    const ctx = await ready({ dailyCap: 5000, weeklyCap: 8000, monthlyCap: 20000 }, MON_10AM);
    await spend(ctx, 1200);
    await later(ctx, 1);
    await spend(ctx, 300);
    await propose(ctx, 'payments', 'pay', pay(999));   // pending: not spent
    const res = await ctx.user.get('/api/me/spending').expect(200);
    expect(res.body.currency).toBe('INR');
    expect(res.body.agents).toEqual([expect.objectContaining({
      agentId: ctx.agentId, agentName: 'Helper',
      today: 300, week: 1500, month: 1500,
      caps: { daily: 5000, weekly: 8000, monthly: 20000 }
    })]);
    expect((await ctx.asAgent().get('/api/me/spending').set(ctx.auth)).status).toBe(401);
  });
});
