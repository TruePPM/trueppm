import { render, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { PendingWritesGuard } from './PendingWritesGuard';

function makeQC() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** Dispatch a cancelable beforeunload and report whether the guard blocked it. */
function unloadBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function axiosError(status: number): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status);
  err.response = { status, data: { detail: 'nope' } } as AxiosResponse;
  return err;
}

/** Mounts the guard next to a probe mutation the test can drive. */
function Harness({ mutationFn }: { mutationFn: () => Promise<unknown> }) {
  const mutation = useMutation({ mutationFn });
  return createElement(
    'div',
    null,
    createElement(PendingWritesGuard),
    createElement('button', { onClick: () => mutation.mutate() }, 'go'),
  );
}

describe('PendingWritesGuard (#2028)', () => {
  it('does not block unload when there are no pending writes', () => {
    const qc = makeQC();
    render(createElement(PendingWritesGuard), { wrapper: wrapper(qc) });
    expect(unloadBlocked()).toBe(false);
  });

  it('blocks unload while a write is in-flight', async () => {
    const qc = makeQC();
    // A never-resolving mutationFn keeps the write pending (in-flight).
    const { getByText } = render(
      createElement(Harness, { mutationFn: () => new Promise<never>(() => {}) }),
      { wrapper: wrapper(qc) },
    );
    expect(unloadBlocked()).toBe(false);
    act(() => getByText('go').click());
    await waitFor(() => expect(unloadBlocked()).toBe(true));
  });

  it('stops blocking once a pending write fails (nothing left to lose)', async () => {
    const qc = makeQC();
    const { getByText } = render(
      createElement(Harness, {
        mutationFn: async () => {
          await Promise.resolve();
          // A 4xx client rejection is never counted — surfaced inline, not retried.
          throw axiosError(400);
        },
      }),
      { wrapper: wrapper(qc) },
    );
    act(() => getByText('go').click());
    // Settles to error and drops out of the pending set.
    await waitFor(() => expect(unloadBlocked()).toBe(false));
  });
});
