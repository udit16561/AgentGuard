/** End-to-end UI cases (docs/TEST_CASES.md §5), run on "Desktop Chrome" and "Mobile Chrome". */
import { test, expect } from '@playwright/test';
import { readyUser, propose, pay, PASSWORD } from './helpers';

test('UI-00 sign up in the UI lands on the dashboard with nothing pending', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tab-signup').click();
  await page.locator('#email').fill(`fresh${Date.now()}${Math.random().toString(36).slice(2, 7)}@test.dev`);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await expect(page.locator('h1#title')).toHaveText('Dashboard');
  await expect(page.locator('#pending-count')).toHaveText('0');
});

test('UI-01 a new pending action appears within 3 seconds, with a risk badge', async ({ page, request }) => {
  const u = await readyUser(page);
  await page.goto('/#/dashboard');
  await expect(page.locator('#pending-count')).toHaveText('0');
  const start = Date.now();
  expect((await propose(request, u.agentKey, 'payments', 'pay', pay())).status).toBe(201);
  await expect(page.locator('#pending-count')).toHaveText('1', { timeout: 3000 });
  expect(Date.now() - start).toBeLessThan(3000);
  await expect(page.locator('#waiting [data-risk]')).toBeVisible();
});

test('UI-02 the review screen shows every detail and the expiry countdown', async ({ page, request }) => {
  const u = await readyUser(page);
  const { body } = await propose(request, u.agentKey, 'payments', 'pay', pay(6000));
  await page.goto(`/#/review/${body.id}`);
  const d = page.locator('#detail');
  await expect(d.locator('#detail-h')).toContainText('Pay ₹6,000.00 (INR) to Ravi');
  await expect(d).toContainText('Payments · Pay');                 // tool and operation
  await expect(d.locator('.fields')).toContainText('Ravi');        // payee
  await expect(d.locator('.fields')).toContainText('₹6,000.00 (INR)');
  await expect(d.locator('.fields .preview')).toHaveText('Lunch split');   // content preview
  await expect(d).toContainText('Make a payment');                 // intent
  await expect(d.locator('#reasons')).toContainText('daily cap');  // risk reasons
  await expect(d.locator('#countdown')).toHaveText(/^\d+:\d\d$/);  // expiry countdown
});

test('UI-03 Approve and Reject are the same size, neither preselected, and reachable by keyboard', async ({ page, request }) => {
  const u = await readyUser(page);
  const { body } = await propose(request, u.agentKey, 'payments', 'pay', pay());
  await page.goto(`/#/review/${body.id}`);
  const approve = page.locator('#btn-approve'), reject = page.locator('#btn-reject');
  await expect(approve).toBeVisible();
  const [a, r] = [await approve.boundingBox(), await reject.boundingBox()];
  expect(Math.abs(a!.width - r!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(a!.height - r!.height)).toBeLessThanOrEqual(1);
  await expect(approve).not.toBeFocused();
  await expect(reject).not.toBeFocused();
  let reached = '';
  for (let i = 0; i < 80 && reached !== 'btn-reject'; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.id ?? ''); }
  expect(reached).toBe('btn-reject');
  await page.keyboard.press('Tab');
  await expect(approve).toBeFocused();
});

test('UI-04 / UI-06 high risk asks for the password first; status goes Approved → Submitted → Completed', async ({ page, request }) => {
  const u = await readyUser(page);
  const { body } = await propose(request, u.agentKey, 'payments', 'pay', pay(6000));
  await page.goto(`/#/review/${body.id}`);
  await page.locator('#btn-approve').click();
  await expect(page.locator('#reauth-box')).toBeVisible();
  await page.locator('#dlg-approve').click();
  await expect(page.locator('.dialog .err')).toContainText('password');      // nothing sent without it
  await page.locator('#reauth-password').fill(PASSWORD);
  await page.locator('#dlg-approve').click();
  await expect(page.locator('#detail [data-status="COMPLETED"]').first()).toHaveText('Completed (confirmed)');
  const steps = page.locator('#detail .pipe');
  await expect(steps).toContainText('Approved');
  await expect(steps).toContainText('Sent to provider');
  await expect(steps).toContainText('Confirmed');
  await expect(page.locator('#detail')).not.toContainText(/\bDone\b/);
  await expect(page.locator('#detail')).toContainText('MOCK');
});

test('UI-05 agent text containing <script> is shown as text and never runs', async ({ page, request }) => {
  const u = await readyUser(page);
  const evil = '<script>window.__xss=1</script><img src=x onerror="window.__xss=2">Hello';
  const { body } = await propose(request, u.agentKey, 'gmail', 'send', { to: ['asha@example.com'], subject: '<b>hi</b>', body: evil });
  await page.goto(`/#/review/${body.id}`);
  await expect(page.locator('#detail .preview')).toHaveText(evil);
  await expect(page.locator('#detail .fields')).toContainText('<b>hi</b>');
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  await expect(page.locator('#detail img, #detail script')).toHaveCount(0);
});

test('UI-07 at 360 px wide nothing scrolls sideways on any screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const u = await readyUser(page);
  const { body } = await propose(request, u.agentKey, 'payments', 'pay', pay());
  for (const route of ['dashboard', `review/${body.id}`, 'tools', 'agents', 'audit', 'settings']) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('h1#title')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(0);
  }
  await page.goto(`/#/review/${body.id}`);
  await expect(page.locator('#btn-approve')).toBeVisible();
  await expect(page.locator('#btn-reject')).toBeVisible();
});

test('UI-08 settings offer no way to disable approvals or delete audit records', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/settings');
  await expect(page.locator('h1#title')).toHaveText('Settings');
  const controls = await page.locator('main button, main input, main select, main a').evaluateAll(els => els.map(e => `${e.textContent} ${e.getAttribute('aria-label') ?? ''} ${(e as HTMLInputElement).value ?? ''}`).join(' | '));
  expect(controls).not.toMatch(/disable approv|turn off approv|skip approv|auto-?approv|delete audit|clear audit|erase/i);
});

test('UI-09 browser storage never holds tokens, keys or passwords', async ({ page, request }) => {
  const u = await readyUser(page);
  const { body } = await propose(request, u.agentKey, 'payments', 'pay', pay(6000));
  await page.goto(`/#/review/${body.id}`);
  await page.locator('#btn-approve').click();
  await page.locator('#reauth-password').fill(PASSWORD);
  await page.locator('#dlg-approve').click();
  await expect(page.locator('#detail [data-status="COMPLETED"]').first()).toBeVisible();
  await page.goto('/#/settings');
  await page.locator('#theme-dark').check();
  // every key and value in both stores, with no labels of our own that could match the patterns below
  const stored = await page.evaluate(() => [localStorage, sessionStorage].flatMap(s => Object.entries({ ...s }).flat()).join('\n'));
  expect(stored).toContain('agentguard.prefs.v1');   // display preferences are the only thing kept
  expect(stored).not.toContain(u.agentKey);
  expect(stored).not.toContain(u.csrf);
  expect(stored).not.toContain(PASSWORD);
  expect(stored).not.toMatch(/ag_[A-Za-z0-9_-]{20,}|token|session|apikey/i);
});

test('UI-10 one tap on the kill switch pauses all agents and the dashboard shows PAUSED', async ({ page, request }) => {
  const u = await readyUser(page);
  await page.goto('/#/dashboard');
  await page.locator('#kill-switch').click();
  await expect(page.locator('#paused-bar')).toContainText('PAUSED');
  await expect(page.locator('#kill-switch')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#agents [data-status="PAUSED"]')).toBeVisible();
  expect((await propose(request, u.agentKey, 'payments', 'pay', pay())).status).toBe(423);
  await page.locator('#bar-resume').click();
  await expect(page.locator('#paused-bar')).toHaveCount(0);
});

test('UI-11 tools and permissions: connect a tool and toggle an operation; the audit log records it and verifies', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/tools');
  await page.locator('#tool-calendar').click();
  await expect(page.locator('#tool-calendar')).toHaveText('Disconnect');
  await page.goto('/#/agents');
  const sw = page.locator('#perm-calendar-create');
  await expect(sw).toHaveAttribute('aria-checked', 'false');      // OFF by default
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await page.goto('/#/audit');
  await expect(page.locator('#timeline [data-event="PERMISSION_CHANGED"]').last()).toContainText('now allowed');
  await page.locator('#verify').click();
  await expect(page.locator('#verify-result')).toContainText('Chain intact');
});

test('UI-12 reject with a reason; the action will not run', async ({ page, request }) => {
  const u = await readyUser(page);
  const { body } = await propose(request, u.agentKey, 'gmail', 'send', { to: ['stranger@unknown.io'], subject: 'Invoice', body: 'Please pay.' });
  await page.goto(`/#/review/${body.id}`);
  await page.locator('#btn-reject').click();
  await page.locator('#reject-reason').fill('I do not know this person');
  await page.locator('#dlg-reject').click();
  await expect(page.locator('#detail [data-status="REJECTED"]').first()).toBeVisible();
  await expect(page.locator('#detail')).toContainText('I do not know this person');
  await expect(page.locator('#btn-approve')).toHaveCount(0);
});
