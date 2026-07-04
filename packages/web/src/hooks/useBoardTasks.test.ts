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
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateTaskStatus } from './useBoardTasks';

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
});

describe('useUpdateTaskStatus', () => {
  it('invalidates the tasks query on success', async () => {
    patchMock.mockResolvedValueOnce({ data: { id: 't1', status: 'COMPLETE' } });
    const qc = makeQC();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('fires an error toast when the PATCH fails (#1631)', async () => {
    patchMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'p1', taskId: 't1', status: 'COMPLETE' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastMock.error).toHaveBeenCalledWith("Couldn't move the card — try again.");
  });
});
