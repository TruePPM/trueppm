/**
 * Pin hook behavior (#2390, ADR-0627).
 *
 * The interesting cases here are the ones that are invisible in the component
 * tests: which cache shapes the optimistic patch actually reaches, that a failed
 * write rolls back rather than leaving a lie on screen, and that the toast waits
 * for the server instead of racing it.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { usePinned, useTogglePin, PINNED_KEY } from './usePins';

// Hoisted fns rather than `vi.mocked(apiClient.post)` at each assertion: passing
// a bare object method to `expect` trips @typescript-eslint/unbound-method.
const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();

vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a) as Promise<unknown>,
    post: (...a: unknown[]) => postMock(...a) as Promise<unknown>,
    delete: (...a: unknown[]) => deleteMock(...a) as Promise<unknown>,
  },
}));
vi.mock('@/components/Toast', () => ({
  toast: {
    info: (...a: unknown[]) => {
      toastInfo(...a);
    },
    error: (...a: unknown[]) => {
      toastError(...a);
    },
  },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usePinned', () => {
  it('returns the pinned list', async () => {
    getMock.mockResolvedValue({
      data: [{ kind: 'project', id: 'p1', name: 'Alpha' }],
    });
    const qc = newClient();
    const { result } = renderHook(() => usePinned(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });

  it('coerces a list-envelope response to an empty array instead of throwing', async () => {
    // The E2E catch-all route answers every unmocked endpoint with
    // `{count, results}`. Letting that reach `.filter` in the rail throws inside
    // the root error boundary and blanks the whole app, which then surfaces as
    // an unrelated flake somewhere else entirely.
    getMock.mockResolvedValue({
      data: { count: 0, next: null, previous: null, results: [] },
    });
    const qc = newClient();
    const { result } = renderHook(() => usePinned(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe('useTogglePin — optimistic cache patching', () => {
  it('patches the camelCase `{items}` envelope used by useProjects', async () => {
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    // This is the real shape of the ['projects'] cache: a mapped domain object
    // behind an envelope, NOT an array of wire rows.
    qc.setQueryData(['projects'], { items: [{ id: 'p1', isPinned: false }], count: 1 });

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      const cached = qc.getQueryData<{ items: { id: string; isPinned: boolean }[] }>(['projects']);
      expect(cached?.items[0]?.isPinned).toBe(true);
    });
  });

  it('patches the snake_case program detail entry under the LIST key prefix', async () => {
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    // Program detail is ['programs', id] — a prefix-extension of the list key,
    // not ['program', id]. Deriving it as [kind, id] misses this entirely.
    qc.setQueryData(['programs', 'g1'], { id: 'g1', is_pinned: false });

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'program', id: 'g1', name: 'Apollo', next: true }));

    await waitFor(() => {
      const cached = qc.getQueryData<{ is_pinned: boolean }>(['programs', 'g1']);
      expect(cached?.is_pinned).toBe(true);
    });
  });

  it('inserts newest-first into the pinned collection', async () => {
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    qc.setQueryData(PINNED_KEY, [{ kind: 'project', id: 'old', name: 'Older' }]);

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'new', name: 'Newer', next: true }));

    await waitFor(() => {
      const cached = qc.getQueryData<{ id: string }[]>(PINNED_KEY);
      expect(cached?.[0]?.id).toBe('new');
    });
  });
});

describe('useTogglePin — failure handling', () => {
  it('rolls the optimistic patch back when the write fails', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    const qc = newClient();
    qc.setQueryData(['projects'], { items: [{ id: 'p1', isPinned: false }], count: 1 });

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<{ items: { isPinned: boolean }[] }>(['projects']);
    expect(cached?.items[0]?.isPinned).toBe(false);
  });

  it('names the cap explicitly, keyed on the machine code not the sentence', async () => {
    postMock.mockRejectedValue({
      response: { status: 400, data: { code: 'pin_limit_reached', detail: 'anything at all' } },
    });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "You've pinned 100 items — unpin one to add another.",
      );
    });
  });

  it('falls back to a generic retry message for an unrecognized failure', async () => {
    postMock.mockRejectedValue(new Error('network'));
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Couldn't pin Alpha — try again.");
    });
  });
});

describe('useTogglePin — toast timing', () => {
  it('does NOT toast success until the server confirms', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    postMock.mockReturnValue(
      new Promise((res) => {
        resolvePost = res;
      }) as never,
    );
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    // Optimistic phase: the star has already flipped, but claiming "Pinned
    // Alpha" here would be followed by "Couldn't pin Alpha" on failure — two
    // contradictory messages stacked in the same live region.
    expect(toastInfo).not.toHaveBeenCalled();

    act(() => resolvePost({ data: {} }));
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('Pinned Alpha'));
  });

  it('says "Unpinned" when removing', async () => {
    deleteMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: false }));
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('Unpinned Alpha'));
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/pin/');
  });
});
