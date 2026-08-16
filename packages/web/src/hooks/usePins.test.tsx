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
const toastAction = vi.fn();
const toastDismiss = vi.fn();

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
    action: (...a: unknown[]) => {
      toastAction(...a);
      return 'toast-id';
    },
    dismiss: (...a: unknown[]) => {
      toastDismiss(...a);
    },
  },
}));

/** The action object handed to `toast.action` for the most recent call. */
function lastToastAction(): { label: string; onClick: () => void } {
  const call = toastAction.mock.calls.at(-1);
  return call?.[1] as { label: string; onClick: () => void };
}

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

  it('patches a project row keyed under its PROGRAM, not under ["projects"]', async () => {
    // useProgramProjects keys the Program → Projects tab as
    // ['programs', {programId}, 'projects'] — the owning program, not the
    // entity being pinned — so the ['projects'] prefix never reached it and the
    // toggle sat inert on that surface until a manual refetch (#2553).
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    qc.setQueryData(['programs', 'g1', 'projects'], [{ id: 'p1', isPinned: false }]);

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      const cached = qc.getQueryData<{ isPinned: boolean }[]>(['programs', 'g1', 'projects']);
      expect(cached?.[0]?.isPinned).toBe(true);
    });
  });

  it('leaves an unrelated program-scoped cache entry referentially identical', async () => {
    // The consequence of the broad ['programs'] sweep above: it spans every
    // program-scoped list. Rebuilding arrays that hold no copy of the pinned
    // project would re-render those surfaces for nothing, so a no-match map
    // must return the original array.
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const otherRows = [{ id: 'someone-else', isPinned: false }];
    qc.setQueryData(['programs', 'g1', 'projects'], [{ id: 'p1', isPinned: false }]);
    qc.setQueryData(['programs', 'g2', 'projects'], otherRows);

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      const patched = qc.getQueryData<{ isPinned: boolean }[]>(['programs', 'g1', 'projects']);
      expect(patched?.[0]?.isPinned).toBe(true);
    });
    expect(qc.getQueryData(['programs', 'g2', 'projects'])).toBe(otherRows);
  });

  it('leaves an absent pins cache absent instead of writing a one-pin rail (#2862)', async () => {
    // An absent PINNED_KEY entry means "the rail has not loaded", never "nothing
    // is pinned". Building the next rail from a manufactured [] would drop every
    // other pin until the settle refetch — and the row patches below still land,
    // so the star flips on the surface while the rail shows one item.
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    qc.setQueryData(['projects'], { items: [{ id: 'p1', isPinned: false }], count: 1 });

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      const cached = qc.getQueryData<{ items: { isPinned: boolean }[] }>(['projects']);
      expect(cached?.items[0]?.isPinned).toBe(true);
    });
    expect(qc.getQueryData(PINNED_KEY)).toBeUndefined();
  });

  it('does not collapse the rail when an invalidation lands mid-onMutate (#2862)', async () => {
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    qc.setQueryData(PINNED_KEY, [
      { kind: 'project', id: 'old-a', name: 'A' },
      { kind: 'project', id: 'old-b', name: 'B' },
    ]);

    const realCancel = qc.cancelQueries.bind(qc);
    qc.cancelQueries = (async (...args: Parameters<typeof realCancel>) => {
      await realCancel(...args);
      // Stand in for a concurrent invalidate clearing the entry in the window
      // between the snapshot read and the optimistic write.
      qc.removeQueries({ queryKey: PINNED_KEY });
    }) as typeof qc.cancelQueries;

    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'new', name: 'Newer', next: true }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    // Absent, not a one-row rail that ate the two existing pins.
    expect(qc.getQueryData<{ id: string }[]>(PINNED_KEY)).toBeUndefined();
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

  it('falls back to a generic message plus Retry for an unrecognized failure', async () => {
    postMock.mockRejectedValue(new Error('network'));
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => {
      expect(toastAction).toHaveBeenCalledWith(
        "Couldn't pin Alpha — try again.",
        expect.objectContaining({ label: 'Retry' }),
        expect.objectContaining({ variant: 'error' }),
      );
    });
  });

  it('offers NO retry on the cap — the one failure retrying cannot fix', async () => {
    postMock.mockRejectedValue({
      response: { status: 400, data: { code: 'pin_limit_reached' } },
    });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // A Retry button here would invite the user to hammer a guaranteed failure.
    expect(toastAction).not.toHaveBeenCalled();
  });
});

describe('useTogglePin — the Undo toast', () => {
  it('offers Undo, and undoing re-enters with the inverse state', async () => {
    postMock.mockResolvedValue({ data: {} });
    deleteMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));

    await waitFor(() =>
      expect(toastAction).toHaveBeenCalledWith(
        'Pinned Alpha',
        expect.objectContaining({ label: 'Undo' }),
        expect.anything(),
      ),
    );

    act(() => lastToastAction().onClick());
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/projects/p1/pin/'));
  });

  it('does not toast the undo itself — two toasts each undoing the other never ends', async () => {
    postMock.mockResolvedValue({ data: {} });
    deleteMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));
    await waitFor(() => expect(toastAction).toHaveBeenCalledTimes(1));

    act(() => lastToastAction().onClick());
    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(toastAction).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous pin toast so Undo always means the newest pin', async () => {
    postMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true }));
    await waitFor(() => expect(toastAction).toHaveBeenCalledTimes(1));
    act(() => result.current.mutate({ kind: 'project', id: 'p2', name: 'Beta', next: true }));
    await waitFor(() => expect(toastAction).toHaveBeenCalledTimes(2));

    expect(toastDismiss).toHaveBeenCalledWith('toast-id');
  });

  it('offers "Re-sort now" instead of Undo where the list held its order', async () => {
    postMock.mockResolvedValue({ data: {} });
    const onResort = vi.fn();
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() =>
      result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: true, onResort }),
    );

    await waitFor(() =>
      expect(toastAction).toHaveBeenCalledWith(
        "Pinned Alpha — it'll move to the top next time",
        expect.objectContaining({ label: 'Re-sort now' }),
        expect.anything(),
      ),
    );
    act(() => lastToastAction().onClick());
    expect(onResort).toHaveBeenCalled();
  });

  it('keeps Undo — not Re-sort — when UNpinning from a grouped list', async () => {
    deleteMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() =>
      result.current.mutate({
        kind: 'project',
        id: 'p1',
        name: 'Alpha',
        next: false,
        onResort: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(toastAction).toHaveBeenCalledWith(
        'Unpinned Alpha',
        expect.objectContaining({ label: 'Undo' }),
        expect.anything(),
      ),
    );
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

    // Optimistic phase: the pin has already flipped, but claiming "Pinned
    // Alpha" here would be followed by "Couldn't pin Alpha" on failure — two
    // contradictory messages stacked in the same live region.
    expect(toastAction).not.toHaveBeenCalled();

    act(() => resolvePost({ data: {} }));
    await waitFor(() =>
      expect(toastAction).toHaveBeenCalledWith(
        'Pinned Alpha',
        expect.anything(),
        expect.anything(),
      ),
    );
  });

  it('says "Unpinned" when removing', async () => {
    deleteMock.mockResolvedValue({ data: {} });
    const qc = newClient();
    const { result } = renderHook(() => useTogglePin(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ kind: 'project', id: 'p1', name: 'Alpha', next: false }));
    await waitFor(() =>
      expect(toastAction).toHaveBeenCalledWith(
        'Unpinned Alpha',
        expect.anything(),
        expect.anything(),
      ),
    );
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/pin/');
  });
});
