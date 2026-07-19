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

// Cap the per-test coverage read (#2228). Skipping a slow page is safe — its
// files are almost always exercised by another spec too, and the merge tolerates
// gaps — and a bounded read can never blow the test's teardown budget.
const COLLECT_TIMEOUT_MS = 8000;

export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [
    async ({ page }, use) => {
      await use();
      if (!COVERAGE_ENABLED) return;
      try {
        // Serialize INSIDE the browser and return a single JSON string, not the
        // deep `__coverage__` object graph. Marshalling the object back over CDP
        // walks every property (megabytes on a 405k-LOC instrumented build) and
        // was blowing the 30s teardown budget on the slower specs (#2228 —
        // "Tearing down collectCoverage exceeded the test timeout"), which failed
        // ~11 specs and, because the job then exited 1 before the merge step, cost
        // the ENTIRE nightly E2E coverage import. One string is a single marshal.
        // Race it against a timeout so a pathologically slow page is skipped
        // rather than failing the test; the eval keeps its own catch so the
        // abandoned promise never surfaces as an unhandled rejection.
        const evalJson = page
          .evaluate(() => {
            const cov = (window as unknown as { __coverage__?: unknown }).__coverage__;
            return cov ? JSON.stringify(cov) : null;
          })
          .catch(() => null);
        const json = await Promise.race([
          evalJson,
          new Promise<null>((r) => setTimeout(() => r(null), COLLECT_TIMEOUT_MS)),
        ]);
        // `"{}"` is an instrumented page that executed nothing worth recording.
        if (json && json !== 'null' && json !== '{}') {
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(resolve(OUT_DIR, `cov-${randomUUID()}.json`), json);
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
