import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { apiClient } from '@/api/client';

/**
 * ⌘Z for the schedule outline's structural acts (ADR-0880, #2974, #3006).
 *
 * One endpoint reverses all six gestures — indent, outdent, reparent, reorder, group,
 * ungroup — because the server records them into one ledger and reverses them with one
 * kind-agnostic function. The client therefore has one hook rather than six, and adding a
 * seventh gesture needs no change here.
 *
 * Unlike the ADR-0810 batch undos (`useBatchOperations.ts`) this is **all-or-nothing**.
 * Those return `{reverted, kept}` because they skip rows a person touched since; a WBS
 * restore cannot do that safely — a partial restore can mint a duplicate path that
 * corrupts the next structural write with nothing in the stack to detect it. So instead
 * of a partial success there is a `409` refusal, and the refusal is the normal, expected
 * outcome when a collaborator has been working in the same place.
 */

/** Why the server will not reverse an operation right now. `''` means it will. */
export type UndoBlockedReason =
  | ''
  | 'already_undone'
  | 'too_large'
  | 'not_top_of_stack'
  | 'shape_changed'
  | 'forbidden';

export interface StructuralUndoSummary {
  /** Rows whose `wbs_path` was put back. */
  restored: number;
  /** Rows the act minted (a group's phase) that the undo removed again. */
  created_removed: number;
  /** Rows the act soft-deleted (an ungroup's wrapper) that the undo brought back. */
  deleted_restored: number;
  dependencies_restored: number;
  /** Edges that could not come back because their other end has since been deleted. */
  dependencies_skipped: number;
}

/** The structured body a 409 carries — branchable without parsing the sentence. */
export interface StructuralUndoRefusal {
  code: Exclude<UndoBlockedReason, ''>;
  detail: string;
  changed?: Array<{
    task_id?: string;
    dependency_id?: string;
    expected_path?: string;
    actual_path?: string;
    change: 'moved' | 'added' | 'removed' | 'deleted' | 'edited' | 'restored_elsewhere';
  }>;
  blocking_operation_id?: string;
}

export class StructuralUndoRefused extends Error {
  readonly refusal: StructuralUndoRefusal;

  constructor(refusal: StructuralUndoRefusal) {
    super(refusal.detail);
    this.name = 'StructuralUndoRefused';
    this.refusal = refusal;
  }
}

/** POST /api/v1/structural-operations/{id}/undo/ */
export function useUndoStructuralOperation(projectId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<{ undo: StructuralUndoSummary }, Error, string>({
    mutationFn: async (operationId: string) => {
      try {
        const res = await apiClient.post<{ undo: StructuralUndoSummary }>(
          `/structural-operations/${operationId}/undo/`,
          {},
        );
        return res.data;
      } catch (error) {
        // A 409 is a designed outcome, not a fault: somebody has been working here
        // since. Rethrowing it typed lets the caller say *what* changed rather than
        // showing a generic failure toast.
        if (error instanceof AxiosError && error.response?.status === 409) {
          throw new StructuralUndoRefused(error.response.data as StructuralUndoRefusal);
        }
        throw error;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

/**
 * The sentence shown after a successful undo.
 *
 * Derived from the summary the server returned rather than from what the client asked
 * for, so it cannot claim more than actually happened — `dependencies_skipped` is the
 * case that matters, because an edge whose other end has since been deleted genuinely
 * does not come back and saying nothing about it would be the silent half-undo #2974
 * warns against.
 */
export function describeStructuralUndo(undo: StructuralUndoSummary): string {
  const parts: string[] = [];
  if (undo.deleted_restored > 0) {
    parts.push(`restored ${undo.deleted_restored} phase${undo.deleted_restored === 1 ? '' : 's'}`);
  }
  if (undo.restored > 0) {
    parts.push(`moved ${undo.restored} row${undo.restored === 1 ? '' : 's'} back`);
  }
  if (undo.created_removed > 0) {
    parts.push(`removed ${undo.created_removed} phase${undo.created_removed === 1 ? '' : 's'}`);
  }
  const head = parts.length > 0 ? `Undone — ${parts.join(', ')}.` : 'Undone.';
  if (undo.dependencies_skipped > 0) {
    const n = undo.dependencies_skipped;
    return `${head} ${n} link${n === 1 ? '' : 's'} could not be restored — the other task was deleted.`;
  }
  return head;
}

/** The sentence shown when the server refuses. Never blames the user's own action. */
export function describeStructuralUndoRefusal(refusal: StructuralUndoRefusal): string {
  switch (refusal.code) {
    case 'shape_changed':
      // Deliberately actor-free: the server cannot name who moved the row to a caller
      // below Project Manager (task history redacts the actor), so a sentence naming
      // one would be a claim the API cannot back (ADR-0880 §2a).
      return 'The outline has changed here since — this can no longer be undone.';
    case 'not_top_of_stack':
      return 'Undo the more recent change first.';
    case 'too_large':
      return 'That change affected too many rows to be reversed automatically.';
    case 'already_undone':
      return 'That change has already been undone.';
    case 'forbidden':
      return 'You do not have permission to undo that change.';
    default:
      return refusal.detail;
  }
}
