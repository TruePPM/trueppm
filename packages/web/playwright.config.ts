import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration.
 *
 * Local: runs against `vite preview` (production build served at :4173).
 *        Build first: `npm run build && npx playwright test`
 *
 * CI: web:e2e job builds the app then starts preview automatically via webServer.
 *     Uses Chromium only to keep CI runtime reasonable; add Firefox/WebKit when
 *     the test suite grows.
 */
export default defineConfig({
  testDir: './e2e',
  // Integration specs require a live Django stack and run only in the
  // main-only `web:integration` job via playwright.integration.config.ts.
  // marketing-shots is an opt-in capture run driven by
  // playwright.marketing.config.ts; it expects a live dev server on :5173.
  testIgnore: ['integration/**', 'marketing-shots.spec.ts'],
  fullyParallel: true,
  // Fail fast on focused tests (.only) in CI — prevents accidental partial runs.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI runners are sized at 4 cores; mocked specs are stateless so worker
  // isolation is safe. Local default is Playwright's 50% of cores.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? 'line' : 'html',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // `vite preview` serves the production build (requires `npm run build` first).
    // In CI the build step runs before this config; locally run `npm run build` once.
    command: 'npm run preview',
    url: 'http://localhost:4173',
    // Reuse an already-running preview server locally; always start fresh in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Mocked specs intercept all /api/* and /ws/* at the browser; the vite
    // preview proxy still attempts to forward stray requests to the backend
    // and floods the trace with ECONNREFUSED noise when nothing is on :8000.
    // Suppress preview stdout/stderr in CI — real test failures surface
    // through Playwright's own reporting, not vite's proxy log.
    stdout: process.env.CI ? 'ignore' : 'pipe',
    stderr: process.env.CI ? 'ignore' : 'pipe',
  },
});
