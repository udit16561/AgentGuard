import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Ctx } from '../context';
import { notFound } from '../http';
import { requireCsrf, requireReauth, requireUser } from '../middleware/auth';
import { CATALOG } from '../services/catalog';
import {
  BINDING_COOKIE, connection, finishConsent, isLiveTool, requireLiveAvailable, revokeAtGoogle, startConsent, STATE_TTL_MS, switchMode
} from '../integrations/google/oauth';

/**
 * Switching a tool between MOCK and LIVE (v0.8.0; Google Calendar only). Going LIVE is a separate, confirmed step:
 * CSRF, a password check within the re-auth window, INTEGRATION_MODE=live, the Google client in .env and a plan with
 * live integrations, then Google's consent screen. Going back to MOCK revokes the grant at Google and deletes the tokens.
 */
export function liveRoutes(ctx: Ctx) {
  const r = Router({ mergeParams: true });
  const liveTool = (req: Request, _res: Response, next: NextFunction) => {
    const tool = String(req.params.tool);
    next(Object.prototype.hasOwnProperty.call(CATALOG, tool) && isLiveTool(tool) ? undefined : notFound('This tool has no live mode'));
  };

  r.post('/live', requireUser, requireCsrf, liveTool, requireReauth(ctx), (req, res) => {
    const userId = req.user!.id;
    const tool = String(req.params.tool);
    requireLiveAvailable(ctx);
    ctx.entitlements.require(userId, { feature: 'liveIntegrations' });
    if (connection(ctx, userId, tool)?.status !== 'CONNECTED') ctx.entitlements.require(userId, { feature: 'tool', tool });
    const { url, binding } = startConsent(ctx, userId, tool, req.cookies?.[BINDING_COOKIE]);
    // Lax, not Strict: it must come back on Google's redirect, which is a cross-site navigation
    res.cookie(BINDING_COOKIE, binding, { httpOnly: true, sameSite: 'lax', secure: ctx.config.nodeEnv === 'production' || req.secure, path: '/api', maxAge: STATE_TTL_MS });
    res.json({ url });
  });

  r.post('/mock', requireUser, requireCsrf, liveTool, async (req, res) => {
    const userId = req.user!.id;
    const tool = String(req.params.tool);
    const c = connection(ctx, userId, tool);
    if (c?.status !== 'CONNECTED' || c.mode !== 'LIVE') { res.json({ tool, mode: c?.mode ?? 'MOCK' }); return; }
    const revoked = await revokeAtGoogle(ctx, userId, tool);
    switchMode(ctx, userId, tool, 'MOCK', undefined, { revokedAtGoogle: revoked });
    res.json({ tool, mode: 'MOCK', revokedAtGoogle: revoked });
  });
  return r;
}

/** Google's redirect back. No session cookie arrives here (SameSite=Strict); the state row and the binding cookie identify the attempt. */
export function oauthRoutes(ctx: Ctx) {
  const r = Router();
  r.get('/google/callback', async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const to = await finishConsent(ctx, { state: str(q.state), code: str(q.code), error: str(q.error) }, req.cookies?.[BINDING_COOKIE]);
    if (to.endsWith('=calendar')) res.clearCookie(BINDING_COOKIE, { path: '/api' });
    res.redirect(303, to);
  });
  return r;
}
