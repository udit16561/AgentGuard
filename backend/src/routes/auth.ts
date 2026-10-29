import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Ctx, UserRow } from '../context';
import { AppError } from '../http';
import { requireCsrf, requireUser, SESSION_COOKIE } from '../middleware/auth';
import { newId, sha256 } from '../services/canonical';
import { dummyHash, hashPassword, verifyPassword } from '../services/password';
import { DEFAULT_PLAN, PLANS } from '../services/plans';
import { liveSummary } from '../integrations/live';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200)
});
const Signup = Credentials.extend({
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  plan: z.enum(Object.keys(PLANS) as [keyof typeof PLANS, ...(keyof typeof PLANS)[]]).optional()
});

export function authRoutes(ctx: Ctx) {
  const r = Router();
  const { db, clock, config, audit } = ctx;

  // per-IP brake on the password endpoints, on top of the per-account lockout (AUTH-02); csrf and logout are not throttled
  const passwordLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }); }
  });

  function startSession(res: Response, user: UserRow) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = clock.now();
    db.prepare('INSERT INTO sessions (id, token_hash, user_id, csrf_token, reauth_at, expires_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .run(newId('ses'), sha256(token), user.id, crypto.randomBytes(24).toString('base64url'), now + config.sessionTtlHours * 3_600_000, now);
    res.cookie(SESSION_COOKIE, token, {
      // Secure in production, and whenever the request came over HTTPS (the LAN dev server for phones)
      httpOnly: true, sameSite: 'strict', secure: config.nodeEnv === 'production' || res.req.secure, path: '/', maxAge: config.sessionTtlHours * 3_600_000
    });
  }

  // signup also signs the user in (docs/DECISIONS.md G); new accounts start on Plus unless a plan is given (A)
  r.post('/signup', passwordLimiter, async (req, res) => {
    const body = Signup.parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email)) throw new AppError(409, 'VALIDATION_ERROR', 'An account with this email already exists');
    const user: UserRow = {
      id: newId('usr'), email: body.email, password_hash: await hashPassword(body.password), plan_id: body.plan ?? DEFAULT_PLAN,
      timezone: 'Asia/Kolkata', kill_switch: 0, failed_logins: 0, locked_until: null, created_at: clock.now()
    };
    db.prepare(`INSERT INTO users (id, email, password_hash, plan_id, timezone, kill_switch, failed_logins, locked_until, created_at)
      VALUES (@id, @email, @password_hash, @plan_id, @timezone, @kill_switch, @failed_logins, @locked_until, @created_at)`).run(user);
    audit.append({ userId: user.id, actorType: 'USER', actorId: user.id, eventType: 'USER_SIGNUP', data: { plan: user.plan_id } });
    startSession(res, user);
    audit.append({ userId: user.id, actorType: 'USER', actorId: user.id, eventType: 'LOGIN' });
    res.status(201).json({ id: user.id, email: user.email, plan: user.plan_id });
  });

  r.post('/login', passwordLimiter, async (req, res) => {
    const body = Credentials.parse(req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as UserRow | undefined;
    const now = clock.now();
    if (!user) { await verifyPassword(await dummyHash(), body.password); throw new AppError(401, 'UNAUTHENTICATED', 'Email or password is wrong'); }
    if (user.locked_until && user.locked_until > now) throw new AppError(429, 'RATE_LIMITED', 'Too many wrong passwords. Try again later.');
    if (!(await verifyPassword(user.password_hash, body.password))) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? now + LOCK_MINUTES * 60_000 : null;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock, user.id);
      audit.append({ userId: user.id, actorType: 'USER', actorId: user.id, eventType: lock ? 'LOGIN_LOCKED' : 'LOGIN_FAILED' });
      if (lock) throw new AppError(429, 'RATE_LIMITED', 'Too many wrong passwords. Try again later.');
      throw new AppError(401, 'UNAUTHENTICATED', 'Email or password is wrong');
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
    startSession(res, user);
    audit.append({ userId: user.id, actorType: 'USER', actorId: user.id, eventType: 'LOGIN' });
    res.json({ id: user.id, email: user.email, plan: user.plan_id });
  });

  r.post('/logout', requireUser, requireCsrf, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session!.id);
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: 'LOGOUT' });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // lets the app decide between the login page and the shell without a 401 in the console; says nothing but yes or no
  r.get('/session', (req, res) => { res.json({ signedIn: !!req.user }); });

  r.get('/csrf', requireUser, (req, res) => { res.json({ token: req.session!.csrf_token }); });

  // a fresh password check, needed before approving HIGH/CRITICAL or NEEDS_REVIEW actions
  r.post('/reauth', passwordLimiter, requireUser, requireCsrf, async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    if (!(await verifyPassword(req.user!.password_hash, password))) {
      audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: 'REAUTH_FAILED' });
      throw new AppError(401, 'UNAUTHENTICATED', 'Password is wrong');
    }
    const now = clock.now();
    db.prepare('UPDATE sessions SET reauth_at = ? WHERE id = ?').run(now, req.session!.id);
    audit.append({ userId: req.user!.id, actorType: 'USER', actorId: req.user!.id, eventType: 'REAUTH' });
    res.json({ ok: true, validUntil: new Date(now + config.reauthWindowMinutes * 60_000).toISOString() });
  });

  return r;
}

export function meRoutes(ctx: Ctx) {
  const r = Router();
  r.get('/', requireUser, (req, res) => {
    const u = req.user!;
    // integrations: which tools are live, and which need "Reconnect Google" (never a token)
    res.json({ id: u.id, email: u.email, plan: u.plan_id, timezone: u.timezone, killSwitch: !!u.kill_switch, integrations: liveSummary(ctx, u.id) });
  });
  return r;
}
