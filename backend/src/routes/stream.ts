import { Router } from 'express';
import type { Ctx } from '../context';
import { requireUser } from '../middleware/auth';
import type { EventBus } from '../services/events';

const HEARTBEAT_MS = 25_000;

/**
 * GET /api/stream: live alerts for the signed-in user (Server-Sent Events). Each event only names what changed
 * ({ eventType, actionId }); the page then fetches details through the normal API. The stream closes when the
 * session ends. Agent keys get 401.
 */
export function streamRoutes(ctx: Ctx, events: EventBus) {
  const r = Router();
  const sessionAlive = ctx.db.prepare('SELECT expires_at FROM sessions WHERE id = ?');
  r.get('/', requireUser, (req, res) => {
    const userId = req.user!.id, sessionId = req.session!.id;
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // signed out or expired: stop announcing
    const alive = () => {
      const s = sessionAlive.get(sessionId) as { expires_at: number } | undefined;
      return !!s && s.expires_at > ctx.clock.now();
    };
    send('ready', {});
    const unsubscribe = events.subscribe(e => {
      if (e.userId !== userId) return;
      if (!alive()) { stop(); res.end(); return; }
      send('change', { eventType: e.eventType, actionId: e.actionId });
    });
    const beat = setInterval(() => { if (alive()) res.write(': ping\n\n'); else { stop(); res.end(); } }, HEARTBEAT_MS);
    function stop() { unsubscribe(); clearInterval(beat); }
    req.on('close', stop);
  });
  return r;
}
