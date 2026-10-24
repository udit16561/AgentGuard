/**
 * Intent and risk tests (docs/TEST_CASES.md, section 2).
 * Contract: src/services/intent.ts exports
 *   classify(input: { tool, operation, payload, context }) -> Promise<{ intent, riskLevel, riskScore, confidence, reasons, flags }>
 * context = { knownRecipients: string[], knownPayees: string[], dailyCap?: number, spentToday?: number }
 */
import { describe, it, expect } from 'vitest';
import fixtures from '../fixtures/intents.json';
import { classify } from '../../src/services/intent';

const ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const atLeast = (actual: string, min: string) => ORDER.indexOf(actual) >= ORDER.indexOf(min);

describe('fixture suite (INT-01..INT-11)', () => {
  for (const f of fixtures as any[]) {
    it(`${f.id} ${f.tool}.${f.operation}`, async () => {
      const r = await classify({ tool: f.tool, operation: f.operation, payload: f.payload, context: f.context ?? {} });
      expect(r.intent).toBe(f.expect.intent);
      expect(atLeast(r.riskLevel, f.expect.minRisk)).toBe(true);
      if (f.expect.flags) for (const flag of f.expect.flags) expect(r.flags).toContain(flag);
    });
  }
});

describe('INT-12 aggregate quality', () => {
  it('reaches >= 90% intent accuracy and never under-scores CRITICAL cases', async () => {
    let correct = 0;
    for (const f of fixtures as any[]) {
      const r = await classify({ tool: f.tool, operation: f.operation, payload: f.payload, context: f.context ?? {} });
      if (r.intent === f.expect.intent) correct++;
      if (f.expect.minRisk === 'CRITICAL') expect(atLeast(r.riskLevel, 'HIGH')).toBe(true);
    }
    expect(correct / (fixtures as any[]).length).toBeGreaterThanOrEqual(0.9);
  });
});
