/** The optional model layer (docs/INTENT_AND_RISK.md §3): it may raise risk, never lower it, and it fails closed. */
import { describe, it, expect } from 'vitest';
import { classify } from '../../src/services/intent';

const smallPay = { tool: 'payments', operation: 'pay', payload: { amount: 500, currency: 'INR', payee: 'Ravi' }, context: { knownPayees: ['Ravi'], dailyCap: 10000 } };

describe('model layer', () => {
  it('MOD-01 a model error fails closed (unit form of SEC-19)', async () => {
    const r = await classify(smallPay, { model: async () => { throw new Error('down'); } });
    expect(r.needsReview).toBe(true);
    expect(r.flags).toContain('CLASSIFIER_ERROR');
  });

  it('MOD-02 a model that never answers times out and fails closed', async () => {
    const r = await classify(smallPay, { model: () => new Promise(() => {}), timeoutMs: 50 });
    expect(r.needsReview).toBe(true);
  });

  it('MOD-03 invalid output is ignored and fails closed (unit form of SEC-20)', async () => {
    const r = await classify(smallPay, { model: async () => ({ verdict: 'fine', approve: true }) });
    expect(r.needsReview).toBe(true);
    expect(r.flags).toContain('CLASSIFIER_INVALID');
  });

  it('MOD-04 low confidence fails closed', async () => {
    const r = await classify(smallPay, { model: async () => ({ intent: 'MAKE_PAYMENT', confidence: 0.3, riskScore: 10, reasons: [], flags: [] }) });
    expect(r.needsReview).toBe(true);
  });

  it('MOD-05 the model can raise risk and add flags', async () => {
    const r = await classify(smallPay, { model: async () => ({ confidence: 0.95, riskLevel: 'CRITICAL', reasons: ['Payee linked to fraud reports'], flags: ['FRAUD_SIGNAL'] }) });
    expect(r.riskLevel).toBe('CRITICAL');
    expect(r.flags).toContain('FRAUD_SIGNAL');
    expect(r.needsReview).toBe(false);
  });

  it('MOD-06 the model can never lower risk', async () => {
    const rules = await classify(smallPay);
    const r = await classify(smallPay, { model: async () => ({ intent: 'MAKE_PAYMENT', confidence: 0.99, riskScore: 0, riskLevel: 'LOW', reasons: [], flags: [] }) });
    expect(r.riskScore).toBe(rules.riskScore);
    expect(r.riskLevel).toBe('HIGH');
  });

  it('MOD-07 a model that disagrees about the intent forces review', async () => {
    const r = await classify(smallPay, { model: async () => ({ intent: 'REFUND', confidence: 0.9, reasons: [], flags: [] }) });
    expect(r.needsReview).toBe(true);
    expect(r.flags).toContain('INTENT_MISMATCH');
  });
});
