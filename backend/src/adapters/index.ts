import crypto from 'node:crypto';
import type { Adapter } from './types';

/** Mock adapter: makes no network request and returns a fake provider reference (SEC-27). */
export function mockAdapter(tool: string): Adapter {
  return {
    mode: 'MOCK',
    async execute(operation, payload) {
      return {
        providerRef: `mock_${tool}_${crypto.randomBytes(6).toString('hex')}`,
        result: { simulated: true, tool, operation, fields: Object.keys(payload).sort() }
      };
    }
  };
}

/**
 * Picks the adapter for a tool. No live adapter exists yet, so even INTEGRATION_MODE=live resolves to MOCK
 * until an owner-approved live adapter is registered here. Tests may pass overrides (createApp({ adapters })).
 */
export function resolveAdapter(tool: string, overrides: Partial<Record<string, Adapter>> = {}): Adapter {
  return overrides[tool] ?? mockAdapter(tool);
}
