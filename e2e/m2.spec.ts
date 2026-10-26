/** M2 UI: per-tool limits, auto-allow, tool previews and "what changed" (written before the UI). */
import { test, expect, type Page } from '@playwright/test';
import { readyUser, propose, pay, PASSWORD } from './helpers';

async function enable(page: Page, csrf: string, agentId: string, tool: string, ops: string[], limits: Record<string, unknown> = {}) {
  await page.request.post(`/api/tools/${tool}/connect`, { data: {}, headers: { 'X-CSRF-Token': csrf } });
  const res = await page.request.put(`/api/agents/${agentId}/permissions`, { headers: { 'X-CSRF-Token': csrf }, data: { permissions: ops.map(operation => ({ tool, operation, allowed: true, limits })) } });
  expect(res.status()).toBe(200);
}

test('UI-13 each tool has its own limits form: payments, messaging and posting', async ({ page }) => {
  const u = await readyUser(page, 'pro');   // X is in the Pro catalog (v0.7.0)
  await enable(page, u.csrf, u.agentId, 'x', ['post', 'reply']);
  await page.goto('/#/agents');

  await page.locator('#limits-payments').click();
  await page.locator('#lim-cap').fill('3000');
  await page.locator('#lim-payees').fill('Ravi, Asha');
  await page.locator('#save-limits').click();
  await expect(page.locator('#limits-summary-payments')).toContainText('daily cap 3000');
  await expect(page.locator('#limits-summary-payments')).toContainText('only pay: Ravi, Asha');

  await page.locator('#limits-gmail').click();
  await expect(page.locator('#lim-allowed')).toBeVisible();
  await page.locator('#lim-bulk').fill('3');
  await page.locator('#save-limits').click();
  await expect(page.locator('#limits-summary-gmail')).toContainText('at most 3 recipients');

  await page.locator('#limits-x').click();
  await page.locator('#lim-start').fill('09:00');
  await page.locator('#lim-end').fill('18:00');
  await page.locator('#lim-enforce').check();
  await page.locator('#save-limits').click();
  await expect(page.locator('#limits-summary-x')).toContainText('only 09:00–18:00');

  const perms = await (await page.request.get(`/api/agents/${u.agentId}/permissions`)).json();
  const pick = (t: string, o: string) => perms.permissions.find((p: any) => p.tool === t && p.operation === o);
  expect(pick('payments', 'pay').limits).toMatchObject({ dailyCap: 3000, allowedPayees: ['Ravi', 'Asha'] });
  expect(pick('x', 'reply').limits).toMatchObject({ timeWindow: { start: '09:00', end: '18:00' }, enforceHours: true });   // the whole tool
});

test('UI-14 auto-allow is off by default, only offered for reads and alarms, and still audited', async ({ page, request }) => {
  const u = await readyUser(page);
  await enable(page, u.csrf, u.agentId, 'gmail', ['read']);
  await page.goto('/#/agents');
  const auto = page.locator('#auto-gmail-read');
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#auto-gmail-send')).toHaveCount(0);            // never for sending
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  const res = await propose(request, u.agentKey, 'gmail', 'read', { query: 'is:unread' });
  expect(res.body.status).toBe('COMPLETED');
  await page.goto('/#/audit');
  await expect(page.locator('#timeline [data-event="ACTION_AUTO_APPROVED"]')).toBeVisible();
});

test('UI-15 the review screen previews each tool: email, post, meeting and payment receipt', async ({ page, request }) => {
  const u = await readyUser(page, 'pro');   // X is in the Pro catalog (v0.7.0)
  await enable(page, u.csrf, u.agentId, 'x', ['post']);
  await enable(page, u.csrf, u.agentId, 'calendar', ['create'], { knownRecipients: ['asha@example.com'] });

  const email = await propose(request, u.agentKey, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Notes', body: 'Hi Asha' });
  await page.goto(`/#/review/${email.body.id}`);
  await expect(page.locator('#preview .email')).toContainText('asha@example.com');
  await expect(page.locator('#preview .email')).toContainText('Notes');

  const post = await propose(request, u.agentKey, 'x', 'post', { text: 'Launching today!', audience: 'public' });
  await page.goto(`/#/review/${post.body.id}`);
  await expect(page.locator('#preview .post-card')).toContainText('Launching today!');
  await expect(page.locator('#preview .post-card')).toContainText('Public');

  const meet = await propose(request, u.agentKey, 'calendar', 'create', { title: 'Sync', start: '2026-11-02T10:00:00+05:30', end: '2026-11-02T10:30:00+05:30', attendees: ['asha@example.com', 'raj@example.com'] });
  await page.goto(`/#/review/${meet.body.id}`);
  await expect(page.locator('#preview .meeting')).toContainText('Sync');
  await expect(page.locator('#preview .meeting .attendee')).toHaveCount(2);
  await expect(page.locator('#detail')).not.toContainText(/\bnull\b/);   // regression: empty cards must not print "null"

  const p = await propose(request, u.agentKey, 'payments', 'pay', pay(500));
  await page.goto(`/#/review/${p.body.id}`);
  await expect(page.locator('#preview .receipt')).toContainText('₹500.00');
  await expect(page.locator('#preview .receipt')).toContainText('Not paid yet');
  await page.locator('#btn-approve').click();
  await page.locator('#reauth-password').fill(PASSWORD);
  await page.locator('#dlg-approve').click();
  await expect(page.locator('#preview .receipt')).toContainText(/RCPT-\d{8}/);
});

test('UI-16 a re-proposal shows what changed', async ({ page, request }) => {
  const u = await readyUser(page);
  const first = await propose(request, u.agentKey, 'payments', 'pay', pay(500));
  const res = await request.post('/api/actions', { headers: { Authorization: `Bearer ${u.agentKey}` }, data: { tool: 'payments', operation: 'pay', payload: { ...pay(900), note: 'Lunch + dessert' }, replaces: first.body.id } });
  const second = await res.json();
  await page.goto(`/#/review/${second.id}`);
  const diff = page.locator('#changes');
  await expect(diff).toContainText('What changed');
  await expect(diff.locator('[data-field="amount"] del')).toHaveText('500');
  await expect(diff.locator('[data-field="amount"] ins')).toHaveText('900');
  await expect(diff.locator('[data-field="note"]')).toContainText('Lunch + dessert');
});
