import { describeRule, type StoredRule } from './rules';
import { minutes, zonedParts } from '../time';

/**
 * Checks one proposed action against a tool's confirmed preference rules, with no learned parameters:
 * exact checks for time, day, account, recipients, duration, attachments and amount; TF-IDF cosine similarity
 * for blocked topics; a small lexicon for tone. The result is only ever used to raise risk, add a reason,
 * or block a rule the user marked hard (docs/PREFERENCES.md). Errors are thrown so the caller fails closed.
 */
export const TOPIC_THRESHOLD = 0.35;

export interface RuleResult { id: string; type: string; label: string; hard: boolean; detail?: string; flag?: string }
export interface PreferenceReport { followed: RuleResult[]; broken: RuleResult[]; error: boolean }
export interface PreferenceInput {
  tool: string; operation: string; payload: Record<string, unknown>;
  now: number; timeZone: string; knownRecipients: string[];
}

/* ---------- TF-IDF topic similarity ---------- */
const STOP = new Set(('a an the and or but if of to in on at for from by with about as is are was were be been being it its this that these those ' +
  'i me my we our us you your he she they them their his her not no so do does did done have has had will would can could should must may might ' +
  'just very too also than then there here what which who whom when where why how all any some more most new now out up down over into get got').split(' '));

function stem(w: string) {
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('ical')) s = s.slice(0, -2);
  else if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}
export const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOP.has(t)).map(stem);

// a few words that usually come with each common topic, so "vote for the party" is close to "politics"
const LEXICON: Record<string, string> = {
  politics: 'election vote party minister government parliament campaign',
  religion: 'religious god church temple mosque prayer faith worship',
  crypto: 'cryptocurrency bitcoin ethereum blockchain token nft coin',
  gambling: 'gamble bet casino poker lottery jackpot wager',
  alcohol: 'beer wine whisky vodka liquor drunk',
  competitors: 'competitor rival competition',
  health: 'medical medicine doctor diagnosis disease symptom',
  sex: 'sexual nude adult explicit'
};
const topicDoc = (topic: string) => tokens(`${topic} ${LEXICON[topic] ?? LEXICON[topic.replace(/s$/, '')] ?? ''}`);

function vector(terms: string[], idf: Map<string, number>) {
  const v = new Map<string, number>();
  for (const t of terms) v.set(t, (v.get(t) ?? 0) + 1);
  for (const [t, n] of v) v.set(t, n * (idf.get(t) ?? 1));
  return v;
}
function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, x] of a) { na += x * x; const y = b.get(t); if (y) dot += x * y; }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Highest cosine similarity between the topic and any sentence (or the whole text); 1 when the topic word itself appears. */
export function topicSimilarity(text: string, topic: string): number {
  const head = tokens(topic);
  const all = tokens(text);
  if (head.length && head.every(t => all.includes(t))) return 1;
  const sentences = text.split(/[.!?;\n]+/).map(tokens).filter(s => s.length);
  const topicDocs = [...new Set([...Object.keys(LEXICON), topic])].map(topicDoc);
  const docs = [...topicDocs, ...sentences];
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log((docs.length + 1) / (n + 1)) + 1]));
  const q = vector(topicDoc(topic), idf);
  return Math.max(0, ...[...sentences, all].map(s => cosine(q, vector(s, idf))));
}

/* ---------- tone lexicon ---------- */
const HOSTILE = /\b(idiot|stupid|moron|loser|dumb|shut up|hate you|pathetic|worthless|useless|incompetent|ridiculous|disgusting|kill (you|yourself))\b/gi;
const UNPROFESSIONAL = /\b(lol|lmao|rofl|wtf|omg|dude|bro|bruh|crap|damn|sucks?|hell|af|gonna|wanna|fuck\w*|shit\w*|bitch\w*|ass(hole)?|bastard)\b/gi;
const SHOUTING = /\b[A-Z]{3,}(?:\s+[A-Z]{2,}){2,}\b|!{3,}/;

/** Words that break the tone. Friendly and casual allow slang; no tone allows hostility. */
export function toneIssues(text: string, tone: string): string[] {
  const found = new Set<string>((text.match(HOSTILE) ?? []).map(w => w.toLowerCase()));
  if (tone === 'professional' || tone === 'formal') {
    for (const w of text.match(UNPROFESSIONAL) ?? []) found.add(w.toLowerCase());
    if (SHOUTING.test(text)) found.add('shouting');
  }
  return [...found];
}

/* ---------- the checks ---------- */
const TEXT_FIELDS = ['subject', 'body', 'text', 'message', 'caption', 'content', 'title', 'comment', 'description'];
const SELF = new Set(['you', 'me', 'self', 'myself']);
const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean);
const recipientsOf = (p: Record<string, unknown>) =>
  [...new Set(['to', 'cc', 'bcc', 'attendees', 'recipients'].flatMap(k => list(p[k])).map(r => r.toLowerCase()))].filter(r => !SELF.has(r));
const matches = (address: string, value: string) => value.startsWith('@') ? address.endsWith(value) : address === value;
const time = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

export function checkPreferences(rules: StoredRule[], input: PreferenceInput): PreferenceReport {
  const p = input.payload;
  const text = TEXT_FIELDS.map(k => p[k]).filter((v): v is string => typeof v === 'string').join('\n');
  const recipients = recipientsOf(p);
  const known = new Set(input.knownRecipients.map(r => r.toLowerCase()));
  const attachments = [...list(p.attachments), ...list(p.media)];
  // when the action happens: a meeting's start, a scheduled send, an alarm's time, otherwise now
  const start = time(p.start) ?? time(p.sendAt) ?? time(p.scheduledAt);
  const when = zonedParts(start ?? input.now, input.timeZone);
  const minuteOfDay = typeof p.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) && start == null ? minutes(p.time) : when.minuteOfDay;
  const end = time(p.end);
  const duration = start != null && end != null ? (end - start) / 60_000 : typeof p.durationMinutes === 'number' ? p.durationMinutes : null;
  const from = typeof p.from === 'string' ? p.from.toLowerCase() : typeof p.account === 'string' ? p.account.toLowerCase() : null;
  const accounts = new Set(rules.flatMap(r => r.type === 'account' ? r.accounts : []));

  const report: PreferenceReport = { followed: [], broken: [], error: false };
  for (const r of rules) {
    const result: RuleResult = { id: r.id, type: r.type, label: describeRule(r, input.tool), hard: !!r.hard };
    let outcome: { ok: boolean; detail?: string; flag?: string } | null = null;   // null: does not apply to this action
    switch (r.type) {
      case 'timeWindow': {
        const nb = r.notBefore ? minutes(r.notBefore) : null, na = r.notAfter ? minutes(r.notAfter) : null;
        const inside = nb != null && na != null && nb > na ? minuteOfDay >= nb || minuteOfDay < na
          : (nb == null || minuteOfDay >= nb) && (na == null || minuteOfDay < na);
        outcome = { ok: inside, detail: `at ${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}` };
        break;
      }
      case 'dayBlock': outcome = { ok: !r.days.includes(when.weekday), detail: `on a ${when.weekday}` }; break;
      case 'maxDuration': if (duration != null) outcome = { ok: duration <= r.minutes, detail: `${Math.round(duration)} minutes` }; break;
      case 'account': if (from) outcome = { ok: accounts.has(from), detail: `from ${from}` }; break;
      case 'recipient': if (recipients.length) {
        const bad = r.mode === 'deny' ? recipients.filter(a => r.values.some(v => matches(a, v))) : recipients.filter(a => !r.values.some(v => matches(a, v)));
        outcome = { ok: !bad.length, detail: bad.length ? bad.slice(0, 3).join(', ') : undefined };
      } break;
      case 'requiredText': if (text) outcome = { ok: text.toLowerCase().includes(r.text.toLowerCase()) }; break;
      case 'blockedTopics': if (text) {
        const hits = r.topics.map(t => [t, topicSimilarity(text, t)] as const).filter(([, s]) => s >= TOPIC_THRESHOLD);
        outcome = { ok: !hits.length, flag: 'PREFERENCE_TOPIC', detail: hits.length ? hits.map(([t, s]) => r.topics.length === 1 ? `similarity ${s.toFixed(2)}` : `${t}: similarity ${s.toFixed(2)}`).join(', ') : undefined };
      } break;
      case 'tone': if (text) {
        const issues = toneIssues(text, r.tone);
        outcome = { ok: !issues.length, flag: 'PREFERENCE_TONE', detail: issues.length ? `words: ${issues.slice(0, 4).join(', ')}` : undefined };
      } break;
      case 'attachmentPolicy': if (attachments.length) {
        const unknown = recipients.filter(a => !known.has(a));
        outcome = { ok: r.policy === 'none' ? false : !unknown.length, detail: r.policy === 'none' ? `${attachments.length} attachment(s)` : unknown.length ? `to ${unknown.slice(0, 3).join(', ')}` : undefined };
      } break;
      case 'maxAmount': if (typeof p.amount === 'number') outcome = { ok: p.amount <= r.amount, detail: `amount ${p.amount}` }; break;
    }
    if (!outcome) continue;
    if (outcome.ok) report.followed.push(result);
    else report.broken.push({ ...result, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.flag ? { flag: outcome.flag } : {}) });
  }
  return report;
}
