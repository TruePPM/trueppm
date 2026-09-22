/**
 * useUpdateTaskStatus unit tests.
 *
 * The board card position is driven by the ['tasks'] cache, which is only
 * invalidated on success — so a failed status move reverts the card silently.
 * The hook fires an explicit error toast on failure (#1631) so the user knows
 * the move did not stick; on success it invalidates the tasks query.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Task } from '@/types';
import { useUpdateTaskStatus } from './useBoardTasks';
import { useBoardOutboxStore } from '@/features/board/offline/boardOutboxStore';
import { useDemoOverlayStore } from '@/stores/demoOverlayStore';
import { DEMO_REFUSAL_BOARD_NOTICE } from '@/lib/demoReadOnly';
import { queryClient as appQueryClient } from '@/lib/queryClient';

const { patchMock, toastMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
  toastMock: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warm: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useBoardOutboxStore.setState({ opsByTask: {}, hydrated: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useUpdateTaskStatus (online)', () => {
  it('invalidates the tasks query on success', async () => {
    patchMock.mockResolvedValueOnce({ data: { id: 't1', status: 'COMPLETE' } });
    const qc = makeQC();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] }),
    );
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'COMPLETE' });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('optimistically moves the card in the cache before the PATCH resolves (#2037)', async () => {
    // A deferred PATCH so we can observe the cache while the request is in flight.
    let resolvePatch: (v: { data: { id: string; status: string } }) => void = () => {};
    patchMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePatch = resolve)),
    );
    const qc = makeQC();
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      [{ id: 't1', name: 'Frame wall', status: 'NOT_STARTED', serverVersion: 3 } as Task],
    );
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'IN_PROGRESS' });

    // The card moves instantly online — no snap-back waiting on the round-trip.
    await waitFor(() =>
      expect(qc.getQueryData<Task[]>(['tasks', 'p1'])?.[0].status).toBe('IN_PROGRESS'),
    );
    resolvePatch({ data: { id: 't1', status: 'IN_PROGRESS' } });
  });

  it('does not wipe sibling tasks when the cache is empty at onMutate time (#2717)', async () => {
    // Regression: cancelQueries can race an invalidation from elsewhere (a WS
    // task_updated handler, the offline reconnect flush, this mutation's own
    // onSuccess) and leave ['tasks', projectId] absent right when onMutate reads
    // it. The optimistic updater must no-op in that case, not manufacture [] —
    // which previously blanked every card on the board, not just the dragged one.
    let resolvePatch: (v: { data: { id: string; status: string } }) => void = () => {};
    patchMock.mockImplementationOnce(() => new Promise((resolve) => (resolvePatch = resolve)));
    const qc = makeQC();
    // Deliberately do NOT seed ['tasks', 'p1'] — simulates the cache being
    // absent when onMutate's setQueryData updater runs.
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'IN_PROGRESS' });

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    // The cache must stay untouched (undefined), never coerced to an empty array.
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])).toBeUndefined();
    resolvePatch({ data: { id: 't1', status: 'IN_PROGRESS' } });
  });

  it('rolls the optimistic move back and toasts when the PATCH fails (#2037, #1631)', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      [{ id: 't1', name: 'Frame wall', status: 'NOT_STARTED', serverVersion: 3 } as Task],
    );
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'IN_PROGRESS' });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't move the card — try again."),
    );
    // The optimistic patch is reverted to the pre-move snapshot on error.
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])?.[0].status).toBe('NOT_STARTED');
  });
});

describe('useUpdateTaskStatus — read-only demo card moves (ADR-1198, #3967)', () => {
  let qc: QueryClient;
  let onDemoRefusal: Mock<(message: string) => void>;

  beforeEach(() => {
    qc = makeQC();
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      [{ id: 't1', name: 'Frame wall', status: 'IN_PROGRESS', serverVersion: 3 } as Task],
    );
    onDemoRefusal = vi.fn();
    useDemoOverlayStore.getState().clear();
    // `isDemoReadOnlySync` reads the app SINGLETON, not this test's client.
    appQueryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: true });
  });

  afterEach(() => {
    useDemoOverlayStore.getState().clear();
    appQueryClient.removeQueries({ queryKey: ['edition'] });
  });

  function make403(data: Record<string, unknown>) {
    const err = new AxiosError('Request failed with status code 403');
    err.config = { headers: new AxiosHeaders() };
    err.response = {
      status: 403,
      data,
      statusText: '',
      headers: {},
      config: err.config,
    } as AxiosError['response'];
    return err;
  }

  const demo403 = () => make403({ detail: 'read-only demo', code: 'demo_read_only' });
  const plain403 = () => make403({ detail: 'Not permitted.' });

  it('leaves the card in its dropped column and never says "try again"', async () => {
    patchMock.mockRejectedValueOnce(demo403());
    const { result } = renderHook(() => useUpdateTaskStatus({ onDemoRefusal }), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    // The overlay — not the cache — is what holds the dropped column. The cache
    // rollback is deliberately untouched, so it stays truthful about the server.
    await waitFor(() =>
      expect(useDemoOverlayStore.getState().entries.get('t1')).toEqual({ status: 'COMPLETE' }),
    );
    expect(qc.getQueryData<Task[]>(['tasks', 'p1'])?.[0].status).toBe('IN_PROGRESS');
    // The red retry instruction is the defect this closes: the move DID land on
    // screen, and it will be refused every time, so "try again" is false twice.
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(onDemoRefusal).toHaveBeenCalledWith(DEMO_REFUSAL_BOARD_NOTICE);
  });

  it('suppresses the app-wide demo toast, because the board renders its own notice', async () => {
    patchMock.mockRejectedValueOnce(demo403());
    const { result } = renderHook(() => useUpdateTaskStatus({ onDemoRefusal }), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'COMPLETE' }, {
      demoRefusalHandled: true,
    });
  });

  it('keeps the app-wide toast armed for a host that passes no notice surface', async () => {
    // Without this branch a future caller would get a refused move with NO
    // affordance at all — the silent failure ADR-1197 D3 exists to prevent.
    patchMock.mockRejectedValueOnce(demo403());
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    // Byte-identical to the call this hook has always made (web rule 312).
    expect(patchMock).toHaveBeenCalledWith('/tasks/t1/', { status: 'COMPLETE' });
  });

  // NEGATIVE CONTROL — without it the branch above could be passing vacuously.
  it('an ordinary 403 still rolls back and toasts', async () => {
    patchMock.mockRejectedValueOnce(plain403());
    const { result } = renderHook(() => useUpdateTaskStatus({ onDemoRefusal }), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't move the card — try again."),
    );
    expect(useDemoOverlayStore.getState().entries.size).toBe(0);
    expect(onDemoRefusal).not.toHaveBeenCalled();
  });

  it('writes no overlay on a demo-coded 403 when the deployment is NOT a demo', async () => {
    // Both facts are load-bearing: a mislabeled 403 on a real install must never
    // fabricate a board state the server does not hold.
    appQueryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: false });
    patchMock.mockRejectedValueOnce(demo403());
    const { result } = renderHook(() => useUpdateTaskStatus({ onDemoRefusal }), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't move the card — try again."),
    );
    expect(useDemoOverlayStore.getState().entries.size).toBe(0);
    expect(onDemoRefusal).not.toHaveBeenCalled();
  });
});

describe('useUpdateTaskStatus (offline, ADR-0220)', () => {
  it('queues the move optimistically instead of hitting the network when offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const qc = makeQC();
    qc.setQueryData<Task[]>(
      ['tasks', 'p1'],
      [{ id: 't1', name: 'Frame wall', status: 'NOT_STARTED', serverVersion: 3 } as Task],
    );
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'IN_PROGRESS' });

    // No network call while offline...
    expect(patchMock).not.toHaveBeenCalled();
    // ...but the card moved optimistically...
    await waitFor(() =>
      expect(qc.getQueryData<Task[]>(['tasks', 'p1'])?.[0].status).toBe('IN_PROGRESS'),
    );
    // ...and the move is queued with the observed base server version for conflict checks.
    await waitFor(() => {
      const op = useBoardOutboxStore.getState().opsByTask['t1'];
      expect(op?.status).toBe('IN_PROGRESS');
      expect(op?.baseServerVersion).toBe(3);
    });
  });
});
