/**
 * Read + mutation hooks for the Product-Owner backlog (ADR-0105).
 *
 * The grooming view is fetched whole (one GET) and the mutations — auto-rank,
 * mark-ready / send-to-refine, split — invalidate the query so the server stays
 * the source of truth for the derived order, health, and DoR gate (rather than
 * re-deriving them client-side and risking drift with the auto-rank result).
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import {
  createBacklogStory,
  createEpic,
  deleteEpic,
  fetchProductBacklog,
  loadedStoryCount,
  mergeBacklogPage,
  patchEpic,
  patchTaskDor,
  postAutoRank,
  postReorderBacklog,
  postSplitStory,
  reparentStory,
  type EpicScalarPatch,
  type ReorderEntry,
} from '../api';
import type { DorState } from '@/types';
import type { ProductBacklog } from '../types';

export const productBacklogKeys = {
  root: (projectId: string | undefined) => ['product-backlog', projectId] as const,
};

/**
 * Fetch the first page, then keep paging until at least `minStories` stories are loaded
 * (or the backlog ends). Used by refetches so a user who clicked "Load next" does not
 * snap back to page one when a mutation or WS event invalidates the query.
 */
async function fetchProductBacklogPages(
  projectId: string,
  minStories: number,
): Promise<ProductBacklog> {
  let backlog = await fetchProductBacklog(projectId);
  while (backlog.truncated && loadedStoryCount(backlog) < minStories) {
    const before = loadedStoryCount(backlog);
    backlog = mergeBacklogPage(backlog, await fetchProductBacklog(projectId, before));
    if (loadedStoryCount(backlog) === before) break;
  }
  return backlog;
}

/**
 * Cache invariant (#2344): `['product-backlog', projectId]` holds ONE merged
 * {@link ProductBacklog} covering rank-ordered pages `[0, loaded)`, never a single page.
 * "Load next" appends a page into that entry ({@link useLoadMoreProductBacklog}), and a
 * refetch re-reads to the same depth ({@link fetchProductBacklogPages}), so every
 * existing writer (optimistic reorder/reparent, WS invalidation) keeps working on the
 * one shape it already knows.
 */
export function useProductBacklog(projectId: string | undefined): UseQueryResult<ProductBacklog> {
  const qc = useQueryClient();
  const key = productBacklogKeys.root(projectId);
  return useQuery({
    queryKey: key,
    queryFn: () =>
      fetchProductBacklogPages(
        projectId as string,
        loadedStoryCount(qc.getQueryData<ProductBacklog>(key)),
      ),
    enabled: !!projectId,
  });
}

/**
 * Fetch the next rank page past the server cap (offset = stories already loaded) and
 * merge it into the cached backlog — the escape hatch behind the truncation notice
 * (packages/web rule 296).
 */
export function useLoadMoreProductBacklog(projectId: string | undefined) {
  const qc = useQueryClient();
  const key = productBacklogKeys.root(projectId);
  return useMutation({
    mutationFn: async (): Promise<ProductBacklog | null> => {
      const current = qc.getQueryData<ProductBacklog>(key);
      if (!current) return null;
      return fetchProductBacklog(projectId as string, loadedStoryCount(current));
    },
    onSuccess: (page) => {
      if (!page) return;
      qc.setQueryData<ProductBacklog>(key, (cur) => (cur ? mergeBacklogPage(cur, page) : page));
    },
  });
}

/**
 * Load every remaining rank page into the cached backlog and resolve with the complete
 * backlog (#2344). The reorder endpoint (ADR-0110) validates the payload against the
 * WHOLE backlog and 409s on any missing story, so a drag on a truncated backlog must
 * read the rest first or it can never save. Concurrent callers (drag start prefetches,
 * the drop awaits) share one in-flight load. Resolves `null` when nothing is cached; a
 * page that adds no new story stops the loop, so the result can still be `truncated`
 * and the caller must check.
 */
export function useEnsureFullProductBacklog(
  projectId: string | undefined,
): () => Promise<ProductBacklog | null> {
  const qc = useQueryClient();
  const inflight = useRef<Promise<ProductBacklog | null> | null>(null);
  return useCallback(() => {
    if (inflight.current) return inflight.current;
    const key = productBacklogKeys.root(projectId);
    const run = (async (): Promise<ProductBacklog | null> => {
      let backlog = qc.getQueryData<ProductBacklog>(key);
      if (!backlog || !projectId) return null;
      while (backlog.truncated) {
        const before = loadedStoryCount(backlog);
        backlog = mergeBacklogPage(backlog, await fetchProductBacklog(projectId, before));
        qc.setQueryData<ProductBacklog>(key, backlog);
        if (loadedStoryCount(backlog) === before) break;
      }
      return backlog;
    })();
    inflight.current = run;
    const clear = () => {
      inflight.current = null;
    };
    void run.then(clear, clear);
    return run;
  }, [qc, projectId]);
}

function useInvalidate(projectId: string | undefined): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: productBacklogKeys.root(projectId) });
  };
}

export function useAutoRank(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: () => postAutoRank(projectId as string),
    onSuccess: invalidate,
  });
}

export function useSetDor(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ taskId, dor }: { taskId: string; dor: DorState }) => patchTaskDor(taskId, dor),
    onSuccess: invalidate,
  });
}

export function useSplitStory(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ taskId, name }: { taskId: string; name?: string }) =>
      postSplitStory(taskId, name),
    onSuccess: invalidate,
  });
}

/**
 * Manual drag reorder (ADR-0110, #494). Optimistically writes the caller-supplied backlog
 * snapshot so the dragged row stays put, then persists it. On any failure — including a 409
 * stale-snapshot conflict — it rolls back to the pre-drag cache and refetches, so the view
 * snaps to the authoritative server order (the caller surfaces the "backlog changed" notice).
 * The `stories` payload is the COMPLETE backlog in target order — on a truncated backlog the
 * caller loads the remaining pages first ({@link useEnsureFullProductBacklog}).
 */
export function useReorderBacklog(projectId: string | undefined) {
  const qc = useQueryClient();
  const key = productBacklogKeys.root(projectId);
  return useMutation({
    mutationFn: ({ stories }: { stories: ReorderEntry[]; optimistic: ProductBacklog }) =>
      postReorderBacklog(projectId as string, stories),
    onMutate: async ({ optimistic }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ProductBacklog>(key);
      qc.setQueryData<ProductBacklog>(key, optimistic);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    // Always reconcile with the server (source of truth for the derived rank).
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * Drag a story into an epic — or out of all epics (ADR-0183). A single
 * optimistic `parent_epic` PATCH: the caller supplies the post-move backlog snapshot
 * (the story relocated to the target group), which lands in the cache immediately so
 * the row follows the drop, then the PATCH persists it. On any failure the move rolls
 * back to the pre-drag cache and the view refetches (the caller surfaces the reload
 * notice + the aria-live failure line). Unlike the reorder endpoint this carries no
 * `server_version`, so it cannot 409 — the failure modes are 403 (permission), 400
 * (invalid target, which the UI structurally prevents), or the network.
 */
export function useReparentStory(projectId: string | undefined) {
  const qc = useQueryClient();
  const key = productBacklogKeys.root(projectId);
  return useMutation({
    mutationFn: ({
      taskId,
      parentEpicId,
    }: {
      taskId: string;
      parentEpicId: string | null;
      optimistic: ProductBacklog;
    }) => reparentStory(taskId, parentEpicId),
    onMutate: async ({ optimistic }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ProductBacklog>(key);
      qc.setQueryData<ProductBacklog>(key, optimistic);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** Inline quick-add of a title-only backlog story (#921). */
export function useQuickAddStory(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ name }: { name: string }) => createBacklogStory(projectId as string, name),
    onSuccess: invalidate,
  });
}

/**
 * Epic CRUD on the grooming view. All three are invalidate-only (matching the
 * quick-add / DoR hooks): the single grooming refetch re-derives the epic groups, so a
 * created epic appears as a childless group and a deleted epic's orphaned stories move to
 * Ungrouped — no client-side cache surgery. `TaskViewSet` broadcasts the task events.
 */
export function useCreateEpic(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ name }: { name: string }) => createEpic(projectId as string, name),
    onSuccess: invalidate,
  });
}

/** Batch-save the {@link import('../components/EpicDetailDrawer')}'s name/description edits. */
export function usePatchEpic(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ epicId, patch }: { epicId: string; patch: EpicScalarPatch }) =>
      patchEpic(epicId, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteEpic(projectId: string | undefined) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ epicId }: { epicId: string }) => deleteEpic(epicId),
    onSuccess: invalidate,
  });
}
