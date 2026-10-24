/**
 * Demo agent: plays the "AI agent" side so you can test AgentGuard by hand.
 * It proposes an action, then polls until the user approves or rejects it on the dashboard.
 *
 * Usage (from backend/):
 *   AGENT_API_KEY=ag_xxx npm run demo:agent -- pay 500 Ravi
 *   AGENT_API_KEY=ag_xxx npm run demo:agent -- email asha@example.com "Hello"
 *   AGENT_API_KEY=ag_xxx npm run demo:agent -- post x "Launching today!"
 * Add to backend/package.json scripts:  "demo:agent": "tsx ../examples/demo-agent.ts"
 *
 * The same pattern works inside a real agent framework: an OpenAI Agents SDK tool with
 * needsApproval, or a LangGraph interrupt(), calls this API and waits for the decision.
 */
const BASE = process.env.AGENTGUARD_URL ?? 'http://localhost:4000';
const KEY = process.env.AGENT_API_KEY;
if (!KEY) { console.error('Set AGENT_API_KEY'); process.exit(1); }

const [kind, a, b] = process.argv.slice(2);
const proposals: Record<string, () => { tool: string; operation: string; payload: unknown }> = {
  pay: () => ({ tool: 'payments', operation: 'pay', payload: { amount: Number(a), currency: 'INR', payee: b } }),
  email: () => ({ tool: 'gmail', operation: 'send', payload: { to: [a], subject: 'From agent', body: b } }),
  post: () => ({ tool: a, operation: 'post', payload: { text: b, audience: 'public' } }),
  meet: () => ({ tool: 'calendar', operation: 'create', payload: { title: b ?? 'Meeting', attendees: [a] } }),
};
if (!proposals[kind]) { console.error(`Unknown kind. Use: ${Object.keys(proposals).join(', ')}`); process.exit(1); }

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const FINAL = ['COMPLETED', 'FAILED', 'UNKNOWN', 'REJECTED', 'EXPIRED', 'BLOCKED'];

async function main() {
  const res = await fetch(`${BASE}/api/actions`, { method: 'POST', headers, body: JSON.stringify(proposals[kind]()) });
  const body = await res.json();
  if (!res.ok) { console.log('Refused:', body.error); return; }
  console.log(`Proposed ${body.id} | risk ${body.riskLevel} | ${body.status}. Waiting for your decision on the dashboard...`);

  let last = body.status;
  while (!FINAL.includes(last)) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await (await fetch(`${BASE}/api/actions/${body.id}`, { headers })).json();
    if (s.status !== last) console.log(' →', (last = s.status));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
