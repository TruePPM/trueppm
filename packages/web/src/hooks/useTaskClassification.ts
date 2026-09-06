import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { DeliveryMode, GovernanceClass } from '@/types';

/**
 * `PATCH /api/v1/projects/{id}/tasks/classification/` — the two-axis subtree
 * cascade (#2736, ADR-0790; API half shipped in #2735).
 *
 * No optimistic cache patch, deliberately. The write touches a subtree the
 * client resolved by walking `parentId`, while the server resolves it from
 * `wbs_path` and then skips milestones and preserved overrides row by row.
 * Painting a client guess onto the cache would show rows changing that the
 * server is about to leave alone, and the receipt would then contradict the
 * grid. Invalidating on success and rendering the server's own report is both
 * simpler and the only version that cannot lie.
 */
export interface ClassificationRequest {
  projectId: string;
  subtree: string;
  cascade: boolean;
  governance_class: GovernanceClass | null;
  delivery_mode: DeliveryMode | null;
  preserve_governance_overrides: boolean;
  skip_milestones: boolean;
}

/** The request minus the project — what the popover hands its host. */
export type ClassificationApply = Omit<ClassificationRequest, 'projectId'>;

export interface ClassificationAxisReport {
  requested: string;
  applied: number;
  unchanged: number;
  /** `null` on `delivery_mode` — that axis carries no inherit bit. */
  overrides_kept: number | null;
  has_inherit_bit: boolean;
}

export interface ClassificationSkip {
  id: string;
  code: string;
  /** Which axes were withheld — a skip is axis-specific, not whole-row. */
  axes: string[];
  message: string;
}

/** The server's report. An axis the request omitted is absent, not zeroed. */
export interface ClassificationReport {
  subtree: string;
  matched: number;
  /**
   * Rows the cascade actually saved (#3306) — the receipt's unit.
   *
   * Not derivable here, which is why the server sends it. `applied` increments once
   * per row PER AXIS, so summing the two axes double-counts every row a both-axes
   * cascade touched; and a milestone withheld on one axis but written on the other
   * appears in exactly one of the two totals. The governance branch also writes two
   * model columns per increment, so the sum is neither rows nor columns.
   */
  rows_written: number;
  governance?: ClassificationAxisReport;
  delivery_mode?: ClassificationAxisReport;
  skipped: ClassificationSkip[];
  /**
   * ADR-0810 (#2756): the ⌘Z undo ledger row for this cascade — pass to
   * `useUndoCascadeClassificationOperation`. Null on a no-op cascade (ADR-0790
   * §7 — nothing changed, so nothing was recorded).
   */
  operation_id: string | null;
  /**
   * Whether **this caller's role** may undo (#3304) — a second, higher floor than
   * the one that let the cascade through.
   *
   * Applying is `IsProjectPlanAuthor` (Member+ minus the resource-management band);
   * `POST /cascade-classification-operations/{id}/undo/` is Admin+. A Member
   * therefore gets this 200 and a 403 on the undo, so `operation_id` alone is not
   * enough to decide whether an Undo affordance can work.
   *
   * The server's own answer rather than a client-side ordinal test, for the reason
   * `canAuthorPlan` takes `can_author`: the rule lives on the server, and a client
   * copy of it drifts. It also rides the very response that raises the toast, so —
   * unlike a `useCurrentUserRole` read — it can never be unsettled or racing at the
   * moment the affordance is decided.
   *
   * Deliberately independent of `operation_id`: that field says whether there is
   * anything to undo, this one says whether you may. Both are required.
   */
  can_undo: boolean;
}

export function useClassifySubtree() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ projectId, ...body }: ClassificationRequest) => {
      const res = await apiClient.patch<ClassificationReport>(
        `/projects/${projectId}/tasks/classification/`,
        body,
      );
      return res.data;
    },
    onSuccess: (_report, variables) => {
      // The cascade enqueues a recalculation server-side, so dates can move on
      // rows the cascade never wrote. Invalidate the whole project task list
      // rather than the subtree — `useScheduleTasks`' poll would pick it up
      // eventually, but "eventually" is not a receipt.
      void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
    },
  });
}
