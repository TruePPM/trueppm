/**
 * Group / Ungroup — the outline's transactional restructure primitives (#2955).
 *
 * These wrap `POST /projects/{id}/tasks/group/` and `.../ungroup/` rather than
 * composing `useReparentTask` N times, and the distinction is the whole point: each
 * operation is **one undo step**, so it has to be one request. A client-side
 * composition is N+1 un-transacted calls whose partial failure leaves a half-made
 * phase with some rows moved and some not — the defect already open as #2914.
 *
 * Consumers must render `left_alone`. The server applies two selection rules — it
 * drops any row whose own ancestor is also selected, and groups on the parent shared
 * by most of the remainder — so a group can legitimately wrap fewer rows than the user
 * selected. Reporting that is not optional polish; a group that silently wrapped four
 * of six rows reads as a bug.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Why the server left a selected row out of the new phase. */
export type LeftAloneReason =
  /** The row sits inside another selected row, so it is already inside the phase. */
  | 'ancestor_selected'
  /** The row's parent was not the parent shared by most of the selection. */
  | 'different_parent';

export interface LeftAloneEntry {
  id: string;
  reason: LeftAloneReason;
  /** The selected ancestor that covered this row; null for `different_parent`. */
  ancestor_id: string | null;
}

/** One row's new WBS path after the restructure. */
export interface WbsPathEntry {
  id: string;
  wbs_path: string;
}

export interface GroupedContainer {
  id: string;
  name: string;
  wbs_path: string;
  /** Always `container` — a grouped phase is declared, never inferred (#2950). */
  structure_role: string;
  /** The level the phase was inserted into; null at root. */
  parent_id: string | null;
}

export interface GroupTasksResponse {
  container: GroupedContainer;
  /** The wrapped rows, in the order they now appear inside the phase. */
  grouped_ids: string[];
  left_alone: LeftAloneEntry[];
  updated: WbsPathEntry[];
  warning: string | null;
  /** Ledger handle for `POST /structural-operations/{id}/undo/` (ADR-0880, #2974). */
  operation_id: string | null;
}

export interface UngroupTasksResponse {
  container_id: string;
  /** The rows lifted one level, in the order they now appear. */
  lifted_ids: string[];
  /**
   * Dependency edges that pointed at the wrapper itself and went with it. The lifted
   * rows' own links are untouched — surface these so the removal is visible rather
   * than something the user discovers later.
   */
  removed_dependency_ids: string[];
  updated: WbsPathEntry[];
  warning: string | null;
  /** Ledger handle for `POST /structural-operations/{id}/undo/` (ADR-0880, #2974). */
  operation_id: string | null;
}

export interface GroupTasksPayload {
  /** Rows to wrap, in selection order. */
  taskIds: string[];
  /** Phase name. Omit to get the server's placeholder — the design names it last. */
  name?: string | null;
}

/**
 * A WBS restructure rewrites paths across a broad set of rows, so both hooks
 * invalidate the whole task list and every task-history query in the project (#1867)
 * rather than trying to patch individual cache entries from `updated`.
 */
function invalidateRestructure(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string | null,
): void {
  void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
  void queryClient.invalidateQueries({ queryKey: ['task-history', projectId ?? undefined] });
}

/** POST /api/v1/projects/{pk}/tasks/group/ — wrap a selection in a new phase. */
export function useGroupTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskIds, name }: GroupTasksPayload) => {
      const res = await apiClient.post<GroupTasksResponse>(
        `/projects/${projectId}/tasks/group/`,
        { task_ids: taskIds, name: name ?? null },
      );
      return res.data;
    },
    onSuccess: () => invalidateRestructure(queryClient, projectId),
  });
}

/** POST /api/v1/projects/{pk}/tasks/ungroup/ — dissolve a phase, lifting its rows. */
export function useUngroupTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiClient.post<UngroupTasksResponse>(
        `/projects/${projectId}/tasks/ungroup/`,
        { task_id: taskId },
      );
      return res.data;
    },
    onSuccess: () => invalidateRestructure(queryClient, projectId),
  });
}
