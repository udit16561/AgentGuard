import type { LanguageModel } from 'ai';

/**
 * The built-in offline model (provider "offline"): an Assistant that works with no API key and no network.
 * It is not AI: it reads simple commands ("pay Ravi 500", "email asha@example.com Running late") and proposes them
 * through propose_action, the same path as any agent, so every gate still applies. It cannot be the guard: the
 * deterministic rules already check every action, and this model has nothing to add to them.
 */
export const OFFLINE_MODEL_ID = 'agentguard-offline';

type Proposal = { tool: string; operation: string; payload: Record<string, unknown> };
type Part = { type: string; text?: string; output?: { type: string; value?: unknown } };
type Prompt = { role: string; content: string | Part[] }[];

const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } };
const stop = { unified: 'stop' as const, raw: undefined };

export const OFFLINE_HELP = [
  'I am the built-in offline assistant: I follow simple commands, with no AI and no internet. Try:',
  '• pay Ravi 500 (or: pay ₹500 to Ravi for lunch)',
  '• email asha@example.com Running 10 minutes late',
  '• meet raj@example.com Coffee chat at 11:30',
  '• post on linkedin We shipped our new release',
  '• whatsapp +91-98000-00001 On my way',
  '• alarm 07:00 Gym, or remind me at 18:00 to call Mom',
  'Everything I propose waits for your approval in Review.'
].join('\n');

const text = (c: string | Part[]) => (typeof c === 'string' ? c : c.map(p => p.text ?? '').join(' '));
const lastUser = (prompt: Prompt) => text([...prompt].reverse().find(m => m.role === 'user')?.content ?? '').trim();

/** Tomorrow at hh:mm in the server's time zone (the app runs on the user's own PC), with its UTC offset. */
function tomorrowAt(hh: number, mm: number) {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(hh, mm, 0, 0);
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return { iso: `${local}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`, ms: d.getTime() };
}
const withOffset = (ms: number, like: string) => {
  const off = like.slice(-6);
  const sign = off[0] === '-' ? -1 : 1;
  const mins = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  return `${new Date(ms + mins * 60_000).toISOString().slice(0, 19)}${off}`;
};

const PAY_AMOUNT_FIRST = /^pay\s+(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d{1,2})?)\s+(?:to\s+)?([A-Za-z][\w]*(?:\s+[A-Z][\w]*)?)(?:\s+for\s+(.+))?$/i;
const PAY_NAME_FIRST = /^pay\s+([A-Za-z][\w]*(?:\s+[A-Z][\w]*)?)\s+(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d{1,2})?)(?:\s+for\s+(.+))?$/i;
const EMAIL = /^(?:send\s+an?\s+)?e?-?mail\s+(?:to\s+)?(\S+@\S+?)[:,]?\s+(?:about\s+|saying\s+)?(.+)$/i;
const MEET = /^(?:meet|meeting\s+with|schedule\s+(?:a\s+)?meeting\s+with)\s+(\S+@\S+?)[:,]?(?:\s+(.*?))?(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i;
const POST = /^post\s+(?:on\s+|to\s+)?(x|twitter|linkedin|instagram|blog)[:,]?\s+(.+)$/i;
const WHATSAPP = /^(?:whatsapp|message|text)\s+(?:to\s+)?(\+?\d[\d -]{5,}\d)[:,]?\s+(.+)$/i;
const DM = /^dm\s+(?:on\s+)?(x|twitter|instagram|linkedin)\s+(\S+)[:,]?\s+(.+)$/i;
const ALARM = /^(?:set\s+an?\s+)?alarm\s+(?:for\s+|at\s+)?(\d{1,2}:\d{2})\s*(.*)$/i;
const REMIND = /^remind\s+me\s+at\s+(\d{1,2}:\d{2})\s+(?:to\s+)?(.+)$/i;

const hhmm = (t: string) => t.padStart(5, '0');

/** One command, or null when it is not one the offline assistant knows. */
export function readCommand(input: string): Proposal | null {
  const s = input.replace(/\s+/g, ' ').trim().replace(/[.!]$/, '');
  let m: RegExpExecArray | null;
  if ((m = PAY_AMOUNT_FIRST.exec(s)) || (m = PAY_NAME_FIRST.exec(s))) {
    const amountFirst = /^\d/.test(m[1]);
    const [amount, payee] = amountFirst ? [m[1], m[2]] : [m[2], m[1]];
    return { tool: 'payments', operation: 'pay', payload: { amount: Number(amount), currency: 'INR', payee, method: 'upi', ...(m[3] ? { note: m[3] } : {}) } };
  }
  if ((m = EMAIL.exec(s))) return { tool: 'gmail', operation: 'send', payload: { to: [m[1]], subject: m[2].length > 60 ? `${m[2].slice(0, 57)}…` : m[2], body: m[2] } };
  if ((m = MEET.exec(s))) {
    const start = tomorrowAt(m[3] ? Number(m[3]) : 11, m[4] ? Number(m[4]) : 0);
    return { tool: 'calendar', operation: 'create', payload: { title: m[2] || 'Meeting', start: start.iso, end: withOffset(start.ms + 30 * 60_000, start.iso), attendees: [m[1]] } };
  }
  if ((m = POST.exec(s))) {
    const where = m[1].toLowerCase() === 'twitter' ? 'x' : m[1].toLowerCase();
    if (where === 'instagram') return { tool: 'instagram', operation: 'post', payload: { caption: m[2], media: ['photo.jpg'] } };
    if (where === 'blog') return { tool: 'blog', operation: 'publish', payload: { title: m[2].slice(0, 60), body: m[2] } };
    return { tool: where, operation: 'post', payload: { text: m[2], audience: 'public' } };
  }
  if ((m = WHATSAPP.exec(s))) return { tool: 'whatsapp', operation: 'send_message', payload: { to: [m[1]], text: m[2] } };
  if ((m = DM.exec(s))) {
    const where = m[1].toLowerCase() === 'twitter' ? 'x' : m[1].toLowerCase();
    return { tool: where, operation: where === 'linkedin' ? 'message' : 'dm', payload: { to: m[2], text: m[3] } };
  }
  if ((m = ALARM.exec(s))) return { tool: 'clock', operation: 'set_alarm', payload: { time: hhmm(m[1]), label: m[2] || 'Alarm' } };
  if ((m = REMIND.exec(s))) return { tool: 'clock', operation: 'set_reminder', payload: { time: hhmm(m[1]), text: m[2] } };
  return null;
}

/** What the last propose_action call returned, for the closing sentence. */
function lastResult(prompt: Prompt): Record<string, unknown> | null {
  const tool = [...prompt].reverse().find(m => m.role === 'tool');
  const part = Array.isArray(tool?.content) ? tool.content.find(p => p.type === 'tool-result') : undefined;
  const v = part?.output?.value;
  return v && typeof v === 'object' ? v as Record<string, unknown> : null;
}

function reply(prompt: Prompt) {
  const r = lastResult(prompt);
  if (!r) return OFFLINE_HELP;
  if (r.status === 'BLOCKED') return `AgentGuard blocked it: ${typeof r.message === 'string' ? r.message : 'it broke one of your rules'}. I will not try to get around that.`;
  return `I have proposed it (risk ${typeof r.riskLevel === 'string' ? r.riskLevel : 'checked'}). It is waiting for your approval in Review; nothing happens before you decide.`;
}

export function offlineModel(modelId: string): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'offline', modelId, supportedUrls: {},
    // plain text only: no structured output, so it never passes the guard test
    doGenerate: async () => ({ content: [{ type: 'text', text: 'OK' }], finishReason: stop, usage, warnings: [] }),
    doStream: async (opts: { prompt: unknown }) => {
      const prompt = opts.prompt as Prompt;
      const answered = prompt.at(-1)?.role === 'tool';
      const proposal = answered ? null : readCommand(lastUser(prompt));
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (proposal) {
        parts.push({ type: 'tool-call', toolCallId: `offline-${Date.now()}`, toolName: 'propose_action', input: JSON.stringify(proposal) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
      } else {
        parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: reply(prompt) }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: stop, usage });
      }
      return { stream: new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }) };
    }
  } as unknown as LanguageModel;
}
