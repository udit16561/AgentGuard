import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { loadConfig, type Config } from './config';
import { createClock, type Clock } from './clock';
import { openDb, type Db } from './db';
import { errorHandler, notFound } from './http';
import { seedPlans } from './services/plans';
import { createAuditService } from './services/audit';
import type { Ctx } from './context';
import { loadAgent, loadSession } from './middleware/auth';
import { authRoutes, meRoutes } from './routes/auth';
import { auditRoutes } from './routes/audit';
import { agentRoutes, killSwitchRoutes } from './routes/agents';
import { permissionRoutes, toolRoutes } from './routes/tools';
import { actionRoutes } from './routes/actions';
import type { ModelClassifier } from './services/intent';
import { decisionRoutes } from './routes/decisions';
import type { Adapter } from './adapters/types';

export interface AppOptions {
  dbPath?: string;
  clock?: Clock;
  config?: Partial<Config>;
  /** Optional model layer for IntentService; may only raise risk, and fails closed (SEC-19, SEC-20). */
  classifier?: ModelClassifier;
  /** Test hook: replace a tool's mock adapter (for example one with no provider reference, SEC-25). */
  adapters?: Partial<Record<string, Adapter>>;
  /** Serve ../frontend as static files (default true). */
  serveFrontend?: boolean;
}

// works from src/ (tsx) and from dist/src/ (built)
function findFrontend(): string | null {
  for (const dir of [path.resolve(__dirname, '../../frontend'), path.resolve(__dirname, '../../../frontend')]) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/** Builds the API. Tests call this with dbPath ':memory:' (docs/ARCHITECTURE_AND_API.md §4). */
export async function createApp(options: AppOptions = {}) {
  const config = loadConfig(options.config);
  const clock = options.clock ?? createClock();
  const db: Db = openDb(options.dbPath ?? ':memory:');
  seedPlans(db);

  const app = express();
  app.disable('x-powered-by');
  // strict CSP: scripts, styles and data only from this origin; no inline script or style attributes
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
        fontSrc: ["'self'"], manifestSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"]
      }
    }
  }));
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  // API responses hold personal data: never cache them (docs/FRONTEND_GUIDE.md §4)
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const ctx: Ctx = { db, clock, config, audit: createAuditService(db, clock) };
  app.use(loadSession(ctx));
  app.use(loadAgent(ctx));

  app.get('/api/health', (_req, res) => { res.json({ ok: true, integrationMode: config.integrationMode }); });
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/me', meRoutes(ctx));
  app.use('/api/audit', auditRoutes(ctx));
  app.use('/api/agents/:id/permissions', permissionRoutes(ctx));
  app.use('/api/agents', agentRoutes(ctx));
  app.use('/api/tools', toolRoutes(ctx));
  app.use('/api/actions', decisionRoutes(ctx, { adapters: options.adapters }));
  app.use('/api/actions', actionRoutes(ctx, { classifier: options.classifier, adapters: options.adapters }));
  app.use('/api/kill-switch', killSwitchRoutes(ctx));

  // the PWA is served from the same origin, so the session cookie stays SameSite=Strict with no CORS needed
  const frontendDir = findFrontend();
  if (frontendDir && options.serveFrontend !== false) app.use(express.static(frontendDir, { index: 'index.html', dotfiles: 'ignore' }));

  app.use((_req, _res, next) => next(notFound('Route not found')));
  app.use(errorHandler);

  return { app, clock, db, config };
}
