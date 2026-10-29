import crypto from 'node:crypto';
import dotenv from 'dotenv';

// tests (vitest and the browser tests) never read the developer's .env, so they run the same on every machine
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

export interface Config {
  nodeEnv: string;
  approvalTtlMinutes: number;
  reauthWindowMinutes: number;
  sessionTtlHours: number;
  integrationMode: 'mock' | 'live';
  corsOrigin: string;
  tokenEncryptionKey: Buffer;
  /** optional small model for parsing tool preferences; "none" keeps the deterministic parser only */
  preferenceModelProvider: 'none' | 'anthropic';
  preferenceModel: string;
  preferenceModelApiKey: string | null;
  /** Web Push (VAPID) keys; without both, phone alerts are off */
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string;
  /** Google OAuth client for the live Calendar adapter (v0.8.0); without both, live mode cannot start */
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleRedirectUri: string;
  /** an unpublished ("Testing") Google app: refresh tokens expire after 7 days, so ask to reconnect before then */
  googleOAuthTesting: boolean;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function encryptionKey(nodeEnv: string): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length === 32) return key;
  if (nodeEnv === 'production') throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  // development and tests: a throwaway key, so stored mock tokens are still encrypted
  return crypto.randomBytes(32);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    approvalTtlMinutes: num(process.env.APPROVAL_TTL_MINUTES, 10),
    reauthWindowMinutes: num(process.env.REAUTH_WINDOW_MINUTES, 5),
    sessionTtlHours: 12,
    // anything but an explicit "live" stays mock; even then only a tool switched to LIVE on the Tools screen is live
    integrationMode: process.env.INTEGRATION_MODE === 'live' ? 'live' : 'mock',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    tokenEncryptionKey: encryptionKey(nodeEnv),
    preferenceModelProvider: process.env.PREFERENCE_MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'none',
    preferenceModel: process.env.PREFERENCE_MODEL || 'claude-haiku-5-5',
    preferenceModelApiKey: process.env.PREFERENCE_MODEL_API_KEY || null,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || null,
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:owner@agentguard.dev',
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://localhost:4443/api/oauth/google/callback',
    googleOAuthTesting: process.env.GOOGLE_OAUTH_TESTING !== 'false',
    ...overrides
  };
}
