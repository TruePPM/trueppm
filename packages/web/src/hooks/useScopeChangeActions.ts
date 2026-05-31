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
 * gate and is surfaced to the caller via the mutation's `error`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ScopeChangeStatus } from '@/types';

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
    void queryClient.invalidateQueries({ queryKey: ['me', 'work'] });
  }

  const acceptOne = useMutation({
    mutationFn: async (scopeChangeId: string) => {
      const res = await apiClient.post<SingleScopeChangeResponse>(
        `/scope-changes/${scopeChangeId}/accept/`,
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const rejectOne = useMutation({
    mutationFn: async (scopeChangeId: string) => {
      const res = await apiClient.post<SingleScopeChangeResponse>(
        `/scope-changes/${scopeChangeId}/reject/`,
      );
      return res.data;
    },
    onSuccess: invalidate,
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
  });

  return { acceptOne, rejectOne, acceptBulk, rejectBulk };
}
