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
  useReparentStory,
  useQuickAddStory,
  useCreateEpic,
  usePatchEpic,
  useDeleteEpic,
  useEnsureFullProductBacklog,
  useLoadMoreProductBacklog,
} from './useProductBacklog';

const {
  fetchProductBacklogMock,
  postAutoRankMock,
  patchTaskDorMock,
  postSplitStoryMock,
  postReorderBacklogMock,
  reparentStoryMock,
  createBacklogStoryMock,
  createEpicMock,
  patchEpicMock,
  deleteEpicMock,
} = vi.hoisted(() => ({
  fetchProductBacklogMock: vi.fn(),
  postAutoRankMock: vi.fn(),
  patchTaskDorMock: vi.fn(),
  postSplitStoryMock: vi.fn(),
  postReorderBacklogMock: vi.fn(),
  reparentStoryMock: vi.fn(),
  createBacklogStoryMock: vi.fn(),
  createEpicMock: vi.fn(),
  patchEpicMock: vi.fn(),
  deleteEpicMock: vi.fn(),
}));

vi.mock('../api', async () => ({
  // Pure page-merge helpers run for real so the hook's paging is exercised end to end.
  loadedStoryCount: (await vi.importActual<typeof import('../api')>('../api')).loadedStoryCount,
  mergeBacklogPage: (await vi.importActual<typeof import('../api')>('../api')).mergeBacklogPage,
  fetchProductBacklog: fetchProductBacklogMock,
  postAutoRank: postAutoRankMock,
  patchTaskDor: patchTaskDorMock,
  postSplitStory: postSplitStoryMock,
  postReorderBacklog: postReorderBacklogMock,
  reparentStory: reparentStoryMock,
  createBacklogStory: createBacklogStoryMock,
  createEpic: createEpicMock,
  patchEpic: patchEpicMock,
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
    truncated: false,
    limit: 500,
    offset: 0,
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
  reparentStoryMock.mockResolvedValue(undefined);
  createBacklogStoryMock.mockResolvedValue(undefined);
  createEpicMock.mockResolvedValue(undefined);
  patchEpicMock.mockResolvedValue(undefined);
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
});

describe('product-backlog paging (#2344)', () => {
  const epic = { id: 'e1', name: 'Epic' } as never;
  const story = (id: string) => ({ id, name: id }) as never;
  const page1 = () =>
    makeBacklog({
      epics: [
        { epic, stories: [story('s1')], rollup: { storyCount: 3, pointsTotal: 0, pointsDone: 0 } },
      ],
      ungrouped: [story('u1')],
      truncated: true,
      limit: 2,
    });
  const page2 = () =>
    makeBacklog({
      epics: [
        { epic, stories: [story('s2')], rollup: { storyCount: 3, pointsTotal: 0, pointsDone: 0 } },
      ],
      // u1 repeats across a shifted page boundary — must not duplicate.
      ungrouped: [story('u1'), story('u2')],
      truncated: false,
      limit: 2,
      offset: 2,
    });

  it('load more fetches offset = stories loaded and merges into epics + ungrouped', async () => {
    fetchProductBacklogMock.mockResolvedValueOnce(page1()).mockResolvedValueOnce(page2());
    const qc = makeQC();
    const wrapper = makeWrapper(qc);
    const read = renderHook(() => useProductBacklog('p1'), { wrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    const more = renderHook(() => useLoadMoreProductBacklog('p1'), { wrapper });
    await act(async () => {
      await more.result.current.mutateAsync();
    });
    expect(fetchProductBacklogMock).toHaveBeenLastCalledWith('p1', 2);
    const merged = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'));
    expect(merged?.epics[0].stories.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(merged?.ungrouped.map((s) => s.id)).toEqual(['u1', 'u2']);
    expect(merged?.truncated).toBe(false);
    expect(merged?.offset).toBe(0);
  });

  it('a refetch re-reads to the depth already loaded instead of snapping to page one', async () => {
    const qc = makeQC();
    qc.setQueryData(productBacklogKeys.root('p1'), {
      ...page1(),
      ungrouped: [story('u1'), story('u2'), story('u3')],
    });
    fetchProductBacklogMock.mockResolvedValueOnce(page1()).mockResolvedValueOnce(page2());
    // Cached-but-stale data refetches on mount — the same path an invalidation takes.
    renderHook(() => useProductBacklog('p1'), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchProductBacklogMock).toHaveBeenCalledTimes(2));
    expect(fetchProductBacklogMock).toHaveBeenNthCalledWith(1, 'p1');
    expect(fetchProductBacklogMock).toHaveBeenNthCalledWith(2, 'p1', 2);
  });

  it('ensure-full loads every remaining page before a reorder and shares one in-flight load', async () => {
    const qc = makeQC();
    qc.setQueryData(productBacklogKeys.root('p1'), page1());
    const page3 = () =>
      makeBacklog({ epics: [], ungrouped: [story('u3')], truncated: false, offset: 4 });
    fetchProductBacklogMock
      .mockResolvedValueOnce({ ...page2(), truncated: true })
      .mockResolvedValueOnce(page3());
    const { result } = renderHook(() => useEnsureFullProductBacklog('p1'), {
      wrapper: makeWrapper(qc),
    });
    let full: ProductBacklog | null = null;
    await act(async () => {
      const a = result.current();
      const b = result.current();
      expect(b).toBe(a);
      full = await a;
    });
    expect(fetchProductBacklogMock).toHaveBeenNthCalledWith(1, 'p1', 2);
    expect(fetchProductBacklogMock).toHaveBeenNthCalledWith(2, 'p1', 4);
    expect(fetchProductBacklogMock).toHaveBeenCalledTimes(2);
    expect(full!.truncated).toBe(false);
    expect(full!.ungrouped.map((s) => s.id)).toEqual(['u1', 'u2', 'u3']);
    expect(qc.getQueryData(productBacklogKeys.root('p1'))).toEqual(full);
  });

  it('ensure-full merges each page into the CURRENT cache, keeping a concurrent depth-neutral write', async () => {
    const qc = makeQC();
    qc.setQueryData(productBacklogKeys.root('p1'), page1());
    let release!: (b: ProductBacklog) => void;
    fetchProductBacklogMock.mockReturnValueOnce(
      new Promise<ProductBacklog>((r) => {
        release = r;
      }),
    );
    const { result } = renderHook(() => useEnsureFullProductBacklog('p1'), {
      wrapper: makeWrapper(qc),
    });
    let done!: Promise<ProductBacklog | null>;
    act(() => {
      done = result.current();
    });
    // An optimistic reparent lands while page 2 is still in flight: it renames/moves a
    // loaded row but does not change how many stories are loaded.
    qc.setQueryData<ProductBacklog>(productBacklogKeys.root('p1'), (cur) => ({
      ...cur!,
      ungrouped: cur!.ungrouped.map((s) =>
        s.id === 'u1' ? ({ ...s, name: 'optimistic' } as never) : s,
      ),
    }));
    await act(async () => {
      release(page2());
      await done;
    });
    const ids = qc
      .getQueryData<ProductBacklog>(productBacklogKeys.root('p1'))!
      .ungrouped.map((s) => s.id);
    const rows = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'))!.ungrouped;
    expect(rows.find((s) => s.id === 'u1')!.name).toBe('optimistic');
    expect(ids).toContain('u2');
  });

  it('ensure-full leaves no hole when a refetch replaces the cache at a shallower depth mid-load', async () => {
    const qc = makeQC();
    const deep = makeBacklog({
      epics: [
        {
          epic,
          stories: [story('s1'), story('s1b')],
          rollup: { storyCount: 5, pointsTotal: 0, pointsDone: 0 },
        },
      ],
      ungrouped: [story('u1'), story('u1b')],
      truncated: true,
      limit: 2,
    });
    qc.setQueryData(productBacklogKeys.root('p1'), deep);
    let release!: (b: ProductBacklog) => void;
    fetchProductBacklogMock
      .mockReturnValueOnce(
        new Promise<ProductBacklog>((r) => {
          release = r;
        }),
      )
      .mockResolvedValueOnce(
        makeBacklog({
          epics: [
            {
              epic,
              stories: [story('s1b')],
              rollup: { storyCount: 5, pointsTotal: 0, pointsDone: 0 },
            },
          ],
          ungrouped: [story('u1b')],
          truncated: false,
          offset: 2,
        }),
      );
    const { result } = renderHook(() => useEnsureFullProductBacklog('p1'), {
      wrapper: makeWrapper(qc),
    });
    let done!: Promise<ProductBacklog | null>;
    act(() => {
      done = result.current();
    });
    // A WS-invalidation refetch swaps in a shallower (page-one) cache while offset 4 is in flight.
    qc.setQueryData(productBacklogKeys.root('p1'), page1());
    let full: ProductBacklog | null = null;
    await act(async () => {
      release(makeBacklog({ ungrouped: [story('u3')], truncated: false, offset: 4 }));
      full = await done;
    });
    const ids = [
      ...full!.epics.flatMap((g) => g.stories.map((s) => s.id)),
      ...full!.ungrouped.map((s) => s.id),
    ];
    expect(ids).toEqual(expect.arrayContaining(['s1', 's1b', 'u1', 'u1b']));
    expect(ids).not.toContain('u3');
    expect(fetchProductBacklogMock).toHaveBeenNthCalledWith(2, 'p1', 2);
  });

  it('ensure-full fetches nothing on a complete backlog', async () => {
    const qc = makeQC();
    qc.setQueryData(productBacklogKeys.root('p1'), page2());
    const { result } = renderHook(() => useEnsureFullProductBacklog('p1'), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await result.current();
    });
    expect(fetchProductBacklogMock).not.toHaveBeenCalled();
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

  it('usePatchEpic patches the scalar fields and invalidates the backlog', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePatchEpic('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ epicId: 'e1', patch: { name: 'Platform Core & SSO', notes: 'OIDC.' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchEpicMock).toHaveBeenCalledWith('e1', {
      name: 'Platform Core & SSO',
      notes: 'OIDC.',
    });
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

describe('useReparentStory (optimistic cross-group move, ADR-0183)', () => {
  it('PATCHes parent_epic and writes the caller’s post-move snapshot optimistically', async () => {
    // Never-resolving PATCH proves the relocated snapshot lands in the cache pre-response.
    reparentStoryMock.mockReturnValueOnce(new Promise(() => {}));
    const qc = makeQC();
    const before = makeBacklog({ health: { ...makeBacklog().health, storyCount: 1 } });
    const optimistic = makeBacklog({ health: { ...makeBacklog().health, storyCount: 99 } });
    qc.setQueryData<ProductBacklog>(productBacklogKeys.root('p1'), before);
    const { result } = renderHook(() => useReparentStory('p1'), { wrapper: makeWrapper(qc) });

    act(() => {
      result.current.mutate({ taskId: 'S1', parentEpicId: 'EP2', optimistic });
    });

    await waitFor(() => {
      const cached = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'));
      expect(cached?.health.storyCount).toBe(99);
    });
    expect(reparentStoryMock).toHaveBeenCalledWith('S1', 'EP2');
  });

  it('passes parentEpicId null through to ungroup the story', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => useReparentStory('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 'S1', parentEpicId: null, optimistic: makeBacklog() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reparentStoryMock).toHaveBeenCalledWith('S1', null);
  });

  it('rolls back to the pre-drag snapshot when the PATCH fails (403/offline)', async () => {
    reparentStoryMock.mockRejectedValueOnce({ response: { status: 403 } });
    const qc = makeQC();
    const before = makeBacklog({ health: { ...makeBacklog().health, storyCount: 1 } });
    const optimistic = makeBacklog({ health: { ...makeBacklog().health, storyCount: 99 } });
    qc.setQueryData<ProductBacklog>(productBacklogKeys.root('p1'), before);
    const { result } = renderHook(() => useReparentStory('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 'S1', parentEpicId: 'EP2', optimistic });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cached = qc.getQueryData<ProductBacklog>(productBacklogKeys.root('p1'));
    expect(cached?.health.storyCount).toBe(1); // optimistic 99 reverted
  });

  it('always reconciles with the server (invalidate on settle) — success and failure', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReparentStory('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate({ taskId: 'S1', parentEpicId: 'EP2', optimistic: makeBacklog() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });

    invalidateSpy.mockClear();
    reparentStoryMock.mockRejectedValueOnce(new Error('boom'));
    result.current.mutate({ taskId: 'S1', parentEpicId: 'EP2', optimistic: makeBacklog() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: productBacklogKeys.root('p1') });
  });
});
