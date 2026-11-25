import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useUpdateProjectViews } from './useProjectViews';
import { useUpdateRoleContext } from './useRoleContext';
import { useUpdateHiddenViews } from './useUpdateHiddenViews';

/**
 * Cache coupling between the lens, the deprecated `hidden_views` list and the per-project
 * view sets (ADR-1478): a write to either side must refresh the other, or the mounted
 * header shows a stale set (no lens offer) for up to its 60 s `staleTime`.
 */

const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

const viewSet = { views: [], lens: 'pm', seeded_lens: null, seed_line: null, lens_offer: null };

describe('view-set cache invalidation', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it('a lens change invalidates every project view set and the current user', async () => {
    patchMock.mockResolvedValue({ data: { role_context: 'scrum_master' } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateRoleContext(), { wrapper: wrapper(qc) });
    result.current.mutate('scrum_master');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-views'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['current-user'] });
  });

  it('the prefix reaches a cached project set, so it goes stale', async () => {
    qc.setQueryData(['project-views', 'p1'], viewSet);
    patchMock.mockResolvedValue({ data: { hidden_views: ['risk'] } });
    const { result } = renderHook(() => useUpdateHiddenViews(), { wrapper: wrapper(qc) });
    result.current.mutate(['risk']);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(['project-views', 'p1'])?.isInvalidated).toBe(true);
  });

  it('a per-view choice refreshes the current user; a layout patch does not', async () => {
    patchMock.mockResolvedValue({ data: viewSet });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProjectViews('p1'), { wrapper: wrapper(qc) });
    result.current.mutate({ last_layouts: { plan: 'grid' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['current-user'] });
    result.current.mutate({ key: 'risk', hidden: true });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['current-user'] }));
    expect(qc.getQueryData(['project-views', 'p1'])).toEqual(viewSet);
  });
});
