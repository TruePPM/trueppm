import { describe, expect, it } from 'vitest';
import type { MonteCarloResult } from '@/types';
import { AxiosError } from 'axios';
import { forecastViewState, staleMessage, runRefusalText } from './forecastViewModel';

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

describe('runRefusalText', () => {
  const refusal = (status: number, data: unknown) =>
    new AxiosError('x', 'ERR_BAD_REQUEST', undefined, undefined, {
      status,
      data,
      statusText: '',
      headers: {},
      config: { headers: {} } as never,
    });

  it('shows the server sentence and no retry for a non-retryable refusal', () => {
    expect(runRefusalText(refusal(409, { detail: 'The schedule has a dependency cycle.' }))).toBe(
      'The schedule has a dependency cycle.',
    );
  });
  it('adds a retry for a retryable refusal', () => {
    expect(runRefusalText(refusal(429, { detail: 'Too many runs.' }))).toBe(
      'Too many runs. Try again.',
    );
  });
  it('falls back for a failure with no body', () => {
    expect(runRefusalText(new Error('boom'))).toBe("Couldn't run the forecast. Try again.");
  });
  it('is null without an error', () => {
    expect(runRefusalText(null)).toBeNull();
  });
});
