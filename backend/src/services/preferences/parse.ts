import { z } from 'zod';
import { MAX_RULES, MAX_TEXT, Rule } from './rules';
import type { Weekday } from '../time';

/**
 * Turns a tool's free-text preferences into structured rules (docs/PREFERENCES.md).
 * a) Deterministic (default): regex and keyword patterns, no learned parameters.
 * b) Optional small model (PREFERENCE_MODEL_PROVIDER=anthropic): strict schema, 3 s timeout, and any error
 *    falls back to (a). Either way the user reviews the result and confirms it before anything is saved,
 *    and text that tries to grant something ("auto-approve all payments") never becomes a rule.
 */
export interface Ignored { text: string; reason: 'GRANTS_NOTHING' }
export interface ParseResult { rules: Rule[]; ignored: Ignored[]; unrecognized: string[] }
export interface ParsedPreferences extends ParseResult { parser: 'deterministic' | 'model'; fallbackReason?: string }
export type PreferenceModel = (input: { text: string; tool: string }) => Promise<unknown>;
export const PREFERENCE_MODEL_TIMEOUT_MS = 3000;

// preferences may only restrict; anything that reads like a permission is reported and dropped
const GRANT = /\b(auto[- ]?approv\w*|approv\w* (all|every|any|everything|automatically)|(allow|permit)\w* (all|every|any|everything)|always (allow|approve|permit)|skip (the )?(approvals?|reviews?|confirmations?)|no need to (ask|approve|confirm)|without (asking|approval|confirmation)|don'?t (ask|need to ask)|bypass|ignore (the |my |all )?(limits?|rules?|caps?)|unlimited|full access|grant)\b/i;
const NEGATIVE = /\b(no|never|not|nothing|don'?t|do not|avoid|none)\b/i;
const ADDRESS = /(?:[\w.+-]+)?@[\w-]+(?:\.[\w-]+)+/g;
const TIME = String.raw`(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)`;
const DAYS: [RegExp, Weekday][] = [[/\bmon(day)?s?\b/i, 'mon'], [/\btue(s|sday)?s?\b/i, 'tue'], [/\bwed(nesday)?s?\b/i, 'wed'], [/\bthu(rs|rsday)?s?\b/i, 'thu'],
  [/\bfri(day)?s?\b/i, 'fri'], [/\bsat(urday)?s?\b/i, 'sat'], [/\bsun(day)?s?\b/i, 'sun']];
const WEEK_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const pad = (n: number) => String(n).padStart(2, '0');
interface Clock { h: number; m: number; meridiem: boolean }
function readTime(raw: string): Clock | null {
  const t = raw.trim().toLowerCase();
  if (t === 'noon') return { h: 12, m: 0, meridiem: true };
  if (t === 'midnight') return { h: 0, m: 0, meridiem: true };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0), mer = m[3]?.replace(/\./g, '');
  if (min > 59 || h > 24 || (mer && (h < 1 || h > 12))) return null;
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (!mer && !m[2] && h > 24) return null;
  return { h: h % 24, m: min, meridiem: !!mer || !!m[2] };
}
const hhmm = (c: Clock) => `${pad(c.h)}:${pad(c.m)}`;

function splitList(s: string) {
  return s.split(/,|\/|\band\b|\bor\b|&/i).map(x => x.trim().replace(/^(the|any|anything about)\s+/i, '').replace(/\s+(topics?|stuff|things|issues)$/i, '').trim().toLowerCase())
    .filter(x => x.length >= 2 && x.length <= 60);
}

function parseSentence(sentence: string, rules: Rule[]): boolean {
  const s = sentence, lower = s.toLowerCase();
  const before = rules.length;
  const add = (r: Record<string, unknown>) => { rules.push(Rule.parse({ ...r, hard: false })); };

  // signature or other required text: everything after the cue, quotes removed
  const req = /\b(?:sign(?:ed)?(?: off)?\s+(?:as|with)|always (?:end|sign off|close) with|end (?:every|each) \w+ with|always include|must include)\s+['"‘“]?(.+?)['"’”]?$/i.exec(s);
  if (req) { add({ type: 'requiredText', text: req[1].trim() }); return true; }

  // "Use udit@work.com for clients": the sending account, not a recipient
  if (/\b(use|send from|from)\b/i.test(s)) {
    for (const m of s.matchAll(/([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s+for\s+([a-z][a-z ]{0,40}?)(?=,|;|$|\s+and\b)/gi))
      add({ type: 'account', accounts: [m[1].toLowerCase()], purpose: m[2].trim().toLowerCase() });
    if (rules.length > before) return true;
  }

  if (/\battach(ment)?s?\b/i.test(s)) {
    if (/\b(new|unknown|unfamiliar)\b.*\b(recipients?|people|contacts?|addresses)\b|\bonly to known\b/i.test(s)) { add({ type: 'attachmentPolicy', policy: 'knownRecipientsOnly' }); return true; }
    if (NEGATIVE.test(s) || /\bwithout\b/i.test(s)) { add({ type: 'attachmentPolicy', policy: 'none' }); return true; }
  }

  const tone = /\b(professional|formal|friendly|casual)\b/i.exec(s);
  if (tone && (/\b(tone|keep (?:it|things)|be|stay|sound|style|only)\b/i.test(s) || s.split(/\s+/).length <= 3)) add({ type: 'tone', tone: tone[1].toLowerCase() });
  else if (/\bno (swearing|profanity|slang|cursing|bad language|rude(ness)?)\b/i.test(s)) add({ type: 'tone', tone: 'professional' });

  const topic = /\b(?:no|never|don'?t|do not|avoid|nothing)\b.*?\b(?:about|mention(?:ing)?|discuss(?:ing)?|on the (?:topic|subject) of|regarding|related to)\s+(.+)$/i.exec(s);
  if (topic) { const topics = splitList(topic[1]); if (topics.length) add({ type: 'blockedTopics', topics: [...new Set(topics)] }); }

  if (/\b(pay|payments?|spend|transfers?|send money)\b/i.test(s)) {
    const amt = /(?:more than|over|above|exceed(?:ing)?|max(?:imum)?(?: of)?|at most|up to|no more than)\s*(?:₹|rs\.?|inr|\$)?\s*([\d,]+(?:\.\d+)?)(?!\s*(?:min|hour|hr|h\b|am|pm|:))/i.exec(s);
    if (amt) add({ type: 'maxAmount', amount: Number(amt[1].replace(/,/g, '')) });
  }

  const dur = /(?:max(?:imum)?(?: of)?|at most|longer than|under|up to|less than)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|m\b|hours?|hrs?|h\b)/i.exec(s);
  if (dur) add({ type: 'maxDuration', minutes: Math.round(Number(dur[1]) * (/^h/i.test(dur[2]) ? 60 : 1)) });

  // times: "between 9am and 6pm", "08:00–22:00", "before 10am", "after 9pm"
  const window: { notBefore?: string; notAfter?: string } = {};
  const range = new RegExp(String.raw`(?:\bbetween\s+${TIME}\s+(?:and|to|-|–)\s+${TIME})|(?:\bfrom\s+${TIME}\s+(?:to|until|till|-|–)\s+${TIME})|(?:\b(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\b)`, 'i').exec(s);
  if (range) {
    const [a, b] = [range[1] ?? range[3] ?? range[5], range[2] ?? range[4] ?? range[6]].map(readTime);
    if (a && b) {
      if (!b.meridiem && b.h <= a.h && b.h + 12 < 24) b.h += 12;   // "from 9 to 5"
      window.notBefore = hhmm(a); window.notAfter = hhmm(b);
    }
  } else {
    const only = /\bonly\b/i.test(s);
    const bef = new RegExp(String.raw`\bbefore\s+${TIME}`, 'i').exec(s), aft = new RegExp(String.raw`\bafter\s+${TIME}`, 'i').exec(s);
    const b = bef && readTime(bef[1]), a = aft && readTime(aft[1]);
    if (b) window[only ? 'notAfter' : 'notBefore'] = hhmm(b);
    if (a) window[only ? 'notBefore' : 'notAfter'] = hhmm(a);
  }
  if (window.notBefore || window.notAfter) add({ type: 'timeWindow', ...window });

  // days: "no meetings on Sundays", "nothing on weekends", "weekdays only"
  const days = new Set<Weekday>();
  if (/\bweekdays? only\b|\bonly (on )?weekdays?\b/i.test(s)) { days.add('sat'); days.add('sun'); }
  else if (NEGATIVE.test(s)) {
    if (/\bweekends?\b/i.test(s)) { days.add('sat'); days.add('sun'); }
    for (const [re, d] of DAYS) if (re.test(s)) days.add(d);
  }
  if (days.size) add({ type: 'dayBlock', days: WEEK_ORDER.filter(d => days.has(d)) });

  // recipients by address or @domain
  const addresses = [...new Set((s.match(ADDRESS) ?? []).map(a => a.toLowerCase()))];
  if (addresses.length) {
    if (/\bonly\b/i.test(lower)) add({ type: 'recipient', mode: 'allow', values: addresses });
    else if (NEGATIVE.test(lower)) add({ type: 'recipient', mode: 'deny', values: addresses });
  }
  return rules.length > before;
}

export function parseDeterministic(text: string, _tool: string): ParseResult {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error(`Preferences can be at most ${MAX_TEXT} characters`);
  const rules: Rule[] = [], ignored: Ignored[] = [], unrecognized: string[] = [];
  // sentence ends only before whitespace, so addresses like udit@work.com stay whole
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/).map(x => x.trim().replace(/[.!?;]+$/, '').trim()).filter(Boolean);
  for (const s of sentences) {
    if (GRANT.test(s)) { ignored.push({ text: s, reason: 'GRANTS_NOTHING' }); continue; }
    if (!parseSentence(s, rules)) unrecognized.push(s);
  }
  return { rules: rules.slice(0, MAX_RULES), ignored, unrecognized };
}

const ModelOutput = z.object({ rules: z.array(Rule).max(MAX_RULES) }).strict();
// structured-output schemas send unused fields as null; drop them before the strict check
const dropNulls = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { rules?: unknown }).rules)) return raw;
  return { ...raw, rules: (raw as { rules: unknown[] }).rules.map(r => r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) : r) };
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export async function parsePreferences(text: string, tool: string, opts: { model?: PreferenceModel; timeoutMs?: number } = {}): Promise<ParsedPreferences> {
  const det = parseDeterministic(text, tool);
  const fallback = (fallbackReason: string): ParsedPreferences => ({ ...det, parser: 'deterministic', fallbackReason });
  if (!opts.model || !text.trim()) return { ...det, parser: 'deterministic' };
  let raw: unknown;
  try { raw = await withTimeout(Promise.resolve().then(() => opts.model!({ text, tool })), opts.timeoutMs ?? PREFERENCE_MODEL_TIMEOUT_MS); }
  catch (e) { return fallback(e instanceof Error && e.message === 'timeout' ? 'Model timeout: the built-in parser was used' : 'The model failed, so the built-in parser was used'); }
  const parsed = ModelOutput.safeParse(dropNulls(raw));
  if (!parsed.success) return fallback('The model gave an answer outside the allowed rule types, so the built-in parser was used');
  // only the user marks a rule hard, on the confirm step
  return { rules: parsed.data.rules.map(r => ({ ...r, hard: false })), ignored: det.ignored, unrecognized: [], parser: 'model' };
}
