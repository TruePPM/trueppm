/**
 * Sprint scope-injection accept/reject mutations (ADR-0102 §5).
 *
 * Four synchronous (200, not 202) endpoints behind one hook:
 *   - single accept  : POST /scope-changes/{id}/accept/
 *   - single reject  : POST /scope-changes/{id}/reject/
 *   - bulk   accept  : POST /sprints/{sprintId}/scope-changes/accept/  { ids? }
 *   - bulk   reject  : POST /sprints/{sprintId}/scope-changes/reject/  { ids? }
 *
 * Accept joins the task to the commitment (clears `sprint_pending`); reject
 * removes it from the sprint. Both flip the audit-row status synchronously; the
 * burndown recompute + board broadcast are deferred server-side (no task id).
 *
 * On success we invalidate the sprint, task, and me/work caches so the board
 * banner's pending line, the burndown caption, and the contributor chip all
 * reconcile from the DB (the WS `sprint_scope_changed` broadcast is best-effort
 * — clients reconcile on the next load regardless). The render-gate is
 * `useCanManageScope`; the server 403 (`scope_accept_forbidden`) is the real
 * gate — every mutation carries an `onError` that toasts the failure (including
 * that authoritative 403) so a denied or failed decision is never silent (#2149).
 * Callers add the success/undo half of the feedback contract (ADR-0102, rules
 * 149/150): accept confirms with a toast, single reject offers a re-add undo.
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast/toast';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import type { ScopeChangeStatus } from '@/types';
import { invalidateMyWork } from '@/hooks/myWorkQueryKeys';

/** One scope-change row as returned by the single accept/reject action. */
export interface ScopeChangeRow {
  id: string;
  task: string;
  sprint: string;
  item_name: string;
  status: ScopeChangeStatus;
  goal_impact: boolean;
  added_at: string;
}

/** Single accept/reject response: the updated row plus the refreshed count. */
export interface SingleScopeChangeResponse extends ScopeChangeRow {
  pending_count: number;
}

/** Bulk accept response (`reject` variant carries `rejected` instead). */
export interface BulkScopeChangeResponse {
  accepted?: ScopeChangeRow[];
  rejected?: ScopeChangeRow[];
  /** ADR-1485 D1: slips the accept refused as stale (closed, dates kept). */
  stale?: ScopeChangeRow[];
  /** Rows whose decision could not be applied; they stay pending. */
  failed?: { id: string; detail: string }[];
  pending_count: number;
}

/**
 * Accept/reject mutations scoped to one project + sprint.
 *
 * `projectId` and `sprintId` are needed only to target cache invalidation; the
 * single-item endpoints address the scope change by its own id, while the bulk
 * endpoints address the sprint. Pass an empty `ids` (or omit it) to the bulk
 * mutations to act on ALL pending items in the sprint.
 */
export function useScopeChangeActions(
  projectId: string | null | undefined,
  sprintId: string | null | undefined,
) {
  const queryClient = useQueryClient();

  function invalidate() {
    // Sprint payload (pending_count), the task lists (sprint_pending), the
    // burndown series, and the contributor me/work chip all derive from these.
    void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'burndown'] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    invalidateMyWork(queryClient);
  }

  const acceptOne = useMutation({
    mutationFn: async (scopeChangeId: string) => {
      const res = await apiClient.post<SingleScopeChangeResponse>(
        `/scope-changes/${scopeChangeId}/accept/`,
      );
      return res.data;
    },
    onSuccess: invalidate,
    onError: () => toast.error("Couldn't accept the scope change — try again."),
  });

  const rejectOne = useMutation({
    mutationFn: async (scopeChangeId: string) => {
      const res = await apiClient.post<SingleScopeChangeResponse>(
        `/scope-changes/${scopeChangeId}/reject/`,
      );
      return res.data;
    },
    onSuccess: invalidate,
    onError: () => toast.error("Couldn't reject the scope change — try again."),
  });

  const acceptBulk = useMutation({
    // `ids` omitted/empty = accept ALL pending in the sprint. The server is
    // partial-failure tolerant: a concurrently-decided row is silently skipped
    // and omitted from the returned `accepted` list.
    mutationFn: async (ids?: string[]) => {
      const res = await apiClient.post<BulkScopeChangeResponse>(
        `/sprints/${sprintId}/scope-changes/accept/`,
        ids && ids.length > 0 ? { ids } : {},
      );
      return res.data;
    },
    onSuccess: invalidate,
    onError: () => toast.error("Couldn't accept the pending items — try again."),
  });

  const rejectBulk = useMutation({
    mutationFn: async (ids?: string[]) => {
      const res = await apiClient.post<BulkScopeChangeResponse>(
        `/sprints/${sprintId}/scope-changes/reject/`,
        ids && ids.length > 0 ? { ids } : {},
      );
      return res.data;
    },
    onSuccess: invalidate,
    onError: () => toast.error("Couldn't reject the pending items — try again."),
  });

  return { acceptOne, rejectOne, acceptBulk, rejectBulk };
}

/** One commitment-slip decision: a single row, or every pending row of a batch. */
export interface SlipDecision {
  accept: boolean;
  /** The row to decide; omit with `batchId` to decide the whole batch. */
  id?: string;
  batchId?: string;
  /** Optional decider's reason, stored as the row's `decision_reason`. */
  reason?: string;
}

const STALE_SLIP_MESSAGE =
  'This date change is out of date (the task changed since it was proposed), so it was closed without applying.';

/**
 * Accept/reject a commitment slip (ADR-1485 D1) from the scope-change drawer.
 *
 * Accepting replays the stored dates; the server refuses a stale row (409
 * `commitment_slip_stale` on a single row, the `stale` list on a batch) and
 * closes it unapplied, which this toasts rather than reporting success. The
 * render gate is `useCanManageScope`; the server's 403 is the real gate.
 * On settle it invalidates the drawer's feed, the sprint, and the task lists so
 * the board and the schedule pick up the applied dates.
 */
export function useSlipDecision(
  projectId: string | null | undefined,
  sprintId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ accept, id, batchId, reason }: SlipDecision) => {
      const verb = accept ? 'accept' : 'reject';
      const body = reason?.trim() ? { reason: reason.trim() } : {};
      if (id) {
        await apiClient.post(`/scope-changes/${id}/${verb}/`, body);
        return { stale: 0, failed: 0, decided: 1 };
      }
      const res = await apiClient.post<BulkScopeChangeResponse>(
        `/sprints/${sprintId}/scope-changes/${verb}/`,
        { batch_id: batchId, ...body },
      );
      const decided = (accept ? res.data.accepted : res.data.rejected)?.length ?? 0;
      return { stale: res.data.stale?.length ?? 0, failed: res.data.failed?.length ?? 0, decided };
    },
    onSuccess: ({ stale, failed, decided }, { accept }) => {
      if (stale > 0)
        toast.info(
          stale === 1
            ? STALE_SLIP_MESSAGE
            : `${stale} date changes were out of date and closed without applying.`,
        );
      if (failed > 0)
        toast.error(
          `${failed} date change${failed === 1 ? '' : 's'} could not be applied and still need${failed === 1 ? 's' : ''} a decision.`,
        );
      if (decided > 0) toast.success(accept ? 'Date change accepted.' : 'Date change rejected.');
    },
    onError: (err) => {
      const code =
        axios.isAxiosError(err) && err.response?.status === 409
          ? (err.response.data as { code?: string } | undefined)?.code
          : undefined;
      if (code === 'commitment_slip_stale') toast.info(STALE_SLIP_MESSAGE);
      else toast.error("Couldn't decide the date change — try again.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'scope-changes'] });
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      invalidateMyWork(queryClient);
    },
  });
}

/**
 * The success/undo half of the scope-decision feedback contract (ADR-0102, web
 * rules 149/150, #2149). The hook above owns the *error* path (a toast on every
 * failed decision); this owns the *positive* path so both callers — the Sprints
 * review panel and the board card — behave identically:
 *
 *  - **accept** = one tap WITH a confirmation toast (rule 149). Accept is not
 *    reversible from here (the task is now part of the commitment), so no undo.
 *  - **single reject** = proceed, then offer an Undo (rule 150). Reject removed
 *    the task from the sprint; Undo re-assigns it (a plain task PATCH), which the
 *    server re-records as a pending injection — restoring the prior pending state.
 *
 * Fire these from the mutation's own `onSuccess` at the call site, where the task
 * name is known. `projectId`/`sprintId` are needed only for the Undo re-assign;
 * when either is absent the reject still confirms, just without the Undo action.
 */
export function useScopeDecisionFeedback(
  projectId: string | null | undefined,
  sprintId: string | null | undefined,
) {
  const itl = useIterationLabel(projectId ?? undefined);
  const updateTask = useUpdateTask();

  // Memoized so a caller can list them in a useMemo/useCallback dep array (the
  // board's `scopeActions`) without thrashing on every render.
  const confirmAccepted = useCallback(
    (taskName: string) => {
      toast.success(`${taskName} accepted into the ${itl.lower}.`);
    },
    [itl.lower],
  );

  const confirmRejectedWithUndo = useCallback(
    (taskId: string, taskName: string) => {
      const removed = `${taskName} removed from the ${itl.lower}.`;
      if (!projectId || !sprintId) {
        toast.success(removed);
        return;
      }
      toast.action(
        removed,
        {
          label: 'Undo',
          ariaLabel: `Re-add ${taskName} to the ${itl.lower}`,
          onClick: () => {
            updateTask.mutate({ id: taskId, projectId, sprint: sprintId });
          },
        },
        { variant: 'info' },
      );
    },
    [itl.lower, projectId, sprintId, updateTask],
  );

  return { confirmAccepted, confirmRejectedWithUndo };
}
