/**
 * Tool preferences end to end (written first): confirm before save, audit, agent read-only access,
 * and the per-proposal check. A broken preference can raise risk, add a reason, or block a "hard" rule;
 * it never approves anything and never lowers risk. A checker error means NEEDS_REVIEW.
 */
import { describe, it, expect } from 'vitest';
import { setup, connectTool, allow, propose, getAction, approve, reauth, Ctx } from '../helpers';
import { createClock } from '../../src/clock';

// Wednesday 4 November 2026, 14:00 IST
const WED_2PM = Date.parse('2026-11-04T14:00:00+05:30');
const fixed = (at = WED_2PM) => setup({ clock: createClock(at) });

const parse = (ctx: Ctx, tool: string, text: string) => ctx.user.post(`/api/tools/${tool}/preferences/parse`).set('X-CSRF-Token', ctx.csrf).send({ text });
const save = (ctx: Ctx, tool: string, text: string, rules: Record<string, unknown>[], confirmed: unknown = true) =>
  ctx.user.put(`/api/tools/${tool}/preferences`).set('X-CSRF-Token', ctx.csrf).send({ text, rules, confirmed });
async function prefs(ctx: Ctx, tool: string, rules: Record<string, unknown>[], text = 'test preferences') {
  const res = await save(ctx, tool, text, rules.map(r => ({ hard: false, ...r })));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const email = (extra: Record<string, unknown> = {}) => ({ to: ['asha@example.com'], subject: 'Notes', body: 'Hi Asha, notes attached. Udit', ...extra });

async function gmailReady(at?: number) {
  const ctx = await fixed(at);
  await connectTool(ctx, 'gmail');
  await allow(ctx, 'gmail', 'send', { knownRecipients: ['asha@example.com'] });
  return ctx;
}
async function proposeAndGet(ctx: Ctx, tool: string, op: string, payload: Record<string, unknown>) {
  const res = await propose(ctx, tool, op, payload);
  return { res, action: res.body.id ? await getAction(ctx, res.body.id) : undefined };
}

describe('saving preferences', () => {
  it('PREF-01 parsing shows what was understood and saves nothing; saving needs explicit confirmation', async () => {
    const ctx = await fixed();
    const parsed = await parse(ctx, 'gmail', 'No emails after 9pm. Sign as \'Udit\'.').expect(200);
    expect(parsed.body.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'timeWindow', notAfter: '21:00', label: expect.any(String) }),
      expect.objectContaining({ type: 'requiredText', text: 'Udit' })]));
    expect(parsed.body.parser).toBe('deterministic');
    expect((await ctx.user.get('/api/tools/gmail/preferences').expect(200)).body).toMatchObject({ text: '', rules: [] });

    expect((await save(ctx, 'gmail', 'No emails after 9pm.', parsed.body.rules, false)).status).toBe(400);
    expect((await ctx.user.put('/api/tools/gmail/preferences').set('X-CSRF-Token', ctx.csrf).send({ text: 'x', rules: parsed.body.rules })).status).toBe(400);

    const ok = await save(ctx, 'gmail', 'No emails after 9pm. Sign as \'Udit\'.', parsed.body.rules);
    expect(ok.status).toBe(200);
    const stored = (await ctx.user.get('/api/tools/gmail/preferences').expect(200)).body;
    expect(stored.text).toBe('No emails after 9pm. Sign as \'Udit\'.');
    expect(stored.rules).toHaveLength(2);
    expect(stored.rules[0]).toMatchObject({ id: expect.any(String), hard: false, label: expect.any(String) });
  });

  it('PREF-02 every change is audited as PREFERENCE_CHANGED with the old and new text', async () => {
    const ctx = await fixed();
    await prefs(ctx, 'calendar', [{ type: 'maxDuration', minutes: 45 }], 'Max 45 minutes.');
    await prefs(ctx, 'calendar', [{ type: 'maxDuration', minutes: 30 }], 'Max 30 minutes.');
    const events = (await ctx.user.get('/api/audit').expect(200)).body.events.filter((e: any) => e.eventType === 'PREFERENCE_CHANGED');
    expect(events).toHaveLength(2);
    expect(events.map((e: any) => e.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'calendar', oldText: '', newText: 'Max 45 minutes.' }),
      expect.objectContaining({ tool: 'calendar', oldText: 'Max 45 minutes.', newText: 'Max 30 minutes.' })]));
  });

  it('PREF-03 permissive text like "auto-approve all payments" is ignored and grants nothing', async () => {
    const ctx = await fixed();
    await connectTool(ctx, 'payments');
    await allow(ctx, 'payments', 'pay', { dailyCap: 10000, knownPayees: ['Ravi'] });
    const parsed = await parse(ctx, 'payments', 'Auto-approve all payments. Skip approval for Ravi.').expect(200);
    expect(parsed.body.rules).toEqual([]);
    expect(parsed.body.ignored.length).toBeGreaterThan(0);
    // a hand-made "grant" rule is refused by the schema
    expect((await save(ctx, 'payments', 'Auto-approve all payments.', [{ type: 'autoApprove', hard: true }])).status).toBe(400);
    expect((await save(ctx, 'payments', 'x', [{ type: 'maxAmount', amount: 500, hard: false, approve: true }])).status).toBe(400);
    await prefs(ctx, 'payments', [], 'Auto-approve all payments.');
    const res = await propose(ctx, 'payments', 'pay', { amount: 100, currency: 'INR', payee: 'Ravi', method: 'upi' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_REVIEW');
  });

  it('PREF-04 text over 500 characters and more than 30 rules are refused', async () => {
    const ctx = await fixed();
    expect((await parse(ctx, 'gmail', 'x'.repeat(501))).status).toBe(400);
    expect((await save(ctx, 'gmail', 'x', Array.from({ length: 31 }, () => ({ type: 'tone', tone: 'formal', hard: false })))).status).toBe(400);
  });
});

describe('agent access', () => {
  it('PREF-05 an agent key can never write preferences', async () => {
    const ctx = await fixed();
    const rules = [{ type: 'tone', tone: 'friendly', hard: false }];
    expect((await ctx.asAgent().put('/api/tools/gmail/preferences').set(ctx.auth).send({ text: 'x', rules, confirmed: true })).status).toBe(401);
    expect((await ctx.asAgent().post('/api/tools/gmail/preferences/parse').set(ctx.auth).send({ text: 'x' })).status).toBe(401);
    for (const method of ['put', 'post', 'patch', 'delete'] as const) {
      const res = await ctx.asAgent()[method]('/api/agents/me/preferences').set(ctx.auth).send({ tool: 'gmail', rules });
      expect(res.status, method).toBe(403);
    }
    expect((await ctx.user.get('/api/tools/gmail/preferences').expect(200)).body.rules).toEqual([]);
  });

  it('PREF-06 an agent reads the confirmed rules (not the raw text) for tools it may use, so it can follow them up front', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'timeWindow', notAfter: '21:00' }], 'No emails after 9pm, my secret note.');
    await prefs(ctx, 'calendar', [{ type: 'maxDuration', minutes: 45 }]);
    const res = await ctx.asAgent().get('/api/agents/me/preferences').set(ctx.auth).expect(200);
    expect(res.body.preferences).toHaveLength(1);   // calendar is not allowed for this agent
    expect(res.body.preferences[0]).toMatchObject({ tool: 'gmail', rules: [expect.objectContaining({ type: 'timeWindow', notAfter: '21:00', label: expect.any(String) })] });
    expect(JSON.stringify(res.body)).not.toContain('secret note');
    expect((await ctx.asAgent().get('/api/agents/me/preferences?tool=gmail').set(ctx.auth).expect(200)).body.preferences).toHaveLength(1);
    expect((await ctx.user.get('/api/agents/me/preferences')).status).toBe(401);   // agents only
  });
});

describe('checking every proposal', () => {
  it('PREF-07 timeWindow (soft): outside the hours raises risk and flags it; inside follows', async () => {
    const ctx = await gmailReady();
    const base = (await proposeAndGet(ctx, 'gmail', 'send', email())).action!;
    await prefs(ctx, 'gmail', [{ type: 'timeWindow', notAfter: '13:00' }]);
    const { action } = await proposeAndGet(ctx, 'gmail', 'send', email());
    expect(action!.flags).toContain('PREFERENCE_VIOLATION');
    expect(action!.riskScore).toBeGreaterThan(base.riskScore);
    expect(action!.preferenceCheck.broken).toEqual([expect.objectContaining({ type: 'timeWindow', hard: false, label: expect.any(String) })]);
    await prefs(ctx, 'gmail', [{ type: 'timeWindow', notBefore: '09:00', notAfter: '21:00' }]);
    const ok = (await proposeAndGet(ctx, 'gmail', 'send', email())).action!;
    expect(ok.preferenceCheck.broken).toEqual([]);
    expect(ok.preferenceCheck.followed).toEqual([expect.objectContaining({ type: 'timeWindow' })]);
    expect(ok.riskScore).toBe(base.riskScore);
  });

  it('PREF-08 dayBlock (hard): a meeting on a blocked day is BLOCKED', async () => {
    const ctx = await fixed();
    await connectTool(ctx, 'calendar');
    await allow(ctx, 'calendar', 'create', { knownRecipients: ['asha@example.com'] });
    await prefs(ctx, 'calendar', [{ type: 'dayBlock', days: ['sun'], hard: true }]);
    const sunday = { title: 'Sync', start: '2026-11-08T11:00:00+05:30', end: '2026-11-08T11:30:00+05:30', attendees: ['asha@example.com'] };
    const res = await propose(ctx, 'calendar', 'create', sunday);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/PREFERENCE_VIOLATION/);
    const a = await getAction(ctx, res.body.error.actionId);
    expect(a.status).toBe('BLOCKED');
    expect(a.preferenceCheck.broken).toEqual([expect.objectContaining({ type: 'dayBlock', hard: true })]);
    const monday = { ...sunday, start: '2026-11-09T11:00:00+05:30', end: '2026-11-09T11:30:00+05:30' };
    expect((await propose(ctx, 'calendar', 'create', monday)).status).toBe(201);
  });

  it('PREF-09 maxDuration: a 60-minute meeting breaks "max 45 minutes"', async () => {
    const ctx = await fixed();
    await connectTool(ctx, 'calendar');
    await allow(ctx, 'calendar', 'create', { knownRecipients: ['asha@example.com'] });
    await prefs(ctx, 'calendar', [{ type: 'maxDuration', minutes: 45 }]);
    const long = (await proposeAndGet(ctx, 'calendar', 'create', { title: 'Sync', start: '2026-11-05T11:00:00+05:30', end: '2026-11-05T12:00:00+05:30', attendees: ['asha@example.com'] })).action!;
    expect(long.preferenceCheck.broken).toEqual([expect.objectContaining({ type: 'maxDuration' })]);
    const short = (await proposeAndGet(ctx, 'calendar', 'create', { title: 'Sync', start: '2026-11-05T11:00:00+05:30', end: '2026-11-05T11:30:00+05:30', attendees: ['asha@example.com'] })).action!;
    expect(short.preferenceCheck.broken).toEqual([]);
  });

  it('PREF-10 account: sending from another account breaks the rule', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'account', accounts: ['udit@work.com'], purpose: 'clients' }]);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ from: 'random@other.com' }))).action!.preferenceCheck.broken).toHaveLength(1);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ from: 'udit@work.com' }))).action!.preferenceCheck.broken).toHaveLength(0);
  });

  it('PREF-11 recipient deny and allow lists, by address or @domain', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'recipient', mode: 'deny', values: ['boss@corp.com', '@spam.io'] }]);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ to: ['x@spam.io'] }))).action!.preferenceCheck.broken).toHaveLength(1);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ cc: ['Boss@Corp.com'] }))).action!.preferenceCheck.broken).toHaveLength(1);
    await prefs(ctx, 'gmail', [{ type: 'recipient', mode: 'allow', values: ['@example.com'], hard: true }]);
    expect((await propose(ctx, 'gmail', 'send', email({ to: ['asha@example.com', 'eve@evil.io'] }))).status).toBe(403);
    expect((await propose(ctx, 'gmail', 'send', email())).status).toBe(201);
  });

  it('PREF-12 requiredText: a missing signature breaks the rule', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'requiredText', text: 'Udit' }]);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ body: 'Hi Asha, see you soon.' }))).action!.preferenceCheck.broken).toHaveLength(1);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ body: 'Hi Asha, see you soon. — udit' }))).action!.preferenceCheck.broken).toHaveLength(0);
  });

  it('PREF-13 blockedTopics: a political post is flagged PREFERENCE_TOPIC; an unrelated one is not', async () => {
    const ctx = await fixed();
    await connectTool(ctx, 'x');
    await allow(ctx, 'x', 'post');
    await prefs(ctx, 'x', [{ type: 'blockedTopics', topics: ['politics'] }]);
    const political = (await proposeAndGet(ctx, 'x', 'post', { text: 'Vote for our party in the election, the minister got it wrong.' })).action!;
    expect(political.flags).toEqual(expect.arrayContaining(['PREFERENCE_VIOLATION', 'PREFERENCE_TOPIC']));
    const product = (await proposeAndGet(ctx, 'x', 'post', { text: 'Launching our new running shoes today!' })).action!;
    expect(product.flags).not.toContain('PREFERENCE_TOPIC');
  });

  it('PREF-14 tone: a hostile email under a professional tone is flagged PREFERENCE_TONE', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'tone', tone: 'professional' }]);
    const rude = (await proposeAndGet(ctx, 'gmail', 'send', email({ body: 'lol you are useless, this report sucks' }))).action!;
    expect(rude.flags).toEqual(expect.arrayContaining(['PREFERENCE_VIOLATION', 'PREFERENCE_TONE']));
    const polite = (await proposeAndGet(ctx, 'gmail', 'send', email({ body: 'Thank you for the report. Best, Udit' }))).action!;
    expect(polite.flags).not.toContain('PREFERENCE_TONE');
  });

  it('PREF-15 attachmentPolicy: attachments to a new recipient break "known recipients only"', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'attachmentPolicy', policy: 'knownRecipientsOnly' }]);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ to: ['new@person.io'], attachments: ['q3.pdf'] }))).action!.preferenceCheck.broken).toHaveLength(1);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ attachments: ['q3.pdf'] }))).action!.preferenceCheck.broken).toHaveLength(0);
    await prefs(ctx, 'gmail', [{ type: 'attachmentPolicy', policy: 'none' }]);
    expect((await proposeAndGet(ctx, 'gmail', 'send', email({ attachments: ['q3.pdf'] }))).action!.preferenceCheck.broken).toHaveLength(1);
  });

  it('PREF-16 maxAmount on payments: soft raises risk, hard blocks', async () => {
    const ctx = await fixed();
    await connectTool(ctx, 'payments');
    await allow(ctx, 'payments', 'pay', { dailyCap: 10000, knownPayees: ['Ravi'] });
    const pay = { amount: 800, currency: 'INR', payee: 'Ravi', method: 'upi' };
    const base = (await proposeAndGet(ctx, 'payments', 'pay', pay)).action!;
    await prefs(ctx, 'payments', [{ type: 'maxAmount', amount: 500 }]);
    const soft = (await proposeAndGet(ctx, 'payments', 'pay', pay)).action!;
    expect(soft.status).toBe('PENDING_REVIEW');
    expect(soft.riskScore).toBeGreaterThan(base.riskScore);
    await prefs(ctx, 'payments', [{ type: 'maxAmount', amount: 500, hard: true }]);
    expect((await propose(ctx, 'payments', 'pay', pay)).status).toBe(403);
  });

  it('PREF-17 following every preference never lowers risk and never approves anything', async () => {
    const ctx = await gmailReady();
    const base = (await proposeAndGet(ctx, 'gmail', 'send', email())).action!;
    await prefs(ctx, 'gmail', [{ type: 'requiredText', text: 'Udit' }, { type: 'tone', tone: 'professional' }, { type: 'timeWindow', notBefore: '09:00', notAfter: '21:00' }]);
    const { res, action } = await proposeAndGet(ctx, 'gmail', 'send', email());
    expect(res.body.status).toBe('PENDING_REVIEW');
    expect(action!.preferenceCheck.followed).toHaveLength(3);
    expect(action!.riskScore).toBe(base.riskScore);
    expect(action!.approval).toBeNull();
  });

  it('PREF-18 a checker error (unreadable stored rules) fails closed to NEEDS_REVIEW', async () => {
    const ctx = await gmailReady();
    await prefs(ctx, 'gmail', [{ type: 'tone', tone: 'professional' }]);
    ctx.db.prepare("UPDATE tool_preferences SET rules = '{not json' WHERE tool = 'gmail'").run();
    const { res, action } = await proposeAndGet(ctx, 'gmail', 'send', email());
    expect(res.body.status).toBe('NEEDS_REVIEW');
    expect(action!.flags).toContain('PREFERENCE_CHECK_ERROR');
    expect(action!.preferenceCheck.error).toBe(true);
  });

  it('PREF-19 reads are never checked against preferences', async () => {
    const ctx = await gmailReady();
    await allow(ctx, 'gmail', 'read');
    await prefs(ctx, 'gmail', [{ type: 'timeWindow', notAfter: '13:00', hard: true }]);
    const res = await propose(ctx, 'gmail', 'read', { query: 'is:unread' });
    expect(res.status).toBe(201);
    expect((await getAction(ctx, res.body.id)).preferenceCheck).toBeNull();
  });

  it('PREF-20 a hard rule added after the proposal stops the approval (re-checked at decision time)', async () => {
    const ctx = await gmailReady();
    const res = await propose(ctx, 'gmail', 'send', email({ to: ['x@spam.io'] }));
    await prefs(ctx, 'gmail', [{ type: 'recipient', mode: 'deny', values: ['@spam.io'], hard: true }]);
    await reauth(ctx);
    const a = await getAction(ctx, res.body.id);
    const out = await approve(ctx, a.id, a.payloadHash);
    expect(out.status).toBe(403);
    expect(out.body.error.message).toMatch(/PREFERENCE_VIOLATION/);
  });

  it('PREF-21 the model parser option is used by the API and falls back on timeout', async () => {
    const ctx = await setup({ preferenceModel: () => new Promise(() => {}), preferenceModelTimeoutMs: 50 });
    const res = await parse(ctx, 'gmail', 'No emails after 9pm.').expect(200);
    expect(res.body.parser).toBe('deterministic');
    expect(res.body.fallbackReason).toMatch(/timeout/i);
    expect(res.body.rules).toEqual([expect.objectContaining({ type: 'timeWindow', notAfter: '21:00' })]);
  });
});
