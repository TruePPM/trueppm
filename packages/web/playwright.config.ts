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
 *
 * Host: everything is pinned to 127.0.0.1 (not `localhost`). On macOS `localhost`
 * resolves to ::1 (IPv6) first and `vite preview` then binds IPv6-only, but
 * Playwright's webServer readiness probe connects over IPv4 — so the probe never
 * reaches the server and times out after 120s even though vite reports "ready".
 * CI (Linux) happens to route localhost→127.0.0.1 throughout and stays green,
 * which is exactly why this never surfaced there. Forcing IPv4 end-to-end makes
 * local runs work and keeps CI identical. (#1116)
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
  // One retry in CI (down from 2, issue 1514): a single retry still absorbs the
  // genuinely non-deterministic infra hiccup (a runner network blip), but does
  // NOT let a test that fails 2-of-3 attempts green the job — that class of flake
  // was invisible noise under 2 retries. The web:e2e:report job's flaky-outcome
  // check (scripts/check-flaky.mjs) surfaces any test that only passed on retry,
  // so a retry masks nothing silently. Local stays at 0 — flakes must be visible
  // the moment they are introduced. Contrast playwright.integration.config.ts (0).
  retries: process.env.CI ? 1 : 0,
  // CI runners are sized at 4 cores; mocked specs are stateless so worker
  // isolation is safe. Local default is Playwright's 50% of cores.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? 'line' : 'html',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    // Emulate `prefers-reduced-motion: reduce` for every spec. The app gates all
    // decorative animation behind Tailwind's `motion-safe:` variant (drawer
    // slide, `animate-pulse` loading skeletons, `animate-spin` refresh icons,
    // the save-bar slide), so this disables them wholesale in tests. A looping
    // `animate-pulse` skeleton left running by a still-loading section keeps its
    // layout perpetually in motion, which trips Playwright's actionability
    // "element is stable" check and surfaces as a nondeterministic 30s click
    // timeout on unrelated controls — the subtasks-drawer flake (#1655). Reduced
    // motion is also how real assistive-tech users experience the app, so this
    // makes the e2e environment more representative, not less. (#1655)
    reducedMotion: 'reduce',
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
    // `--host 127.0.0.1` forces an IPv4 bind so the readiness probe below can reach
    // it on macOS (see the host note in the file header).
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
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
