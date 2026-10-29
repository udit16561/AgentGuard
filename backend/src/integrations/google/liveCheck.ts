import crypto from 'node:crypto';
import type { GoogleFetch } from './oauth';
import { API } from './calendar';

/**
 * The core of `npm run live:check:calendar` (src/dev/live-check-calendar.ts), which the owner runs by hand: one test
 * event an hour from now, 15 minutes long, no attendees and no invitations (sendUpdates=none), then cancelled.
 */
export async function runLiveCheck(o: { fetch: GoogleFetch; accessToken: string; now: number; timeZone: string }) {
  const id = `agcheck${crypto.randomBytes(8).toString('hex')}`;
  const start = new Date(Math.ceil((o.now + 60 * 60_000) / 300_000) * 300_000);
  const end = new Date(start.getTime() + 15 * 60_000);
  const headers = { authorization: `Bearer ${o.accessToken}`, accept: 'application/json' };
  const none = '?sendUpdates=none';

  const created = await o.fetch(`${API}${none}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      id, summary: 'AgentGuard live check (safe to ignore)', description: 'Created and cancelled straight away by npm run live:check:calendar.',
      start: { dateTime: start.toISOString(), timeZone: o.timeZone }, end: { dateTime: end.toISOString(), timeZone: o.timeZone },
      transparency: 'transparent', reminders: { useDefault: false }
    })
  });
  const body = await created.json().catch(() => null) as { id?: string; htmlLink?: string } | null;
  if (created.status !== 200 || body?.id !== id) throw new Error(`Google did not create the test event (HTTP ${created.status})`);

  const cancelled = await o.fetch(`${API}/${id}${none}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) });
  return { created: true, cancelled: cancelled.status === 204 || cancelled.status === 200, eventId: id, htmlLink: body.htmlLink ?? null, start: start.toISOString() };
}
