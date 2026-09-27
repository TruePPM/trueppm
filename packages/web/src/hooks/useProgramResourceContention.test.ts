import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useInvalidateProgramContention,
  useProgramResourceContention,
  type ProgramContentionResponse,
} from './useProgramResourceContention';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

const RESPONSE: ProgramContentionResponse = {
  program_id: 'pg1',
  window_start: '2026-04-01',
  window_end: '2026-04-30',
  resources: [],
  resource_count: 0,
  truncated: false,
};

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

let qc: QueryClient;
beforeEach(() => {
  getMock.mockReset();
  // The hook sets its own `retry` (twice on a 5xx); zero the delay so that path
  // runs inside waitFor's window instead of the default exponential backoff.
  qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
});

describe('useProgramResourceContention', () => {
  it('is idle and fetches nothing without a program id', () => {
    const { result } = renderHook(() => useProgramResourceContention(undefined), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current).toEqual({ data: undefined, status: 'idle', error: null });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('reports loading, then success with the server body', async () => {
    getMock.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(() => useProgramResourceContention('pg1'), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toEqual(RESPONSE);
    expect(result.current.error).toBeNull();
    expect(getMock).toHaveBeenCalledWith('/programs/pg1/resource-contention/', { params: {} });
  });

  it('forwards only the filter params that are set', async () => {
    getMock.mockResolvedValue({ data: RESPONSE });
    const { result } = renderHook(
      () =>
        useProgramResourceContention('pg1', {
          start: '2026-04-01',
          end: '2026-04-30',
          resource: ['r1', 'r2'],
          status: [],
        }),
      { wrapper: makeWrapper(qc) },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(getMock).toHaveBeenCalledWith('/programs/pg1/resource-contention/', {
      params: { start: '2026-04-01', end: '2026-04-30', resource: ['r1', 'r2'] },
    });
  });

  it.each([
    [409, 'schedule-not-run'],
    [403, 'forbidden'],
  ] as const)('maps HTTP %i to the %s status with no error', async (code, status) => {
    getMock.mockRejectedValue(httpError(code));
    const { result } = renderHook(() => useProgramResourceContention('pg1'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.status).toBe(status));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeUndefined();
  });

  it('surfaces any other failure as error with the thrown error attached', async () => {
    const err = httpError(500);
    getMock.mockRejectedValue(err);
    const { result } = renderHook(() => useProgramResourceContention('pg1'), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(err);
  });
});

describe('useInvalidateProgramContention', () => {
  it('invalidates the program contention query key', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useInvalidateProgramContention('pg1'), {
      wrapper: makeWrapper(qc),
    });
    result.current();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['program-resource-contention', 'pg1'] });
  });
});
