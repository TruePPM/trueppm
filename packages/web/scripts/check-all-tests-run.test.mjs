import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSkippedSpecs, positionalFilters, walkTestFiles } from './check-all-tests-run.mjs';

describe('positionalFilters', () => {
  it('returns [] when the script runs the whole suite (the fixed state)', () => {
    expect(
      positionalFilters('NODE_OPTIONS=--max-old-space-size=4096 vitest run --coverage'),
    ).toEqual([]);
  });

  it('extracts a directory allowlist — the #1657 regression it guards against', () => {
    expect(
      positionalFilters(
        'NODE_OPTIONS=--max-old-space-size=4096 vitest run src/api src/features src/stores --coverage',
      ),
    ).toEqual(['src/api', 'src/features', 'src/stores']);
  });

  it('does not mistake env assignments or flags for path filters', () => {
    expect(positionalFilters('FOO=bar vitest run --shard=1/4 --coverage --reporter=dot')).toEqual(
      [],
    );
  });

  it('returns [] for a script that never calls `vitest run`', () => {
    expect(positionalFilters('eslint src/')).toEqual([]);
    expect(positionalFilters(undefined)).toEqual([]);
  });
});

describe('findSkippedSpecs', () => {
  it('flags on-disk specs missing from the collected set, sorted', () => {
    const onDisk = ['src/workers/cpm.test.ts', 'src/api/client.test.ts', 'src/utils/csv.test.ts'];
    const collected = new Set(['src/api/client.test.ts']);
    expect(findSkippedSpecs(onDisk, collected)).toEqual([
      'src/utils/csv.test.ts',
      'src/workers/cpm.test.ts',
    ]);
  });

  it('passes when every on-disk spec is collected', () => {
    const onDisk = ['src/a.test.ts', 'src/b.test.tsx'];
    const collected = new Set(['src/a.test.ts', 'src/b.test.tsx']);
    expect(findSkippedSpecs(onDisk, collected)).toEqual([]);
  });
});

describe('walkTestFiles', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'walk-'));
    mkdirSync(resolve(root, 'src/workers'), { recursive: true });
    mkdirSync(resolve(root, 'node_modules/pkg'), { recursive: true });
    mkdirSync(resolve(root, 'e2e'), { recursive: true });
    writeFileSync(resolve(root, 'src/workers/cpm.test.ts'), '');
    writeFileSync(resolve(root, 'src/App.test.tsx'), '');
    writeFileSync(resolve(root, 'src/index.ts'), ''); // not a test file
    writeFileSync(resolve(root, 'node_modules/pkg/dep.test.js'), ''); // excluded dir
    writeFileSync(resolve(root, 'e2e/flow.spec.ts'), ''); // excluded dir
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('collects test files under src but skips node_modules and e2e', () => {
    expect(walkTestFiles(root).sort()).toEqual(['src/App.test.tsx', 'src/workers/cpm.test.ts']);
  });
});
