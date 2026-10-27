import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'Owner#12345';
let n = 0;

/**
 * Signs up through page.request (which shares cookies with the page), creates agent "Helper",
 * connects Payments and Gmail (MOCK) and grants pay + send with limits. Returns the agent key.
 */
export async function readyUser(page: Page, plan?: 'starter' | 'plus' | 'pro') {
  const email = `owner${Date.now()}${n++}${Math.floor(Math.random() * 1e6)}@test.dev`;
  const r = page.request;
  expect((await r.post('/api/auth/signup', { data: { email, password: PASSWORD, ...(plan ? { plan } : {}) } })).status()).toBe(201);
  const csrf = (await (await r.get('/api/auth/csrf')).json()).token as string;
  const headers = { 'X-CSRF-Token': csrf };
  const agent = await (await r.post('/api/agents', { data: { name: 'Helper' }, headers })).json();
  for (const tool of ['payments', 'gmail']) expect((await r.post(`/api/tools/${tool}/connect`, { data: {}, headers })).status()).toBe(200);
  const perms = await r.put(`/api/agents/${agent.id}/permissions`, { headers, data: { permissions: [
    { tool: 'payments', operation: 'pay', allowed: true, limits: { dailyCap: 10000, currency: 'INR', knownPayees: ['Ravi'] } },
    { tool: 'gmail', operation: 'send', allowed: true, limits: { knownRecipients: ['asha@example.com'] } }
  ] } });
  expect(perms.status()).toBe(200);
  return { email, csrf, agentId: agent.id as string, agentKey: agent.apiKey as string };
}

/** The agent's side: a separate request context with only the bearer key, no user cookies. */
export async function propose(request: APIRequestContext, key: string, tool: string, operation: string, payload: Record<string, unknown>) {
  const res = await request.post('/api/actions', { data: { tool, operation, payload }, headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status(), body: await res.json() };
}

export const pay = (amount = 500, payee = 'Ravi') => ({ amount, currency: 'INR', payee, note: 'Lunch split' });
