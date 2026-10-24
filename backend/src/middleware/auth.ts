import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AgentRow, Ctx, SessionRow, UserRow } from '../context';
import { AppError } from '../http';
import { sha256 } from '../services/canonical';

export const SESSION_COOKIE = 'ag_session';

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Attaches req.user / req.session when a valid session cookie is present. Never fails on its own. */
export function loadSession(ctx: Ctx) {
  const find = ctx.db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?');
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 20) {
      const s = find.get(sha256(token)) as SessionRow | undefined;
      if (s && s.expires_at > ctx.clock.now()) {
        req.session = s;
        req.user = user.get(s.user_id) as UserRow;
      }
    }
    next();
  };
}

/** User routes. An agent key is never accepted here (SEC-13, SEC-14). */
export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !req.session) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in first'));
  next();
}

/** State-changing user routes need the session's CSRF token in X-CSRF-Token (SEC-22). */
export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  const sent = req.get('x-csrf-token');
  if (!req.session || !sent || !safeEqual(sent, req.session.csrf_token)) return next(new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token'));
  next();
}

const bearer = (req: Request) => {
  const h = req.get('authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** Attaches req.agent for a valid, not-revoked agent key. Paused agents are attached; the policy decides what they may do. */
export function loadAgent(ctx: Ctx) {
  const find = ctx.db.prepare("SELECT * FROM agents WHERE api_key_hash = ? AND status != 'REVOKED'");
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = bearer(req);
    if (key) req.agent = find.get(sha256(key)) as AgentRow | undefined;
    next();
  };
}

export function requireAgent(req: Request, _res: Response, next: NextFunction) {
  if (!req.agent) return next(new AppError(401, 'UNAUTHENTICATED', 'A valid agent API key is required'));
  next();
}
