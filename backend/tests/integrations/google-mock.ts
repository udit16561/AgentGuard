/**
 * A stand-in for Google's OAuth and Calendar HTTP endpoints, passed to createApp({ googleFetch }). No test reaches Google.
 * It records every request, so the tests can check exactly what would have been sent.
 */
export interface Call { method: string; url: URL; auth: string | null; body: unknown }
interface StoredEvent { id: string; status: string; [k: string]: unknown }

export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CAL = '/calendar/v3/calendars/primary/events';

export function mockGoogle() {
  const calls: Call[] = [];
  const s = {
    n: 1,
    accessToken: 'ya29.ACCESS-1',
    refreshToken: '1//REFRESH-SECRET-1',
    expiresIn: 3600,
    scope: SCOPE,
    giveRefreshToken: true,
    /** OAuth error for the next token request (e.g. invalid_grant: expired or revoked) */
    tokenError: null as string | null,
    /** status forced on the next Calendar request (e.g. 403, 500) */
    calendarStatus: null as number | null,
    /** throw instead of answering (a timeout or dropped connection) */
    calendarThrows: false,
    omitId: false,
    /** runs while a refresh is in flight (to change state between the gate checks and the Google call) */
    onRefresh: null as null | (() => void),
    events: new Map<string, StoredEvent>()
  };

  async function fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const raw = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null;
    const form = headers.get('content-type')?.includes('application/x-www-form-urlencoded');
    const body = raw == null ? null : form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    calls.push({ method, url, auth: headers.get('authorization'), body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      const b = body as Record<string, string>;
      if (s.tokenError) { const e = s.tokenError; s.tokenError = null; return json(400, { error: e, error_description: 'Token has been expired or revoked.' }); }
      if (b.grant_type === 'authorization_code') {
        if (b.code !== 'auth-code-1') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: s.accessToken, expires_in: s.expiresIn, scope: s.scope, token_type: 'Bearer', ...(s.giveRefreshToken ? { refresh_token: s.refreshToken } : {}) });
      }
      if (b.grant_type === 'refresh_token') {
        if (b.refresh_token !== s.refreshToken) return json(400, { error: 'invalid_grant' });
        s.onRefresh?.();
        s.accessToken = `ya29.ACCESS-${++s.n}`;
        return json(200, { access_token: s.accessToken, expires_in: s.expiresIn, scope: s.scope, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke') return new Response(null, { status: 200 });

    if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith(CAL)) {
      if (s.calendarThrows) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      if (s.calendarStatus) { const st = s.calendarStatus; s.calendarStatus = null; return json(st, { error: { code: st, message: `Google says no (${st}) secret-detail` } }); }
      if (headers.get('authorization') !== `Bearer ${s.accessToken}`) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
      const id = decodeURIComponent(url.pathname.slice(CAL.length + 1));
      if (method === 'GET' && !id) return json(200, { kind: 'calendar#events', etag: '"etag-list-1"', items: [...s.events.values()].filter(e => e.status !== 'cancelled') });
      if (method === 'POST' && !id) {
        const b = body as Record<string, unknown>;
        const ev = { ...b, id: String(b.id ?? `gen${s.events.size}`), status: 'confirmed', htmlLink: `https://www.google.com/calendar/event?eid=${b.id}` };
        s.events.set(ev.id, ev);
        const { id: evId, ...rest } = ev;
        return json(200, s.omitId ? rest : { id: evId, ...rest });
      }
      const ev = s.events.get(id);
      if (!ev) return json(404, { error: { code: 404, message: 'Not Found' } });
      if (method === 'PATCH') { Object.assign(ev, body); return json(200, ev); }
      if (method === 'DELETE') {
        if (ev.status === 'cancelled') return json(410, { error: { code: 410, message: 'Resource has been deleted' } });
        ev.status = 'cancelled';
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { error: 'unexpected request in the Google mock' });
  }

  const calendarCalls = () => calls.filter(c => c.url.pathname.startsWith(CAL));
  const tokenCalls = () => calls.filter(c => c.url.pathname === '/token');
  return { fetch, calls, calendarCalls, tokenCalls, s };
}
