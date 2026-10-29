/** v1.0.0 polish: empty, error and loading states, one date format, and a quiet console. */
import { test, expect, type Page } from '@playwright/test';
import { propose, readyUser, PASSWORD } from './helpers';

const SCREENS = ['dashboard', 'review', 'assistant', 'tools', 'agents', 'audit', 'settings', 'settings/models', 'plans'];

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

test('UI-39 the login page and every screen of a new account load with no console errors, no "null", and a friendly empty message', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/');
  await expect(page.locator('#auth-submit')).toBeVisible();
  await page.locator('#tab-signup').click();
  await page.locator('#email').fill(`polish${Date.now()}${Math.random().toString(36).slice(2, 7)}@test.dev`);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#nav-dashboard')).toBeVisible();
  for (const s of SCREENS) {
    await page.goto(`/#/${s}`);
    await expect(page.locator('#loading')).toHaveCount(0);
    const text = await page.locator('#view').innerText();
    expect(text, s).not.toMatch(/\bnull\b|\bundefined\b|NaN|\[object Object\]/);
    expect(text.trim().length, s).toBeGreaterThan(30);
  }
  await page.goto('/#/review');
  await expect(page.locator('#queue .empty')).toBeVisible();
  await page.goto('/#/agents');
  await expect(page.locator('#agent-list .empty')).toContainText('No agents yet');
  await page.goto('/#/settings/models');
  await expect(page.locator('#view')).toContainText('No models yet');
  expect(errors).toEqual([]);
});

test('UI-40 a blocked action says why in plain words, an unknown link says not found, and meeting times use the app date format', async ({ page, request }) => {
  const errors = watchConsole(page);
  const u = await readyUser(page);
  const blocked = await propose(request, u.agentKey, 'payments', 'pay', { amount: 50000, currency: 'INR', payee: 'Ravi', method: 'upi' });
  expect(blocked.status).toBe(403);
  await page.goto(`/#/review/${blocked.body.error.actionId}`);
  await expect(page.locator('#block-note')).toContainText('over your daily cap');
  await expect(page.locator('#block-note')).not.toContainText('LIMIT_EXCEEDED');
  await page.goto('/#/review/act_doesnotexist');
  await expect(page.locator('#not-found')).toContainText('Action not found');

  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).token;
  await page.request.post('/api/tools/calendar/connect', { headers: { 'X-CSRF-Token': csrf }, data: {} });
  await page.request.put(`/api/agents/${u.agentId}/permissions`, { headers: { 'X-CSRF-Token': csrf }, data: { permissions: [{ tool: 'calendar', operation: 'create', allowed: true, limits: {} }] } });
  const meet = await propose(request, u.agentKey, 'calendar', 'create', { title: 'Sync', start: '2026-11-02T10:00:00+05:30', end: '2026-11-02T10:30:00+05:30', attendees: ['asha@example.com'] });
  await page.goto(`/#/review/${meet.body.id}`);
  const details = page.locator('#detail .fields');
  await expect(details).toContainText('Mon, 2 Nov, 10:00 IST');
  await expect(details).not.toContainText('2026-11-02T10:00');
  expect(errors).toEqual([]);
});
