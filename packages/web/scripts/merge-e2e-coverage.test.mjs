import { describe, expect, it } from 'vitest';
import libCoverage from 'istanbul-lib-coverage';
import { toRepoRelPath, rerootCoverageData } from './merge-e2e-coverage.mjs';

// Minimal istanbul FileCoverage-shaped object with one executed statement so it
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

describe('toRepoRelPath', () => {
  it('rewrites an absolute build path to a repo-root-relative packages/web path', () => {
    expect(toRepoRelPath('/tmp/builds/trueppm/trueppm/packages/web/src/foo.ts')).toBe(
      'packages/web/src/foo.ts',
    );
    expect(toRepoRelPath('/mnt/nvme1/gitlab-runner/builds/x/packages/web/src/a/b.tsx')).toBe(
      'packages/web/src/a/b.tsx',
    );
  });

  it('uses the LAST /packages/web/ marker', () => {
    expect(toRepoRelPath('/home/packages/web/dev/packages/web/src/x.ts')).toBe(
      'packages/web/src/x.ts',
    );
  });

  it('prefixes an already-package-relative src path', () => {
    expect(toRepoRelPath('src/features/board/BoardView.tsx')).toBe(
      'packages/web/src/features/board/BoardView.tsx',
    );
  });

  it('leaves an unexpected path unchanged so it fails loudly in the scanner', () => {
    expect(toRepoRelPath('/elsewhere/lib/x.ts')).toBe('/elsewhere/lib/x.ts');
  });

  it('normalizes Windows separators', () => {
    expect(toRepoRelPath('C:\\build\\packages\\web\\src\\foo.ts')).toBe('packages/web/src/foo.ts');
  });
});

describe('rerootCoverageData', () => {
  it('re-keys every entry and rewrites the inner path field', () => {
    const raw = {
      '/tmp/builds/z/packages/web/src/a.ts': fileCov('/tmp/builds/z/packages/web/src/a.ts'),
    };
    const out = rerootCoverageData(raw);
    expect(Object.keys(out)).toEqual(['packages/web/src/a.ts']);
    expect(out['packages/web/src/a.ts'].path).toBe('packages/web/src/a.ts');
    expect(out['packages/web/src/a.ts'].s).toEqual({ 0: 1 });
  });

  it('collapses two page snapshots of the same file onto one entry, summing hits', () => {
    const pageA = { '/tmp/x/packages/web/src/foo.ts': fileCov('/tmp/x/packages/web/src/foo.ts') };
    const pageB = { '/mnt/y/packages/web/src/foo.ts': fileCov('/mnt/y/packages/web/src/foo.ts') };
    const map = libCoverage.createCoverageMap({});
    map.merge(rerootCoverageData(pageA));
    map.merge(rerootCoverageData(pageB));
    expect(map.files()).toEqual(['packages/web/src/foo.ts']);
    expect(map.fileCoverageFor('packages/web/src/foo.ts').data.s[0]).toBe(2);
  });
});
