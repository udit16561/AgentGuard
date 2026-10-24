/**
 * npm run db:seed: a demo account you can try straight away (MOCK mode only).
 * It goes through the real API, so every step is validated and written to the audit log like normal use.
 * Running it again keeps the data and issues a fresh agent key (keys are shown only once).
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { dbPathFromUrl } from '../server-config';

const DEMO = { email: 'demo@agentguard.dev', password: 'Demo#12345' };

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const dbPath = dbPathFromUrl(process.env.DATABASE_URL);
  const { app, db } = await createApp({ dbPath, serveFrontend: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '', csrf = '';

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers }
    });
    const set = res.headers.getSetCookie().find(c => c.startsWith('ag_session='));
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return { status: res.status, data };
  };

  try {
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(DEMO.email);
    await call('POST', exists ? '/api/auth/login' : '/api/auth/signup', DEMO);
    csrf = (await call('GET', '/api/auth/csrf')).data.token;

    let agent = (await call('GET', '/api/agents')).data.agents.find((a: { name: string }) => a.name === 'Helper');
    let apiKey: string;
    if (!agent) {
      const created = (await call('POST', '/api/agents', { name: 'Helper', model: 'demo-agent' })).data;
      agent = created; apiKey = created.apiKey;
    } else {
      apiKey = (await call('POST', `/api/agents/${agent.id}/rotate-key`, {})).data.apiKey;
    }

    await call('POST', '/api/tools/payments/connect', {});
    await call('PUT', `/api/agents/${agent.id}/permissions`, {
      permissions: [{ tool: 'payments', operation: 'pay', allowed: true, limits: { dailyCap: 2000, currency: 'INR', knownPayees: ['Ravi'] } }]
    });

    // two alerts waiting on the dashboard (they expire 10 minutes after seeding, like any proposal)
    const asAgent = { Authorization: `Bearer ${apiKey}`, Cookie: '', 'X-CSRF-Token': '' };
    const saved = cookie; cookie = '';
    await call('POST', '/api/actions', { tool: 'payments', operation: 'pay', payload: { amount: 500, currency: 'INR', payee: 'Ravi', note: 'Lunch split' } }, asAgent);
    await call('POST', '/api/actions', { tool: 'payments', operation: 'pay', payload: { amount: 1500, currency: 'INR', payee: 'NewShop', note: 'Order #4471' } }, asAgent);
    cookie = saved;

    console.log(`
AgentGuard demo is ready (MOCK mode, database: ${dbPath})
  Sign in:        ${DEMO.email} / ${DEMO.password}
  Agent:          Helper (payments.pay allowed, daily cap INR 2,000, known payee Ravi)
  Agent API key:  ${apiKey}   <- shown once; run db:seed again for a new one
  Try the agent:  set AGENT_API_KEY to the key above, then: npm run demo:agent -- pay 500 Ravi
`);
  } finally {
    server.close();
    db.close();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
