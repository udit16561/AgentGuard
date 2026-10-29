/** v0.9.0: the whole journey on MOCK, through the UI, with no API keys (written before the gaps were filled). */
import { test, expect } from '@playwright/test';
import { propose, readyUser, PASSWORD } from './helpers';

const TOOLS = ['gmail', 'calendar', 'clock', 'whatsapp', 'instagram', 'linkedin', 'x', 'blog', 'payments'];

test('UI-37 full journey: sign up → agent → 9 tools → permissions, limits, preferences → alert → review → approve → audit → kill switch → plans', async ({ page, request }) => {
  test.setTimeout(90_000);
  // sign up
  await page.goto('/');
  await page.locator('#tab-signup').click();
  await page.locator('#email').fill(`journey${Date.now()}${Math.random().toString(36).slice(2, 7)}@test.dev`);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await expect(page.locator('h1#title')).toHaveText('Dashboard');

  // create an agent: its key is shown once
  await page.goto('/#/agents');
  await page.locator('#new-agent').fill('Helper');
  await page.locator('#create-agent').click();
  const key = (await page.locator('#api-key').textContent())!.trim();
  expect(key).toMatch(/^ag_/);

  // tools: Plus connects six; the rest say "Upgrade to unlock" and Plans moves to Pro (mock billing)
  await page.goto('/#/tools');
  for (const t of ['gmail', 'calendar', 'clock', 'whatsapp', 'linkedin', 'payments']) {
    await page.locator(`#tool-${t}`).click();
    await expect(page.locator(`#tool-${t}`)).toHaveText('Disconnect');
  }
  await expect(page.locator('article', { hasText: 'Instagram' }).locator('.lock')).toContainText('Upgrade to unlock');
  await page.goto('/#/plans');
  await page.locator('#plan-pick-pro').click();
  await page.locator('#plan-confirm').click();
  await expect(page.locator('#plan-current-pro')).toHaveText('Current plan');
  await page.goto('/#/tools');
  for (const t of ['instagram', 'x', 'blog']) {
    await page.locator(`#tool-${t}`).click();
    await expect(page.locator(`#tool-${t}`)).toHaveText('Disconnect');
  }
  for (const t of TOOLS) await expect(page.locator(`#live-badge-${t}`)).toHaveCount(0);   // every tool MOCK

  // preferences: parsed, confirmed, saved
  await page.locator('#pref-text-payments').fill('Never pay more than ₹2,000.');
  await page.locator('#pref-check-payments').click();
  await page.locator('#layer .dialog #pref-confirm').click();
  await expect(page.locator('#pref-saved-payments')).toContainText('2000');

  // permissions and limits
  await page.goto('/#/agents');
  await page.locator('#agent-list a', { hasText: 'Permissions' }).first().click();
  const sw = page.locator('#perm-payments-pay');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');

  // the agent proposes; the alert appears; the review shows the preview and the risk
  const { status, body } = await propose(request, key, 'payments', 'pay', { amount: 1500, currency: 'INR', payee: 'Ravi', method: 'upi', note: 'Rent share' });
  expect(status).toBe(201);
  await page.goto('/#/dashboard');
  await expect(page.locator('#pending-count')).toHaveText('1', { timeout: 5000 });
  await page.goto(`/#/review/${body.id}`);
  await expect(page.locator('#detail [data-risk]').first()).toBeVisible();
  await expect(page.locator('#detail')).toContainText('Ravi');
  await expect(page.locator('#detail')).toContainText('MOCK');

  // approve: high risk asks for the password; mock execution completes
  await page.locator('#btn-approve').click();
  await page.locator('#reauth-box, #dlg-approve').first().waitFor();
  if (await page.locator('#reauth-box').isVisible()) {
    await page.locator('#reauth-password').fill(PASSWORD);
  }
  await page.locator('#dlg-approve').click();
  await expect(page.locator('#detail [data-status="COMPLETED"]').first()).toBeVisible();

  // audit timeline, verified
  await page.goto('/#/audit');
  await expect(page.locator('#timeline [data-event="ACTION_EXECUTED"], #timeline [data-event="ACTION_COMPLETED"]').first()).toBeVisible();
  await page.locator('#verify').click();
  await expect(page.locator('#verify-result')).toContainText('Chain intact');

  // kill switch: everything stops, then resumes
  await page.goto('/#/dashboard');
  await page.locator('#kill-switch').click();
  await expect(page.locator('#paused-bar')).toContainText('PAUSED');
  expect((await propose(request, key, 'payments', 'pay', { amount: 100, currency: 'INR', payee: 'Ravi', method: 'upi' })).status).toBe(423);
  await page.locator('#bar-resume').click();
  await expect(page.locator('#paused-bar')).toHaveCount(0);

  // plans: Pro is current
  await page.goto('/#/settings');
  await page.locator('#open-plans').click();
  await expect(page.locator('#plan-current-pro')).toHaveText('Current plan');
});

test('UI-38 with no AI key, one click turns on the offline Assistant; what it proposes waits in Review', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/assistant');
  await expect(page.locator('#chat-off')).toContainText('No Assistant model yet');
  await page.locator('#chat-offline').click();
  await page.locator('#models-password, #chat-h').first().waitFor();
  if (await page.locator('#models-password').isVisible()) {
    await page.locator('#models-password').fill(PASSWORD);
    await page.locator('#models-password-ok').click();
  }
  await expect(page.locator('#chat-h')).toContainText('Offline assistant');
  await expect(page.locator('#chat-log')).toContainText('offline assistant');

  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).token;
  const assistant = ((await (await page.request.get('/api/agents')).json()).agents as { id: string; kind: string }[]).find(a => a.kind === 'assistant')!;
  expect((await page.request.put(`/api/agents/${assistant.id}/permissions`, { headers: { 'X-CSRF-Token': csrf }, data: { permissions: [
    { tool: 'payments', operation: 'pay', allowed: true, limits: { dailyCap: 10000, currency: 'INR', knownPayees: ['Ravi'] } }] } })).status()).toBe(200);

  await page.locator('#chat-input').fill('pay Ravi 500');
  await page.locator('#chat-send').click();
  await expect(page.locator('.proposal')).toContainText('Nothing happens until you approve it');
  await expect(page.locator('#chat-log')).toContainText('waiting for your approval');
  await page.locator('.proposal a.link').click();
  await expect(page.locator('#detail')).toContainText('Ravi');
});
