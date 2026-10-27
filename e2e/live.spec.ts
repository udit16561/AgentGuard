/**
 * v0.8.0 UI: switching Calendar to LIVE (confirm dialog plus password), the red LIVE badge on the tool card and the
 * review screen, and the "Reconnect Google" banner. The server runs a pretend Google (GOOGLE_OAUTH_MODE=fake, test
 * builds only): consent returns at once, and its access tokens expire at once with refreshes refused, as after the
 * 7-day Testing-mode expiry. No test reaches Google.
 */
import { test, expect, type Page } from '@playwright/test';
import { readyUser, propose, PASSWORD } from './helpers';

const EVENT = { title: 'Project sync', start: '2026-11-02T10:00:00+05:30', end: '2026-11-02T10:30:00+05:30' };

async function calendarReady(page: Page) {
  const u = await readyUser(page);
  const headers = { 'X-CSRF-Token': u.csrf };
  expect((await page.request.post('/api/tools/calendar/connect', { data: {}, headers })).status()).toBe(200);
  expect((await page.request.put(`/api/agents/${u.agentId}/permissions`, { headers, data: { permissions: [{ tool: 'calendar', operation: 'create', allowed: true }] } })).status()).toBe(200);
  return u;
}

async function goLive(page: Page, trigger: string) {
  await page.locator(trigger).click();
  await expect(page.locator('#live-confirm-text')).toContainText('real Google Calendar');
  await expect(page.locator('#live-confirm-text')).toContainText('No invitations');
  await page.locator('#live-continue').click();
  await expect(page.locator('.dialog .err')).toContainText('password');   // a separate password check, every time
  await page.locator('#live-password').fill(PASSWORD);
  await page.locator('#live-continue').click();
  // the browser leaves for the consent step and comes back: wait for the return, not just the current URL
  await expect(page.locator('#toasts')).toContainText('Calendar is LIVE');
  await expect(page).toHaveURL(/#\/tools$/);
}

test('UI-34 Calendar goes LIVE only after a confirm dialog and the password; the card shows a red LIVE badge, and it can go back to MOCK', async ({ page }) => {
  await calendarReady(page);
  await page.goto('/#/tools');
  await expect(page.locator('#live-gmail')).toHaveCount(0);   // only Calendar has a live mode
  await page.locator('#live-calendar').click();
  await page.locator('#live-cancel').click();
  await expect(page.locator('#live-badge-calendar')).toHaveCount(0);

  await goLive(page, '#live-calendar');
  await expect(page.locator('#live-badge-calendar')).toHaveText('LIVE');
  await expect(page.locator('#live-badge-calendar')).toHaveClass(/live-badge/);
  await expect(page.locator('#mode-foot')).toContainText('LIVE: Calendar');

  await page.locator('#mock-calendar').click();
  await page.locator('#confirm-mock').click();
  await expect(page.locator('#live-badge-calendar')).toHaveCount(0);
  await expect(page.locator('#live-calendar')).toBeVisible();
});

test('UI-35 the review screen of a live action shows the red LIVE badge and whether Google will email anyone', async ({ page }) => {
  const u = await calendarReady(page);
  await page.goto('/#/tools');
  await goLive(page, '#live-calendar');
  const quiet = await propose(page.request, u.agentKey, 'calendar', 'create', EVENT);
  expect(quiet.status).toBe(201);
  await page.goto(`/#/review/${quiet.body.id}`);
  await expect(page.locator('#live-badge')).toHaveText('LIVE');
  await expect(page.locator('#live-note')).toContainText('real Google Calendar');
  await expect(page.locator('#live-note')).toContainText('No invitations will be sent');

  const loud = await propose(page.request, u.agentKey, 'calendar', 'create', { ...EVENT, attendees: ['asha@example.com'], sendInvites: true });
  await page.goto(`/#/review/${loud.body.id}`);
  await expect(page.locator('#live-note')).toContainText('Google will email an invitation to 1 person');

  // a MOCK action keeps the MOCK badge
  const mock = await propose(page.request, u.agentKey, 'payments', 'pay', { amount: 100, currency: 'INR', payee: 'Ravi' });
  await page.goto(`/#/review/${mock.body.id}`);
  await expect(page.locator('#live-badge')).toHaveCount(0);
});

test('UI-36 when Google refuses the sign-in refresh, the action fails with nothing sent and "Reconnect Google" shows on every screen until reconnected', async ({ page }) => {
  const u = await calendarReady(page);
  await page.goto('/#/tools');
  await goLive(page, '#live-calendar');
  const a = await propose(page.request, u.agentKey, 'calendar', 'create', EVENT);
  await page.goto(`/#/review/${a.body.id}`);
  await page.locator('#btn-approve').click();
  if (await page.locator('#reauth-password').count()) await page.locator('#reauth-password').fill(PASSWORD);
  await page.locator('#dlg-approve').click();
  await expect(page.getByRole('region', { name: 'Result from the provider' })).toContainText('Reconnect Google');
  await expect(page.locator('#reconnect-bar')).toBeVisible();
  await page.goto('/#/dashboard');
  await expect(page.locator('#reconnect-bar')).toContainText('Google Calendar');

  await goLive(page, '#bar-reconnect');
  await expect(page.locator('#reconnect-bar')).toHaveCount(0);
  await expect(page.locator('#live-badge-calendar')).toHaveText('LIVE');
});
