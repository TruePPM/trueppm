/**
 * Mutation hooks for the story-detail grooming drawer (#1043 / #731).
 *
 * The drawer batches the editable scalar fields (title, description, type, epic,
 * points, scoring inputs) into one PATCH, and mutates acceptance criteria through
 * their own flat endpoint. Every mutation invalidates the product-backlog query so
 * the row, AC meter, computed score, DoR gate, and grooming-health strip all
 * reconcile from the server (the same source-of-truth posture as the page's other
 * mutations — never re-derive the score/health client-side).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createCriterion,
  deleteCriterion,
  patchStory,
  updateCriterion,
  type StoryScalarPatch,
} from '../api';
import { productBacklogKeys } from './useProductBacklog';

function useInvalidateBacklog(projectId: string | undefined): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: productBacklogKeys.root(projectId) });
  };
}

/** Batch-save the drawer's scalar story edits (#1043). */
export function usePatchStory(projectId: string | undefined) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: ({ taskId, patch }: { taskId: string; patch: StoryScalarPatch }) =>
      patchStory(taskId, patch),
    onSuccess: invalidate,
  });
}

/** Append an acceptance criterion to a story (#731). */
export function useCreateCriterion(projectId: string | undefined) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: ({ taskId, text, position }: { taskId: string; text: string; position: number }) =>
      createCriterion(taskId, text, position),
    onSuccess: invalidate,
  });
}

/** Edit a criterion's text, met flag, or position (#731). */
export function useUpdateCriterion(projectId: string | undefined) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: ({
      criterionId,
      patch,
    }: {
      criterionId: string;
      patch: { text?: string; met?: boolean; position?: number };
    }) => updateCriterion(criterionId, patch),
    onSuccess: invalidate,
  });
}

/** Remove a criterion (soft-delete) (#731). */
export function useDeleteCriterion(projectId: string | undefined) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: ({ criterionId }: { criterionId: string }) => deleteCriterion(criterionId),
    onSuccess: invalidate,
  });
}
