import { describe, expect, it } from 'vitest';
import type { MonteCarloResult } from '@/types';
import { forecastViewState, staleMessage } from './forecastViewModel';

const result = (over: Partial<MonteCarloResult> = {}): MonteCarloResult =>
  ({
    projectId: 'p1',
    runs: 1000,
    p50: '2026-12-01',
    p80: '2026-12-15',
    p95: '2027-01-05',
    buckets: [],
    cpmFinish: null,
    confidenceCurve: [],
    lastRunAt: '2026-11-20T10:00:00Z',
    forecastStaleness: 'current',
    ...over,
  }) as MonteCarloResult;

describe('forecastViewState', () => {
  it('an error wins over loading and data (never reads as "not run yet")', () => {
    expect(forecastViewState({ data: result(), isLoading: true, error: new Error('x') }).kind).toBe(
      'error',
    );
  });

  it('loading while the read is in flight', () => {
    expect(forecastViewState({ data: undefined, isLoading: true, error: null })).toEqual({
      kind: 'loading',
    });
  });

  it('no result, or a result without percentiles, is "not run yet"', () => {
    expect(forecastViewState({ data: undefined, isLoading: false, error: null }).kind).toBe(
      'not-run',
    );
    expect(
      forecastViewState({ data: result({ p80: '' }), isLoading: false, error: null }).kind,
    ).toBe('not-run');
  });

  it('a current forecast is ready, not stale, with the server last_run_at as "as of"', () => {
    expect(forecastViewState({ data: result(), isLoading: false, error: null })).toMatchObject({
      kind: 'ready',
      stale: false,
      asOf: '2026-11-20T10:00:00Z',
    });
  });

  it.each(['projectChanged', 'aged', 'unknown'] as const)(
    'server staleness %s marks the forecast stale',
    (s) => {
      const state = forecastViewState({
        data: result({ forecastStaleness: s }),
        isLoading: false,
        error: null,
      });
      expect(state).toMatchObject({ kind: 'ready', stale: true });
    },
  );
});

describe('staleMessage', () => {
  it('never claims a date moved', () => {
    for (const s of ['projectChanged', 'aged', 'unknown'] as const) {
      expect(staleMessage(s)).toMatch(/Run it again/);
      expect(staleMessage(s)).not.toMatch(/moved|slipped|later/i);
    }
  });
});
