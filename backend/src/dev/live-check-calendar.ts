/**
 * npm run live:check:calendar  [-- --email you@example.com] [-- --yes]
 *
 * A manual check the owner runs by hand (never in CI): with Calendar switched to LIVE in the app, it creates one test
 * event an hour from now in that account's primary Google Calendar, with no attendees and no invitations, then
 * cancels it. It asks first (unless --yes) and records the run in the audit log. Tokens are never printed.
 */
import readline from 'node:readline/promises';
import { loadConfig } from '../config';
import { createClock } from '../clock';
import { openDb } from '../db';
import { dbPathFromUrl } from '../server-config';
import { createAuditService } from '../services/audit';
import { accessToken, liveUnavailable, UNAVAILABLE_TEXT } from '../integrations/google/oauth';
import { runLiveCheck } from '../integrations/google/liveCheck';
import type { Ctx } from '../context';

async function main() {
  const args = process.argv.slice(2);
  const emailArg = args.includes('--email') ? args[args.indexOf('--email') + 1] : undefined;
  const config = loadConfig();
  const off = liveUnavailable({ config });
  if (off) throw new Error(UNAVAILABLE_TEXT[off]);
  if (!process.env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not set in backend/.env, so the stored Google tokens cannot be read.');

  const db = openDb(dbPathFromUrl(process.env.DATABASE_URL));
  const clock = createClock();
  const audit = createAuditService(db, clock);
  const rows = db.prepare(`SELECT c.user_id, u.email, u.timezone FROM tool_connections c JOIN users u ON u.id = c.user_id
    WHERE c.tool = 'calendar' AND c.mode = 'LIVE' AND c.status = 'CONNECTED'`).all() as { user_id: string; email: string; timezone: string }[];
  const pick = emailArg ? rows.filter(r => r.email === emailArg) : rows;
  if (pick.length !== 1) {
    throw new Error(rows.length ? `Several accounts have Calendar live (${rows.map(r => r.email).join(', ')}): add -- --email <one of them>.`
      : 'No account has Calendar switched to LIVE. In the app: Tools → Calendar → Use live Google Calendar.');
  }
  const user = pick[0];

  if (!args.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`This creates one event "AgentGuard live check" in the Google Calendar connected to ${user.email}, an hour from now, with no attendees and no invitations, then cancels it.\nType yes to continue: `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') { console.log('Cancelled. Nothing was sent.'); return; }
  }

  const ctx = { db, clock, config, audit, google: { fetch: (url: string, init: RequestInit) => fetch(url, init), fakeConsent: false } } as unknown as Ctx;
  const token = await accessToken(ctx, user.user_id, 'calendar');
  const out = await runLiveCheck({ fetch: ctx.google.fetch, accessToken: token, now: clock.now(), timeZone: user.timezone });
  audit.append({ userId: user.user_id, actorType: 'USER', actorId: user.user_id, eventType: 'LIVE_CHECK_RUN', data: { tool: 'calendar', eventId: out.eventId, created: out.created, cancelled: out.cancelled } });
  console.log(`Created test event ${out.eventId} for ${out.start}.`);
  console.log(out.cancelled ? 'Cancelled it again. Google Calendar works live.' : `Could not cancel it: delete it by hand: ${out.htmlLink ?? out.eventId}`);
  db.close();
}

main().catch(err => { console.error(`Live check failed: ${err instanceof Error ? err.message : 'unexpected error'}`); process.exit(1); });
