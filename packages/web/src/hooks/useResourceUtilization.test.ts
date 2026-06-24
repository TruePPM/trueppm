/**
 * Tests for useResourceUtilization — the resource-load read hook (#784 backfill).
 *
 * The value this hook adds over a raw useQuery is the HTTP-code → typed-status
 * mapping: a 409 means "CPM has not been run yet" and must render as the
 * `schedule-not-run` empty state, not a generic error; a 403 is a real
 * permission error; `undefined` projectId is `idle` with no fetch. Each branch
 * is covered explicitly because the component renders different copy per status.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useResourceUtilization } from './useResourceUtilization';
import type { UtilizationResponse } from '@/features/resource/resourceUtils';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** An axios-shaped rejection carrying an HTTP status, mirroring apiClient errors. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

const RESPONSE: UtilizationResponse = {
  project_id: 'proj-1',
  window: { start: '2026-06-01', end: '2026-06-30' },
  resources: [],
  unassigned_task_count: 0,
};

describe('useResourceUtilization', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('is idle and does not fetch when projectId is undefined', () => {
    const { result } = renderHook(
      () => useResourceUtilization(undefined, '2026-06-01', '2026-06-30'),
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
      () => useResourceUtilization('proj-1', '2026-06-01', '2026-06-30'),
      { wrapper: makeWrapper(freshClient()) },
    );
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeUndefined();
  });

  it('passes the start/end window as query params', async () => {
    getMock.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(
      () => useResourceUtilization('proj-1', '2026-06-01', '2026-06-30'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/utilization/', {
      params: { start: '2026-06-01', end: '2026-06-30' },
    });
  });

  it('passes the loaded utilization payload through on success', async () => {
    getMock.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(
      () => useResourceUtilization('proj-1', '2026-06-01', '2026-06-30'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toEqual(RESPONSE);
    expect(result.current.error).toBeNull();
  });

  it('maps a 409 to schedule-not-run with no error (CPM has not been run)', async () => {
    getMock.mockRejectedValue(httpError(409));
    const { result } = renderHook(
      () => useResourceUtilization('proj-1', '2026-06-01', '2026-06-30'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('schedule-not-run'));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('maps a 403 to error (permission denied is a real failure)', async () => {
    getMock.mockRejectedValue(httpError(403));
    const { result } = renderHook(
      () => useResourceUtilization('proj-1', '2026-06-01', '2026-06-30'),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).not.toBeNull();
  });
});
