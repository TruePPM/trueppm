/**
 * Read + mutation hooks for the Product-Owner backlog (ADR-0105).
 *
 * The grooming view is fetched whole (one GET) and the mutations — auto-rank,
 * mark-ready / send-to-refine, split — invalidate the query so the server stays
 * the source of truth for the derived order, health, and DoR gate (rather than
 * re-deriving them client-side and risking drift with the auto-rank result).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  createBacklogStory,
  createEpic,
  deleteEpic,
  fetchProductBacklog,
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

export function useProductBacklog(
  projectId: string | undefined,
): UseQueryResult<ProductBacklog> {
  return useQuery({
    queryKey: productBacklogKeys.root(projectId),
    queryFn: () => fetchProductBacklog(projectId as string),
    enabled: !!projectId,
  });
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
 * The `stories` payload is the COMPLETE backlog in target order.
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
