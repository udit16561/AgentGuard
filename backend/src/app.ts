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
import { agentSelfRoutes, preferenceRoutes } from './routes/preferences';
import { spendingRoutes } from './routes/spending';
import { anthropicPreferenceModel } from './services/preferences/model';
import type { PreferenceModel } from './services/preferences/parse';
import { providerFactory, type ModelFactory } from './models/providers';
import type { Resolve } from './models/baseUrl';
import { fakeModelFactory } from './models/fake';
import { modelRoutes } from './routes/models';
import { assistantRoutes } from './routes/assistant';
import { createEventBus } from './services/events';
import { pushOnAlert, webPushSender, type PushSender } from './services/notify';
import { pushRoutes } from './routes/push';
import { streamRoutes } from './routes/stream';
import { entitlementService } from './services/entitlements';
import { planRoutes, mePlanRoutes } from './routes/plans';

export interface AppOptions {
  dbPath?: string;
  clock?: Clock;
  config?: Partial<Config>;
  /** Optional model layer for IntentService; may only raise risk, and fails closed (SEC-19, SEC-20). */
  classifier?: ModelClassifier;
  /** Test hook: replace a tool's mock adapter (for example one with no provider reference, SEC-25). */
  adapters?: Partial<Record<string, Adapter>>;
  /** Optional preference parser model; defaults to PREFERENCE_MODEL_PROVIDER. Any error falls back to the deterministic parser. */
  preferenceModel?: PreferenceModel;
  preferenceModelTimeoutMs?: number;
  /** Builds the user's own models (bring your own model). Tests pass AI SDK mock models; the default uses the real providers. */
  modelFactory?: ModelFactory;
  /** Test hook: DNS for custom base URLs (the default provider factory checks every resolved address at connect time). */
  resolveHost?: Resolve;
  /** Test hook: replaces the Web Push sender, so no test reaches a push service. */
  pushSender?: PushSender;
  /** Guard timeout in ms (default 3000). */
  modelTimeoutMs?: number;
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

  const preferenceModel = options.preferenceModel
    ?? (config.preferenceModelProvider === 'anthropic' && config.preferenceModelApiKey ? anthropicPreferenceModel(config.preferenceModelApiKey, config.preferenceModel) : undefined);
  // the fake factory exists for the browser tests only: NODE_ENV=test and MODEL_PROVIDER_MODE=fake, never otherwise
  const modelFactory = options.modelFactory
    ?? (config.nodeEnv === 'test' && process.env.MODEL_PROVIDER_MODE === 'fake' ? fakeModelFactory() : providerFactory({ resolveHost: options.resolveHost }));
  // every audited change is announced: to open dashboards (SSE) and, for new alerts, to the user's phones (Web Push)
  const events = createEventBus();
  let onPush: ReturnType<typeof pushOnAlert> | null = null;
  const audit = createAuditService(db, clock, e => {
    if (e.userId) events.publish({ userId: e.userId, eventType: e.eventType, actionId: e.actionId ?? null });
    onPush?.(e);
  });
  const ctx: Ctx = {
    db, clock, config, audit, preferenceModel, preferenceModelTimeoutMs: options.preferenceModelTimeoutMs,
    modelFactory, modelTimeoutMs: options.modelTimeoutMs
  } as Ctx;
  ctx.entitlements = entitlementService(ctx);
  ctx.pushSender = options.pushSender ?? webPushSender(ctx);
  onPush = pushOnAlert(ctx);
  app.locals.events = events;
  app.use(loadSession(ctx));
  app.use(loadAgent(ctx));

  app.get('/api/health', (_req, res) => { res.json({ ok: true, integrationMode: config.integrationMode }); });
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/me/spending', spendingRoutes(ctx));
  app.use('/api/me', mePlanRoutes(ctx));
  app.use('/api/plans', planRoutes(ctx));
  app.use('/api/me', meRoutes(ctx));
  app.use('/api/audit', auditRoutes(ctx));
  app.use('/api/agents/me', agentSelfRoutes(ctx));   // agent key only; before the user-only /api/agents routes
  app.use('/api/agents/:id/permissions', permissionRoutes(ctx));
  app.use('/api/agents', agentRoutes(ctx));
  app.use('/api/tools/:tool/preferences', preferenceRoutes(ctx));
  app.use('/api/tools', toolRoutes(ctx));
  app.use('/api/actions', decisionRoutes(ctx, { adapters: options.adapters }));
  app.use('/api/actions', actionRoutes(ctx, { classifier: options.classifier, adapters: options.adapters }));
  app.use('/api/kill-switch', killSwitchRoutes(ctx));
  app.use('/api/models', modelRoutes(ctx));
  app.use('/api/stream', streamRoutes(ctx, events));
  app.use('/api/push', pushRoutes(ctx));
  app.use('/api/assistant', assistantRoutes(ctx, { classifier: options.classifier, adapters: options.adapters }));

  // the PWA is served from the same origin, so the session cookie stays SameSite=Strict with no CORS needed
  const frontendDir = findFrontend();
  if (frontendDir && options.serveFrontend !== false) app.use(express.static(frontendDir, {
    index: 'index.html', dotfiles: 'ignore',
    // the service worker must always be re-checked, or a fixed version could never replace it
    setHeaders: (res, file) => { if (file.endsWith(`${path.sep}sw.js`)) res.setHeader('Cache-Control', 'no-cache'); }
  }));

  app.use((_req, _res, next) => next(notFound('Route not found')));
  app.use(errorHandler);

  return { app, clock, db, config };
}
