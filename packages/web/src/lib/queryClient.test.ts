import { describe, it, expect, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, useMutation } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { queryClient } from './queryClient';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/components/Toast/toastStore';

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

  it('answers the first refused write with a toast and a repeat with the blocking modal (#4316)', async () => {
    useAuthStore.setState({
      sessionExpired: true,
      sessionExpiredReadOnly: true,
      readOnlyWriteCueShown: false,
    });

    const { result } = renderHook(
      () =>
        useMutation({
          // Mirrors what the apiClient request interceptor throws
          // synchronously once sessionExpired is true.
          mutationFn: () => Promise.reject(new Error('Signed out')),
        }),
      { wrapper },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isError).toBe(true));

    // First stray write: a light cue, the screen stays usable.
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(true);
    expect(useToastStore.getState().transient?.message).toBe(
      "That change wasn't saved. Sign in again to make changes.",
    );

    result.current.mutate();
    await waitFor(() => expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false));
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
          mutationFn: () => Promise.reject(new Error('Signed out')),
        }),
      { wrapper },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(useAuthStore.getState().sessionExpired).toBe(true);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
  });
});

describe('queryClient — session bridge (#4316, #4313)', () => {
  beforeEach(() => {
    queryClient.clear();
    useAuthStore.setState({
      accessToken: 'tok',
      isAuthenticated: true,
      sessionExpired: false,
      sessionExpiredReadOnly: false,
      sessionExpiredCanView: true,
    });
  });

  it('a cold cache ends the session with no "Continue viewing"', () => {
    useAuthStore.getState().markSessionExpired({ broadcast: false });
    expect(useAuthStore.getState().sessionExpiredCanView).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
  });

  it('a cache holding only the public edition read is still a cold load', () => {
    queryClient.setQueryData(['edition'], { edition: 'community' });
    useAuthStore.getState().markSessionExpired({ broadcast: false });
    expect(useAuthStore.getState().sessionExpiredCanView).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
  });

  it('a warm cache and no pending write goes straight to the read-only banner', () => {
    queryClient.setQueryData(['tasks', 'p1'], [{ id: 't1' }]);
    useAuthStore.getState().markSessionExpired({ broadcast: false });
    expect(useAuthStore.getState().sessionExpiredCanView).toBe(true);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(true);
  });

  it('a pending mutation keeps the modal and flags the interruption', () => {
    queryClient.setQueryData(['tasks', 'p1'], [{ id: 't1' }]);
    void queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => new Promise<never>(() => {}) })
      .execute(undefined);
    useAuthStore.getState().markSessionExpired({ broadcast: false });
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
    expect(useAuthStore.getState().sessionExpiredInterrupted).toBe(true);
  });

  it('endReadOnlyViewing empties the query cache', () => {
    queryClient.setQueryData(['tasks', 'p1'], [{ id: 't1' }]);
    useAuthStore.getState().markSessionExpired({ broadcast: false });
    useAuthStore.getState().endReadOnlyViewing();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
