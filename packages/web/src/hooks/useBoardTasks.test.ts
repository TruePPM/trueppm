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
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { Task } from '@/types';
import { useUpdateTaskStatus } from './useBoardTasks';
import { useBoardOutboxStore } from '@/features/board/offline/boardOutboxStore';

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

  it('fires an error toast when the PATCH fails (#1631)', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't move the card — try again."),
    );
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
