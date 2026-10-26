/** v0.7.0 UI: the Plans screen, mock upgrade/downgrade, and locked features labelled "Upgrade to unlock". */
import { test, expect, type Page } from '@playwright/test';
import { readyUser, PASSWORD } from './helpers';

/** A Starter account with Gmail connected (Starter's catalog has no Payments, so readyUser cannot be used). */
async function starterUser(page: Page) {
  const email = `starter${Date.now()}${Math.floor(Math.random() * 1e6)}@test.dev`;
  expect((await page.request.post('/api/auth/signup', { data: { email, password: PASSWORD, plan: 'starter' } })).status()).toBe(201);
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).token as string;
  await page.request.post('/api/agents', { data: { name: 'Helper' }, headers: { 'X-CSRF-Token': csrf } });
  await page.request.post('/api/tools/gmail/connect', { data: {}, headers: { 'X-CSRF-Token': csrf } });
  return { csrf };
}

test('UI-31 the Plans screen compares the plans, marks the current one, and a downgrade shows what will pause before it happens', async ({ page }) => {
  await readyUser(page);   // Plus, with Payments and Gmail connected
  await page.goto('/#/settings');
  await page.locator('#open-plans').click();
  await expect(page.locator('#title')).toHaveText('Plans');
  for (const id of ['starter', 'plus', 'pro']) await expect(page.locator(`#plan-${id}`)).toBeVisible();
  await expect(page.locator('#plan-current-plus')).toHaveText('Current plan');
  await expect(page.locator('.always')).toContainText('kill switch');

  await page.locator('#plan-pick-starter').click();
  await expect(page.locator('#plan-will-pause')).toContainText('Payments is paused');
  await expect(page.locator('#plan-will-pause')).toContainText('Nothing is deleted');
  await page.locator('#plan-confirm').click();
  await expect(page.locator('#plan-current-starter')).toHaveText('Current plan');
  await expect(page.locator('#plan-paused')).toContainText('Payments');

  await page.goto('/#/tools');
  await expect(page.locator('#paused-payments')).toHaveText('Paused by plan');
  await expect(page.locator('article', { hasText: 'Instagram' }).locator('.lock')).toContainText('Upgrade to unlock');

  await page.goto('/#/plans');
  await page.locator('#plan-pick-pro').click();
  await page.locator('#plan-confirm').click();
  await expect(page.locator('#plan-current-pro')).toHaveText('Current plan');
  await page.goto('/#/tools');
  await expect(page.locator('#tool-payments')).toHaveText('Disconnect');   // back on, settings kept
});

test('UI-32 audit export: CSV downloads on Plus; JSON and the integrity report say "Upgrade to unlock"', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/audit');
  await expect(page.locator('#audit-retention')).toContainText('180 days');
  await expect(page.locator('#export-json')).toContainText('Upgrade to unlock');
  await expect(page.locator('#export-integrity')).toContainText('Upgrade to unlock');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-csv').click()]);
  expect(download.suggestedFilename()).toMatch(/^agentguard-audit-.*\.csv$/);
});

test('UI-33 Starter: locked features are labelled, while approvals, the kill switch and the audit log still work', async ({ page }) => {
  await starterUser(page);
  await page.goto('/#/agents');
  await expect(page.locator('#agent-limit')).toContainText('Upgrade to unlock more agents');
  await page.goto('/#/tools');
  await expect(page.locator('article', { hasText: 'Payments' }).locator('.lock')).toContainText('Upgrade to unlock');
  await page.goto('/#/settings/models');
  await expect(page.locator('#role-lock-agent')).toContainText('Upgrade to unlock');
  await page.goto('/#/audit');
  await expect(page.locator('#export-csv')).toContainText('Upgrade to unlock');
  await page.locator('#verify').click();
  await expect(page.locator('#verify-result')).toContainText('Chain intact');
  await page.goto('/#/dashboard');
  await page.locator('#kill-switch').click();
  await expect(page.locator('#paused-bar')).toBeVisible();
  await page.locator('#bar-resume').click();
  await expect(page.locator('#paused-bar')).toHaveCount(0);
});
