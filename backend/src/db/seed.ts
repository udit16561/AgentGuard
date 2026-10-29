/**
 * npm run db:seed: a demo account you can try straight away (MOCK mode only, no API keys needed).
 * It goes through the real API, so every step is validated and written to the audit log like normal use.
 * Running it again keeps the data, adds fresh pending alerts and issues a fresh agent key (keys are shown only once).
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { dbPathFromUrl } from '../server-config';

const DEMO = { email: 'demo@agentguard.dev', password: process.env.DEMO_PASSWORD || 'Demo#12345' };

export async function seedDemo({ dbPath }: { dbPath: string }) {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
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
    if (!res.ok && res.status !== 409 && !(res.status === 403 && data?.error?.actionId)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return { status: res.status, data };
  };

  try {
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(DEMO.email);
    // the demo connects all nine tools, so it is on the plan that includes them all
    await call('POST', exists ? '/api/auth/login' : '/api/auth/signup', exists ? DEMO : { ...DEMO, plan: 'pro' });
    csrf = (await call('GET', '/api/auth/csrf')).data.token;
    if (exists) await call('POST', '/api/me/plan', { plan: 'pro' });   // a demo made before v0.7.0 moves to Pro (mock billing)

    let agent = (await call('GET', '/api/agents')).data.agents.find((a: { name: string }) => a.name === 'Helper');
    let apiKey: string;
    if (!agent) {
      const created = (await call('POST', '/api/agents', { name: 'Helper', model: 'demo-agent' })).data;
      agent = created; apiKey = created.apiKey;
    } else {
      apiKey = (await call('POST', `/api/agents/${agent.id}/rotate-key`, {})).data.apiKey;
    }

    // all nine tools in MOCK mode, with limits a careful person would set; destructive operations stay off
    for (const tool of ['gmail', 'calendar', 'clock', 'whatsapp', 'instagram', 'linkedin', 'x', 'blog', 'payments']) await call('POST', `/api/tools/${tool}/connect`, {});
    const contacts = ['asha@example.com', 'raj@example.com', '+91-98000-00001'];
    const messaging = { knownRecipients: contacts, maxRecipients: 5 };
    const posting = { timeWindow: { start: '09:00', end: '21:00' } };   // outside these hours posts are flagged, not blocked
    const money = {
      dailyCap: 2000, weeklyCap: 8000, monthlyCap: 20000, currency: 'INR', knownPayees: ['Ravi'], allowedPayees: ['Ravi', 'Asha', 'NewShop'],
      payeeCaps: { Ravi: 1500 }, allowedMethods: ['upi', 'netbanking', 'card'], blockedCategories: ['gambling', 'crypto', 'gift cards'], reauthAbove: 1000,
      timeWindow: { start: '08:00', end: '22:00' }   // flagged outside these hours, not blocked, so the seed works at any time
    };
    const grant = (tool: string, ops: string[], limits: Record<string, unknown> = {}) => ops.map(operation => ({ tool, operation, allowed: true, limits }));
    await call('PUT', `/api/agents/${agent.id}/permissions`, { permissions: [
      ...grant('gmail', ['read', 'search']), ...grant('gmail', ['send', 'reply', 'forward'], messaging),
      ...grant('calendar', ['view']), ...grant('calendar', ['create', 'update', 'invite', 'cancel'], { knownRecipients: contacts, maxRecipients: 10 }),
      ...grant('clock', ['list_alarms', 'set_alarm', 'set_reminder']),
      ...grant('whatsapp', ['send_message', 'send_media'], messaging),
      ...grant('instagram', ['post', 'story'], posting), ...grant('instagram', ['dm'], messaging),
      ...grant('linkedin', ['post'], posting), ...grant('linkedin', ['message'], messaging),
      ...grant('x', ['post', 'reply'], posting), ...grant('x', ['dm'], { ...messaging, maxRecipients: 1 }),
      ...grant('blog', ['publish', 'edit_live'], posting),
      ...grant('payments', ['view_balance', 'view_history']), ...grant('payments', ['pay', 'refund'], money), ...grant('payments', ['subscribe'], { dailyCap: 2000, currency: 'INR' })
    ] });

    // preferences in plain language, parsed and then confirmed (the app asks the user to confirm the same way)
    const preferences: Record<string, string> = {
      gmail: "Sign as 'Udit'. No emails after 9pm. Never send attachments to new recipients.",
      calendar: 'No meetings before 10am or on Sundays. Max 45 minutes.',
      x: 'Professional tone only. No posts about politics.',
      linkedin: 'Professional tone only. No posts about politics.'
    };
    for (const [tool, text] of Object.entries(preferences)) {
      const parsed = (await call('POST', `/api/tools/${tool}/preferences/parse`, { text })).data;
      await call('PUT', `/api/tools/${tool}/preferences`, { text, rules: parsed.rules, confirmed: true });
    }

    // the built-in offline Assistant (no key, no network): it proposes through the same gates as any agent
    const models = (await call('GET', '/api/models')).data;
    if (models.roles.agent.model?.provider !== 'offline') {
      await call('POST', '/api/auth/reauth', { password: DEMO.password });
      const offline = (await call('POST', '/api/models', { provider: 'offline', modelId: 'agentguard-offline', label: 'Offline assistant' })).data;
      await call('POST', `/api/models/${offline.id}/test`, {});
      await call('PUT', '/api/models/roles', { agent: offline.id, guard: models.roles.guard.model?.id ?? null });
    }
    const assistant = (await call('GET', '/api/agents')).data.agents.find((a: { kind: string }) => a.kind === 'assistant');
    await call('PUT', `/api/agents/${assistant.id}/permissions`, { permissions: [
      ...grant('gmail', ['send'], messaging), ...grant('calendar', ['create'], { knownRecipients: contacts, maxRecipients: 10 }),
      ...grant('clock', ['set_alarm', 'set_reminder']), ...grant('whatsapp', ['send_message'], messaging),
      ...grant('x', ['post'], posting), ...grant('linkedin', ['post'], posting), ...grant('payments', ['pay'], money)
    ] });

    // alerts waiting on the dashboard, one per kind of preview (they expire 10 minutes after seeding, like any proposal)
    const asAgent = { Authorization: `Bearer ${apiKey}`, Cookie: '', 'X-CSRF-Token': '' };
    const saved = cookie; cookie = '';
    const propose = async (tool: string, operation: string, payload: Record<string, unknown>, replaces?: string) =>
      (await call('POST', '/api/actions', { tool, operation, payload, ...(replaces ? { replaces } : {}) }, asAgent)).data;
    const lunch = await propose('payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi', method: 'upi', note: 'Lunch split' });
    await propose('payments', 'pay', { amount: 650, currency: 'INR', payee: 'Ravi', method: 'upi', note: 'Lunch split + coffee' }, lunch.id);   // shows "what changed"
    await propose('payments', 'pay', { amount: 1500, currency: 'INR', payee: 'NewShop', method: 'card', note: 'Order #4471' });
    await propose('gmail', 'send', { to: ['asha@example.com'], subject: 'Notes from today', body: 'Hi Asha,\n\nSharing the notes from today’s call. Let me know if I missed anything.\n\nThanks' });
    const tomorrow = new Date(Date.now() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);   // tomorrow in IST
    await propose('calendar', 'create', { title: 'Project sync', start: `${tomorrow}T10:00:00+05:30`, end: `${tomorrow}T10:30:00+05:30`, attendees: ['asha@example.com', 'raj@example.com'] });
    await propose('x', 'post', { text: 'Shipping our new release today! Thanks to everyone who tested it.', audience: 'public' });
    await propose('linkedin', 'post', { text: 'Big week: vote for our party in the election, the minister got it wrong.', audience: 'public' });   // breaks a preference
    // some history for the audit timeline: approved and run, rejected, and blocked by a limit
    const alarm = await propose('clock', 'set_alarm', { time: '07:00', label: 'Gym' });
    const note = await propose('whatsapp', 'send_message', { to: ['+91-98000-00001'], text: 'On my way, 10 minutes.' });
    const gift = await propose('payments', 'pay', { amount: 300, currency: 'INR', payee: 'Asha', method: 'upi', note: 'Birthday gift' });
    await propose('payments', 'pay', { amount: 5000, currency: 'INR', payee: 'LuckyBet', method: 'card', note: 'Top-up' });   // not an allowed payee: BLOCKED
    cookie = saved;
    const decide = async (a: { id: string; status: string }, how: 'approve' | 'reject') => {
      if (a.status !== 'PENDING_REVIEW' && a.status !== 'NEEDS_REVIEW') return;
      const hash = (await call('GET', `/api/actions/${a.id}`)).data.payloadHash;
      await call('POST', '/api/auth/reauth', { password: DEMO.password });
      await call('POST', `/api/actions/${a.id}/${how}`, how === 'approve' ? { payloadHash: hash } : { reason: 'Not this one' });
    };
    await decide(alarm, 'approve');
    await decide(note, 'approve');
    await decide(gift, 'reject');

    const { n: pending } = db.prepare("SELECT COUNT(*) AS n FROM actions a JOIN users u ON u.id = a.user_id WHERE u.email = ? AND a.status = 'PENDING_REVIEW' AND a.expires_at > ?").get(DEMO.email, Date.now()) as { n: number };
    return { dbPath, apiKey, email: DEMO.email, password: DEMO.password, pending };
  } finally {
    server.close();
    db.close();
  }
}

async function main() {
  const { dbPath, apiKey, email, password, pending } = await seedDemo({ dbPath: dbPathFromUrl(process.env.DATABASE_URL) });
  // the password is only printed in development (the default when NODE_ENV is unset); set DEMO_PASSWORD to choose your own
  const showPassword = (process.env.NODE_ENV ?? 'development') === 'development';
  console.log(`
AgentGuard demo is ready (MOCK mode, database: ${dbPath})
  Sign in:        ${email} / ${showPassword ? password : '(hidden: NODE_ENV is not development)'}
  Plan:           Pro (mock billing)
  Agent:          Helper, with all 9 tools connected in MOCK mode and limits set (see Agents in the app)
  Assistant:      the built-in offline assistant (no key): open Assistant and type "pay Ravi 500"
  Preferences:    Gmail, Calendar, X and LinkedIn have confirmed preferences (see Tools)
  Alerts:         ${pending} waiting for review (they expire after 10 minutes; run db:seed again for fresh ones)
  Agent API key:  ${apiKey}   <- shown once; run db:seed again for a new one
  Try the agent:  set AGENT_API_KEY to the key above, then for example:
                  npm run demo:agent -- pay 500 Ravi
                  npm run demo:agent -- email asha@example.com "Running 10 minutes late"
                  npm run demo:agent -- meet raj@example.com "Coffee chat"
                  npm run demo:agent -- post x "Hello from my agent"
                  npm run demo:agent -- dm whatsapp +91-98000-00001 "On my way"
                  npm run demo:agent -- alarm 07:00 "Gym"
                  npm run demo:agent -- prefs            (the rules the agent should follow)
`);
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });
