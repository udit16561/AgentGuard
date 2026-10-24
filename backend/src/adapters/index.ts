import type { Adapter } from './types';
import { ProviderError, rid, type MockTool } from './mock/util';
import { gmail } from './mock/gmail';
import { calendar } from './mock/calendar';
import { clock } from './mock/clock';
import { whatsapp } from './mock/whatsapp';
import { instagram } from './mock/instagram';
import { linkedin } from './mock/linkedin';
import { x } from './mock/x';
import { blog } from './mock/blog';
import { payments } from './mock/payments';

const MOCKS: Record<string, MockTool> = { gmail, calendar, clock, whatsapp, instagram, linkedin, x, blog, payments };

/** A tool's MOCK adapter: realistic provider responses, no network request (SEC-27). */
export function mockAdapter(tool: string): Adapter {
  const ops = Object.prototype.hasOwnProperty.call(MOCKS, tool) ? MOCKS[tool] : undefined;
  return {
    mode: 'MOCK',
    async execute(operation, payload, meta) {
      const op = ops && Object.prototype.hasOwnProperty.call(ops, operation) ? ops[operation] : undefined;
      if (!op) throw new ProviderError(`${tool}.${operation} is not supported by the mock provider`);
      return op(payload, meta);
    }
  };
}

export { ProviderError, rid };

/**
 * Picks the adapter for a tool. No live adapter exists yet, so even INTEGRATION_MODE=live resolves to MOCK
 * until an owner-approved live adapter is registered here. Tests may pass overrides (createApp({ adapters })).
 */
export function resolveAdapter(tool: string, overrides: Partial<Record<string, Adapter>> = {}): Adapter {
  return overrides[tool] ?? mockAdapter(tool);
}
