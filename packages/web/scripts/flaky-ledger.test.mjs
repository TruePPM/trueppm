import { describe, expect, it } from 'vitest';
import {
  detectJobRetries,
  entriesFromReport,
  mergeLedger,
  parseLedger,
} from './flaky-ledger.mjs';

const ctx = { date: '2026-11-17', sha: 'abc', pipeline: 7, job: 'web:e2e:report' };

describe('detectJobRetries', () => {
  const job = (name, status, sha = 's1', id = 1) => ({ name, status, pipeline: { id, sha } });

  it('flags a job with both failed and success for one sha', () => {
    const out = detectJobRetries([job('web:e2e', 'failed'), job('web:e2e', 'success')], '2026-11-17');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'job-retry', job: 'web:e2e', sha: 's1', schema: 1 });
  });

  it('ignores a plain failure, a plain success, and fail/success on different shas', () => {
    expect(detectJobRetries([job('a', 'failed')], 'd')).toEqual([]);
    expect(detectJobRetries([job('a', 'success')], 'd')).toEqual([]);
    expect(detectJobRetries([job('a', 'failed', 's1'), job('a', 'success', 's2')], 'd')).toEqual([]);
  });
});

describe('ledger', () => {
  const report = {
    suites: [
      {
        title: 'f.spec.ts',
        file: 'e2e/f.spec.ts',
        specs: [{ title: 't', file: 'e2e/f.spec.ts', line: 1, tests: [{ status: 'flaky', results: [{}, {}] }] }],
      },
    ],
  };

  it('records retry-pass tests from a report', () => {
    const [e] = entriesFromReport(report, ctx);
    expect(e).toMatchObject({ kind: 'retry-pass', test: 'f.spec.ts › t', sha: 'abc', schema: 1 });
  });

  it('does not double-count when the same entries are merged twice', () => {
    const fresh = entriesFromReport(report, ctx);
    const once = mergeLedger([], fresh);
    const twice = mergeLedger(once.merged, fresh);
    expect(once.added).toHaveLength(1);
    expect(twice.added).toHaveLength(0);
    expect(twice.merged).toHaveLength(1);
  });

  it('skips corrupt lines instead of throwing', () => {
    expect(parseLedger('{"kind":"x"}\n{trunc\n\n')).toHaveLength(1);
  });
});
