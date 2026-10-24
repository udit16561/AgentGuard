import { defineConfig, devices } from '@playwright/test';

const PORT = 4300;

/** UI-* cases from docs/TEST_CASES.md §5, on desktop and "Mobile Chrome". The API runs with an in-memory database. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } }
  ],
  webServer: {
    command: 'npx tsx src/server.ts',
    cwd: 'backend',
    url: `http://localhost:${PORT}/api/health`,
    env: { PORT: String(PORT), DATABASE_URL: 'file::memory:', NODE_ENV: 'test', INTEGRATION_MODE: 'mock' },
    reuseExistingServer: false,
    timeout: 60_000
  }
});
