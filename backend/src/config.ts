import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface Config {
  nodeEnv: string;
  approvalTtlMinutes: number;
  reauthWindowMinutes: number;
  sessionTtlHours: number;
  integrationMode: 'mock' | 'live';
  corsOrigin: string;
  tokenEncryptionKey: Buffer;
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
    // live adapters are not built yet, so anything but an explicit "live" stays mock
    integrationMode: process.env.INTEGRATION_MODE === 'live' ? 'live' : 'mock',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    tokenEncryptionKey: encryptionKey(nodeEnv),
    ...overrides
  };
}
