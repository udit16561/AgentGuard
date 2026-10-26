/**
 * v0.5.0 UI: Settings → Models and the Assistant (docs/MODEL_PROVIDERS.md). The server runs with
 * MODEL_PROVIDER_MODE=fake (NODE_ENV=test only), so every model is a local mock and nothing leaves the machine.
 */
import { test, expect, type Page } from '@playwright/test';
import { readyUser, PASSWORD } from './helpers';

const KEY = 'sk-e2e-SECRET-1234567890-ABCD';

/** Adds a model through the form; the first key change asks for the password. */
async function addModel(page: Page, provider: string, modelId: string, label: string, key = KEY) {
  await page.locator('#model-provider').selectOption(provider);
  await page.locator('#model-id').fill(modelId);
  await page.locator('#model-key').fill(key);
  await page.locator('#model-label').fill(label);
  await page.locator('#model-add').click();
  const pw = page.locator('#models-password');
  if (await pw.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
    await pw.fill(PASSWORD);
    await page.locator('#models-password-ok').click();
  }
  await expect(page.locator('#model-list')).toContainText(label);
}
const row = (page: Page, label: string) => page.locator('.model-row', { hasText: label });

test('UI-21 add a model: the key is masked, Test connection runs, and roles can be assigned', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/settings');
  await page.locator('#open-models').click();
  await expect(page.locator('#title')).toHaveText('Models');
  await expect(page.locator('#model-list')).toContainText('built-in rules');

  await addModel(page, 'anthropic', 'claude-haiku-5-5', 'Guard Haiku');
  await expect(row(page, 'Guard Haiku')).toContainText('••••ABCD');
  await expect(page.locator('body')).not.toContainText('SECRET');
  await row(page, 'Guard Haiku').getByRole('button', { name: 'Test connection' }).click();
  await expect(row(page, 'Guard Haiku')).toContainText('can be the guard');

  await addModel(page, 'openai', 'gpt-6.1-sol', 'Agent Sol');
  await row(page, 'Agent Sol').getByRole('button', { name: 'Test connection' }).click();
  await expect(row(page, 'Agent Sol')).toContainText('Connected');

  await page.locator('#role-agent').selectOption({ label: 'Agent Sol · gpt-6.1-sol' });
  await page.locator('#role-guard').selectOption({ label: 'Guard Haiku · claude-haiku-5-5' });
  await page.locator('#roles-save').click();
  await expect(page.locator('#same-provider')).toHaveCount(0);
  const data = await (await page.request.get('/api/models')).json();
  expect(data.roles.agent.model.label).toBe('Agent Sol');
  expect(data.roles.guard.model.label).toBe('Guard Haiku');
  expect(JSON.stringify(data)).not.toContain('SECRET');
});

test('UI-22 a bad key fails the test, a prose-only model cannot be the guard, and one provider for both roles is warned about', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/settings/models');
  await addModel(page, 'groq', 'llama-bad', 'Bad key', 'sk-bad-key-0000');
  await row(page, 'Bad key').getByRole('button', { name: 'Test connection' }).click();
  await expect(row(page, 'Bad key')).toContainText('rejected the API key');

  await addModel(page, 'anthropic', 'prose-only', 'Prose');
  await row(page, 'Prose').getByRole('button', { name: 'Test connection' }).click();
  await expect(row(page, 'Prose')).toContainText('agent role only');
  await expect(page.locator('#role-guard option', { hasText: 'Prose' })).toHaveCount(0);

  await addModel(page, 'anthropic', 'claude-haiku-5-5', 'Haiku');
  await row(page, 'Haiku').getByRole('button', { name: 'Test connection' }).click();
  await expect(row(page, 'Haiku')).toContainText('can be the guard');
  await page.locator('#role-agent').selectOption({ label: 'Prose · prose-only' });
  await page.locator('#role-guard').selectOption({ label: 'Haiku · claude-haiku-5-5' });
  await page.locator('#roles-save').click();
  await expect(page.locator('#same-provider')).toContainText('different provider');
});

test('UI-23 the Assistant proposes a payment that waits in Review; it is never paid from the chat', async ({ page }) => {
  await readyUser(page);
  await page.goto('/#/assistant');
  await expect(page.locator('#chat-off')).toContainText('No Assistant model yet');

  await page.goto('/#/settings/models');
  await addModel(page, 'openai', 'gpt-6.1-sol', 'Sol');
  await row(page, 'Sol').getByRole('button', { name: 'Test connection' }).click();
  await expect(row(page, 'Sol')).toContainText('Connected');
  await page.locator('#role-agent').selectOption({ label: 'Sol · gpt-6.1-sol' });
  await page.locator('#roles-save').click();
  await expect(page.locator('#roles-save')).toBeEnabled();

  // the Assistant is an ordinary agent: give it the payment permission like any other
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).token;
  const agents = (await (await page.request.get('/api/agents')).json()).agents as { id: string; kind: string }[];
  const assistant = agents.find(a => a.kind === 'assistant')!;
  expect((await page.request.put(`/api/agents/${assistant.id}/permissions`, { headers: { 'X-CSRF-Token': csrf }, data: { permissions: [
    { tool: 'payments', operation: 'pay', allowed: true, limits: { dailyCap: 10000, currency: 'INR', knownPayees: ['Ravi'] } }] } })).status()).toBe(200);

  await page.locator('#nav-assistant').click();
  await page.locator('#chat-input').fill('pay Ravi ₹500');
  await page.locator('#chat-send').click();
  const card = page.locator('.proposal');
  await expect(card).toContainText('Payments');
  await expect(card).toContainText('Nothing happens until you approve it');
  await expect(page.locator('#chat-log')).toContainText('waiting for your approval');
  await card.getByRole('link', { name: 'Review it' }).click();
  await expect(page).toHaveURL(/#\/review\/act_/);
  const id = decodeURIComponent(page.url().split('/review/')[1]);
  expect((await (await page.request.get(`/api/actions/${id}`)).json()).status).toBe('PENDING_REVIEW');
});
