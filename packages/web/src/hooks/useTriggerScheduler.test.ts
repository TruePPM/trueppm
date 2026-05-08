/**
 * Tests for useTriggerScheduler — verifies the hook POSTs to
 * /projects/{id}/schedule/ and invalidates the resource allocation, heatmap,
 * and summary query keys so the UI refreshes after a recalculation. (#242)
 */
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useTriggerScheduler } from './useTriggerScheduler';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('useTriggerScheduler', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: {} });
  });

  it('POSTs to the project schedule endpoint with the project id', async () => {
    const { result } = renderHook(() => useTriggerScheduler('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await result.current();

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/schedule/');
  });

  it('invalidates resource allocation, heatmap, and summary queries on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useTriggerScheduler('proj-1'), {
      wrapper: makeWrapper(qc),
    });

    await result.current();

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        ['resource-allocation', 'proj-1'],
        ['resources-heatmap', 'proj-1'],
        ['resources-summary', 'proj-1'],
      ]),
    );
  });

  it('is a no-op when projectId is undefined', async () => {
    const { result } = renderHook(() => useTriggerScheduler(undefined), {
      wrapper: makeWrapper(qc),
    });

    await result.current();

    expect(postMock).not.toHaveBeenCalled();
  });
});
