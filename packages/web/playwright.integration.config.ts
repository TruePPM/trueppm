import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright integration test configuration.
 *
 * Runs against a live stack: real Django API (port 8000) + Vite dev proxy
 * (port 5173). Covers auth flows, write-contract validation, and WebSocket
 * broadcasts — scenarios the mocked web:e2e suite cannot exercise.
 *
 * CI (web:integration job): Django is started before Playwright; Vite dev
 * server is started via webServer below and proxies /api → Django.
 * Local: set API_URL=http://localhost:8000 and ensure Django is running, then
 *   npx playwright test --config playwright.integration.config.ts
 */
export default defineConfig({
  testDir: './e2e/integration',
  // Real state is shared — serial execution avoids race conditions.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries: a failure means a real regression, not test flakiness.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'html',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Vite dev server with the /api proxy — inherits API_URL from the
    // environment (set to http://localhost:8000 in the CI job).
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
