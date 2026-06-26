/**
 * useProductBacklog hook unit tests (#784 coverage backfill, ADR-0105 / ADR-0110).
 *
 * The grooming hooks keep the server as the source of truth for the derived rank,
 * health, and DoR gate, so their contract is "mutate → invalidate the whole backlog".
 * The branch that carries real UI state is `useReorderBacklog` (ADR-0110, #494): it
 * optimistically writes the caller-supplied backlog snapshot so the dragged row stays
 * put, then on ANY failure — including a 409 stale-snapshot conflict — rolls back to
 * the pre-drag cache and refetches so the view snaps to the authoritative order.
 *
 * The hooks call the `../api` boundary functions (not apiClient directly), so the api
 * module is mocked at that layer — matching the hook's real import surface.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { ProductBacklog } from '../types';
import type { ReorderEntry } from '../api';
import {
  productBacklogKeys,
  useProductBacklog,
  useAutoRank,
  useSetDor,
  useSplitStory,
  useReorderBacklog,
  useQuickAddStory,
  useCreateEpic,
  useRenameEpic,
  useDeleteEpic,
} from './useProductBacklog';

const {
  fetchProductBacklogMock,
  postAutoRankMock,
  patchTaskDorMock,
  postSplitStoryMock,
  postReorderBacklogMock,
  createBacklogStoryMock,
  createEpicMock,
  renameEpicMock,
  deleteEpicMock,
} = vi.hoisted(() => ({
  fetchProductBacklogMock: vi.fn(),
  postAutoRankMock: vi.fn(),
  patchTaskDorMock: vi.fn(),
  postSplitStoryMock: vi.fn(),
  postReorderBacklogMock: vi.fn(),
  createBacklogStoryMock: vi.fn(),
  createEpicMock: vi.fn(),
  renameEpicMock: vi.fn(),
  deleteEpicMock: vi.fn(),
}));

vi.mock('../api', () => ({
  fetchProductBacklog: fetchProductBacklogMock,
  postAutoRank: postAutoRankMock,
  patchTaskDor: patchTaskDorMock,
  postSplitStory: postSplitStoryMock,
  postReorderBacklog: postReorderBacklogMock,
  createBacklogStory: createBacklogStoryMock,
  createEpic: createEpicMock,
  renameEpic: renameEpicMock,
  deleteEpic: deleteEpicMock,
}));

function makeBacklog(overrides: Partial<ProductBacklog> = {}): ProductBacklog {
  return {
    epics: [],
    ungrouped: [],
    health: {
      dorPct: 0,
      readyCount: 0,
      readyPoints: 0,
      capacityPoints: null,
      unestimated: 0,
      acMet: 0,
      acTotal: 0,
      storyCount: 0,
    },
    scoring: { model: 'wsjf' as ProductBacklog['scoring']['model'] },
    ...overrides,
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

const ENTRIES: ReorderEntry[] = [
  { id: 'a', server_version: 1 },
  { id: 'b', server_version: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  fetchProductBacklogMock.mockResolvedValue(makeBacklog());
  postAutoRankMock.mockResolvedValue({ reranked: 0 });
  patchTaskDorMock.mockResolvedValue(undefined);
  postSplitStoryMock.mockResolvedValue(undefined);
  postReorderBacklogMock.mockResolvedValue({ updated: 0 });
  createBacklogStoryMock.mockResolvedValue(undefined);
  createEpicMock.mockResolvedValue(undefined);
  renameEpicMock.mockResolvedValue(undefined);
  deleteEpicMock.mockResolvedValue(undefined);
});

describe('useProductBacklog (read)', () => {
  it('fetches the grooming view for the project', async () => {
    const backlog = makeBacklog({ ungrouped: [{ id: 'x' } as never] });
    fetchProductBacklogMock.mockResolvedValueOnce(backlog);
    const qc = makeQC();
    const { result } = renderHook(() => useProductBacklog('p1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchProductBacklogMock).toHaveBeenCalledWith('p1');
    expect(result.current.data).toBe(backlog);
  });

  it('does not fetch while the projectId is undefined (gated query)', () => {
    const qc = makeQC();
    renderHook(() => useProductBacklog(undefined), { wrapper: makeWrapper(qc) });

    expect(fetchProductBacklogMock).not.toHaveBeenCalled();
  });
});

describe('useAutoRank', () => {
  it('triggers the server auto-rank and invalidates the backlog', async () => {
    postAutoRankMock.mockResolvedValueOnce({ reranked: 7 });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAutoRank('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postAutoRankMock).toHaveBeenCalledWith('p1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});

describe('useSetDor', () => {
  it('patches the task DoR and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetDor('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 't1', dor: 'ready' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchTaskDorMock).toHaveBeenCalledWith('t1', 'ready');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});

describe('useSplitStory', () => {
  it('splits the story (optional name) and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSplitStory('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 't1', name: 'Part B' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postSplitStoryMock).toHaveBeenCalledWith('t1', 'Part B');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});

describe('useQuickAddStory', () => {
  it('creates a title-only story and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useQuickAddStory('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ name: 'New idea' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createBacklogStoryMock).toHaveBeenCalledWith('p1', 'New idea');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});

describe('epic CRUD (#1339)', () => {
  it('useCreateEpic creates an epic and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateEpic('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ name: 'Platform Core' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createEpicMock).toHaveBeenCalledWith('p1', 'Platform Core');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });

  it('useCreateEpic surfaces the error (e.g. a 403) and does NOT invalidate', async () => {
    createEpicMock.mockRejectedValueOnce({ response: { status: 403 } });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateEpic('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ name: 'No perms' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('useRenameEpic patches the name and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRenameEpic('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ epicId: 'e1', name: 'Platform Core & SSO' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(renameEpicMock).toHaveBeenCalledWith('e1', 'Platform Core & SSO');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });

  it('useDeleteEpic deletes the epic and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteEpic('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ epicId: 'e1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteEpicMock).toHaveBeenCalledWith('e1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});

describe('useReorderBacklog (optimistic drag, ADR-0110)', () => {
  it('persists the COMPLETE backlog in target order', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useReorderBacklog('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ stories: ENTRIES, optimistic: makeBacklog() });

    await waitFor(() => expect(postReorderBacklogMock).toHaveBeenCalledTimes(1));
    expect(postReorderBacklogMock).toHaveBeenCalledWith('p1', ENTRIES);
  });

  it('optimistically writes the caller-supplied snapshot before the server responds', async () => {
    // Never-resolving reorder proves the dragged order lands in the cache pre-response.
    postReorderBacklogMock.mockReturnValueOnce(new Promise(() => {}));
    const qc = makeQC();
    const before = makeBacklog({ health: { ...makeBacklog().health, storyCount: 1 } });
    const optimistic = makeBacklog({ health: { ...makeBacklog().health, storyCount: 99 } });
    qc.setQueryData<ProductBacklog>(productBacklogKeys.root('p1'), before);
    const { result } = renderHook(() => useReorderBacklog('p1'), { wrapper: makeWrapper(qc) });

    act(() => {
      result.current.mutate({ stories: ENTRIES, optimistic });
    });

    await waitFor(() => {
      const cached = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'));
      expect(cached?.health.storyCount).toBe(99);
    });
  });

  it('rolls back to the pre-drag snapshot on a generic failure', async () => {
    postReorderBacklogMock.mockRejectedValueOnce(new Error('boom'));
    const qc = makeQC();
    const before = makeBacklog({ health: { ...makeBacklog().health, storyCount: 1 } });
    const optimistic = makeBacklog({ health: { ...makeBacklog().health, storyCount: 99 } });
    qc.setQueryData<ProductBacklog>(productBacklogKeys.root('p1'), before);
    const { result } = renderHook(() => useReorderBacklog('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ stories: ENTRIES, optimistic });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'));
    // Snapped back to the pre-drag order; the optimistic 99 is gone.
    expect(cached?.health.storyCount).toBe(1);
  });

  it('rolls back AND surfaces the 409 stale-snapshot conflict verbatim', async () => {
    // A concurrent PO changed the backlog → the server rejects the stale snapshot with 409.
    const conflict = { response: { status: 409 } };
    postReorderBacklogMock.mockRejectedValueOnce(conflict);
    const qc = makeQC();
    const before = makeBacklog({ health: { ...makeBacklog().health, storyCount: 1 } });
    const optimistic = makeBacklog({ health: { ...makeBacklog().health, storyCount: 99 } });
    qc.setQueryData<ProductBacklog>(productBacklogKeys.root('p1'), before);
    const { result } = renderHook(() => useReorderBacklog('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ stories: ENTRIES, optimistic });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The hook does not swallow the conflict — the caller surfaces the "backlog changed" notice.
    expect(result.current.error).toBe(conflict);
    const cached = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'));
    expect(cached?.health.storyCount).toBe(1);
  });

  it('always reconciles with the server (invalidate on settle) — success and failure', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReorderBacklog('p1'), { wrapper: makeWrapper(qc) });

    // success path
    result.current.mutate({ stories: ENTRIES, optimistic: makeBacklog() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });

    // failure path also reconciles
    invalidateSpy.mockClear();
    postReorderBacklogMock.mockRejectedValueOnce(new Error('boom'));
    result.current.mutate({ stories: ENTRIES, optimistic: makeBacklog() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});
