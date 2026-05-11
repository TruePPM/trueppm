import { defineConfig, devices } from '@playwright/test';

/**
 * One-off config for marketing-shots.spec.ts. Targets the running dev server
 * on :5173 (no webServer block — start `npm run dev` separately).
 *
 * Run: npx playwright test --config=playwright.marketing.config.ts
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
