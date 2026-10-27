/**
 * v0.8.0: the first LIVE adapter, Google Calendar (owner-approved, Calendar only), written first.
 * Google's HTTP is mocked (tests/integrations/google-mock.ts): no test reaches Google. Everything but Calendar stays MOCK.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setup, connectTool, allow, propose, getAction, approve, reauth, Ctx } from '../helpers';
import { mockGoogle, SCOPE } from './google-mock';
import { runLiveCheck } from '../../src/integrations/google/liveCheck';
import { createApp } from '../../src/app';

const GOOGLE = { integrationMode: 'live', googleClientId: 'cid-123.apps.googleusercontent.com', googleClientSecret: 'CLIENT-SECRET-XYZ' } as const;
const REDIRECT = 'https://localhost:4443/api/oauth/google/callback';
const csrf = (ctx: Ctx) => ({ 'X-CSRF-Token': ctx.csrf });
const EVENT = { title: 'Project sync', start: '2026-11-02T10:00:00+05:30', end: '2026-11-02T10:30:00+05:30', attendees: ['asha@example.com'] };

type Live = Ctx & { google: ReturnType<typeof mockGoogle> };

async function liveSetup(opts: { config?: Record<string, unknown>; plan?: string; dbPath?: string } = {}): Promise<Live> {
  const google = mockGoogle();
  const ctx = await setup({ config: { ...GOOGLE, ...opts.config }, googleFetch: google.fetch, ...(opts.plan ? { plan: opts.plan } : {}), ...(opts.dbPath ? { dbPath: opts.dbPath } : {}) });
  await connectTool(ctx, 'calendar');
  return { ...ctx, google };
}

/** Starts "Use live Google Calendar": re-auth, then the start call; returns the Google consent URL. */
async function startLive(ctx: Ctx) {
  await reauth(ctx);
  const res = await ctx.user.post('/api/tools/calendar/live').set(csrf(ctx)).send({}).expect(200);
  return new URL(res.body.url);
}

/** The whole consent round trip (Google's consent screen is skipped: the mock accepts code auth-code-1). */
async function goLive(ctx: Live) {
  const url = await startLive(ctx);
  const cb = await ctx.user.get(`/api/oauth/google/callback?code=auth-code-1&state=${url.searchParams.get('state')}`);
  expect(cb.status).toBe(303);
  expect(cb.headers.location).toBe('/#/tools?live=calendar');
  return url;
}

async function approveLatest(ctx: Ctx, id: string) {
  const a = await getAction(ctx, id);
  return approve(ctx, id, a.payloadHash);
}

const tool = async (ctx: Ctx, name = 'calendar') => (await ctx.user.get('/api/tools').expect(200)).body.tools.find((t: { tool: string }) => t.tool === name);
const auditTypes = (ctx: Ctx) => (ctx.db.prepare('SELECT event_type, data FROM audit_events ORDER BY seq').all() as { event_type: string; data: string }[]);

const relogin = (ctx: Ctx) => ctx.user.post('/api/auth/login').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(200);

afterEach(() => { vi.restoreAllMocks(); });

describe('switching Calendar to LIVE', () => {
  it('LIVE-01 needs CSRF, a fresh password check, INTEGRATION_MODE=live, the Google client in .env and a plan with live integrations', async () => {
    const ctx = await liveSetup();
    expect((await ctx.user.post('/api/tools/calendar/live').send({})).status).toBe(403);   // no CSRF
    const noReauth = await ctx.user.post('/api/tools/calendar/live').set(csrf(ctx)).send({});
    expect(noReauth.status).toBe(401);
    expect(noReauth.body.error.code).toBe('REAUTH_REQUIRED');

    const mock = await liveSetup({ config: { integrationMode: 'mock' } });
    await reauth(mock);
    const off = await mock.user.post('/api/tools/calendar/live').set(csrf(mock)).send({});
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('LIVE_UNAVAILABLE');
    expect(off.body.error.message).toMatch(/INTEGRATION_MODE=live/);

    const noClient = await liveSetup({ config: { googleClientId: null, googleClientSecret: null } });
    await reauth(noClient);
    const nc = await noClient.user.post('/api/tools/calendar/live').set(csrf(noClient)).send({});
    expect(nc.status).toBe(409);
    expect(nc.body.error.message).toMatch(/GOOGLE_CLIENT_ID/);

    const starter = await liveSetup({ plan: 'starter' });
    await reauth(starter);
    const st = await starter.user.post('/api/tools/calendar/live').set(csrf(starter)).send({});
    expect(st.status).toBe(402);
    expect(st.body.error.code).toBe('ENTITLEMENT_REQUIRED');

    // only Calendar has a live adapter
    await reauth(ctx);
    expect((await ctx.user.post('/api/tools/gmail/live').set(csrf(ctx)).send({})).status).toBe(404);
  });

  it('LIVE-02 the consent URL: Google OAuth directly, the fixed https://localhost:4443 redirect, PKCE (S256), a random state, calendar.events only, offline access', async () => {
    const ctx = await liveSetup();
    const url = await startLive(ctx);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(GOOGLE.googleClientId);
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe(SCOPE);   // the minimum: no profile, no email, no read-everything scope
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(q.has('include_granted_scopes')).toBe(false);
    expect(q.get('client_secret')).toBeNull();
    expect(url.toString()).not.toContain(GOOGLE.googleClientSecret);
    const again = await startLive(ctx);
    expect(again.searchParams.get('state')).not.toBe(q.get('state'));

    // the code exchange sends the PKCE verifier that matches the challenge, and the client secret from .env (server side only)
    await ctx.user.get(`/api/oauth/google/callback?code=auth-code-1&state=${q.get('state')}`).expect(303);
    const exchange = ctx.google.tokenCalls()[0].body as Record<string, string>;
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code-1', redirect_uri: REDIRECT, client_id: GOOGLE.googleClientId, client_secret: GOOGLE.googleClientSecret });
    expect(crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(q.get('code_challenge'));
  });

  it('LIVE-03 the callback refuses a wrong, reused or expired state, a missing browser binding, a Google error and a narrower scope; nothing is connected live', async () => {
    const ctx = await liveSetup();
    const live = async () => (await tool(ctx)).mode;
    const cb = (q: string, agent = ctx.user) => agent.get(`/api/oauth/google/callback?${q}`);

    expect((await cb('code=auth-code-1&state=forged')).headers.location).toBe('/#/tools?live=failed');
    expect((await cb('code=auth-code-1')).headers.location).toBe('/#/tools?live=failed');
    expect(await live()).toBe('MOCK');

    // another browser (no binding cookie) cannot finish this user's flow: no connect-CSRF
    const state1 = (await startLive(ctx)).searchParams.get('state')!;
    const other = request.agent(ctx.app);
    expect((await cb(`code=auth-code-1&state=${state1}`, other)).headers.location).toBe('/#/tools?live=failed');
    expect(ctx.google.tokenCalls()).toHaveLength(0);

    // the user said no on Google's screen
    const state2 = (await startLive(ctx)).searchParams.get('state')!;
    expect((await cb(`error=access_denied&state=${state2}`)).headers.location).toBe('/#/tools?live=denied');

    // expired after 10 minutes
    const state3 = (await startLive(ctx)).searchParams.get('state')!;
    ctx.clock.advanceMinutes(11);
    expect((await cb(`code=auth-code-1&state=${state3}`)).headers.location).toBe('/#/tools?live=failed');

    // Google granted less than calendar.events (the user unticked it)
    ctx.google.s.scope = 'openid';
    const state4 = (await startLive(ctx)).searchParams.get('state')!;
    expect((await cb(`code=auth-code-1&state=${state4}`)).headers.location).toBe('/#/tools?live=failed');
    expect(await live()).toBe('MOCK');

    // single use: a state works once
    ctx.google.s.scope = SCOPE;
    const state5 = (await startLive(ctx)).searchParams.get('state')!;
    expect((await cb(`code=auth-code-1&state=${state5}`)).headers.location).toBe('/#/tools?live=calendar');
    expect((await cb(`code=auth-code-1&state=${state5}`)).headers.location).toBe('/#/tools?live=failed');
    expect(await live()).toBe('LIVE');
    const failures = auditTypes(ctx).filter(e => e.event_type === 'LIVE_CONNECT_FAILED');
    expect(failures.length).toBeGreaterThanOrEqual(4);
  });

  it('LIVE-04 tokens are encrypted at rest and never reach the frontend, the audit log or the logs', async () => {
    const logged: string[] = [];
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    const p = await propose(ctx, 'calendar', 'create', EVENT);
    await approveLatest(ctx, p.body.id);

    const secrets = [ctx.google.s.accessToken, 'ya29.ACCESS-1', ctx.google.s.refreshToken, GOOGLE.googleClientSecret];
    const row = ctx.db.prepare("SELECT encrypted_token, mode FROM tool_connections WHERE tool = 'calendar'").get() as { encrypted_token: string; mode: string };
    expect(row.mode).toBe('LIVE');
    const visible = [
      row.encrypted_token,
      JSON.stringify((await ctx.user.get('/api/tools')).body),
      JSON.stringify((await ctx.user.get('/api/me')).body),
      JSON.stringify((await ctx.user.get(`/api/actions/${p.body.id}`)).body),
      JSON.stringify(auditTypes(ctx)),
      JSON.stringify(ctx.db.prepare('SELECT * FROM oauth_states').all()),
      logged.join('\n')
    ].join('\n');
    for (const s of secrets) expect(visible).not.toContain(s);
    const changed = auditTypes(ctx).find(e => e.event_type === 'TOOL_MODE_CHANGED')!;
    expect(JSON.parse(changed.data)).toMatchObject({ tool: 'calendar', mode: 'LIVE', provider: 'google', scopes: [SCOPE] });
    expect(await tool(ctx)).toMatchObject({ mode: 'LIVE', connected: true, live: { reconnect: false } });
  });
});

describe('live actions', () => {
  it('LIVE-05 create: approval first, then one Google call with the Bearer token and sendUpdates=none; the Google event ID is the provider reference', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    const p = await propose(ctx, 'calendar', 'create', EVENT);
    expect(p.status).toBe(201);
    expect(ctx.google.calendarCalls()).toHaveLength(0);   // nothing happens before approval
    const pending = await getAction(ctx, p.body.id);
    expect(pending.adapterMode).toBe('LIVE');

    const res = await approveLatest(ctx, p.body.id);
    expect(res.status).toBe(200);
    const [call] = ctx.google.calendarCalls();
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(call.url.searchParams.get('sendUpdates')).toBe('none');   // never invite unless the approved payload says so
    expect(call.auth).toBe('Bearer ya29.ACCESS-1');
    expect(call.body).toMatchObject({ summary: 'Project sync', start: { dateTime: EVENT.start }, end: { dateTime: EVENT.end }, attendees: [{ email: 'asha@example.com' }] });
    const eventId = (call.body as { id: string }).id;
    expect(eventId).toMatch(/^[a-v0-9]{5,1024}$/);   // derived from the action: a retry cannot make a second event

    const done = await getAction(ctx, p.body.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.execution).toMatchObject({ adapterMode: 'LIVE', providerRef: eventId });
    expect(done.execution.result).toMatchObject({ eventId, invitationsSent: false });
  });

  it('LIVE-06 invites go out only when the approved payload says sendInvites: true, and adding it later needs a new approval', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    const quiet = await propose(ctx, 'calendar', 'create', EVENT);
    const shown = (await getAction(ctx, quiet.body.id)).payloadHash;
    const loud = await propose(ctx, 'calendar', 'create', { ...EVENT, sendInvites: true });
    expect((await getAction(ctx, loud.body.id)).payloadHash).not.toBe(shown);
    // the hash the user saw for the quiet version cannot approve the version that emails people
    expect((await approve(ctx, loud.body.id, shown)).status).toBe(409);
    expect(ctx.google.calendarCalls()).toHaveLength(0);

    await reauth(ctx);
    expect((await approveLatest(ctx, loud.body.id)).status).toBe(200);
    expect(ctx.google.calendarCalls()[0].url.searchParams.get('sendUpdates')).toBe('all');
    expect((await getAction(ctx, loud.body.id)).execution.result.invitationsSent).toBe(true);
  });

  it('LIVE-07 view, update and cancel go to the matching Google endpoints; a changed time or attendee is a new action to approve', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    for (const op of ['create', 'view', 'update', 'cancel']) await allow(ctx, 'calendar', op);
    const c = await propose(ctx, 'calendar', 'create', EVENT);
    await approveLatest(ctx, c.body.id);
    const eventId = (await getAction(ctx, c.body.id)).execution.providerRef as string;

    const v = await propose(ctx, 'calendar', 'view', { from: '2026-11-01T00:00:00+05:30', to: '2026-11-08T00:00:00+05:30' });
    await approveLatest(ctx, v.body.id);
    const list = ctx.google.calendarCalls()[1];
    expect(list.method).toBe('GET');
    expect(list.url.searchParams.get('timeMin')).toBe('2026-10-31T18:30:00.000Z');
    expect(list.url.searchParams.get('singleEvents')).toBe('true');
    const viewed = await getAction(ctx, v.body.id);
    expect(viewed.status).toBe('COMPLETED');
    expect(viewed.execution.result.events[0]).toMatchObject({ eventId, title: 'Project sync' });

    const moved = { eventId, start: '2026-11-02T11:00:00+05:30', end: '2026-11-02T11:30:00+05:30' };
    const u = await propose(ctx, 'calendar', 'update', moved);
    const uHash = (await getAction(ctx, u.body.id)).payloadHash;
    // the agent changes the time again before approval: a new proposal, new hash, the old approval hash is useless
    const u2 = await propose(ctx, 'calendar', 'update', { ...moved, start: '2026-11-02T12:00:00+05:30', end: '2026-11-02T12:30:00+05:30', attendees: ['raj@example.com'] });
    expect((await approve(ctx, u2.body.id, uHash)).status).toBe(409);
    await approve(ctx, u.body.id, uHash).expect(200);
    const patch = ctx.google.calendarCalls()[2];
    expect(patch.method).toBe('PATCH');
    expect(patch.url.pathname).toBe(`/calendar/v3/calendars/primary/events/${eventId}`);
    expect(patch.url.searchParams.get('sendUpdates')).toBe('none');
    expect(patch.body).toEqual({ start: { dateTime: moved.start }, end: { dateTime: moved.end } });
    expect((await getAction(ctx, u.body.id)).execution.providerRef).toBe(eventId);

    const x = await propose(ctx, 'calendar', 'cancel', { eventId });
    await approveLatest(ctx, x.body.id);
    const del = ctx.google.calendarCalls()[3];
    expect(del.method).toBe('DELETE');
    expect(del.url.searchParams.get('sendUpdates')).toBe('none');
    expect(await getAction(ctx, x.body.id)).toMatchObject({ status: 'COMPLETED', execution: { providerRef: eventId } });
    expect(ctx.google.s.events.get(eventId)!.status).toBe('cancelled');
  });

  it('LIVE-08 every gate is checked again right before the Google call (after the token refresh): kill switch, revoked permission, changed payload', async () => {
    for (const change of ['kill', 'revoke', 'tamper'] as const) {
      const ctx = await liveSetup();
      await goLive(ctx);
      await allow(ctx, 'calendar', 'create');
      ctx.clock.advanceMinutes(120);   // the access token has expired, so the adapter refreshes it first
      const p = await propose(ctx, 'calendar', 'create', EVENT);
      const hash = (await getAction(ctx, p.body.id)).payloadHash;
      ctx.google.s.onRefresh = () => {
        if (change === 'kill') ctx.db.prepare('UPDATE users SET kill_switch = 1').run();
        if (change === 'revoke') ctx.db.prepare("UPDATE permissions SET allowed = 0 WHERE tool = 'calendar'").run();
        if (change === 'tamper') ctx.db.prepare('UPDATE actions SET payload = ? WHERE id = ?').run(JSON.stringify({ ...EVENT, attendees: ['everyone@example.com'], sendInvites: true }), p.body.id);
      };
      await reauth(ctx);
      await approve(ctx, p.body.id, hash);
      expect(ctx.google.tokenCalls().some(c => (c.body as Record<string, string>).grant_type === 'refresh_token')).toBe(true);
      expect(ctx.google.calendarCalls()).toHaveLength(0);   // stopped before Google
      const a = await getAction(ctx, p.body.id);
      expect(a.status).toBe('BLOCKED');
      expect(a.blockReason).toBe({ kill: 'AGENT_PAUSED', revoke: 'PERMISSION_DENIED', tamper: 'PAYLOAD_CHANGED' }[change]);
      const blocked = auditTypes(ctx).filter(e => e.event_type === 'ACTION_BLOCKED').at(-1)!;
      expect(JSON.parse(blocked.data)).toMatchObject({ stage: 'BEFORE_PROVIDER' });
    }
  });

  it('LIVE-09 no confirmation means UNKNOWN: a reply without an event ID, or a timeout on a write; writes are never retried', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    ctx.google.s.omitId = true;
    const a = await propose(ctx, 'calendar', 'create', EVENT);
    await approveLatest(ctx, a.body.id);
    expect((await getAction(ctx, a.body.id)).status).toBe('UNKNOWN');

    ctx.google.s.omitId = false;
    ctx.google.s.calendarThrows = true;
    const b = await propose(ctx, 'calendar', 'create', { ...EVENT, title: 'Second' });
    await approveLatest(ctx, b.body.id);
    const got = await getAction(ctx, b.body.id);
    expect(got.status).toBe('UNKNOWN');
    expect(got.execution.result.note).toMatch(/check your Google Calendar/i);
    expect(ctx.google.calendarCalls().filter(c => c.method === 'POST')).toHaveLength(2);   // one call each, no retry
  });

  it('LIVE-10 a Google refusal is FAILED with a fixed message (Google\'s text is not passed on)', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    ctx.google.s.calendarStatus = 403;
    const p = await propose(ctx, 'calendar', 'create', EVENT);
    await approveLatest(ctx, p.body.id);
    const a = await getAction(ctx, p.body.id);
    expect(a.status).toBe('FAILED');
    expect(a.execution.error).toMatch(/Google refused/);
    expect(a.execution.error).not.toContain('secret-detail');
  });

  it('LIVE-11 live payloads are checked when proposed: an unsupported operation, a missing end time or a bad email is blocked and never reaches Google', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    for (const op of ['create', 'invite']) await allow(ctx, 'calendar', op);
    for (const [op, payload] of [
      ['invite', { eventId: 'abc12345', attendees: ['a@b.co'] }],
      ['create', { title: 'No end', start: EVENT.start }],
      ['create', { ...EVENT, attendees: ['not an email'] }],
      ['create', { ...EVENT, end: '2026-11-02T09:00:00+05:30' }]
    ] as const) {
      const res = await propose(ctx, 'calendar', op, payload);
      expect(res.status).toBe(400);
      expect((await getAction(ctx, res.body.error.actionId)).blockReason).toBe('LIVE_PAYLOAD_INVALID');
    }
    expect(ctx.google.calendarCalls()).toHaveLength(0);
  });
});

describe('tokens over time', () => {
  it('LIVE-12 an expired access token is refreshed and stored encrypted again; a revoked or expired refresh token asks to reconnect', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    ctx.clock.advanceMinutes(90);
    const a = await propose(ctx, 'calendar', 'create', EVENT);
    await reauth(ctx);
    await approveLatest(ctx, a.body.id);
    expect(ctx.google.calendarCalls()[0].auth).toBe('Bearer ya29.ACCESS-2');
    expect((await getAction(ctx, a.body.id)).status).toBe('COMPLETED');
    const refresh = ctx.google.tokenCalls().find(c => (c.body as Record<string, string>).grant_type === 'refresh_token')!;
    expect(refresh.body).toMatchObject({ refresh_token: '1//REFRESH-SECRET-1', client_id: GOOGLE.googleClientId, client_secret: GOOGLE.googleClientSecret });
    expect((ctx.db.prepare("SELECT encrypted_token FROM tool_connections WHERE tool = 'calendar'").get() as { encrypted_token: string }).encrypted_token).not.toContain('ACCESS-2');

    // revoked at myaccount.google.com (or the 7-day Testing-mode expiry): invalid_grant
    ctx.clock.advanceMinutes(90);
    ctx.google.s.tokenError = 'invalid_grant';
    const b = await propose(ctx, 'calendar', 'create', { ...EVENT, title: 'After revoke' });
    await reauth(ctx);
    await approveLatest(ctx, b.body.id);
    expect(ctx.google.calendarCalls()).toHaveLength(1);
    const failed = await getAction(ctx, b.body.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.execution.error).toMatch(/Reconnect Google/);
    expect((await ctx.user.get('/api/me')).body.integrations).toEqual({ live: ['calendar'], reconnect: ['calendar'] });
    expect((await tool(ctx)).live.reconnect).toBe(true);
    expect(auditTypes(ctx).some(e => e.event_type === 'LIVE_RECONNECT_NEEDED')).toBe(true);

    // until reconnected, new live proposals are blocked
    const c = await propose(ctx, 'calendar', 'create', { ...EVENT, title: 'Blocked' });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('RECONNECT_REQUIRED');

    // reconnecting clears it
    ctx.google.s.refreshToken = '1//REFRESH-SECRET-2';
    await goLive(ctx);
    expect((await ctx.user.get('/api/me')).body.integrations.reconnect).toEqual([]);
    expect((await propose(ctx, 'calendar', 'create', { ...EVENT, title: 'Back' })).status).toBe(201);
  });

  it('LIVE-13 Testing mode: a refresh token older than 7 days shows "Reconnect Google" before anything fails (GOOGLE_OAUTH_TESTING, on by default)', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    ctx.clock.advanceMinutes(7 * 24 * 60 + 1);
    await relogin(ctx);   // the 12-hour session ended long ago
    expect((await ctx.user.get('/api/me')).body.integrations.reconnect).toEqual(['calendar']);
    const published = await liveSetup({ config: { googleOAuthTesting: false } });
    await goLive(published);
    published.clock.advanceMinutes(7 * 24 * 60 + 1);
    await relogin(published);
    expect((await published.user.get('/api/me')).body.integrations.reconnect).toEqual([]);
  });

  it('LIVE-14 Google returned no refresh token: refused, so live mode never starts half-working', async () => {
    const ctx = await liveSetup();
    ctx.google.s.giveRefreshToken = false;
    const url = await startLive(ctx);
    const cb = await ctx.user.get(`/api/oauth/google/callback?code=auth-code-1&state=${url.searchParams.get('state')}`);
    expect(cb.headers.location).toBe('/#/tools?live=failed');
    expect((await tool(ctx)).mode).toBe('MOCK');
  });
});

describe('MOCK stays the default', () => {
  it('LIVE-15 an action keeps the mode it was proposed in: switching modes blocks open actions, and a LIVE action never falls back to MOCK', async () => {
    const ctx = await liveSetup();
    await allow(ctx, 'calendar', 'create');
    const mockAction = await propose(ctx, 'calendar', 'create', EVENT);
    expect((await getAction(ctx, mockAction.body.id)).adapterMode).toBe('MOCK');
    await goLive(ctx);
    const stale = await getAction(ctx, mockAction.body.id);
    expect(stale).toMatchObject({ status: 'BLOCKED', blockReason: 'MODE_CHANGED' });

    const liveAction = await propose(ctx, 'calendar', 'create', EVENT);
    // back to MOCK: tokens revoked at Google and deleted here; the open LIVE action is blocked
    await ctx.user.post('/api/tools/calendar/mock').set(csrf(ctx)).send({}).expect(200);
    expect(ctx.google.calls.some(c => c.url.pathname === '/revoke' && (c.body as Record<string, string>).token === '1//REFRESH-SECRET-1')).toBe(true);
    expect(await getAction(ctx, liveAction.body.id)).toMatchObject({ status: 'BLOCKED', blockReason: 'MODE_CHANGED' });
    expect((await tool(ctx)).mode).toBe('MOCK');
    expect(auditTypes(ctx).filter(e => e.event_type === 'TOOL_MODE_CHANGED').map(e => JSON.parse(e.data).mode)).toEqual(['LIVE', 'MOCK']);
    expect(ctx.google.calendarCalls()).toHaveLength(0);
  });

  it('LIVE-16 with INTEGRATION_MODE back to mock (or a plan without live integrations), LIVE actions are refused, never run as MOCK, and the tokens are kept', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await allow(ctx, 'calendar', 'create');
    const p = await propose(ctx, 'calendar', 'create', EVENT);
    ctx.db.prepare("UPDATE users SET plan_id = 'starter'").run();
    const res = await approveLatest(ctx, p.body.id);
    expect(res.status).toBe(402);
    const q = await propose(ctx, 'calendar', 'create', EVENT);
    expect(q.status).toBe(402);
    ctx.db.prepare("UPDATE users SET plan_id = 'plus'").run();

    expect(ctx.google.calendarCalls()).toHaveLength(0);

    // the server restarts with INTEGRATION_MODE=mock on the same database: the LIVE action is refused, not run as MOCK
    const file = path.join(os.tmpdir(), `ag-live-${crypto.randomUUID()}.db`);
    const first = await liveSetup({ dbPath: file });
    await goLive(first);
    await allow(first, 'calendar', 'create');
    const r = await propose(first, 'calendar', 'create', EVENT);
    expect(r.status).toBe(201);
    const second = await createApp({ dbPath: file, config: { ...GOOGLE, integrationMode: 'mock' }, googleFetch: first.google.fetch });
    try {
      const u = request.agent(second.app);
      await u.post('/api/auth/login').send({ email: 'owner@test.dev', password: 'Owner#12345' }).expect(200);
      const token = (await u.get('/api/auth/csrf')).body.token as string;
      await u.post('/api/auth/reauth').set('X-CSRF-Token', token).send({ password: 'Owner#12345' }).expect(200);
      const shown = (await u.get(`/api/actions/${r.body.id}`).expect(200)).body;
      expect(shown.adapterMode).toBe('LIVE');
      const res2 = await u.post(`/api/actions/${r.body.id}/approve`).set('X-CSRF-Token', token).send({ payloadHash: shown.payloadHash });
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('LIVE_UNAVAILABLE');
      expect(first.google.calendarCalls()).toHaveLength(0);
      expect((second.db.prepare("SELECT encrypted_token FROM tool_connections WHERE tool = 'calendar'").get() as { encrypted_token: string | null }).encrypted_token).not.toBeNull();
    } finally {
      first.db.close();
      second.db.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  });

  it('LIVE-17 only Calendar can be live: other tools stay MOCK with INTEGRATION_MODE=live, and no test reaches the network', async () => {
    const ctx = await liveSetup();
    await connectTool(ctx, 'gmail');
    await allow(ctx, 'gmail', 'send');
    const g = await propose(ctx, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Hi', body: 'Hello' });
    await reauth(ctx);
    await approveLatest(ctx, g.body.id);
    expect((await getAction(ctx, g.body.id)).execution.adapterMode).toBe('MOCK');
    expect((await tool(ctx, 'gmail')).live).toEqual({ available: false, reconnect: false, reason: 'NO_LIVE_ADAPTER' });

    // without a googleFetch, a test build has no way to reach Google
    const bare = await setup({ config: GOOGLE });
    await connectTool(bare, 'calendar');
    await reauth(bare);
    const res = await bare.user.post('/api/tools/calendar/live').set(csrf(bare)).send({}).expect(200);
    const state = new URL(res.body.url).searchParams.get('state');
    expect((await bare.user.get(`/api/oauth/google/callback?code=auth-code-1&state=${state}`)).headers.location).toBe('/#/tools?live=failed');
  });

  it('LIVE-18 disconnecting a live Calendar revokes the token at Google and removes it here', async () => {
    const ctx = await liveSetup();
    await goLive(ctx);
    await ctx.user.delete('/api/tools/calendar').set(csrf(ctx)).expect(200);
    expect(ctx.google.calls.some(c => c.url.pathname === '/revoke')).toBe(true);
    const row = ctx.db.prepare("SELECT encrypted_token, mode FROM tool_connections WHERE tool = 'calendar'").get() as { encrypted_token: string | null; mode: string };
    expect(row).toEqual({ encrypted_token: null, mode: 'MOCK' });
    // reconnecting with "Connect" is MOCK again
    await connectTool(ctx, 'calendar');
    expect((await tool(ctx)).mode).toBe('MOCK');
  });
});

describe('npm run live:check:calendar', () => {
  it('LIVE-19 creates one test event with no attendees and no invitations, then cancels it', async () => {
    const google = mockGoogle();
    const out = await runLiveCheck({ fetch: google.fetch, accessToken: 'ya29.ACCESS-1', now: Date.parse('2026-11-01T10:00:00Z'), timeZone: 'Asia/Kolkata' });
    const [create, cancel] = google.calendarCalls();
    expect(create.method).toBe('POST');
    expect(create.url.searchParams.get('sendUpdates')).toBe('none');
    expect(create.body).toMatchObject({ summary: expect.stringMatching(/AgentGuard live check/) });
    expect((create.body as Record<string, unknown>).attendees).toBeUndefined();
    expect(cancel.method).toBe('DELETE');
    expect(cancel.url.searchParams.get('sendUpdates')).toBe('none');
    expect(out).toMatchObject({ created: true, cancelled: true });
    expect(out.eventId).toBe((create.body as { id: string }).id);
    expect(google.calendarCalls()).toHaveLength(2);
  });
});
