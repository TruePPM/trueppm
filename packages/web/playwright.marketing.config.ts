import { defineConfig, devices } from '@playwright/test';

/**
 * Config for the maintained marketing-shots surface (issue #380). Targets the
 * already-running dev server on :5173 (no webServer block — start `npm run dev`
 * separately). Deliberately separate from the main `web:e2e` Playwright config
 * so a broken product shot never blocks a normal MR pipeline.
 *
 *   npm run screenshots            # or:  make screenshots  (from repo root)
 *   npx playwright test --config=playwright.marketing.config.ts
 *
 * Full run procedure + shot inventory: e2e/README.md. Shots land in ~/Downloads.
 *
 * Single worker + no parallelism keeps the run order deterministic; the spec
 * itself pins the wall-clock and mocks every API call so content is byte-stable.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /marketing-shots\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
