import type { GoogleFetch } from './oauth';

/**
 * A pretend Google for the browser tests only (NODE_ENV=test and GOOGLE_OAUTH_MODE=fake, never otherwise): any
 * consent code gives tokens, and events live in memory. Access tokens expire at once and refreshes are refused (as
 * after the 7-day Testing-mode expiry), so the browser tests can show "Reconnect Google". Unit tests use their own mock (tests/integrations/google-mock.ts).
 */
export function fakeGoogle(): GoogleFetch {
  const events = new Map<string, Record<string, unknown>>();
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.pathname === '/token' && String(init.body).includes('grant_type=refresh_token')) return json(400, { error: 'invalid_grant' });
    if (url.pathname === '/token') return json(200, { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 0, scope: 'https://www.googleapis.com/auth/calendar.events' });
    if (url.pathname === '/revoke') return new Response(null, { status: 200 });
    const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '');
    if (method === 'GET') return json(200, { etag: '"fake"', items: [...events.values()] });
    if (method === 'POST') { const b = JSON.parse(String(init.body)); events.set(b.id, b); return json(200, { ...b, htmlLink: `https://calendar.google.com/event?eid=${b.id}` }); }
    if (!events.has(id)) return json(404, {});
    if (method === 'PATCH') { Object.assign(events.get(id)!, JSON.parse(String(init.body))); return json(200, events.get(id)); }
    events.delete(id);
    return new Response(null, { status: 204 });
  };
}
