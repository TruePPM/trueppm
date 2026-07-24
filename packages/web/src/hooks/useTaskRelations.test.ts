import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useTaskRelations,
  useCreateTaskRelation,
  useDeleteTaskRelation,
  useUpdateTaskRelation,
} from './useTaskRelations';

// ---------------------------------------------------------------------------
// API client mock — this UI is a pure consumer of GET /api/v1/task-relations/
// (#2068). The endpoint returns a BARE ARRAY, not a paginated envelope; the
// bare-array contract is asserted below (#2321) and enforced server-side by
// TaskRelationViewSet.pagination_class = None.
// ---------------------------------------------------------------------------

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
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

const TASK = 't1';

function apiRelation(over: Record<string, unknown> = {}) {
  return {
    id: 'rel-1',
    source: TASK,
    target: 't2',
    relation_type: 'blocks',
    note: '',
    created_by: 'u1',
    created_at: '2026-07-16T00:00:00Z',
    source_card: null,
    target_card: null,
    ...over,
  };
}

describe('useTaskRelations', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
  });

  it('returns empty arrays and does not fetch when taskId is null', () => {
    const { result } = renderHook(() => useTaskRelations(null), { wrapper: makeWrapper(qc) });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.outgoing).toEqual([]);
    expect(result.current.incoming).toEqual([]);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('calls the correct endpoint with the task id as a param', async () => {
    getMock.mockResolvedValueOnce({ data: [] });
    const { result } = renderHook(() => useTaskRelations(TASK), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/task-relations/', { params: { task: TASK } });
  });

  it('splits rows into outgoing (source===taskId) and incoming (target===taskId)', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        // outgoing — task is the source
        apiRelation({ id: 'out-1', source: TASK, target: 't2', relation_type: 'blocks' }),
        // incoming — task is the target
        apiRelation({ id: 'in-1', source: 't3', target: TASK, relation_type: 'duplicates' }),
      ],
    });

    const { result } = renderHook(() => useTaskRelations(TASK), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.outgoing).toHaveLength(1);
    expect(result.current.outgoing[0].id).toBe('out-1');
    expect(result.current.outgoing[0].relationType).toBe('blocks');

    expect(result.current.incoming).toHaveLength(1);
    expect(result.current.incoming[0].id).toBe('in-1');
    expect(result.current.incoming[0].relationType).toBe('duplicates');
  });

  it('maps snake_case card fields to camelCase', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        apiRelation({
          id: 'x',
          source: TASK,
          target: 'cross',
          target_card: {
            id: 'cross',
            title: 'Cross task',
            hex_id: '00A3F',
            project_id: 'p2',
            project_name: 'Sibling',
            is_milestone: false,
            early_start: '2026-08-01',
            early_finish: '2026-08-05',
            is_critical: true,
          },
        }),
      ],
    });

    const { result } = renderHook(() => useTaskRelations(TASK), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const card = result.current.outgoing[0].targetCard;
    expect(card).toEqual({
      id: 'cross',
      title: 'Cross task',
      hexId: '00A3F',
      projectId: 'p2',
      projectName: 'Sibling',
      isMilestone: false,
      earlyStart: '2026-08-01',
      earlyFinish: '2026-08-05',
      isCritical: true,
    });
  });

  it('propagates an API error', async () => {
    getMock.mockRejectedValueOnce(new Error('Boom'));
    const { result } = renderHook(() => useTaskRelations(TASK), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('Boom');
  });

  it('surfaces an error (not silent bad data) when the response is a paginated envelope', async () => {
    // Regression for #2321: the drawer showed "Couldn't load related tasks"
    // because TaskRelationViewSet leaked the project-wide PageNumberPagination,
    // returning `{count, next, previous, results}` instead of a bare array. The
    // hook reads `res.data.map(...)`, so an envelope throws — this test locks
    // the bare-array contract: if the backend ever re-paginates this endpoint,
    // the hook errors loudly rather than rendering wrong/empty data silently.
    getMock.mockResolvedValueOnce({
      data: { count: 1, next: null, previous: null, results: [apiRelation()] },
    });
    const { result } = renderHook(() => useTaskRelations(TASK), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.outgoing).toEqual([]);
    expect(result.current.incoming).toEqual([]);
  });
});

describe('relation mutations — cache invalidation', () => {
  let qc: QueryClient;
  // The top-level query key of every invalidateQueries call, captured to assert
  // the relation key is hit and the tasks key is NOT (relations don't touch CPM).
  let invalidatedTopKeys: unknown[];

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
    invalidatedTopKeys = [];
    vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters?: unknown) => {
      const key = (filters as { queryKey?: unknown[] } | undefined)?.queryKey;
      invalidatedTopKeys.push(key?.[0]);
      return Promise.resolve();
    });
  });

  it('create invalidates ["task-relations", taskId] and NOT ["tasks"]', async () => {
    postMock.mockResolvedValueOnce({ data: apiRelation() });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTaskRelation(TASK), { wrapper: makeWrapper(qc) });

    result.current.mutate({ source: TASK, target: 't2', relation_type: 'blocks' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/task-relations/', {
      source: TASK,
      target: 't2',
      relation_type: 'blocks',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-relations', TASK] });
    // Relations never affect the card/CPM, so the tasks cache is untouched.
    expect(invalidatedTopKeys).toContain('task-relations');
    expect(invalidatedTopKeys).not.toContain('tasks');
  });

  it('delete invalidates ["task-relations", taskId] and NOT ["tasks"]', async () => {
    deleteMock.mockResolvedValueOnce({ data: null });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTaskRelation(TASK), { wrapper: makeWrapper(qc) });

    result.current.mutate('rel-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteMock).toHaveBeenCalledWith('/task-relations/rel-1/');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-relations', TASK] });
    expect(invalidatedTopKeys).toContain('task-relations');
    expect(invalidatedTopKeys).not.toContain('tasks');
  });

  it('update PATCHes the note and invalidates ["task-relations", taskId]', async () => {
    patchMock.mockResolvedValueOnce({ data: apiRelation({ note: 'see also' }) });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTaskRelation(TASK), { wrapper: makeWrapper(qc) });

    result.current.mutate({ id: 'rel-1', note: 'see also' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(patchMock).toHaveBeenCalledWith('/task-relations/rel-1/', { note: 'see also' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-relations', TASK] });
  });
});
