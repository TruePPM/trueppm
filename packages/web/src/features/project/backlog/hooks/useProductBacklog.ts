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
  fetchProductBacklog,
  patchTaskDor,
  postAutoRank,
  postSplitStory,
} from '../api';
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
    mutationFn: ({ taskId, dor }: { taskId: string; dor: 'ready' | 'refine' }) =>
      patchTaskDor(taskId, dor),
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
