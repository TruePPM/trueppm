import { useCallback, useMemo, useState } from 'react';
import { useBulkUpdateTasks, type TaskBulkResponse } from '@/hooks/useTaskMutations';
import { describeWriteRefusal, type WriteRefusal } from '@/lib/writeRefusal';
import type { Task } from '@/types';
import type { UseScheduleFocusReturn } from '../useScheduleFocus';
import { buildBulkEditOperations, type BulkEditSpec, type ProjectionContext } from './bulkEditSpec';

/**
 * State and wiring for the ⌘⇧K bulk-edit sheet (#2756 pt.2, ADR-0810).
 *
 * Lives beside the sheet rather than inside ScheduleView so the selection→
 * operations→result flow is testable on its own, and so ScheduleView gains one
 * hook call instead of six more `useState`s.
 */

export interface UseBulkEditOptions {
  projectId: string | null;
  focus: UseScheduleFocusReturn;
  /** Visible rows in top-to-bottom order — the order the batch is sent in. */
  visibleTasks: Task[];
  readOnly: boolean;
  /** Move DOM focus to a row that may still be virtualized out. */
  focusRowById: (id: string) => void;
}

export interface UseBulkEditReturn {
  isOpen: boolean;
  /** The selection the sheet is acting on, in visible order. */
  selectedTasks: Task[];
  isPending: boolean;
  /** The non-207 refusal (network, 403 on the batch itself), shaped once (#3332). */
  error: WriteRefusal | null;
  result: TaskBulkResponse | null;
  /** Ids the sheet dropped before sending — the result phase counts them as left alone. */
  skippedLocallyIds: string[];
  /** ⌘⇧K. No-op when there is nothing to act on — never opens an empty sheet. */
  open: () => void;
  /**
   * Open for a selection dispatched in the SAME event handler (#2987).
   *
   * `open` guards on `focus.state.selectedIds`, which is the value captured when
   * this render's closure was built — so a caller that dispatches `selectIds`
   * and then calls `open` reads the selection as it was *before* its own
   * dispatch and bails. This variant takes the ids it is opening for, leaving
   * `selectedTasks` to resolve normally on the next render once the reducer and
   * the expand have both landed.
   */
  openForIds: (ids: string[]) => void;
  close: () => void;
  /**
   * `ctx` is the SAME projection context the sheet renders its review from.
   * Threaded rather than defaulted: the payload and the review are one
   * computation only if they are given one input, and a context field that
   * later influences a value would otherwise make them disagree in silence.
   */
  apply: (spec: BulkEditSpec, ctx?: ProjectionContext) => void;
  reviewFailed: (taskIds: string[]) => void;
  /**
   * `S20` — a clean result clears the selection; a partial one leaves the
   * refused items selected, so `⌘⇧K` *is* the retry.
   */
  done: (clean: boolean) => void;
}

export function useBulkEdit({
  projectId,
  focus,
  visibleTasks,
  readOnly,
  focusRowById,
}: UseBulkEditOptions): UseBulkEditReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [result, setResult] = useState<TaskBulkResponse | null>(null);
  const [skippedLocallyIds, setSkippedLocallyIds] = useState<string[]>([]);
  const [error, setError] = useState<WriteRefusal | null>(null);
  const mutation = useBulkUpdateTasks(projectId);
  const { mutate } = mutation;

  const { selectedIds, rowId } = focus.state;

  /**
   * The selection, resolved in visible top-to-bottom order.
   *
   * With no multi-row selection the focused row *is* the selection of one — the
   * same rule ⌫ already uses, so ⌘⇧K on a single row does the obvious thing
   * rather than nothing.
   */
  const selectedTasks = useMemo(() => {
    if (selectedIds && selectedIds.size > 0) {
      return visibleTasks.filter((t) => selectedIds.has(t.id));
    }
    if (rowId) {
      const single = visibleTasks.find((t) => t.id === rowId);
      return single ? [single] : [];
    }
    return [];
  }, [selectedIds, rowId, visibleTasks]);

  const open = useCallback(() => {
    if (readOnly || !projectId) return;
    // Nothing focused and nothing selected: there is no batch to describe, and a
    // sheet headed "Edit 0 rows" is worse than no response at all.
    if (!selectedIds?.size && !rowId) return;
    setResult(null);
    setError(null);
    setSkippedLocallyIds([]);
    setIsOpen(true);
  }, [readOnly, projectId, selectedIds, rowId]);

  const openForIds = useCallback(
    (ids: string[]) => {
      if (readOnly || !projectId || ids.length === 0) return;
      setResult(null);
      setError(null);
      setSkippedLocallyIds([]);
      setIsOpen(true);
    },
    [readOnly, projectId],
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setResult(null);
    setError(null);
  }, []);

  const apply = useCallback(
    (spec: BulkEditSpec, ctx: ProjectionContext = {}) => {
      if (!projectId) return;
      const { operations, skippedLocally } = buildBulkEditOperations(spec, selectedTasks, ctx);
      setSkippedLocallyIds(skippedLocally.map((s) => s.id));
      // Every selected row was dropped client-side (an owner-only edit over a
      // selection of nothing but summary rows). Report it as the result it is
      // rather than sending an empty `operations` array the server would reject.
      if (operations.length === 0) {
        setResult({
          applied: [],
          rejected: [],
          skipped: [],
          // Nothing was sent, so nothing was denied — this synthesizes the shape
          // the server would have returned, and the server always sends the key.
          capabilities_denied: [],
          // Nothing was sent, so no edge was applied or rejected — the shape the
          // server would have returned, not an omission.
          dependencies: { applied: [], rejected: [] },
          operation_id: null,
          // Nothing was sent, so nothing was created and there is nothing to
          // reverse. `false` states the same fact the server would (#3353); the
          // sheet has no Undo of its own, so no affordance reads it.
          can_undo: false,
        });
        return;
      }
      setError(null);
      mutate(operations, {
        onSuccess: (data) => setResult(data),
        // The batch endpoint refuses whole-request the same three ways every
        // other write does — a 403 on the project, a 400 on a malformed
        // operation, a 5xx. Collapsing all of them to one sentence discarded the
        // only thing that separates "you cannot do this" from "try again"
        // (#3332). A 207 is not a refusal and never reaches here.
        onError: (err) => setError(describeWriteRefusal(err, 'Couldn’t apply the changes.')),
      });
    },
    [projectId, selectedTasks, mutate],
  );

  /**
   * Replace the selection with exactly the rows that did not apply and focus the
   * first. In a virtualized outline this — not scrolling — is how a planner gets
   * back to three failures scattered through four hundred rows.
   */
  const reviewFailed = useCallback(
    (taskIds: string[]) => {
      if (taskIds.length === 0) return;
      focus.selectIds(taskIds);
      focus.focusRow(taskIds[0]);
      focusRowById(taskIds[0]);
      setIsOpen(false);
      setResult(null);
    },
    [focus, focusRowById],
  );

  /**
   * Close after a result. A clean batch clears the selection — the act is over
   * and leaving fifteen rows highlighted invites a second, accidental pass. A
   * PARTIAL batch keeps it, because the refused rows are exactly what a retry
   * needs selected and `reviewFailed` has already narrowed it to them.
   */
  const done = useCallback(
    (clean: boolean) => {
      if (clean) focus.clear();
      setIsOpen(false);
      setResult(null);
    },
    [focus],
  );

  return {
    isOpen,
    selectedTasks,
    isPending: mutation.isPending,
    error,
    result,
    skippedLocallyIds,
    open,
    openForIds,
    close,
    apply,
    reviewFailed,
    done,
  };
}
