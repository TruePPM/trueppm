import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * ⌘Z undo for the schedule outline's batch write operations (ADR-0810, #2756).
 *
 * Three server-recorded operation ledgers, mirroring `useUndoTemplateApplication`
 * (`useProjectTemplates.ts`) exactly: POST an empty body to the operation's own
 * `/undo/` action, get back how many rows reverted vs. how many were kept because
 * a person touched them since. Idempotent — undoing an already-undone operation
 * is a 400 the caller should treat as "nothing left to do", not retry.
 */

export interface UndoSummary {
  /** Rows the paste/import undo deleted, or the cascade undo reverted. */
  deleted?: number;
  reverted?: number;
  /** Rows skipped because a person touched them since the original write. */
  kept: number;
}

/** POST /api/v1/paste-many-operations/{id}/undo/ */
export function useUndoPasteManyOperation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (operationId: string) => {
      const res = await apiClient.post<{ undo: UndoSummary }>(
        `/paste-many-operations/${operationId}/undo/`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

/** POST /api/v1/cascade-classification-operations/{id}/undo/ */
export function useUndoCascadeClassificationOperation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (operationId: string) => {
      const res = await apiClient.post<{ undo: UndoSummary }>(
        `/cascade-classification-operations/${operationId}/undo/`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

/**
 * POST /api/v1/projects/{projectId}/import/csv/{id}/undo/
 *
 * Project-nested, unlike the two router-registered siblings above — the backend
 * endpoint follows `apps/csvimport`'s own path()-based convention rather than a
 * flat `import-fix-operations` collection (ADR-0810's amendment explains why).
 */
export function useUndoImportFixOperation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (importRequestId: string) => {
      const res = await apiClient.post<{ status: string; undo: UndoSummary }>(
        `/projects/${projectId}/import/csv/${importRequestId}/undo/`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

/** A human-readable summary line for the undo toast, shared across all three. */
export function describeUndo(undo: UndoSummary): string {
  const isRevert = undo.reverted !== undefined;
  const count = undo.reverted ?? undo.deleted ?? 0;
  const verb = isRevert ? 'reverted' : 'removed';
  const rowWord = `row${count === 1 ? '' : 's'}`;
  if (undo.kept > 0) {
    return `Undone — ${verb} ${count} ${rowWord}, kept ${undo.kept} you'd already touched.`;
  }
  return `Undone — ${verb} ${count} ${rowWord}.`;
}
