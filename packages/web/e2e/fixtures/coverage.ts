import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';

/**
 * E2E coverage capture (issue #2117). Extends Playwright's base `test` with one
 * automatic fixture that, in teardown, reads the istanbul `window.__coverage__`
 * populated by the instrumented build (vite-plugin-istanbul, VITE_COVERAGE=true)
 * and writes it to `coverage/e2e/.nyc_output/` for the post-run merge to LCOV.
 * SonarCloud imports that LCOV alongside the vitest report, so UI files exercised
 * only by E2E stop reading as 0% covered (the ~53% aggregate is misleadingly low
 * because E2E coverage was never collected).
 *
 * Every e2e spec imports `test`/`expect` from here instead of '@playwright/test'
 * so the capture applies without a per-spec hook. The re-export is transparent:
 * `export *` forwards every type and value (Page, Route, devices, …); the local
 * `test`/`expect` shadow the base ones.
 *
 * Gated on VITE_COVERAGE: when it is unset — the normal `web:e2e` gate and local
 * runs — the fixture body is a no-op passthrough, so this changes nothing about
 * how the suite runs; only the nightly `web:e2e:coverage` job sets the flag.
 *
 * Why a fixture and not a teardown beacon: `pagehide`/`visibilitychange` do not
 * fire reliably when Playwright closes a page via CDP, so a page-side flush drops
 * coverage. Reading `window.__coverage__` in fixture teardown runs while the page
 * is still alive (the fixture depends on `page`, so it tears down before `page`),
 * which is deterministic.
 */

const COVERAGE_ENABLED = process.env.VITE_COVERAGE === 'true';
const OUT_DIR = resolve(process.cwd(), 'coverage/e2e/.nyc_output');

export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [
    async ({ page }, use) => {
      await use();
      if (!COVERAGE_ENABLED) return;
      try {
        const cov = await page.evaluate(
          () => (window as unknown as { __coverage__?: Record<string, unknown> }).__coverage__,
        );
        if (cov && Object.keys(cov).length > 0) {
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(resolve(OUT_DIR, `cov-${randomUUID()}.json`), JSON.stringify(cov));
        }
      } catch {
        // The page was already closed, or the spec opened none — skip this one.
        // Files exercised here are almost always covered by another spec too.
      }
    },
    { auto: true },
  ],
});

export { expect };
export * from '@playwright/test';
