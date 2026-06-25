/**
 * Tests for useResourceHeatmap — the weekly utilization heatmap read hook
 * (#784 backfill).
 *
 * The value this hook adds over a raw useQuery is the HTTP-code → typed-status
 * mapping: a 409 means "CPM has not been run yet" and must render as the
 * `schedule-not-run` empty state, not a generic error; a 403 is a real
 * permission error; `undefined` projectId is `idle` with no fetch. Each branch
 * is covered explicitly because the component renders different copy per status.
 * The start/weeks/group_by triple is forwarded as query params, so that mapping
 * is asserted too.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useResourceHeatmap } from './useResourceHeatmap';
import type { HeatmapResponse } from './useResourceHeatmap';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function freshClient() {
  // retryDelay:0 is required: the hook sets its own per-query `retry` fn that
  // overrides the client's `retry:false`, so a non-403/409 error retries up to
  // 2x — without a zero delay the exponential backoff outlives `waitFor`.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

/** An axios-shaped rejection carrying an HTTP status, mirroring apiClient errors. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

const RESPONSE: HeatmapResponse = {
  weeks: ['2026-W18', '2026-W19'],
  resources: [
    {
      id: 'res-1',
      name: 'Avery Diaz',
      initials: 'AD',
      job_role: 'Engineer',
      color: '#336699',
      calendar_differs_from_project: false,
      util: [80, 95],
    },
  ],
};

describe('useResourceHeatmap', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('is idle and does not fetch when projectId is undefined', () => {
    const { result } = renderHook(
      () => useResourceHeatmap(undefined, '2026-06-01', 8, 'role'),
      { wrapper: makeWrapper(freshClient()) },
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('reports loading while the request is in flight', () => {
    getMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(
      () => useResourceHeatmap('proj-1', '2026-06-01', 8, 'role'),
      { wrapper: makeWrapper(freshClient()) },
    );
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeUndefined();
  });

  it('passes start, weeks, and group_by as query params', async () => {
    getMock.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(
      () => useResourceHeatmap('proj-1', '2026-06-01', 12, 'project'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/resources/heatmap/', {
      params: { start: '2026-06-01', weeks: 12, group_by: 'project' },
    });
  });

  it('passes the loaded heatmap payload through on success', async () => {
    getMock.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(
      () => useResourceHeatmap('proj-1', '2026-06-01', 8, 'role'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toEqual(RESPONSE);
    expect(result.current.error).toBeNull();
  });

  it('maps a 409 to schedule-not-run with no error (CPM has not been run)', async () => {
    getMock.mockRejectedValue(httpError(409));
    const { result } = renderHook(
      () => useResourceHeatmap('proj-1', '2026-06-01', 8, 'role'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('schedule-not-run'));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('maps a 403 to error (permission denied is a real failure)', async () => {
    getMock.mockRejectedValue(httpError(403));
    const { result } = renderHook(
      () => useResourceHeatmap('proj-1', '2026-06-01', 8, 'role'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).not.toBeNull();
  });

  it('maps a non-409 server error (500) to error after retrying', async () => {
    getMock.mockRejectedValue(httpError(500));
    const { result } = renderHook(
      () => useResourceHeatmap('proj-1', '2026-06-01', 8, 'role'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).not.toBeNull();
    // The hook's retry fn allows up to 2 retries for non-403/409 errors,
    // so the initial call plus 2 retries = 3 total attempts.
    expect(getMock).toHaveBeenCalledTimes(3);
  });
});
