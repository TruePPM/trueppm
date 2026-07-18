#!/usr/bin/env node
// Merges the per-page Playwright E2E coverage collected by the vite coverage
// plugin (issue #2117) into a single LCOV that SonarCloud imports alongside the
// vitest report, so UI files exercised only by E2E stop reading as 0% covered.
//
// The `web:e2e:coverage` nightly job builds the app instrumented
// (VITE_COVERAGE=true, vite-plugin-istanbul), runs the mocked Chromium suite,
// and the coverage collector persists one `coverage/e2e/.nyc_output/cov-*.json`
// per browser page (istanbul coverage-data objects). This stitches them at the
// coverage-map level — the same map-merge approach as merge-coverage.mjs (no GNU
// lcov install; istanbul-lib-* is already a transitive dep) — and emits
// `coverage/e2e/lcov.info`.
//
// Path form: istanbul records absolute build-time paths (e.g.
// `<builds_dir>/packages/web/src/foo.ts`). We rewrite them to repo-root-relative
// `packages/web/src/foo.ts` so the scanner (run from the repo root) resolves them
// directly — no sed rewrite needed in CI, unlike the vitest report whose
// `SF:src/...` paths get the `SF:packages/web/` prefix injected by sonar:scan.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const PACKAGE_MARKER = '/packages/web/';

// Rewrite an istanbul file path to a repo-root-relative `packages/web/...` path
// so SonarCloud resolves it from the checkout root. Handles the two shapes
// istanbul emits: an absolute build path containing `/packages/web/` (the CI and
// local case — take everything after the last marker and re-prefix), and an
// already-package-relative `src/...` path (prefix it). Anything unexpected is
// returned unchanged so it fails loudly in the scanner rather than silently
// resolving to the wrong file.
export function toRepoRelPath(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf(PACKAGE_MARKER);
  if (idx !== -1) return 'packages/web/' + norm.slice(idx + PACKAGE_MARKER.length);
  if (norm.startsWith('src/')) return 'packages/web/' + norm;
  return norm;
}

// Return a new istanbul coverage-data object re-keyed onto repo-root-relative
// paths. Nested maps (statementMap/s/f/b/…) are shared by reference — never
// mutated, only re-keyed — matching merge-coverage.mjs's rebaseCoverageData.
export function rerootCoverageData(rawData) {
  const out = {};
  for (const entry of Object.values(rawData)) {
    const rel = toRepoRelPath(entry.path);
    out[rel] = { ...entry, path: rel };
  }
  return out;
}

function main() {
  const cwd = process.cwd();
  const nycDir = resolve(cwd, 'coverage/e2e/.nyc_output');
  const outDir = resolve(cwd, 'coverage/e2e');

  if (!existsSync(nycDir)) {
    // Not fatal: the nightly sonar:scan still imports the vitest report. Fail
    // loudly so a genuinely-broken collection is visible, but exit 0 so a
    // coverage hiccup never reds the (allow_failure) nightly pipeline.
    console.warn(`WARNING: ${nycDir} not found — no E2E coverage to merge.`);
    console.warn('  Did the instrumented build run (VITE_COVERAGE=true) and the suite execute?');
    return;
  }

  const covFiles = readdirSync(nycDir).filter((f) => /^cov-.*\.json$/.test(f));
  if (covFiles.length === 0) {
    console.warn(`WARNING: no cov-*.json under ${nycDir} — no E2E coverage collected.`);
    return;
  }

  const map = libCoverage.createCoverageMap({});
  let parsed = 0;
  for (const f of covFiles) {
    const file = resolve(nycDir, f);
    try {
      map.merge(rerootCoverageData(JSON.parse(readFileSync(file, 'utf-8'))));
      parsed += 1;
    } catch (err) {
      // A truncated final snapshot (page closed mid-POST) is expected occasionally
      // — skip it; the periodic snapshots already captured that page's coverage.
      console.warn(`  skipped unreadable ${f}: ${err.message}`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const context = libReport.createContext({ dir: outDir, coverageMap: map });
  reports.create('lcovonly', { file: 'lcov.info' }).execute(context);

  const summary = libCoverage.createCoverageSummary();
  for (const file of map.files()) {
    summary.merge(map.fileCoverageFor(file).toSummary());
  }
  console.log(
    `merged ${parsed}/${covFiles.length} page snapshots (${map.files().length} files): ` +
      `E2E line coverage ${summary.lines.pct}% → coverage/e2e/lcov.info`,
  );
}

// Run only when invoked directly; importing for unit tests must not merge.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
