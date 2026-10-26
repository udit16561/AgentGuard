/**
 * v0.6.0 UI: installable PWA, live alerts and the phone layout (written before the UI).
 * Push delivery itself is covered by backend PUSH-* tests with a fake push service.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test, expect } from '@playwright/test';
import { readyUser, propose, pay } from './helpers';

const FRONTEND = path.join(__dirname, '..', 'frontend');
/** The service worker's helpers, loaded the way the worker loads them (importScripts), outside the browser. */
function swHelpers() {
  const sandbox: Record<string, unknown> = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'js', 'sw-helpers.js'), 'utf8'), sandbox);
  return (sandbox.self as { agSw: { STATIC_FILES: string[]; CACHE: string; safeReviewUrl: (u: unknown) => string; isCacheable: (u: string) => boolean } }).agSw;
}

test('UI-24 live alerts: the dashboard shows Live and a new proposal appears within 3 seconds over SSE', async ({ page, request }) => {
  const u = await readyUser(page);
  await page.goto('/#/dashboard');
  await expect(page.locator('#live-status')).toHaveText(/live/i);
  const start = Date.now();
  await propose(request, u.agentKey, 'payments', 'pay', pay(700));
  await expect(page.locator('#nav-review .count')).toHaveText('1', { timeout: 3000 });
  expect(Date.now() - start).toBeLessThan(3000);
});

test('UI-25 installable: manifest with 192 and 512 PNG icons, a registered service worker, and no API data in its cache', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/dashboard');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: expect.any(String), scope: expect.any(String) });
  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find((i: { sizes: string; type: string }) => i.sizes === size && i.type === 'image/png');
    expect(icon, size).toBeTruthy();
    const res = await page.request.get(icon.src);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
  }
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose?.includes('maskable'))).toBe(true);
  expect((await page.request.get('/sw.js')).headers()['cache-control']).toBe('no-cache');

  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.goto('/#/review');
  await expect(page.locator('#title')).toHaveText('Review');
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    return urls;
  });
  expect(cached).toContain('/js/app.js');
  expect(cached.filter(u => u.startsWith('/api'))).toEqual([]);
});

test('UI-26 offline: the app opens as a read-only shell with no stored API data, and recovers when back online', async ({ page, context }) => {
  await readyUser(page);
  await page.goto('/#/dashboard');
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#offline')).toContainText(/offline/i);
  await expect(page.locator('#offline')).toContainText(/nothing can be approved/i);
  await expect(page.locator('#btn-approve')).toHaveCount(0);
  await expect(page.locator('#offline-retry')).toBeVisible();
  await context.setOffline(false);   // the shell reloads by itself when the connection is back
  await expect(page.locator('#title')).toHaveText('Dashboard');
});

test('UI-27 notifications: the worker caches only static files and a tap can only open a Review screen', async () => {
  const sw = swHelpers();
  expect(sw.safeReviewUrl('/#/review/act_AbC123xyz')).toBe('/#/review/act_AbC123xyz');
  for (const bad of ['https://evil.example.com/', '/#/review/act_x"><script>', 'javascript:alert(1)', '/api/actions/act_1/approve', null, 42]) {
    expect(sw.safeReviewUrl(bad), String(bad)).toBe('/#/review');
  }
  expect(sw.isCacheable('/api/actions')).toBe(false);
  expect(sw.isCacheable('/api/stream')).toBe(false);
  expect(sw.isCacheable('/js/app.js')).toBe(true);
  // every frontend module is precached, so the shell works offline
  const js = fs.readdirSync(path.join(FRONTEND, 'js'), { recursive: true }).map(String).filter(f => f.endsWith('.js') && f !== 'sw-helpers.js').map(f => `js/${f.replace(/\\/g, '/')}`);
  for (const f of js) expect(sw.STATIC_FILES, f).toContain(f);
  expect(sw.STATIC_FILES.some(f => f.startsWith('api'))).toBe(false);
  const worker = fs.readFileSync(path.join(FRONTEND, 'sw.js'), 'utf8');
  expect(worker).not.toMatch(/approve/i);   // the worker can open the app; it can never decide anything
});

test('UI-28 a notification link opens that action’s Review screen; HIGH risk still asks for the password in the app', async ({ page, request }) => {
  const u = await readyUser(page);
  const p = await propose(request, u.agentKey, 'payments', 'pay', pay(2500, 'Stranger'));
  await page.goto(`/#/review/${p.body.id}`);
  await expect(page.locator('h1#title')).toHaveText('Review');
  await expect(page.locator('#detail')).toContainText('Stranger');
  await page.locator('#btn-approve').click();
  await expect(page.locator('#reauth-password')).toBeVisible();
});

test('UI-29 phone layout: one action fills the review screen with a back link, the decision bar is on screen, and the kill switch is a big first-screen button', async ({ page, request }) => {
  test.skip(test.info().project.name !== 'Mobile Chrome', 'phone layout');
  const u = await readyUser(page);
  const p = await propose(request, u.agentKey, 'payments', 'pay', pay(2500, 'Stranger'));
  await page.goto(`/#/review/${p.body.id}`);
  await expect(page.locator('#review-back')).toBeVisible();
  await expect(page.locator('#queue')).toBeHidden();
  const vh = page.viewportSize()!.height;
  for (const id of ['#btn-approve', '#btn-reject']) {
    const box = (await page.locator(id).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.y + box.height).toBeLessThanOrEqual(vh);
  }
  const a = (await page.locator('#btn-approve').boundingBox())!, r = (await page.locator('#btn-reject').boundingBox())!;
  expect(Math.abs(a.width - r.width)).toBeLessThan(2);

  await page.goto('/#/dashboard');
  const kill = (await page.locator('#kill-switch').boundingBox())!;
  expect(kill.height).toBeGreaterThanOrEqual(56);
  expect(kill.y + kill.height).toBeLessThanOrEqual(vh);
  await expect(page.locator('#nav-dashboard .lbl-short')).toBeVisible();
});

test('UI-30 Settings → Phone alerts explains the state; with no VAPID keys on the server it says alerts are not set up', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/settings');
  await expect(page.locator('#alerts-card')).toContainText(/phone alerts/i);
  await expect(page.locator('#alerts-card')).toContainText(/not set up|VAPID/i);
  await expect(page.locator('#alerts-card')).toContainText(/never approve/i);
});
