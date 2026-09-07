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
 *
 * Port: deliberately NOT the per-worktree `TRUEPPM_E2E_DEV_PORT` the other two
 * configs read (#3514). This config has no `webServer` block, so it never adopts
 * a server silently the way `reuseExistingServer` does — and the server it
 * targets is the SHARED `make up` docker stack, which is one service on :5173 by
 * design (see the Makefile and e2e/README.md), not a per-worktree process.
 * Pointing this at a worktree port would break the documented `make screenshots`
 * flow to fix a collision this config cannot have. The residual caveat is real
 * and belongs to the shared stack rather than to this file: run from a worktree,
 * `make screenshots` captures whatever tree that stack is serving.
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
