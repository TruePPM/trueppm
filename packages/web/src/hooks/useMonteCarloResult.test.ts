import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useMonteCarloResult } from './useMonteCarloResult';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useMonteCarloResult', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('is idle and not loading when projectId is undefined', () => {
    const { result } = renderHook(() => useMonteCarloResult(undefined), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fetches from /projects/{id}/monte-carlo/latest/ and maps the wire shape to MonteCarloResult', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        project_id: 'proj-1',
        runs: 1000,
        p50: '2026-10-05',
        p80: '2026-11-03',
        p95: '2026-11-30',
        histogram_buckets: [
          { date: '2026-10-05', count: 148 },
          { date: '2026-11-03', count: 88 },
        ],
        last_run_at: '2026-05-05T10:30:00Z',
      },
    });

    const { result } = renderHook(() => useMonteCarloResult('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/monte-carlo/latest/');
    expect(result.current.data).toEqual({
      projectId: 'proj-1',
      runs: 1000,
      p50: '2026-10-05',
      p80: '2026-11-03',
      p95: '2026-11-30',
      buckets: [
        { weekStart: '2026-10-05', count: 148 },
        { weekStart: '2026-11-03', count: 88 },
      ],
      lastRunAt: '2026-05-05T10:30:00Z',
    });
    expect(result.current.error).toBeNull();
  });

  it('dedupes and sorts histogram buckets by date', async () => {
    // The simulator occasionally emits multiple bucket entries for the same
    // week and the order is not guaranteed ascending. The hook must collapse
    // duplicates (summing counts) and sort ascending so downstream renderers
    // (Confidence by date, histogram) do not produce repeated keys / rows.
    getMock.mockResolvedValueOnce({
      data: {
        project_id: 'proj-1',
        runs: 100,
        p50: '2026-06-21',
        p80: '2026-06-24',
        p95: '2026-06-28',
        histogram_buckets: [
          { date: '2026-06-21', count: 10 },
          { date: '2026-05-31', count: 5 },
          { date: '2026-06-21', count: 7 },
          { date: '2026-06-07', count: 8 },
          { date: '2026-06-24', count: 4 },
          { date: '2026-06-24', count: 6 },
        ],
      },
    });

    const { result } = renderHook(() => useMonteCarloResult('proj-1'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.buckets).toEqual([
      { weekStart: '2026-05-31', count: 5 },
      { weekStart: '2026-06-07', count: 8 },
      { weekStart: '2026-06-21', count: 17 },
      { weekStart: '2026-06-24', count: 10 },
    ]);
  });

  it('leaves lastRunAt undefined when the wire payload omits last_run_at (legacy cached entries)', async () => {
    // Cached payloads written before #335 will not have the field. The hook
    // must tolerate this without crashing or throwing — `lastRunAt` is
    // optional and consumers gate the freshness UI on its presence.
    getMock.mockResolvedValueOnce({
      data: {
        project_id: 'proj-legacy',
        runs: 100,
        p50: '2026-10-05',
        p80: '2026-11-03',
        p95: '2026-11-30',
        histogram_buckets: [],
      },
    });

    const { result } = renderHook(() => useMonteCarloResult('proj-legacy'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.lastRunAt).toBeUndefined();
  });

  it('treats a 404 as the empty "no simulation run yet" state, not an error', async () => {
    // axios.isAxiosError checks for `isAxiosError === true` on the thrown object.
    const axiosError = Object.assign(new Error('not found'), {
      isAxiosError: true,
      response: { status: 404, data: { detail: 'No simulation result available.' } },
    });
    getMock.mockRejectedValueOnce(axiosError);

    const { result } = renderHook(() => useMonteCarloResult('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('propagates non-404 errors so callers can surface them', async () => {
    const axiosError = Object.assign(new Error('server boom'), {
      isAxiosError: true,
      response: { status: 500, data: { detail: 'Internal server error' } },
    });
    getMock.mockRejectedValueOnce(axiosError);

    const { result } = renderHook(() => useMonteCarloResult('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toBe('server boom');
  });

  it('propagates network errors (no response) — they are not silenced as 404', async () => {
    // ECONNREFUSED / DNS failure / offline: axios throws an AxiosError with
    // `response` undefined. The 404 branch must not swallow this.
    const networkError = Object.assign(new Error('Network Error'), {
      isAxiosError: true,
      response: undefined,
      code: 'ECONNREFUSED',
    });
    getMock.mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useMonteCarloResult('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toBe('Network Error');
  });

  it('propagates non-axios thrown errors', async () => {
    // Defence in depth: if the queryFn throws something that is not an
    // AxiosError, it must not match the 404 short-circuit.
    getMock.mockRejectedValueOnce(new Error('unexpected'));

    const { result } = renderHook(() => useMonteCarloResult('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toBe('unexpected');
  });

  it('maps an empty histogram_buckets array to an empty buckets array', async () => {
    // A simulation that produced no aggregated buckets (e.g. all runs landed
    // on the same day, or the window was collapsed) must still resolve, not
    // crash on `.map`.
    getMock.mockResolvedValueOnce({
      data: {
        project_id: 'proj-empty',
        runs: 0,
        p50: '2026-10-05',
        p80: '2026-10-05',
        p95: '2026-10-05',
        histogram_buckets: [],
      },
    });

    const { result } = renderHook(() => useMonteCarloResult('proj-empty'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual({
      projectId: 'proj-empty',
      runs: 0,
      p50: '2026-10-05',
      p80: '2026-10-05',
      p95: '2026-10-05',
      buckets: [],
    });
    expect(result.current.error).toBeNull();
  });

  it('refetches when projectId changes (query key is keyed on projectId)', async () => {
    getMock
      .mockResolvedValueOnce({
        data: {
          project_id: 'proj-A',
          runs: 100,
          p50: '2026-10-05',
          p80: '2026-10-10',
          p95: '2026-10-15',
          histogram_buckets: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          project_id: 'proj-B',
          runs: 200,
          p50: '2026-12-01',
          p80: '2026-12-05',
          p95: '2026-12-10',
          histogram_buckets: [],
        },
      });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useMonteCarloResult(id),
      { wrapper: makeWrapper(qc), initialProps: { id: 'proj-A' } },
    );

    await waitFor(() => expect(result.current.data?.projectId).toBe('proj-A'));
    expect(getMock).toHaveBeenLastCalledWith('/projects/proj-A/monte-carlo/latest/');

    rerender({ id: 'proj-B' });

    await waitFor(() => expect(result.current.data?.projectId).toBe('proj-B'));
    expect(getMock).toHaveBeenLastCalledWith('/projects/proj-B/monte-carlo/latest/');
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
