#!/usr/bin/env node
// Reads the merged Playwright JSON report emitted by the web:e2e:report job
// (playwright.merge.config.ts adds the `json` reporter alongside `html`) and
// surfaces every test that only passed on RETRY — Playwright's "flaky" outcome.
//
// Why this exists (issue 1514): CI runs with retries (playwright.config.ts). A
// test that fails its first attempt and passes on retry counts as a pass, so the
// web:e2e job greens even though the test is non-deterministic. Nothing gated on
// that before — flaky outcomes landed in the blob report and were never read.
// Given the repo's documented flake classes (stateless mocks, detached elements),
// a silent retry-pass is exactly how a real intermittent regression hides. This
// check makes those outcomes loud.
//
// Behaviour: prints a prominent banner listing every flaky test. By default it
// only WARNS (exit 0) so its first rollout does not start blocking pipelines on a
// pre-existing flake backlog; set TRUEPPM_FLAKY_FAIL=1 to turn it into a hard gate
// once the suite is clean. A clean report always exits 0 quietly.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Walk a Playwright JSON report and collect every test whose outcome was "flaky"
 * (it failed at least one attempt but ultimately passed on retry).
 *
 * The report shape is a tree of `suites`, each with nested `suites` and `specs`;
 * every spec has `tests`, and each test carries a `status` of
 * expected | unexpected | flaky | skipped. We return one entry per flaky test
 * with a human-readable title path and its file location.
 *
 * @param {object} report Parsed Playwright JSON report.
 * @returns {{title: string, file: string, line: number}[]} Flaky tests found.
 */
export function collectFlaky(report) {
  const flaky = [];

  const visitSuite = (suite, titlePath) => {
    const here = suite.title ? [...titlePath, suite.title] : titlePath;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'flaky') {
          const attempts = (test.results ?? []).length;
          flaky.push({
            title: [...here, spec.title].filter(Boolean).join(' › '),
            file: spec.file ?? suite.file ?? '(unknown)',
            line: spec.line ?? 0,
            attempts,
          });
        }
      }
    }
    for (const child of suite.suites ?? []) visitSuite(child, here);
  };

  for (const suite of report.suites ?? []) visitSuite(suite, []);
  return flaky;
}

function main() {
  const reportPath = resolve(
    process.cwd(),
    process.env.TRUEPPM_FLAKY_REPORT ?? 'flaky-report.json',
  );

  if (!existsSync(reportPath)) {
    // Not a failure: the report is absent when web:e2e:report did not run (e.g. a
    // non-web branch) or when merge-reports produced no JSON. Say so and move on.
    console.log(`check-flaky: no report at ${reportPath} — nothing to check.`);
    return 0;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (err) {
    console.error(`check-flaky: could not parse ${reportPath}: ${err.message}`);
    return 0;
  }

  const flaky = collectFlaky(report);
  const declaredFlaky = report.stats?.flaky ?? flaky.length;

  if (flaky.length === 0 && declaredFlaky === 0) {
    console.log('check-flaky: no flaky outcomes — every test passed on its first attempt. ✓');
    return 0;
  }

  const bar = '='.repeat(72);
  console.warn(`\n${bar}`);
  console.warn(`⚠  FLAKY E2E OUTCOMES: ${flaky.length} test(s) passed only on retry`);
  console.warn(bar);
  for (const f of flaky) {
    console.warn(`  • ${f.title}`);
    console.warn(`      ${f.file}:${f.line}  (${f.attempts} attempt(s))`);
  }
  console.warn(bar);
  console.warn(
    'These tests are non-deterministic: they failed at least once and passed on\n' +
      'retry. Under CI retries this greened the job silently. Fix the root cause\n' +
      '(stale mock, detached element, unawaited state) — do not rely on the retry.\n' +
      'Set TRUEPPM_FLAKY_FAIL=1 to make this a hard pipeline gate.',
  );
  console.warn(`${bar}\n`);

  if (process.env.TRUEPPM_FLAKY_FAIL === '1') {
    console.error('check-flaky: failing because TRUEPPM_FLAKY_FAIL=1 and flaky tests were found.');
    return 1;
  }
  return 0;
}

// Run only when invoked directly (node scripts/check-flaky.mjs); importing this
// module for unit tests must not trigger the side effects above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
