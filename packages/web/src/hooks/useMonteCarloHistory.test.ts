import { describe, expect, it } from 'vitest';
import { buildResultFromRun, type MonteCarloRunHistoryItem } from './useMonteCarloHistory';

/**
 * Unit coverage for the pure `buildResultFromRun` transform (#784 backfill).
 *
 * The function folds a persisted-distribution wire slice into the frontend
 * `MonteCarloResult` shape that drives `MonteCarloHistogram` (issue 1231). The
 * histogram-bucket merge/sort mirrors `useMonteCarloResult`'s `mapResponse`, so
 * the same dedup + chronological-sort invariants are asserted here.
 */

function makeRun(overrides: Partial<MonteCarloRunHistoryItem> = {}): MonteCarloRunHistoryItem {
  return {
    id: 'run-1',
    takenAt: '2026-03-01T12:00:00Z',
    p50: '2026-06-01',
    p80: '2026-06-08',
    p95: '2026-06-15',
    cpmFinish: '2026-05-25',
    nSimulations: 1000,
    taskCount: 42,
    delta: null,
    triggeredByName: null,
    ...overrides,
  };
}

describe('buildResultFromRun', () => {
  it('maps the run percentiles and run count straight through', () => {
    const result = buildResultFromRun(makeRun(), {
      histogram_buckets: [{ date: '2026-06-01', count: 3 }],
    });
    expect(result.p50).toBe('2026-06-01');
    expect(result.p80).toBe('2026-06-08');
    expect(result.p95).toBe('2026-06-15');
    expect(result.runs).toBe(1000);
    expect(result.lastRunAt).toBe('2026-03-01T12:00:00Z');
    expect(result.cpmFinish).toBe('2026-05-25');
  });

  it('returns empty arrays when the distribution is null (legacy run, no stored shape)', () => {
    const result = buildResultFromRun(makeRun(), null);
    expect(result.buckets).toEqual([]);
    expect(result.confidenceCurve).toEqual([]);
    expect(result.sensitivity).toEqual([]);
  });

  it('treats an undefined distribution the same as null', () => {
    const result = buildResultFromRun(makeRun(), undefined);
    expect(result.buckets).toEqual([]);
  });

  it('merges duplicate same-date buckets by summing their counts', () => {
    const result = buildResultFromRun(makeRun(), {
      histogram_buckets: [
        { date: '2026-06-01', count: 2 },
        { date: '2026-06-01', count: 5 },
        { date: '2026-06-08', count: 1 },
      ],
    });
    expect(result.buckets).toEqual([
      { weekStart: '2026-06-01', count: 7 },
      { weekStart: '2026-06-08', count: 1 },
    ]);
  });

  it('sorts buckets chronologically by ISO date regardless of input order', () => {
    const result = buildResultFromRun(makeRun(), {
      histogram_buckets: [
        { date: '2026-06-15', count: 1 },
        { date: '2026-06-01', count: 2 },
        { date: '2026-06-08', count: 3 },
      ],
    });
    expect(result.buckets.map((b) => b.weekStart)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
    ]);
  });

  it('falls back to empty-string percentiles when a baseline run carries nulls', () => {
    const result = buildResultFromRun(makeRun({ p50: null, p80: null, p95: null }), {
      histogram_buckets: [],
    });
    expect(result.p50).toBe('');
    expect(result.p80).toBe('');
    expect(result.p95).toBe('');
  });

  it('passes the confidence curve through and remaps sensitivity to camelCase', () => {
    const result = buildResultFromRun(makeRun(), {
      histogram_buckets: [],
      confidence_curve: [{ date: '2026-06-01', pct: 0.5 }],
      sensitivity: [
        { task_id: 'task-9', index: 0.42 },
        { task_id: 'task-3', index: 0.18 },
      ],
    });
    expect(result.confidenceCurve).toEqual([{ date: '2026-06-01', pct: 0.5 }]);
    expect(result.sensitivity).toEqual([
      { taskId: 'task-9', index: 0.42 },
      { taskId: 'task-3', index: 0.18 },
    ]);
  });

  it('always emits a null deltaVsCpm and an empty projectId (history rows carry no CPM delta)', () => {
    const result = buildResultFromRun(makeRun(), null);
    expect(result.deltaVsCpm).toEqual({ p50: null, p80: null, p95: null });
    expect(result.projectId).toBe('');
  });
});
