import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateHiddenViews } from './useUpdateHiddenViews';

/**
 * Hook-level coverage for the hidden-views profile mutation (#1365): the full
 * desired set is PATCHed each call (not a delta), the empty array is the
 * "reset to default" payload, and success invalidates `['current-user']` so the
 * view bar recomposes.
 */

const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('useUpdateHiddenViews', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('PATCHes /auth/me/profile/ with the full desired hidden_views set', async () => {
    patchMock.mockResolvedValue({ data: { hidden_views: ['gantt', 'calendar'] } });
    const { result } = renderHook(() => useUpdateHiddenViews(), { wrapper: makeWrapper(qc) });
    result.current.mutate(['gantt', 'calendar']);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/auth/me/profile/', {
      hidden_views: ['gantt', 'calendar'],
    });
  });

  it('sends an empty array for "reset to default"', async () => {
    patchMock.mockResolvedValue({ data: { hidden_views: [] } });
    const { result } = renderHook(() => useUpdateHiddenViews(), { wrapper: makeWrapper(qc) });
    result.current.mutate([]);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/auth/me/profile/', { hidden_views: [] });
  });

  it('invalidates the current-user query on success', async () => {
    patchMock.mockResolvedValue({ data: { hidden_views: [] } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateHiddenViews(), { wrapper: makeWrapper(qc) });
    result.current.mutate([]);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['current-user'] });
  });
});
