/**
 * useSyncStatus — the fix for #1945: an *online 4xx client rejection* must not
 * be counted as an offline-pending write nor drive the global sync badge, while
 * a 5xx (possibly transient) still does.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { afterEach, describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useSyncStatus } from './useSyncStatus';
import { useWsConnectionStore } from '@/stores/wsConnectionStore';

function axiosError(status: number): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status);
  err.response = { status, data: { detail: 'nope' } } as AxiosResponse;
  return err;
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** Drives a failing mutation alongside the live sync-status projection. */
function useProbe(error: unknown) {
  const mutation = useMutation({
    mutationFn: async (): Promise<never> => {
      await Promise.resolve();
      throw error;
    },
  });
  const view = useSyncStatus();
  return { mutation, view };
}

describe('useSyncStatus — online client-rejection exclusion (#1945)', () => {
  it('keeps a 4xx validation failure OFF the sync badge and out of pending writes', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useProbe(axiosError(400)), { wrapper: wrapper(qc) });

    result.current.mutation.mutate();
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));

    // The badge stays calm: no error state, no pending-write row for the rejection.
    expect(result.current.view.status.kind).toBe('synced');
    expect(result.current.view.pendingWrites).toHaveLength(0);
  });

  it('still surfaces a 5xx server error through the badge (may be transient)', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useProbe(axiosError(500)), { wrapper: wrapper(qc) });

    result.current.mutation.mutate();
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));

    expect(result.current.view.status.kind).toBe('error');
    expect(result.current.view.pendingWrites).toHaveLength(1);
  });
});

describe('useSyncStatus — live-update degradation surfaces as stale (#2053)', () => {
  // The WS connection store is a module singleton; restore it after each case.
  afterEach(() => useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 }));

  it('derives stale when the socket is prolonged-down (stale)', () => {
    useWsConnectionStore.setState({ state: 'stale' });
    const { result } = renderHook(() => useSyncStatus(), { wrapper: wrapper(makeQC()) });
    expect(result.current.status.kind).toBe('stale');
  });

  it('derives stale when the socket has failed terminally', () => {
    useWsConnectionStore.setState({ state: 'failed' });
    const { result } = renderHook(() => useSyncStatus(), { wrapper: wrapper(makeQC()) });
    expect(result.current.status.kind).toBe('stale');
  });

  it('stays synced for transient socket states (connecting / reconnecting)', () => {
    useWsConnectionStore.setState({ state: 'reconnecting' });
    const { result } = renderHook(() => useSyncStatus(), { wrapper: wrapper(makeQC()) });
    // A brief blip must not alarm — only stale/failed count.
    expect(result.current.status.kind).toBe('synced');
  });
});
