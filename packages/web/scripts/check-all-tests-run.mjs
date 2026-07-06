#!/usr/bin/env node
// Fails when a test file that exists on disk is NOT collected by the command CI
// uses to run the web suite (`npm run test:coverage`, sharded by web:test).
//
// Why this exists (issue #1657): web:test's only vitest invocation is
// `npm run test:coverage`. For a long time that script carried a positional path
// filter — `vitest run src/api src/features src/hooks src/lib src/stores` — so
// every spec outside those directories (src/workers, src/utils, src/styles,
// src/App.test.tsx, scripts/*.test.mjs) silently never ran in CI. Coverage
// instrumentation is module-graph-scoped (coverage.include is unset), so the
// filter guarded nothing; it only dropped specs. Nothing else asserts that every
// *.test.* file actually executes, so the gap was invisible until a newly-added
// file in a dropped directory tripped check-added-files-covered.mjs — or never.
//
// Invariant: every test file on disk (vitest's default include glob, minus the
// config excludes) must be collected by `vitest list` when scoped with the exact
// positional filters embedded in the test:coverage script. Any on-disk spec that
// is not collected is a silently-skipped test → non-zero exit. Pure presence is
// enough — this does not run the tests, only proves CI would.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Directories never scanned for specs. Mirrors vitest's built-in defaults plus
// the `exclude` in vitest.config.ts (e2e runs under Playwright's own runner).
// KEEP IN SYNC with vitest.config.ts `exclude`.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'e2e', '.git', '.cache']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Recursively collect package-relative test-file paths under `dir`.
export function walkTestFiles(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkTestFiles(full, root, out);
    } else if (TEST_FILE.test(entry.name)) {
      out.push(relative(root, full));
    }
  }
  return out;
}

// Positional (path) filters embedded in a `vitest run …` script line — the exact
// scoping CI applies. Env assignments (FOO=bar) and flags (-x / --x) are not
// filters; everything else after `vitest run` narrows which specs execute.
export function positionalFilters(scriptLine) {
  const afterRun = (scriptLine ?? '').split(/\bvitest\s+run\b/)[1];
  if (afterRun === undefined) return [];
  return afterRun
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
}

function collectedFiles(filters) {
  // Positional filters MUST precede the flags: `--json [path]` takes an optional
  // value, so `--json src/api` would treat src/api as its output path (EISDIR),
  // not a spec filter. Filters first, boolean flags last, keeps `--json` valueless.
  const out = execFileSync('npx', ['vitest', 'list', ...filters, '--filesOnly', '--json'], {
    cwd: WEB_DIR,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // vitest may emit a non-JSON preamble; slice from the first array bracket.
  const arr = JSON.parse(out.slice(out.indexOf('[')));
  return new Set(arr.map((e) => relative(WEB_DIR, e.file)));
}

// Test files present on disk but absent from the collected set.
export function findSkippedSpecs(onDisk, collected) {
  return onDisk.filter((f) => !collected.has(f)).sort();
}

function main() {
  const pkg = JSON.parse(readFileSync(resolve(WEB_DIR, 'package.json'), 'utf-8'));
  const filters = positionalFilters(pkg.scripts?.['test:coverage']);

  const onDisk = walkTestFiles(WEB_DIR);
  const skipped = findSkippedSpecs(onDisk, collectedFiles(filters));

  if (skipped.length > 0) {
    console.error(
      `ERROR: ${skipped.length} test file(s) exist on disk but are NOT run by ` +
        "`npm run test:coverage` (the command CI's web:test job shards).\n" +
        (filters.length
          ? `Its positional filter [${filters.join(' ')}] excludes them. Remove the path ` +
            'filter so the whole suite runs (test:coverage should be `vitest run --coverage`), ' +
            'or, if a spec is intentionally not run, exclude it in vitest.config.ts so the intent ' +
            'is explicit and this guard stays green:'
          : 'They fall outside vitest.config.ts `include` or are dropped by its `exclude`. Make ' +
            'the exclusion explicit and intentional, or fix the config:'),
    );
    for (const f of skipped) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `check-all-tests-run: all ${onDisk.length} test file(s) are collected by test:coverage`,
  );
}

// Side effects only when invoked directly; importing for unit tests is inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
