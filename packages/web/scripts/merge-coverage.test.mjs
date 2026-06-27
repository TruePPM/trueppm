import { describe, expect, it } from 'vitest';
import libCoverage from 'istanbul-lib-coverage';
import { rebaseCoveragePath, rebaseCoverageData } from './merge-coverage.mjs';

// Minimal istanbul FileCoverage-shaped object: one executed statement so it
// participates in a real coverageMap merge.
function fileCov(path) {
  return {
    path,
    statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 8 } } },
    fnMap: {},
    branchMap: {},
    s: { 0: 1 },
    f: {},
    b: {},
  };
}

const WEB_ROOT = '/checkout/packages/web';

describe('rebaseCoveragePath', () => {
  it('collapses two builds_dir prefixes for the same file onto one canonical path', () => {
    const fromTmp = rebaseCoveragePath('/tmp/builds/trueppm/trueppm/packages/web/src/foo.ts', WEB_ROOT);
    const fromMnt = rebaseCoveragePath(
      '/mnt/nvme1/gitlab-runner/builds/trueppm/trueppm/packages/web/src/foo.ts',
      WEB_ROOT,
    );
    expect(fromTmp).toBe('/checkout/packages/web/src/foo.ts');
    expect(fromMnt).toBe(fromTmp);
  });

  it('uses the LAST /packages/web/ segment (a nested path is rebased once at the package root)', () => {
    expect(rebaseCoveragePath('/a/packages/web/src/components/Button.tsx', WEB_ROOT)).toBe(
      '/checkout/packages/web/src/components/Button.tsx',
    );
  });

  it('returns a path without the marker unchanged', () => {
    expect(rebaseCoveragePath('src/foo.ts', WEB_ROOT)).toBe('src/foo.ts');
    expect(rebaseCoveragePath('/elsewhere/lib/x.ts', WEB_ROOT)).toBe('/elsewhere/lib/x.ts');
  });
});

describe('rebaseCoverageData', () => {
  it('re-keys every entry and rewrites the inner path field', () => {
    const raw = { '/tmp/builds/z/packages/web/src/a.ts': fileCov('/tmp/builds/z/packages/web/src/a.ts') };
    const out = rebaseCoverageData(raw, WEB_ROOT);
    expect(Object.keys(out)).toEqual(['/checkout/packages/web/src/a.ts']);
    expect(out['/checkout/packages/web/src/a.ts'].path).toBe('/checkout/packages/web/src/a.ts');
    // nested coverage maps are preserved by reference
    expect(out['/checkout/packages/web/src/a.ts'].s).toEqual({ 0: 1 });
  });

  it('regression: a file from two different-builds_dir shards merges as ONE file, not two', () => {
    const shardA = {
      '/tmp/builds/x/packages/web/src/foo.ts': fileCov('/tmp/builds/x/packages/web/src/foo.ts'),
    };
    const shardB = {
      '/mnt/y/packages/web/src/foo.ts': fileCov('/mnt/y/packages/web/src/foo.ts'),
    };

    // Without rebasing, the divergent absolute keys merge as two distinct files
    // (the issue 1348 flake — inflated count, halved per-file coverage).
    const naive = libCoverage.createCoverageMap({});
    naive.merge(shardA);
    naive.merge(shardB);
    expect(naive.files()).toHaveLength(2);

    // After rebasing both shards onto the same checkout, they collapse to one.
    const fixed = libCoverage.createCoverageMap({});
    fixed.merge(rebaseCoverageData(shardA, WEB_ROOT));
    fixed.merge(rebaseCoverageData(shardB, WEB_ROOT));
    expect(fixed.files()).toEqual(['/checkout/packages/web/src/foo.ts']);
    // both shards' hits on statement 0 are summed on the single entry
    expect(fixed.fileCoverageFor('/checkout/packages/web/src/foo.ts').data.s[0]).toBe(2);
  });
});
