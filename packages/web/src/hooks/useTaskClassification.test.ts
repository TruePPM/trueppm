import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useClassifySubtree } from './useTaskClassification';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiClient: { patch: patchMock } }));

const REPORT = {
  subtree: 'p',
  matched: 4,
  governance: {
    requested: 'flow',
    applied: 2,
    unchanged: 1,
    overrides_kept: 1,
    has_inherit_bit: true,
  },
  delivery_mode: {
    requested: 'scrum',
    applied: 3,
    unchanged: 0,
    overrides_kept: null,
    has_inherit_bit: false,
  },
  skipped: [{ id: 'm', code: 'milestone_gate', axes: ['delivery_mode'], message: 'skipped' }],
};

function wrapper(queryClient: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

describe('useClassifySubtree', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: REPORT });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('PATCHes the project-scoped classification route with the axis body', async () => {
    const { result } = renderHook(() => useClassifySubtree(), { wrapper: wrapper(queryClient) });
    result.current.mutate({
      projectId: 'proj-1',
      subtree: 'p',
      cascade: true,
      governance_class: 'flow',
      delivery_mode: 'scrum',
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/projects/proj-1/tasks/classification/', {
      subtree: 'p',
      cascade: true,
      governance_class: 'flow',
      delivery_mode: 'scrum',
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    // projectId routes the call; it is never part of the body.
    expect(patchMock.mock.calls[0][1]).not.toHaveProperty('projectId');
  });

  it('returns the server report verbatim, including a null overrides_kept', async () => {
    const { result } = renderHook(() => useClassifySubtree(), { wrapper: wrapper(queryClient) });
    result.current.mutate({
      projectId: 'proj-1',
      subtree: 'p',
      cascade: true,
      governance_class: 'flow',
      delivery_mode: 'scrum',
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // null, not 0 — the receipt must not claim "there were no overrides" on an
    // axis that structurally cannot have one.
    expect(result.current.data?.delivery_mode?.overrides_kept).toBeNull();
    expect(result.current.data?.governance?.overrides_kept).toBe(1);
    expect(result.current.data?.skipped).toHaveLength(1);
  });

  it('invalidates the project task list so the grid shows what actually landed', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useClassifySubtree(), { wrapper: wrapper(queryClient) });
    result.current.mutate({
      projectId: 'proj-1',
      subtree: 'p',
      cascade: true,
      governance_class: null,
      delivery_mode: 'kanban',
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks', 'proj-1'] });
  });

  it('leaves the cache untouched on failure — nothing was optimistically painted', async () => {
    patchMock.mockRejectedValueOnce(new Error('403'));
    const spy = vi.spyOn(queryClient, 'setQueryData');
    const { result } = renderHook(() => useClassifySubtree(), { wrapper: wrapper(queryClient) });
    result.current.mutate({
      projectId: 'proj-1',
      subtree: 'p',
      cascade: true,
      governance_class: 'gated',
      delivery_mode: null,
      preserve_governance_overrides: true,
      skip_milestones: true,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).not.toHaveBeenCalled();
  });
});
