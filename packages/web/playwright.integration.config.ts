import { defineConfig, devices } from '@playwright/test';

import { devPort } from './e2e/ports';

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
 *
 * Port: same defect and same fix as playwright.config.ts (#3514). This config
 * also sets `reuseExistingServer: !CI`, so a hardcoded 5173 lets a run in one
 * worktree silently adopt a sibling worktree's dev server — which serves that
 * OTHER checkout's source. `devPort()` reads the per-worktree
 * `TRUEPPM_E2E_DEV_PORT` from `.envrc`; unset it is 5173, so CI is unchanged.
 * See `e2e/ports.ts`.
 */
const PORT = devPort();
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
    baseURL: ORIGIN,
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
    // `--port`/`--strictPort` and `url` all read PORT: a dev server on one port
    // with `baseURL` naming another is the silent-wrong-server class itself.
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
