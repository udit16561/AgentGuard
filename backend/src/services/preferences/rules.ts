import { z } from 'zod';
import { WEEKDAYS } from '../time';

/**
 * Tool preference rules (docs/PREFERENCES.md). Every rule type is a restriction: there is deliberately
 * no type that allows, approves or widens anything, so a preference can only raise risk or block.
 * `hard: true` (set only by the user on the confirm step) turns a broken rule into a block.
 */
export const MAX_TEXT = 500;
export const MAX_RULES = 30;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const short = z.string().trim().min(1).max(120);
const base = { hard: z.boolean().default(false) };

export const Rule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('account'), accounts: z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(10), purpose: short.optional(), ...base }).strict(),
  z.object({ type: z.literal('recipient'), mode: z.enum(['allow', 'deny']), values: z.array(z.string().trim().toLowerCase().min(1).max(254)).min(1).max(50), ...base }).strict(),
  z.object({ type: z.literal('timeWindow'), notBefore: hhmm.optional(), notAfter: hhmm.optional(), ...base }).strict()
    .refine(r => r.notBefore || r.notAfter, 'Give notBefore or notAfter'),
  z.object({ type: z.literal('dayBlock'), days: z.array(z.enum(WEEKDAYS)).min(1).max(7), ...base }).strict(),
  z.object({ type: z.literal('maxDuration'), minutes: z.number().int().min(1).max(24 * 60), ...base }).strict(),
  z.object({ type: z.literal('requiredText'), text: short, ...base }).strict(),
  z.object({ type: z.literal('blockedTopics'), topics: z.array(z.string().trim().toLowerCase().min(2).max(60)).min(1).max(20), ...base }).strict(),
  z.object({ type: z.literal('tone'), tone: z.enum(['professional', 'formal', 'friendly', 'casual']), ...base }).strict(),
  z.object({ type: z.literal('attachmentPolicy'), policy: z.enum(['none', 'knownRecipientsOnly']), ...base }).strict(),
  z.object({ type: z.literal('maxAmount'), amount: z.number().positive().max(1e9), ...base }).strict()
]);
export type Rule = z.infer<typeof Rule>;
export type StoredRule = Rule & { id: string };

export const Rules = z.array(Rule).max(MAX_RULES);
export const StoredRules = z.array(z.intersection(Rule, z.object({ id: z.string().max(16) }))).max(MAX_RULES);

const NOUN: Record<string, string> = { gmail: 'emails', calendar: 'meetings', clock: 'alarms', whatsapp: 'messages', instagram: 'posts', linkedin: 'posts', x: 'posts', blog: 'posts', payments: 'payments' };
const DAY: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;

/** The plain-language line shown on the confirm step ("I understood: …"), the review screen and to agents. Always computed, never stored. */
export function describeRule(r: Rule, tool: string): string {
  const noun = NOUN[tool] ?? 'actions';
  switch (r.type) {
    case 'account': return `Send from ${list(r.accounts)}${r.purpose ? ` (for ${r.purpose})` : ''}`;
    case 'recipient': return r.mode === 'deny' ? `Never to ${list(r.values)}` : `Only to ${list(r.values)}`;
    case 'timeWindow': return r.notBefore && r.notAfter ? `${cap(noun)} only between ${r.notBefore} and ${r.notAfter}` : r.notBefore ? `No ${noun} before ${r.notBefore}` : `No ${noun} after ${r.notAfter}`;
    case 'dayBlock': return `No ${noun} on ${list(r.days.map(d => DAY[d]))}`;
    case 'maxDuration': return `At most ${r.minutes} minutes long`;
    case 'requiredText': return `Must include “${r.text}”`;
    case 'blockedTopics': return `Nothing about ${list(r.topics)}`;
    case 'tone': return `${cap(r.tone)} tone`;
    case 'attachmentPolicy': return r.policy === 'none' ? 'No attachments' : 'Attachments only to known recipients';
    case 'maxAmount': return `No payment over ${r.amount}`;
  }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const withLabels = (rules: StoredRule[] | Rule[], tool: string) => rules.map(r => ({ ...r, label: describeRule(r, tool) }));
