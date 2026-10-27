import crypto from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../../context';
import type { Adapter, AdapterResult } from '../../adapters/types';
import { ProviderError } from '../../adapters/mock/util';
import { accessToken, markReconnect, RECONNECT_TEXT, TIMEOUT_MS } from './oauth';

/**
 * LiveCalendarAdapter (v0.8.0): view, create, update and cancel on the user's primary Google Calendar.
 * Used only for a tool switched to LIVE, with INTEGRATION_MODE=live, for an action that was proposed in LIVE mode.
 * - Invitations go out only when the approved payload says sendInvites: true (sendUpdates=none otherwise).
 * - Right before the Google call (after any token refresh) the execution service re-checks every gate (meta.recheck).
 * - The Google event ID is the provider reference; no confirmation means UNKNOWN, and writes are never retried.
 */
export const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SELF = ['you', 'me', 'self'];

const when = z.iso.datetime({ offset: true, local: true });
const instant = z.iso.datetime({ offset: true });
const zone = z.string().max(64).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone');
const attendees = z.array(z.string().max(320)).max(50)
  .transform(l => l.filter(x => !SELF.includes(x.trim().toLowerCase())))
  .pipe(z.array(z.email('Each attendee must be an email address')));
const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/, 'eventId is not a Google event ID');
const ordered = (p: { start?: string; end?: string }) => !p.start || !p.end || Date.parse(p.end) > Date.parse(p.start);
const CHANGES = ['title', 'start', 'end', 'description', 'location', 'attendees'] as const;
const fields = {
  title: z.string().trim().min(1).max(200), description: z.string().max(2000), location: z.string().max(300),
  timeZone: zone, attendees, sendInvites: z.boolean()
};

const SCHEMAS = {
  view: z.object({ from: instant.optional(), to: instant.optional(), max: z.number().int().min(1).max(50).optional() }).strict(),
  create: z.object({
    title: fields.title, start: when, end: when, timeZone: fields.timeZone.optional(), description: fields.description.optional(),
    location: fields.location.optional(), attendees: fields.attendees.optional(), sendInvites: fields.sendInvites.optional()
  }).strict().refine(ordered, 'end must be after start'),
  update: z.object({
    eventId, title: fields.title.optional(), start: when.optional(), end: when.optional(), timeZone: fields.timeZone.optional(),
    description: fields.description.optional(), location: fields.location.optional(), attendees: fields.attendees.optional(), sendInvites: fields.sendInvites.optional()
  }).strict()
    .refine(p => !!p.start === !!p.end, 'Give both start and end')
    .refine(ordered, 'end must be after start')
    .refine(p => CHANGES.some(k => p[k] !== undefined), 'Nothing to change'),
  cancel: z.object({ eventId, sendInvites: fields.sendInvites.optional() }).strict()
};
export const LIVE_OPERATIONS = Object.keys(SCHEMAS);
type Op = keyof typeof SCHEMAS;

/** Checked when proposed (an invalid payload is blocked and never reaches Google) and again before the call. */
export function checkLivePayload(operation: string, payload: Record<string, unknown>) {
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, operation)) return { ok: false as const, message: `${operation} is not available on live Google Calendar (use update to change attendees)` };
  const r = SCHEMAS[operation as Op].safeParse(payload);
  return r.success ? { ok: true as const, value: r.data as Record<string, unknown> } : { ok: false as const, message: r.error.issues.map(i => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ') };
}

/** Google event IDs allow a-v and 0-9; one fixed per action, so a second attempt could never make a second event. */
export const eventIdFor = (actionId: string) => `ag${crypto.createHash('sha256').update(actionId).digest('hex').slice(0, 30)}`;

const REFUSED: Record<number, string> = {
  400: 'Google refused the event details.',
  403: 'Google refused: no access to this calendar, or a quota was reached.',
  404: 'Google could not find that event.',
  409: 'Google refused: an event with this ID already exists.',
  410: 'That event was already cancelled.',
  412: 'Google refused: the event changed in the meantime.',
  429: 'Google refused: too many requests. Try again later.'
};
const NO_CONFIRMATION = 'Google did not confirm this. Check your Google Calendar before asking again.';

type Reply = { status: number; data: Record<string, unknown> | null };

export function liveCalendarAdapter(ctx: Ctx, userId: string): Adapter {
  const call = async (token: string, method: string, url: string, body?: unknown): Promise<Reply> => {
    try {
      const res = await ctx.google.fetch(url, {
        method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
    } catch { return { status: 0, data: null }; }   // timeout or dropped connection: Google may or may not have acted
  };

  /** A non-2xx reply: a write without a clear answer is UNKNOWN (gate 3); a clear refusal is FAILED with a fixed message. */
  const settle = (r: Reply, write: boolean, extra: Record<string, unknown> = {}): AdapterResult => {
    if (r.status === 0 || r.status >= 500) {
      if (write) return { providerRef: null, result: { outcome: 'NO_CONFIRMATION', ...extra, note: NO_CONFIRMATION } };
      throw new ProviderError('Google did not answer. Try again.');
    }
    if (r.status === 401) { markReconnect(ctx, userId, 'calendar', 'TOKEN_REJECTED'); throw new ProviderError(RECONNECT_TEXT); }
    throw new ProviderError(REFUSED[r.status] ?? `Google refused the request (HTTP ${r.status}).`);
  };

  return {
    mode: 'LIVE',
    async execute(operation, payload, meta) {
      const checked = checkLivePayload(operation, payload);
      if (!checked.ok) throw new ProviderError(`Not sent: ${checked.message}`);
      const p = checked.value as Record<string, never> & { [k: string]: unknown };
      const token = await accessToken(ctx, userId, 'calendar');
      // every gate again, now that the (possibly slow) refresh is done: nothing reaches Google past a closed gate
      await meta.recheck?.();

      const userZone = (ctx.db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as { timezone: string }).timezone;
      const at = (v: unknown) => {
        const s = String(v);
        // a local time ("2026-11-02T10:00:00") needs a zone; an offset already says when it is
        return /(?:Z|[+-]\d{2}:\d{2})$/.test(s) ? { dateTime: s } : { dateTime: s, timeZone: (p.timeZone as string | undefined) ?? userZone };
      };
      const invites = p.sendInvites === true;
      const q = (extra: Record<string, string> = {}) => `?${new URLSearchParams({ sendUpdates: invites ? 'all' : 'none', ...extra })}`;
      const people = (p.attendees as string[] | undefined)?.map(email => ({ email }));
      const event = () => ({
        ...(p.title !== undefined ? { summary: p.title } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.location !== undefined ? { location: p.location } : {}),
        ...(p.start !== undefined ? { start: at(p.start) } : {}),
        ...(p.end !== undefined ? { end: at(p.end) } : {}),
        ...(people ? { attendees: people } : {})
      });

      switch (operation as Op) {
        case 'view': {
          const from = p.from ? Date.parse(p.from as string) : ctx.clock.now();
          const to = p.to ? Date.parse(p.to as string) : from + 7 * 86_400_000;
          const max = (p.max as number | undefined) ?? 25;
          const r = await call(token, 'GET', `${API}?${new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) })}`);
          if (r.status !== 200) return settle(r, false);
          const items = (Array.isArray(r.data?.items) ? r.data.items : []) as Record<string, Record<string, string> | string | unknown[]>[];
          const events = items.slice(0, max).map(e => ({
            eventId: e.id, title: e.summary ?? '(no title)',
            start: (e.start as Record<string, string> | undefined)?.dateTime ?? (e.start as Record<string, string> | undefined)?.date ?? null,
            end: (e.end as Record<string, string> | undefined)?.dateTime ?? (e.end as Record<string, string> | undefined)?.date ?? null,
            attendees: Array.isArray(e.attendees) ? e.attendees.length : 0
          }));
          return { providerRef: typeof r.data?.etag === 'string' ? `list:${r.data.etag}` : null, result: { events, count: events.length } };
        }
        case 'create': {
          const id = eventIdFor(meta.actionId);
          const r = await call(token, 'POST', `${API}${q()}`, { id, ...event() });
          if (r.status !== 200) return settle(r, true, { expectedEventId: id });
          const ref = typeof r.data?.id === 'string' ? r.data.id : null;
          return { providerRef: ref, result: { eventId: ref, htmlLink: r.data?.htmlLink ?? null, title: p.title, start: p.start, end: p.end, attendees: p.attendees ?? [], invitationsSent: invites, ...(ref ? {} : { note: NO_CONFIRMATION }) } };
        }
        case 'update': {
          const r = await call(token, 'PATCH', `${API}/${encodeURIComponent(p.eventId as string)}${q()}`, event());
          if (r.status !== 200) return settle(r, true, { eventId: p.eventId });
          const ref = typeof r.data?.id === 'string' ? r.data.id : null;
          return { providerRef: ref, result: { eventId: ref, updated: CHANGES.filter(k => p[k] !== undefined), htmlLink: r.data?.htmlLink ?? null, invitationsSent: invites } };
        }
        case 'cancel': {
          const r = await call(token, 'DELETE', `${API}/${encodeURIComponent(p.eventId as string)}${q()}`);
          if (r.status !== 204 && r.status !== 200) return settle(r, true, { eventId: p.eventId });
          // 204 is Google's confirmation; the reference is the event that was cancelled
          return { providerRef: p.eventId as string, result: { eventId: p.eventId, status: 'cancelled', cancellationsSent: invites } };
        }
      }
      throw new ProviderError('Not supported');
    }
  };
}
