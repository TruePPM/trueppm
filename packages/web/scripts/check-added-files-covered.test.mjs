import { describe, expect, it } from 'vitest';
import {
  coveredRelPaths,
  findUncoveredAdded,
  isCoverageEligible,
} from './check-added-files-covered.mjs';

const LCOV = [
  'TN:',
  'SF:/tmp/builds/x/packages/web/src/hooks/useThing.ts',
  'DA:1,1',
  'end_of_record',
  'SF:/mnt/y/packages/web/src/components/Button.tsx',
  'DA:1,0',
  'end_of_record',
].join('\n');

describe('coveredRelPaths', () => {
  it('extracts package-relative paths from rebased absolute SF entries, any builds_dir', () => {
    const covered = coveredRelPaths(LCOV);
    expect(covered.has('src/hooks/useThing.ts')).toBe(true);
    expect(covered.has('src/components/Button.tsx')).toBe(true);
    expect(covered.size).toBe(2);
  });

  it('keeps an SF path without the package marker as-is rather than dropping it', () => {
    const covered = coveredRelPaths('SF:src/plain/relative.ts\nend_of_record');
    expect(covered.has('src/plain/relative.ts')).toBe(true);
  });
});

describe('isCoverageEligible', () => {
  it('accepts ordinary web source files', () => {
    expect(isCoverageEligible('packages/web/src/features/foo/FooPanel.tsx')).toBe(true);
    expect(isCoverageEligible('packages/web/src/lib/util.ts')).toBe(true);
  });

  it('rejects paths outside packages/web/src', () => {
    expect(isCoverageEligible('packages/api/src/foo.py')).toBe(false);
    expect(isCoverageEligible('packages/web/e2e/foo.spec.ts')).toBe(false);
    expect(isCoverageEligible('packages/web/scripts/check-added-files-covered.mjs')).toBe(false);
  });

  it('rejects non-source and mirror-excluded files (kept in sync with vitest.config.ts)', () => {
    expect(isCoverageEligible('packages/web/src/styles/foo.css')).toBe(false);
    expect(isCoverageEligible('packages/web/src/vite-env.d.ts')).toBe(false);
    expect(isCoverageEligible('packages/web/src/hooks/useThing.test.ts')).toBe(false);
    expect(isCoverageEligible('packages/web/src/test/setup.ts')).toBe(false);
    expect(isCoverageEligible('packages/web/src/api/types.ts')).toBe(false);
    expect(isCoverageEligible('packages/web/src/features/schedule/engine/GanttEngineStub.ts')).toBe(
      false,
    );
  });
});

describe('findUncoveredAdded', () => {
  const covered = coveredRelPaths(LCOV);

  it('passes when every added eligible file is in the coverage map', () => {
    const added = ['packages/web/src/hooks/useThing.ts', 'packages/web/src/hooks/useThing.test.ts'];
    expect(findUncoveredAdded(added, covered)).toEqual([]);
  });

  it('flags an added src file absent from the coverage map — the issue 1510 dodge', () => {
    const added = ['packages/web/src/features/foo/FooPanel.tsx'];
    expect(findUncoveredAdded(added, covered)).toEqual(['packages/web/src/features/foo/FooPanel.tsx']);
  });

  it('ignores added files that are exempt or outside web src', () => {
    const added = [
      'packages/web/src/test/helpers.ts',
      'packages/web/e2e/new.spec.ts',
      'docs/features/foo.md',
      'packages/web/src/new.d.ts',
    ];
    expect(findUncoveredAdded(added, covered)).toEqual([]);
  });
});
