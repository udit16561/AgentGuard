/**
 * Demo agent: plays the "AI agent" side so you can test AgentGuard by hand.
 * It proposes an action, then polls until the user approves or rejects it on the dashboard.
 *
 * Usage (from backend/, with AGENT_API_KEY set to the key printed by npm run db:seed):
 *   npm run demo:agent -- pay 500 Ravi
 *   npm run demo:agent -- email asha@example.com "Running 10 minutes late"
 *   npm run demo:agent -- post x "Launching today!"            (x | linkedin | instagram | blog)
 *   npm run demo:agent -- meet raj@example.com "Coffee chat" [2026-11-02T10:00:00+05:30]
 *   npm run demo:agent -- dm whatsapp +91-98000-00001 "On my way"   (whatsapp | instagram | x | linkedin)
 *   npm run demo:agent -- alarm 07:00 "Gym"
 * Add --replaces <actionId> to revise an earlier proposal; the review screen then shows what changed.
 *
 * The same pattern works inside a real agent framework: an OpenAI Agents SDK tool with
 * needsApproval, or a LangGraph interrupt(), calls this API and waits for the decision.
 */
const BASE = process.env.AGENTGUARD_URL ?? 'http://localhost:4000';
const KEY = process.env.AGENT_API_KEY;
if (!KEY) { console.error('Set AGENT_API_KEY to the key printed by npm run db:seed'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = argv.indexOf('--replaces');
const replaces = flag >= 0 ? argv.splice(flag, 2)[1] : undefined;
const [kind, a, b, c] = argv;

type Proposal = { tool: string; operation: string; payload: Record<string, unknown> };
const tomorrowAt10 = () => `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00:00+05:30`;
const plus30 = (iso: string) => new Date(Date.parse(iso) + 30 * 60_000).toISOString();

const proposals: Record<string, () => Proposal> = {
  pay: () => ({ tool: 'payments', operation: 'pay', payload: { amount: Number(a), currency: 'INR', payee: b, ...(c ? { note: c } : {}) } }),
  email: () => ({ tool: 'gmail', operation: 'send', payload: { to: [a], subject: c ?? 'A note from your agent', body: b } }),
  post: () => {
    const text = b ?? '';
    if (a === 'instagram') return { tool: 'instagram', operation: 'post', payload: { caption: text, media: ['photo.jpg'] } };
    if (a === 'blog') return { tool: 'blog', operation: 'publish', payload: { title: text.slice(0, 60) || 'Untitled', body: text } };
    return { tool: a, operation: 'post', payload: { text, audience: 'public' } };
  },
  meet: () => { const start = c ?? tomorrowAt10(); return { tool: 'calendar', operation: 'create', payload: { title: b ?? 'Meeting', start, end: plus30(start), attendees: [a] } }; },
  dm: () => {
    const op: Record<string, string> = { whatsapp: 'send_message', instagram: 'dm', x: 'dm', linkedin: 'message' };
    if (!op[a]) throw new Error('dm needs one of: whatsapp, instagram, x, linkedin');
    return { tool: a, operation: op[a], payload: { to: a === 'whatsapp' ? [b] : b, text: c } };
  },
  alarm: () => ({ tool: 'clock', operation: 'set_alarm', payload: { time: a, label: b ?? 'Alarm' } })
};
if (!proposals[kind]) { console.error(`Unknown kind. Use: ${Object.keys(proposals).join(', ')}`); process.exit(1); }

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const FINAL = ['COMPLETED', 'FAILED', 'UNKNOWN', 'REJECTED', 'EXPIRED', 'BLOCKED'];

async function main() {
  const res = await fetch(`${BASE}/api/actions`, { method: 'POST', headers, body: JSON.stringify({ ...proposals[kind](), ...(replaces ? { replaces } : {}) }) });
  const body = await res.json();
  if (!res.ok) { console.log('Refused:', body.error); return; }
  console.log(`Proposed ${body.id} | risk ${body.riskLevel} | ${body.status}${FINAL.includes(body.status) ? '' : '. Waiting for your decision on the dashboard...'}`);

  let last = body.status, result = body.result;
  while (!FINAL.includes(last)) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await (await fetch(`${BASE}/api/actions/${body.id}`, { headers })).json();
    if (s.status !== last) console.log(' →', (last = s.status));
    result = s.result;
  }
  if (result) console.log('Result:', JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.message ?? e); process.exit(1); });
