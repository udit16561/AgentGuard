import crypto from 'node:crypto';
import type { Ctx } from '../../context';
import { AppError } from '../../http';
import { ProviderError } from '../../adapters/mock/util';
import { sha256 } from '../../services/canonical';
import { decrypt, encrypt } from '../../services/secrets';

/**
 * Google OAuth 2.0 for the live Calendar adapter (v0.8.0), called directly (no Nango): authorization code with PKCE
 * (S256), a single-use state that expires in 10 minutes and is tied to the browser that started it, and the one
 * scope calendar.events. Tokens are AES-256-GCM encrypted in tool_connections and never leave the backend: not to
 * the frontend, the audit log or the logs. Google's error text is never passed on (fixed messages only).
 */
export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface GoogleClient { fetch: GoogleFetch; /** e2e only (NODE_ENV=test): consent goes straight to the callback */ fakeConsent: boolean }
type OAuthCtx = Pick<Ctx, 'db' | 'clock' | 'config' | 'audit' | 'google'>;

export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CALLBACK_PATH = '/api/oauth/google/callback';
export const BINDING_COOKIE = 'ag_oauth';
export const STATE_TTL_MS = 10 * 60_000;
export const TIMEOUT_MS = 15_000;
/** the tools with a live adapter; everything else is MOCK whatever INTEGRATION_MODE says */
export const LIVE_TOOLS = ['calendar'];
const TESTING_REFRESH_LIFETIME_MS = 7 * 24 * 3_600_000;

export const RECONNECT_TEXT = 'Google needs you to sign in again: use Reconnect Google on the Tools screen. Nothing was sent.';

export interface LiveConn { status: string; mode: string; live_state: string | null; live_since: number | null; encrypted_token: string | null }
interface Tokens { access: string; refresh: string; expiresAt: number }

/** In a test build nothing may reach Google: tests pass their own googleFetch. */
export const noNetwork: GoogleFetch = async () => { throw new Error('No network in tests'); };

export const isLiveTool = (tool: string) => LIVE_TOOLS.includes(tool);
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Why live mode cannot be used on this server right now, or null. */
export function liveUnavailable(ctx: Pick<Ctx, 'config'>): 'INTEGRATION_MODE_OFF' | 'GOOGLE_NOT_CONFIGURED' | null {
  if (ctx.config.integrationMode !== 'live') return 'INTEGRATION_MODE_OFF';
  if (!ctx.config.googleClientId || !ctx.config.googleClientSecret) return 'GOOGLE_NOT_CONFIGURED';
  return null;
}
export const UNAVAILABLE_TEXT = {
  INTEGRATION_MODE_OFF: 'Live mode is off on this server: set INTEGRATION_MODE=live in .env and restart. Nothing was sent.',
  GOOGLE_NOT_CONFIGURED: 'Google is not set up on this server: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart.'
};

export function connection(ctx: Pick<Ctx, 'db'>, userId: string, tool: string) {
  return ctx.db.prepare('SELECT status, mode, live_state, live_since, encrypted_token FROM tool_connections WHERE user_id = ? AND tool = ?').get(userId, tool) as LiveConn | undefined;
}

/** Google refused the refresh token (expired or revoked), or, for an unpublished Testing app, it is 7 days old. */
export function needsReconnect(ctx: Pick<Ctx, 'clock' | 'config'>, c: LiveConn | undefined) {
  if (!c || c.mode !== 'LIVE') return false;
  if (c.live_state === 'RECONNECT') return true;
  return ctx.config.googleOAuthTesting && c.live_since != null && ctx.clock.now() - c.live_since >= TESTING_REFRESH_LIFETIME_MS;
}

/** Starts consent: stores the state and PKCE verifier, and returns Google's consent URL. */
export function startConsent(ctx: OAuthCtx, userId: string, tool: string, existingBinding: string | undefined) {
  const state = token();
  const verifier = token(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  // one binding per browser, so two open consent tabs both still work
  const binding = existingBinding && /^[A-Za-z0-9_-]{43}$/.test(existingBinding) ? existingBinding : token();
  const now = ctx.clock.now();
  ctx.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now - STATE_TTL_MS);
  ctx.db.prepare('INSERT INTO oauth_states (state_hash, user_id, tool, verifier_enc, binding_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(state), userId, tool, encrypt(ctx.config.tokenEncryptionKey, verifier), sha256(binding), now, now + STATE_TTL_MS);
  if (ctx.google.fakeConsent) return { url: `${CALLBACK_PATH}?code=fake-code&state=${state}`, binding };
  const q = new URLSearchParams({
    client_id: ctx.config.googleClientId!, redirect_uri: ctx.config.googleRedirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256'
  });
  return { url: `${AUTH_URL}?${q}`, binding };
}

class ConsentFailed extends Error {
  constructor(public reason: string, public userId: string | null = null, public tool = 'calendar') { super(reason); }
}

async function postForm(ctx: OAuthCtx, url: string, form: Record<string, string>) {
  const res = await ctx.google.fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return { status: res.status, data: await res.json().catch(() => null) as Record<string, unknown> | null };
}

/**
 * The redirect back from Google. It arrives as a cross-site navigation, so the SameSite=Strict session cookie is not
 * sent: the user comes from the state row, and the Lax binding cookie proves it is the same browser that started.
 * Returns where to send the browser.
 */
export async function finishConsent(ctx: OAuthCtx & Pick<Ctx, 'entitlements'>, q: { state?: string; code?: string; error?: string }, binding: string | undefined) {
  try {
    if (!q.state || q.state.length > 200) throw new ConsentFailed('STATE_MISSING');
    const row = ctx.db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').get(sha256(q.state)) as
      { state_hash: string; user_id: string; tool: string; verifier_enc: string; binding_hash: string; expires_at: number; used_at: number | null } | undefined;
    if (!row) throw new ConsentFailed('STATE_UNKNOWN');
    const fail = (reason: string) => new ConsentFailed(reason, row.user_id, row.tool);
    // single use, whatever happens next
    const claimed = ctx.db.prepare('UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL').run(ctx.clock.now(), row.state_hash);
    if (claimed.changes !== 1) throw fail('STATE_REUSED');
    if (ctx.clock.now() > row.expires_at) throw fail('STATE_EXPIRED');
    if (!binding || sha256(binding) !== row.binding_hash) throw fail('OTHER_BROWSER');
    if (q.error) throw fail('DENIED');
    if (!q.code || q.code.length > 2048) throw fail('CODE_MISSING');
    if (liveUnavailable(ctx)) throw fail('LIVE_UNAVAILABLE');
    if (!ctx.entitlements.can(row.user_id, { feature: 'liveIntegrations' })) throw fail('NOT_IN_PLAN');

    let out;
    try {
      out = await postForm(ctx, TOKEN_URL, {
        grant_type: 'authorization_code', code: q.code, redirect_uri: ctx.config.googleRedirectUri,
        client_id: ctx.config.googleClientId!, client_secret: ctx.config.googleClientSecret!,
        code_verifier: decrypt(ctx.config.tokenEncryptionKey, row.verifier_enc)
      });
    } catch { throw fail('TOKEN_EXCHANGE'); }
    const d = out.data ?? {};
    if (out.status !== 200 || typeof d.access_token !== 'string') throw fail('TOKEN_EXCHANGE');
    // without a refresh token live mode would stop working within the hour
    if (typeof d.refresh_token !== 'string') throw fail('NO_REFRESH_TOKEN');
    const scopes = String(d.scope ?? '').split(' ').filter(Boolean);
    if (!scopes.includes(SCOPE)) throw fail('SCOPE');

    const now = ctx.clock.now();
    const tokens: Tokens = { access: d.access_token, refresh: d.refresh_token, expiresAt: now + Number(d.expires_in ?? 3600) * 1000 };
    switchMode(ctx, row.user_id, row.tool, 'LIVE', { tokens, scopes: [SCOPE] });
    return `/#/tools?live=${row.tool}`;
  } catch (err) {
    const f = err instanceof ConsentFailed ? err : new ConsentFailed('ERROR');
    // only an attempt that belongs to a user is audited (a forged state could otherwise fill the log)
    if (f.userId) ctx.audit.append({ userId: f.userId, actorType: 'SYSTEM', actorId: null, eventType: 'LIVE_CONNECT_FAILED', data: { tool: f.tool, provider: 'google', reason: f.reason } });
    return f.reason === 'DENIED' ? '/#/tools?live=denied' : '/#/tools?live=failed';
  }
}

/**
 * Sets a tool's mode. Open actions proposed in the other mode are blocked: an approval covers the mode it was
 * proposed in (a MOCK approval must never run against the real calendar, and a LIVE one never quietly as MOCK).
 */
export function switchMode(ctx: OAuthCtx, userId: string, tool: string, mode: 'LIVE' | 'MOCK', live?: { tokens: Tokens; scopes: string[] }, extra: Record<string, unknown> = {}) {
  const { db, clock, audit } = ctx;
  const now = clock.now();
  const before = connection(ctx, userId, tool);
  const sealed = live ? encrypt(ctx.config.tokenEncryptionKey, JSON.stringify(live.tokens)) : encrypt(ctx.config.tokenEncryptionKey, `mock-token-${token(12)}`);
  db.transaction(() => {
    db.prepare(`INSERT INTO tool_connections (id, user_id, tool, status, encrypted_token, scopes, mode, live_state, live_since, connected_at) VALUES (?, ?, ?, 'CONNECTED', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(user_id, tool) DO UPDATE SET status = 'CONNECTED', encrypted_token = excluded.encrypted_token, scopes = excluded.scopes, mode = excluded.mode, live_state = NULL, live_since = excluded.live_since`)
      .run(`con_${token(12)}`, userId, tool, sealed, JSON.stringify(live?.scopes ?? []), mode, live ? now : null, now);
    if (before?.mode === mode && before.status === 'CONNECTED') {
      audit.append({ userId, actorType: 'USER', actorId: userId, eventType: 'LIVE_RECONNECTED', data: { tool, provider: 'google', scopes: live?.scopes ?? [] } });
      return;
    }
    const open = db.prepare("SELECT id, agent_id FROM actions WHERE user_id = ? AND tool = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW') AND adapter_mode != ?").all(userId, tool, mode) as { id: string; agent_id: string }[];
    db.prepare("UPDATE actions SET status = 'BLOCKED', block_reason = 'MODE_CHANGED', updated_at = ? WHERE user_id = ? AND tool = ? AND status IN ('PENDING_REVIEW', 'NEEDS_REVIEW') AND adapter_mode != ?").run(now, userId, tool, mode);
    for (const a of open) audit.append({ userId, actorType: 'SYSTEM', actorId: null, eventType: 'ACTION_BLOCKED', actionId: a.id, data: { agentId: a.agent_id, tool, reason: 'MODE_CHANGED' } });
    audit.append({ userId, actorType: 'USER', actorId: userId, eventType: 'TOOL_MODE_CHANGED', data: { tool, mode, ...(live ? { provider: 'google', scopes: live.scopes } : {}), actionsBlocked: open.length, ...extra } });
  })();
}

function readTokens(ctx: OAuthCtx, c: LiveConn): Tokens | null {
  if (!c.encrypted_token) return null;
  try {
    const t = JSON.parse(decrypt(ctx.config.tokenEncryptionKey, c.encrypted_token)) as Tokens;
    return typeof t.access === 'string' && typeof t.refresh === 'string' ? t : null;
  } catch { return null; }   // a key change makes stored tokens unreadable: reconnect
}

export function markReconnect(ctx: OAuthCtx, userId: string, tool: string, reason: string) {
  const changed = ctx.db.prepare("UPDATE tool_connections SET live_state = 'RECONNECT' WHERE user_id = ? AND tool = ? AND mode = 'LIVE' AND live_state IS NOT 'RECONNECT'").run(userId, tool);
  if (changed.changes) ctx.audit.append({ userId, actorType: 'SYSTEM', actorId: null, eventType: 'LIVE_RECONNECT_NEEDED', data: { tool, provider: 'google', reason } });
}

/** A valid access token, refreshed when it is (nearly) expired. Throws ProviderError with a fixed message; nothing is sent then. */
export async function accessToken(ctx: OAuthCtx, userId: string, tool: string): Promise<string> {
  const c = connection(ctx, userId, tool);
  if (!c || c.mode !== 'LIVE' || c.status !== 'CONNECTED') throw new ProviderError('This tool is not connected live. Nothing was sent.');
  if (needsReconnect(ctx, c)) throw new ProviderError(RECONNECT_TEXT);
  const t = readTokens(ctx, c);
  if (!t) { markReconnect(ctx, userId, tool, 'TOKENS_UNREADABLE'); throw new ProviderError(RECONNECT_TEXT); }
  if (t.expiresAt - 60_000 > ctx.clock.now()) return t.access;

  let out;
  try {
    out = await postForm(ctx, TOKEN_URL, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: ctx.config.googleClientId ?? '', client_secret: ctx.config.googleClientSecret ?? '' });
  } catch { throw new ProviderError('Google did not answer the sign-in refresh. Nothing was sent; try again.'); }
  if (out.status !== 200 || typeof out.data?.access_token !== 'string') {
    // expired (7 days in Testing mode) or revoked by the user: ask them to reconnect
    if (out.data?.error === 'invalid_grant') { markReconnect(ctx, userId, tool, 'REFRESH_REFUSED'); throw new ProviderError(RECONNECT_TEXT); }
    throw new ProviderError('Google refused the sign-in refresh. Nothing was sent.');
  }
  const next: Tokens = { access: out.data.access_token, refresh: typeof out.data.refresh_token === 'string' ? out.data.refresh_token : t.refresh, expiresAt: ctx.clock.now() + Number(out.data.expires_in ?? 3600) * 1000 };
  ctx.db.prepare('UPDATE tool_connections SET encrypted_token = ? WHERE user_id = ? AND tool = ?').run(encrypt(ctx.config.tokenEncryptionKey, JSON.stringify(next)), userId, tool);
  return next.access;
}

/** Best effort: tells Google to revoke the grant (switch back to MOCK, disconnect). Returns whether Google confirmed. */
export async function revokeAtGoogle(ctx: OAuthCtx, userId: string, tool: string) {
  const c = connection(ctx, userId, tool);
  const t = c?.mode === 'LIVE' ? readTokens(ctx, c) : null;
  if (!t) return false;
  try { return (await postForm(ctx, REVOKE_URL, { token: t.refresh })).status === 200; } catch { return false; }
}

export function requireLiveAvailable(ctx: Pick<Ctx, 'config'>) {
  const why = liveUnavailable(ctx);
  if (why) throw new AppError(409, 'LIVE_UNAVAILABLE', UNAVAILABLE_TEXT[why]);
}
