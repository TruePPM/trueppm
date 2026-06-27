#!/usr/bin/env node
// Stitches the per-shard istanbul coverage produced by the sharded `web:test`
// job into a single `coverage/lcov.info` for the `web:diff-coverage` gate, and
// enforces the package-total line floor (`WEB_COVERAGE_MIN`).
//
// Why this exists: `vitest --shard` runs each shard in its own process, so each
// only measures ~1/N of the suite. The shards emit `coverage-<n>/coverage-final.json`
// (the istanbul data file); the merged result is what the gate must read.
//
// Why node, not GNU lcov: the previous `web:coverage` job ran `lcov -a` on
// python:3.11-slim, which had to `apt-get install lcov` first — that drags in
// perl + binutils for ~5 min, while the merge itself took <1s. Merging the
// istanbul coverage maps here needs no install (istanbul-lib-coverage is already
// a transitive dep of @vitest/coverage-istanbul, present in the cached
// node_modules) and merges at the coverage-map level — which also sidesteps the
// istanbul duplicate-function-name inconsistency that forced `--ignore-errors`
// on the lcov text-merge path.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const PACKAGE_MARKER = '/packages/web/';

// Re-root an absolute istanbul file path onto the current checkout (`webRoot` =
// the merge job's packages/web dir). The web:test shards record absolute paths
// like `<builds_dir>/packages/web/src/foo.ts`; the shards and this merge job can
// land on runners with different builds_dir (/tmp/builds vs
// /mnt/nvme1/gitlab-runner/builds), so the same source file would arrive under
// two different keys and merge as TWO half-covered entries — inflating the file
// count and tanking the line total below the floor (issue 1348). Re-rooting the
// path after the last `/packages/web/` onto `webRoot` collapses the divergent
// prefixes to one canonical absolute path, so identical files merge as one. On a
// homogeneous fleet this is a no-op (the prefix already equals webRoot). A path
// without the marker (already relative, or measured outside the package) is
// returned unchanged.
export function rebaseCoveragePath(filePath, webRoot) {
  const idx = filePath.lastIndexOf(PACKAGE_MARKER);
  if (idx === -1) return filePath;
  return resolve(webRoot, filePath.slice(idx + PACKAGE_MARKER.length));
}

// Return a new istanbul coverage-data object with every entry's key and inner
// `path` field rebased onto `webRoot`. The nested maps (statementMap/s/f/b/…)
// are shared by reference — they are never mutated here, only re-keyed.
export function rebaseCoverageData(rawData, webRoot) {
  const out = {};
  for (const entry of Object.values(rawData)) {
    const rebased = rebaseCoveragePath(entry.path, webRoot);
    out[rebased] = { ...entry, path: rebased };
  }
  return out;
}

function main() {
  const cwd = process.cwd();

  // Shard dirs are written as coverage-<CI_NODE_INDEX>/ by web:test (1-based).
  const shardDirs = readdirSync(cwd, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^coverage-\d+$/.test(d.name))
    .map((d) => d.name)
    .sort();

  if (shardDirs.length === 0) {
    console.error('ERROR: no coverage-<n>/ shard directories found to merge');
    process.exit(1);
  }

  const map = libCoverage.createCoverageMap({});
  for (const dir of shardDirs) {
    const file = resolve(cwd, dir, 'coverage-final.json');
    if (!existsSync(file)) {
      console.error(`ERROR: ${file} missing — did the web:test shard emit the 'json' reporter?`);
      process.exit(1);
    }
    // Rebase before merging so shards that ran on a different builds_dir than
    // this job still collapse onto one entry per source file (issue 1348).
    map.merge(rebaseCoverageData(JSON.parse(readFileSync(file, 'utf-8')), cwd));
  }

  // Write the merged lcov tracefile that web:diff-coverage's diff-cover consumes.
  mkdirSync(resolve(cwd, 'coverage'), { recursive: true });
  const context = libReport.createContext({ dir: resolve(cwd, 'coverage'), coverageMap: map });
  reports.create('lcovonly', { file: 'lcov.info' }).execute(context);

  // Package-total line floor against legacy regressions, enforced on the merged
  // result (vitest can't — no single shard sees it). Mirrors api:coverage's
  // --fail-under soft floor; the primary gate remains web:diff-coverage.
  const summary = libCoverage.createCoverageSummary();
  for (const file of map.files()) {
    summary.merge(map.fileCoverageFor(file).toSummary());
  }
  const linesPct = summary.lines.pct;
  const min = Number(process.env.WEB_COVERAGE_MIN ?? '0');
  console.log(
    `merged ${shardDirs.length} shards (${map.files().length} files): line coverage ${linesPct}% (floor ${min}%)`,
  );
  if (linesPct < min) {
    console.error(`ERROR: line coverage ${linesPct}% is below floor ${min}%`);
    process.exit(1);
  }
}

// Run the merge only when invoked directly (node scripts/merge-coverage.mjs);
// importing this module for unit tests must not trigger the side effects above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
