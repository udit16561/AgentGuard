// Keys whose values are secrets: dropped entirely
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|cvv|cvc|pin|otp|private[-_]?key)/i;
// 12-19 digit runs (card and bank numbers), allowing spaces or dashes between groups
const LONG_NUMBER = /\b(?:\d[ -]?){11,18}\d\b/g;

const maskNumber = (m: string) => `****${m.replace(/\D/g, '').slice(-4)}`;

/** Copy of `value` that is safe to store in the audit log (docs/SECURITY_AND_APPROVALS.md §6, SEC-24). */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(LONG_NUMBER, maskNumber);
  if (typeof value === 'number') return Number.isInteger(value) && String(Math.abs(value)).length >= 12 ? maskNumber(String(value)) : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v);
    return out;
  }
  return value;
}
