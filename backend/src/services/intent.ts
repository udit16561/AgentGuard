import { z } from 'zod';
import { operationDef, type Intent } from './catalog';
import { categoryHit } from './categories';

/**
 * Intent classification and risk scoring (docs/INTENT_AND_RISK.md).
 * Layer 1, rules, always runs. Layer 2, an optional model, may only raise risk or add reasons and flags;
 * any error, timeout, invalid output or low confidence fails closed to needsReview (SEC-19, SEC-20).
 * The result is advisory: it never approves anything.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ClassifyContext {
  knownRecipients?: string[];
  knownPayees?: string[];
  dailyCap?: number;
  spentToday?: number;
  outsideAllowedHours?: boolean;
  trustedDomains?: string[];
  /** payments: categories the user blocked; the words showing up in payee or note raise the risk */
  blockedCategories?: string[];
  /** payments: methods are restricted but the agent named none */
  methodMissing?: boolean;
  reauthAbove?: number;
  /** tool preferences the action breaks (soft rules; hard ones were already blocked by the policy) */
  preferenceViolations?: { label: string; flag?: string }[];
  preferenceError?: boolean;
}
export interface ClassifyInput { tool: string; operation: string; payload: Record<string, unknown>; context?: ClassifyContext }
export interface Classification {
  intent: Intent; riskLevel: RiskLevel; riskScore: number; confidence: number;
  reasons: string[]; flags: string[]; needsReview: boolean;
}
export type ModelClassifier = (input: ClassifyInput & { rules: Classification }) => Promise<unknown>;

export const MIN_CONFIDENCE = 0.6;
const MODEL_TIMEOUT_MS = 3000;
const CRITICAL_FLOOR = 80;

export const levelOf = (score: number): RiskLevel => score >= 80 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';
const LEVEL_FLOOR: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 25, HIGH: 50, CRITICAL: 80 };

const SELF = new Set(['you', 'me', 'self', 'myself']);
const MESSAGING: Intent[] = ['SEND_EMAIL', 'SEND_MESSAGE'];
const PEOPLE: Intent[] = ['SEND_EMAIL', 'SEND_MESSAGE', 'SCHEDULE_EVENT', 'MODIFY_EVENT', 'CANCEL_EVENT', 'CONNECT_SOCIAL'];
const MONEY: Intent[] = ['MAKE_PAYMENT', 'REFUND', 'SUBSCRIBE'];

const INJECTION = /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.]{0,20}\b(instructions?|rules?|prompts?|guardrails?)\b|\bsystem prompt\b|\byou are now\b|\b(auto[- ]?)?approve (all|every|this)\b|\bdo not (ask|alert|notify) (the )?(user|owner)\b/i;
const HOSTILE = /\b(idiot|stupid|moron|loser|dumb|shut up|hate you|kill (you|yourself)|worthless|pathetic)\b/i;
const CARD_OR_ACCOUNT = /\b(?:\d[ -]?){11,18}\d\b/;
const SENSITIVE_KEY = /(card(number)?|cvv|cvc|otp|pin|password|ssn|aadhaar|pan(number)?|iban|account(number)?)$/i;
const URL = /\bhttps?:\/\/[^\s"'<>]+/gi;
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'cutt.ly', 'rb.gy']);

function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 200) return out;
  if (typeof value === 'string') out.push(value.slice(0, 5000));
  else if (Array.isArray(value)) value.forEach(v => strings(v, out, depth + 1));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out, depth + 1));
  return out;
}
function keys(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) { out.push(k); keys(v, out, depth + 1); }
  return out;
}
const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean);

function recipientsOf(p: Record<string, unknown>) {
  return [...new Set([...asList(p.to), ...asList(p.cc), ...asList(p.bcc), ...asList(p.recipients), ...asList(p.attendees)])]
    .filter(r => !SELF.has(r.toLowerCase()));
}
const shortList = (xs: string[]) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` and ${xs.length - 3} more` : '');

/** Layer 1: deterministic rules. */
export function classifyRules(input: ClassifyInput): Classification {
  const { tool, operation } = input;
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const ctx = input.context ?? {};
  const def = operationDef(tool, operation);
  if (!def) {
    return { intent: 'UNKNOWN', riskLevel: 'HIGH', riskScore: 50, confidence: 0, reasons: [`Unknown tool or operation: ${tool}.${operation}`], flags: ['UNKNOWN_OPERATION'], needsReview: true };
  }

  let score = def.baseRisk, floor = 0, needsReview = false;
  const reasons: string[] = [], flags = new Set<string>();
  const add = (points: number, reason: string, flag?: string) => { score += points; reasons.push(reason); if (flag) flags.add(flag); };
  const text = strings(payload).join('\n');

  if (PEOPLE.includes(def.intent)) {
    const recipients = recipientsOf(payload);
    const known = new Set((ctx.knownRecipients ?? []).map(s => s.toLowerCase()));
    const unknown = recipients.filter(r => !known.has(r.toLowerCase()));
    if (unknown.length) add(20, `New recipient${unknown.length > 1 ? 's' : ''}: ${shortList(unknown)}`, 'NEW_RECIPIENT');
    if (recipients.length > 5) {
      add(20, `Bulk: ${recipients.length} recipients`, 'BULK');
      if (MESSAGING.includes(def.intent)) floor = Math.max(floor, CRITICAL_FLOOR);   // mass messaging is CRITICAL (DECISIONS E)
    }
    if (MESSAGING.includes(def.intent) && !recipients.length) { reasons.push('No recipient given'); flags.add('MISSING_DETAILS'); needsReview = true; }
  }

  if (MONEY.includes(def.intent)) {
    const amount = typeof payload.amount === 'number' ? payload.amount : NaN;
    if (!Number.isFinite(amount) || amount <= 0) { reasons.push('Amount missing or invalid'); flags.add('MISSING_DETAILS'); needsReview = true; }
    if (def.intent === 'MAKE_PAYMENT') {
      const payee = asList(payload.payee ?? payload.to)[0];
      if (!payee) { reasons.push('Payee not given'); flags.add('MISSING_DETAILS'); needsReview = true; }
      else if (!(ctx.knownPayees ?? []).some(k => k.toLowerCase() === payee.toLowerCase())) add(20, `New payee: ${payee}`, 'NEW_PAYEE');
    }
    if (ctx.dailyCap && Number.isFinite(amount)) {
      const total = (ctx.spentToday ?? 0) + amount;
      if (total > ctx.dailyCap) { reasons.push(`Over the daily cap of ${ctx.dailyCap}`); flags.add('LIMIT_EXCEEDED'); floor = Math.max(floor, CRITICAL_FLOOR); }
      else if (amount > ctx.dailyCap * 0.5) add(15, `Amount is ${Math.round(amount / ctx.dailyCap * 100)}% of the daily cap`, 'LARGE_AMOUNT');
    }
    if (ctx.methodMissing) { reasons.push('Payment method not given'); flags.add('MISSING_DETAILS'); needsReview = true; }
    if (ctx.reauthAbove != null && Number.isFinite(amount) && amount > ctx.reauthAbove) { reasons.push(`Above your PIN threshold of ${ctx.reauthAbove}`); flags.add('REAUTH_THRESHOLD'); }
    const described = ['payee', 'to', 'note', 'description', 'merchant', 'category', 'memo'].map(k => payload[k]).filter(v => typeof v === 'string').join(' ');
    const category = (ctx.blockedCategories ?? []).find(c => categoryHit(c, described));
    if (category) add(25, `Looks like a blocked category: ${category}`, 'CATEGORY_MATCH');
  }

  if (payload.audience === 'public' || payload.visibility === 'public') add(15, 'Public audience', 'PUBLIC');
  if (ctx.outsideAllowedHours) add(10, 'Outside the allowed hours', 'OUTSIDE_HOURS');

  const hostile = HOSTILE.test(text);
  const sensitive = CARD_OR_ACCOUNT.test(text) || keys(payload).some(k => SENSITIVE_KEY.test(k));
  if (hostile) flags.add('HOSTILE_TONE');
  if (sensitive) flags.add('SENSITIVE_DATA');
  if (hostile || sensitive) add(15, [hostile && 'Hostile or aggressive tone', sensitive && 'Contains sensitive data (card, account or secret)'].filter(Boolean).join('; '));

  const trusted = new Set((ctx.trustedDomains ?? []).map(d => d.toLowerCase()));
  const untrusted = (text.match(URL) ?? []).filter(u => {
    try { const url = new globalThis.URL(u); const host = url.hostname.toLowerCase(); return url.protocol !== 'https:' || SHORTENERS.has(host) || (trusted.size > 0 && !trusted.has(host)); }
    catch { return true; }
  });
  if (untrusted.length) add(10, `Link from an untrusted source: ${shortList(untrusted)}`, 'UNTRUSTED_LINK');

  if (INJECTION.test(text)) add(25, 'Contains instructions aimed at the system (possible prompt injection)', 'PROMPT_INJECTION');

  // tool preferences may only add risk: +20 for each broken soft rule, at most +40 (docs/PREFERENCES.md)
  const broken = ctx.preferenceViolations ?? [];
  broken.forEach((v, i) => { add(i < 2 ? 20 : 0, `Breaks your preference: ${v.label}`, 'PREFERENCE_VIOLATION'); if (v.flag) flags.add(v.flag); });
  if (ctx.preferenceError) { reasons.push('Your preferences for this tool could not be checked'); flags.add('PREFERENCE_CHECK_ERROR'); needsReview = true; }

  score = Math.min(100, Math.max(score, floor));
  return { intent: def.intent, riskLevel: levelOf(score), riskScore: score, confidence: 0.9, reasons, flags: [...flags], needsReview };
}

const INTENTS = ['READ_DATA', 'SEND_MESSAGE', 'SEND_EMAIL', 'PUBLISH_CONTENT', 'EDIT_CONTENT', 'DELETE_CONTENT', 'SCHEDULE_EVENT', 'MODIFY_EVENT',
  'CANCEL_EVENT', 'SET_REMINDER', 'MAKE_PAYMENT', 'REFUND', 'SUBSCRIBE', 'CONNECT_SOCIAL', 'UNKNOWN'] as const;
/** Strict schema for the model layer's output; anything else is ignored and fails closed. */
const ModelOutput = z.object({
  intent: z.enum(INTENTS).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  riskScore: z.number().min(0).max(100).optional(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(200)).max(10).default([]),
  flags: z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(10).default([])
}).strict();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('classifier timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Rules, then the optional model. `classify(input)` alone is the rules-only contract the tests use. */
export async function classify(input: ClassifyInput, opts: { model?: ModelClassifier; timeoutMs?: number } = {}): Promise<Classification> {
  const rules = classifyRules(input);
  if (!opts.model) return finish(rules);

  const failClosed = (flag: string, reason: string) => finish({ ...rules, needsReview: true, flags: [...new Set([...rules.flags, flag])], reasons: [...rules.reasons, reason] });
  let raw: unknown;
  try { raw = await withTimeout(Promise.resolve().then(() => opts.model!({ ...input, rules })), opts.timeoutMs ?? MODEL_TIMEOUT_MS); }
  catch { return failClosed('CLASSIFIER_ERROR', 'The risk model did not answer, so this needs your review'); }
  const parsed = ModelOutput.safeParse(raw);
  if (!parsed.success) return failClosed('CLASSIFIER_INVALID', 'The risk model gave an unreadable answer, so this needs your review');

  const m = parsed.data;
  // the model may raise risk, never lower it
  const score = Math.min(100, Math.max(rules.riskScore, m.riskScore ?? 0, m.riskLevel ? LEVEL_FLOOR[m.riskLevel] : 0));
  const flags = new Set([...rules.flags, ...m.flags]);
  let needsReview = rules.needsReview;
  const reasons = [...rules.reasons, ...m.reasons];
  if (m.confidence < MIN_CONFIDENCE) { needsReview = true; flags.add('LOW_CONFIDENCE'); reasons.push('The risk model is unsure'); }
  if (m.intent && m.intent !== rules.intent) { needsReview = true; flags.add('INTENT_MISMATCH'); reasons.push(`The risk model reads this as ${m.intent}`); }
  return finish({ intent: rules.intent, riskScore: score, riskLevel: levelOf(score), confidence: Math.min(rules.confidence, m.confidence), reasons, flags: [...flags], needsReview });
}

// fail closed on unknown intent or low confidence, whichever layer produced them
const finish = (c: Classification): Classification =>
  ({ ...c, needsReview: c.needsReview || c.intent === 'UNKNOWN' || c.confidence < MIN_CONFIDENCE });
