import { digits, need, nowIso, rid, str, type MockTool } from './util';

const amountOf = (p: Record<string, unknown>) => {
  const a = p.amount;
  need(typeof a === 'number' && Number.isFinite(a) && a > 0, 'Invalid amount: it must be more than zero');
  return a;
};
const currencyOf = (p: Record<string, unknown>) => str(p.currency, 'INR').toUpperCase();

/** A payment gateway in test mode (Razorpay/Stripe style), simulated. Nothing is charged. */
export const payments: MockTool = {
  view_balance: () => ({ providerRef: rid('bal-'), result: { available: 24850.5, currency: 'INR', asOf: nowIso() } }),
  view_history: () => ({ providerRef: rid('hist-'), result: { transactions: [{ transactionId: 'pay_hist1', payee: 'Ravi', amount: 350, currency: 'INR', at: '2026-10-24' }] } }),
  pay: p => {
    const amount = amountOf(p), payee = str(p.payee) || str(p.to);
    need(payee, 'Payee is missing');
    const id = rid('pay_');
    return { providerRef: id, result: { transactionId: id, status: 'captured', amount, currency: currencyOf(p), payee, fee: 0, receiptNumber: `RCPT-${digits(8)}`, paidAt: nowIso() } };
  },
  transfer: p => {
    const amount = amountOf(p), payee = str(p.payee) || str(p.to);
    need(payee, 'Payee is missing');
    const id = rid('pay_');
    return { providerRef: id, result: { transactionId: id, status: 'processed', amount, currency: currencyOf(p), payee, receiptNumber: `RCPT-${digits(8)}`, paidAt: nowIso() } };
  },
  refund: p => {
    const amount = amountOf(p);
    const id = rid('rfnd_');
    return { providerRef: id, result: { refundId: id, status: 'processed', amount, currency: currencyOf(p), originalTransaction: str(p.txnId) || null } };
  },
  subscribe: p => {
    const amount = amountOf(p);
    const id = rid('sub_');
    return { providerRef: id, result: { subscriptionId: id, status: 'active', plan: str(p.plan, 'monthly'), amount, currency: currencyOf(p), nextBillingDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) } };
  }
};
