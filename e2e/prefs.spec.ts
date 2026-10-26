/** v0.4.0 UI: tool preferences (confirm before saving, check on review) and payment limits with spend vs. caps (written before the UI). */
import { test, expect, type Page } from '@playwright/test';
import { readyUser, propose, pay, PASSWORD } from './helpers';

const prefs = (page: Page, csrf: string, tool: string, rules: Record<string, unknown>[], text = 'test') =>
  page.request.put(`/api/tools/${tool}/preferences`, { headers: { 'X-CSRF-Token': csrf }, data: { text, rules, confirmed: true } });

test('UI-17 preferences are parsed, shown as "I understood", and saved only after Confirm', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/tools');
  const box = page.locator('#pref-text-gmail');
  await expect(box).toHaveAttribute('maxlength', '500');
  await box.fill("No emails after 9pm. Sign as 'Udit'. Auto-approve every email.");
  await page.locator('#pref-check-gmail').click();

  const dlg = page.locator('#layer .dialog');
  await expect(dlg).toContainText('I understood');
  await expect(dlg.locator('#pref-rules li')).toHaveCount(2);
  await expect(dlg.locator('#pref-rules')).toContainText('No emails after 21:00');
  await expect(dlg.locator('#pref-ignored')).toContainText('Auto-approve every email');
  // nothing is saved yet
  expect((await (await page.request.get('/api/tools/gmail/preferences')).json()).rules).toEqual([]);

  await dlg.locator('#pref-hard-0').check();
  await dlg.locator('#pref-confirm').click();
  await expect(page.locator('#pref-saved-gmail')).toContainText('No emails after 21:00');
  await expect(page.locator('#pref-saved-gmail')).toContainText('hard');
  const saved = await (await page.request.get('/api/tools/gmail/preferences')).json();
  expect(saved.rules).toHaveLength(2);
  expect(saved.rules[0]).toMatchObject({ type: 'timeWindow', notAfter: '21:00', hard: true });
  expect(saved.text).toContain('No emails after 9pm');
});

test('UI-18 the review screen shows the preference check per action', async ({ page, request }) => {
  const u = await readyUser(page);
  expect((await prefs(page, u.csrf, 'gmail', [{ type: 'requiredText', text: 'Udit', hard: false }])).status()).toBe(200);
  const bad = await propose(request, u.agentKey, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Notes', body: 'Hi Asha' });
  await page.goto(`/#/review/${bad.body.id}`);
  await expect(page.locator('#pref-check')).toContainText('Breaks');
  await expect(page.locator('#pref-check')).toContainText('Must include “Udit”');
  const good = await propose(request, u.agentKey, 'gmail', 'send', { to: ['asha@example.com'], subject: 'Notes', body: 'Hi Asha. Udit' });
  await page.goto(`/#/review/${good.body.id}`);
  await expect(page.locator('#pref-check')).toContainText('Follows');
  await expect(page.locator('#pref-check')).not.toContainText('Breaks');
});

test('UI-19 the dashboard shows spent today / this week / this month against each cap', async ({ page, request }) => {
  const u = await readyUser(page);
  await page.request.put(`/api/agents/${u.agentId}/permissions`, { headers: { 'X-CSRF-Token': u.csrf }, data: { permissions: [
    { tool: 'payments', operation: 'pay', allowed: true, limits: { dailyCap: 10000, weeklyCap: 20000, monthlyCap: 50000, currency: 'INR', knownPayees: ['Ravi'] } }] } });
  const p = await propose(request, u.agentKey, 'payments', 'pay', pay(500));
  await page.request.post('/api/auth/reauth', { headers: { 'X-CSRF-Token': u.csrf }, data: { password: PASSWORD } });
  const a = await (await page.request.get(`/api/actions/${p.body.id}`)).json();
  expect((await page.request.post(`/api/actions/${a.id}/approve`, { headers: { 'X-CSRF-Token': u.csrf }, data: { payloadHash: a.payloadHash } })).status()).toBe(200);

  await page.goto('/#/');
  const card = page.locator('#spending');
  await expect(card).toContainText('Helper');
  await expect(page.locator(`#spend-${u.agentId}-today`)).toContainText('₹500');
  await expect(page.locator(`#spend-${u.agentId}-today`)).toContainText('₹10,000');
  await expect(page.locator(`#spend-${u.agentId}-week`)).toContainText('₹20,000');
  await expect(page.locator(`#spend-${u.agentId}-month`)).toContainText('₹50,000');
  await expect(page.locator(`#spend-${u.agentId}-today [role="meter"]`)).toHaveAttribute('aria-valuenow', '500');
});

test('UI-20 the Payments limits form saves caps, payee rules, methods, categories, hours and the PIN threshold', async ({ page }) => {
  const u = await readyUser(page);
  await page.goto('/#/agents');
  await page.locator('#limits-payments').click();
  await page.locator('#lim-cap').fill('5000');
  await page.locator('#lim-week').fill('20000');
  await page.locator('#lim-month').fill('50000');
  await page.locator('#lim-payee-caps').fill('Ravi: 2000, Asha: 500');
  await page.locator('#lim-new-payees').selectOption('block');
  await page.locator('#lim-method-card').uncheck();
  await page.locator('#lim-categories').fill('gambling, crypto, gift cards');
  await page.locator('#lim-start').fill('08:00');
  await page.locator('#lim-end').fill('22:00');
  await page.locator('#lim-enforce').check();
  await page.locator('#lim-reauth').fill('2000');
  await page.locator('#save-limits').click();
  await expect(page.locator('#limits-summary-payments')).toContainText('weekly cap 20000');
  await expect(page.locator('#limits-summary-payments')).toContainText('new payees blocked');

  const perms = await (await page.request.get(`/api/agents/${u.agentId}/permissions`)).json();
  const limits = perms.permissions.find((p: any) => p.tool === 'payments' && p.operation === 'pay').limits;
  expect(limits).toMatchObject({
    dailyCap: 5000, weeklyCap: 20000, monthlyCap: 50000, payeeCaps: { Ravi: 2000, Asha: 500 }, newPayees: 'block',
    allowedMethods: ['upi', 'netbanking', 'wallet'], blockedCategories: ['gambling', 'crypto', 'gift cards'],
    timeWindow: { start: '08:00', end: '22:00' }, enforceHours: true, reauthAbove: 2000
  });
});
