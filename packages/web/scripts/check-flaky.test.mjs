import { describe, expect, it } from 'vitest';
import { collectFlaky } from './check-flaky.mjs';

// A minimal Playwright JSON report tree: nested suites → specs → tests, each
// test carrying a `status` (expected | unexpected | flaky | skipped).
function report(specs) {
  return {
    stats: { flaky: specs.flatMap((s) => s.tests).filter((t) => t.status === 'flaky').length },
    suites: [
      {
        title: 'file.spec.ts',
        file: 'e2e/file.spec.ts',
        specs,
        suites: [],
      },
    ],
  };
}

function spec(title, status, { line = 10, attempts = 2 } = {}) {
  return {
    title,
    file: 'e2e/file.spec.ts',
    line,
    tests: [{ status, results: Array.from({ length: attempts }) }],
  };
}

describe('collectFlaky', () => {
  it('returns nothing when all tests passed on first attempt', () => {
    expect(collectFlaky(report([spec('a', 'expected'), spec('b', 'expected')]))).toEqual([]);
  });

  it('collects a test that only passed on retry', () => {
    const flaky = collectFlaky(report([spec('flaky one', 'flaky', { line: 42, attempts: 2 })]));
    expect(flaky).toHaveLength(1);
    expect(flaky[0]).toMatchObject({
      title: 'file.spec.ts › flaky one',
      file: 'e2e/file.spec.ts',
      line: 42,
      attempts: 2,
    });
  });

  it('ignores hard failures and skips (only retry-passes are flaky)', () => {
    const flaky = collectFlaky(
      report([spec('broken', 'unexpected'), spec('skipped', 'skipped'), spec('flaky', 'flaky')]),
    );
    expect(flaky.map((f) => f.title)).toEqual(['file.spec.ts › flaky']);
  });

  it('recurses into nested describe suites', () => {
    const nested = {
      stats: { flaky: 1 },
      suites: [
        {
          title: 'outer.spec.ts',
          file: 'e2e/outer.spec.ts',
          specs: [],
          suites: [
            {
              title: 'inner describe',
              specs: [spec('deep flaky', 'flaky')],
              suites: [],
            },
          ],
        },
      ],
    };
    const flaky = collectFlaky(nested);
    expect(flaky).toHaveLength(1);
    expect(flaky[0].title).toBe('outer.spec.ts › inner describe › deep flaky');
  });

  it('tolerates an empty report', () => {
    expect(collectFlaky({})).toEqual([]);
    expect(collectFlaky({ suites: [] })).toEqual([]);
  });
});
