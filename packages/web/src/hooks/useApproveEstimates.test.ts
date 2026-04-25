import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useApproveEstimates } from './useApproveEstimates';

const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { estimate_status: 'accepted' } }),
);

vi.mock('@/api/client', () => ({ apiClient: { post: postMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useApproveEstimates', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs to the approve-estimates URL', async () => {
    const { result } = renderHook(
      () => useApproveEstimates('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    result.current.mutate('task-abc');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/tasks/task-abc/approve-estimates/');
  });

  it('invalidates the tasks query for the project on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useApproveEstimates('proj-1'),
      { wrapper: makeWrapper(qc) },
    );

    result.current.mutate('task-abc');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });
});
