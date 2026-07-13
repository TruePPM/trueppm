import { describe, it, expect, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, useMutation } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { queryClient } from './queryClient';
import { useAuthStore } from '@/stores/authStore';

describe('queryClient — retry policy', () => {
  // Pull the configured retry function back out of the QueryClient so we can
  // exercise its branches without a network round-trip.
  const opts = queryClient.getDefaultOptions().queries!;
  const retry = opts.retry as (failureCount: number, error: unknown) => boolean;

  it('does NOT retry a 401 response (interceptor handles refresh)', () => {
    const error = new AxiosError('unauthorized', undefined, undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      data: null,
      headers: {},
      config: {} as never,
    });
    expect(retry(0, error)).toBe(false);
  });

  it('retries once for non-401 axios errors', () => {
    const error = new AxiosError('server error', undefined, undefined, undefined, {
      status: 500,
      statusText: 'Internal Server Error',
      data: null,
      headers: {},
      config: {} as never,
    });
    expect(retry(0, error)).toBe(true);
    expect(retry(1, error)).toBe(false);
  });

  it('retries once for non-axios errors too', () => {
    const error = new Error('boom');
    expect(retry(0, error)).toBe(true);
    expect(retry(1, error)).toBe(false);
  });
});

/**
 * The apiClient request interceptor (api/client.ts) already rejects every
 * request, read or write, while `sessionExpired` is true — so a mutation
 * attempted from the read-only escape hatch never reaches the network. What
 * this suite verifies is the other half (#1922): a failed mutation while the
 * user is in read-only mode re-engages the blocking re-auth modal instead of
 * leaving the write to fail silently (or the user stuck retrying a doomed
 * write in a loop).
 */
describe('queryClient — MutationCache session-expired gating (#1922)', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      sessionExpiredReadOnly: false,
    });
    queryClient.getMutationCache().clear();
  });

  it('re-opens the blocking re-auth modal when a mutation fails while in read-only mode', async () => {
    useAuthStore.setState({ sessionExpired: true, sessionExpiredReadOnly: true });

    const { result } = renderHook(
      () =>
        useMutation({
          // Mirrors what the apiClient request interceptor throws
          // synchronously once sessionExpired is true.
          mutationFn: () => Promise.reject(new Error('Session expired')),
        }),
      { wrapper },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
    // The session is still expired — reassertSessionExpired only re-opens the
    // modal, it does not itself force a re-authentication.
    expect(useAuthStore.getState().sessionExpired).toBe(true);
  });

  it('does not touch auth state when a mutation fails outside read-only mode', async () => {
    // Session is fine; a mutation can fail for an ordinary business reason
    // (validation, conflict, etc.) without this ever touching auth state.
    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => Promise.reject(new Error('Validation failed')),
        }),
      { wrapper },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
  });

  it('is a no-op when the blocking modal is already showing (not yet in read-only mode)', async () => {
    useAuthStore.setState({ sessionExpired: true, sessionExpiredReadOnly: false });

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => Promise.reject(new Error('Session expired')),
        }),
      { wrapper },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(useAuthStore.getState().sessionExpired).toBe(true);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
  });
});
