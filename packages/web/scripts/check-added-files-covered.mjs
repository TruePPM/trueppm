#!/usr/bin/env node
// Fails the coverage gate when a file ADDED in the MR never entered the merged
// coverage map — the "brand-new untested file" dodge (issue 1510).
//
// Why this exists: `coverage.include` is deliberately unset in vitest.config.ts
// (instrumenting all of src/** would drag the historical untested surface into
// the package-total denominator and land ~6pp below the WEB_COVERAGE_MIN floor).
// The cost of that choice is that a new src/** file with no test is never
// imported during the run, never enters coverage/lcov.info, and is therefore
// invisible to both web:diff-coverage (diff-cover skips files absent from the
// report) and the package floor (absent from the denominator too). This check
// closes exactly that hole: every file added vs the MR target branch must
// appear in the merged lcov — i.e. something imported it during the test run.
// It does NOT demand a coverage percentage (web:diff-coverage owns that); mere
// presence in the report is enough, because presence means diff-cover can see
// and gate it.
//
// Runs inside web:coverage (the node image that produces the merged lcov —
// web:diff-coverage runs on python:3.11-slim with no node). Outside an MR
// context (main pipelines) there is no diff to check and it exits 0.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_MARKER = '/packages/web/';

// Mirror of the coverage-relevant exclusions in vitest.config.ts (its
// `coverage.exclude` plus vitest's own default of not counting test files).
// KEEP IN SYNC with vitest.config.ts — a file excluded from coverage there must
// be exempt here, or every MR adding one would fail this check spuriously.
const EXEMPT_PATTERNS = [
  /\.d\.ts$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^src\/test\//,
  /^src\/api\/types\.ts$/, // openapi-typescript generated
  /^src\/features\/schedule\/engine\/GanttEngineStub\.ts$/, // test double
  /^src\/components\/dialog\/index\.ts$/, // pure re-export barrel (no coverable statements)
  /^src\/router\/routeHandle\.ts$/, // type-only module (interface RouteHandle, no coverable statements)
];

const ELIGIBLE_EXT = /\.[cm]?[jt]sx?$/;

// A repo-relative path (as printed by `git diff --name-only`) is subject to the
// check when it is web source that vitest would put in the coverage report.
export function isCoverageEligible(repoPath) {
  if (!repoPath.startsWith('packages/web/src/')) return false;
  const rel = repoPath.slice('packages/web/'.length);
  if (!ELIGIBLE_EXT.test(rel)) return false;
  return !EXEMPT_PATTERNS.some((p) => p.test(rel));
}

// Extract the set of package-relative source paths (`src/...`) recorded in an
// lcov tracefile. merge-coverage.mjs rebases every SF: entry onto one canonical
// absolute path under .../packages/web/, so slicing after the LAST marker
// yields the package-relative path regardless of which builds_dir the shards
// ran on.
export function coveredRelPaths(lcovText) {
  const covered = new Set();
  for (const line of lcovText.split('\n')) {
    if (!line.startsWith('SF:')) continue;
    const sf = line.slice(3).trim();
    const idx = sf.lastIndexOf(PACKAGE_MARKER);
    covered.add(idx === -1 ? sf : sf.slice(idx + PACKAGE_MARKER.length));
  }
  return covered;
}

// Return the added files that are eligible but absent from the coverage set.
export function findUncoveredAdded(addedRepoPaths, covered) {
  return addedRepoPaths
    .filter(isCoverageEligible)
    .filter((repoPath) => !covered.has(repoPath.slice('packages/web/'.length)));
}

function main() {
  const target = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? process.argv[2];
  if (!target) {
    console.log('check-added-files-covered: no target branch (not an MR pipeline) — skipped');
    return;
  }

  const lcovPath = resolve(process.cwd(), 'coverage/lcov.info');
  if (!existsSync(lcovPath)) {
    console.error(`ERROR: ${lcovPath} missing — run after merge-coverage.mjs has written it`);
    process.exit(1);
  }

  // Repo-relative paths of files ADDED on this branch vs the merge-base.
  const added = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `origin/${target}...HEAD`],
    { encoding: 'utf-8' },
  )
    .split('\n')
    .filter(Boolean);

  const uncovered = findUncoveredAdded(added, coveredRelPaths(readFileSync(lcovPath, 'utf-8')));
  if (uncovered.length > 0) {
    console.error(
      'ERROR: files added in this MR never entered the coverage report — nothing imported\n' +
        'them during the test run, so web:diff-coverage cannot gate them. Add a test that\n' +
        'exercises each file (or, if it is genuinely not unit-testable, add it to the\n' +
        'coverage excludes in vitest.config.ts AND the exempt list in this script):',
    );
    for (const f of uncovered) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `check-added-files-covered: ${added.length} added file(s), all eligible ones present in coverage`,
  );
}

// Side effects only when invoked directly; importing for unit tests is inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
