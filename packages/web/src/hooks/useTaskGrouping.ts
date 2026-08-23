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
import { AxiosError } from 'axios';
import { apiClient } from '@/api/client';

/**
 * Why the server left a selected row out of the new phase.
 *
 * **Open, not closed, and deliberately so.** The two named members are what the server
 * emits today; the vocabulary belongs to the server and can grow without this file. A
 * closed union would make the client's own defensive branch untypeable — and a branch
 * you cannot write a test for is one nobody notices has stopped being reachable. The
 * `(string & {})` arm keeps editor completion on the two known members while admitting
 * the third the server has not shipped yet (web rule 301).
 */
export type LeftAloneReason =
  /** The row sits inside another selected row, so it is already inside the phase. */
  | 'ancestor_selected'
  /** The row's parent was not the parent shared by most of the selection. */
  | 'different_parent'
  | (string & {});

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

/**
 * Every refusal these two endpoints raise, as the server names it.
 *
 * Kept as a union rather than a bare `string` so the sentence map below is checkable
 * against the server's own vocabulary — the mirror will still drift when the API grows
 * a code, which is exactly why {@link describeGroupingRefusal} has a cautious default
 * instead of a reassuring one (web rule 301).
 */
export type GroupingRefusalCode =
  | 'invalid_task_ids'
  | 'invalid_task_id'
  | 'invalid_body'
  | 'invalid_name'
  | 'selection_too_large'
  | 'cannot_group_subtasks'
  | 'nothing_to_group'
  | 'unknown_task'
  | 'cannot_ungroup_subtask'
  | 'container_has_subtasks'
  | 'task_without_wbs_path'
  // The ADR-0259 graph guard re-raises under its own `reason`, which is one of these
  // two — not a code this module chose. `apps/scheduling/graph_guard.py` owns them.
  | 'cyclic_dependency'
  | 'self_reference'
  | 'invalid_graph_input';

/** The `{ code, detail }` body every 4xx from these endpoints carries. */
export interface GroupingRefusal {
  /**
   * One of {@link GroupingRefusalCode} today. Typed open for the same reason
   * {@link LeftAloneReason} is: the vocabulary is the server's, and
   * {@link describeGroupingRefusal}'s default branch exists precisely because it grows
   * without this file.
   */
  code: string;
  detail: string;
  /** `nothing_to_group` echoes the rows it dropped, so the refusal can still explain. */
  left_alone?: LeftAloneEntry[];
  unknown?: string[];
}

/**
 * A refusal the server stated, rethrown typed.
 *
 * These are *designed* outcomes — a selection that is entirely nested inside itself, a
 * phase carrying drawer subtasks — and the whole point of the transactional endpoints
 * is that a refusal wrote nothing. Surfacing them as a generic "something went wrong"
 * would hide the one thing the user can act on: which rule they hit.
 */
export class TaskGroupingRefused extends Error {
  readonly refusal: GroupingRefusal;

  constructor(refusal: GroupingRefusal) {
    super(refusal.detail);
    this.name = 'TaskGroupingRefused';
    this.refusal = refusal;
  }
}

/**
 * The sentence shown when the server refuses, and the reassurance that nothing moved.
 *
 * "No rows were moved" is on every branch on purpose: the refusals that fire *after* a
 * partial move are the ones a user would otherwise assume left their plan half-changed,
 * and the transaction is what makes the reassurance true.
 */
export function describeGroupingRefusal(refusal: GroupingRefusal): string {
  switch (refusal.code) {
    case 'nothing_to_group':
      return 'Every row you selected sits inside another one you selected, so there is nothing to wrap. Select the rows themselves, not a phase and its contents.';
    case 'cannot_group_subtasks':
      return 'Subtasks belong to their parent task and cannot be wrapped in a phase. Take them out of the selection and try again.';
    case 'cannot_ungroup_subtask':
      return 'That is a subtask, not a phase, so there is nothing to dissolve.';
    case 'container_has_subtasks':
      return 'That phase carries subtasks, which would be deleted with it. Move or delete them first. Nothing was changed.';
    case 'selection_too_large':
      return 'That is too many rows to wrap in one phase. Nothing was changed.';
    case 'unknown_task':
      return 'One of those rows is no longer in this plan — somebody may have deleted it. Nothing was changed.';
    case 'cyclic_dependency':
    case 'self_reference':
    case 'invalid_graph_input':
      return 'That restructure would leave the dependency graph impossible to schedule. No rows were moved.';
    default:
      // Cautious, never reassuring: an unrecognized code is a refusal we cannot
      // explain, and the server's own `detail` is the most honest thing to show.
      return refusal.detail || 'That change was refused. No rows were moved.';
  }
}

/** Narrow an unknown mutation error to the server's structured refusal. */
function asRefusal(error: unknown): never {
  if (error instanceof AxiosError && error.response && error.response.status < 500) {
    const body = error.response.data as Partial<GroupingRefusal> | undefined;
    if (body && typeof body.code === 'string') {
      throw new TaskGroupingRefused({
        code: body.code,
        detail: typeof body.detail === 'string' ? body.detail : '',
        left_alone: body.left_alone,
        unknown: body.unknown,
      });
    }
  }
  throw error;
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
      try {
        const res = await apiClient.post<GroupTasksResponse>(
          `/projects/${projectId}/tasks/group/`,
          { task_ids: taskIds, name: name ?? null },
        );
        return res.data;
      } catch (error) {
        return asRefusal(error);
      }
    },
    onSuccess: () => invalidateRestructure(queryClient, projectId),
  });
}

/** POST /api/v1/projects/{pk}/tasks/ungroup/ — dissolve a phase, lifting its rows. */
export function useUngroupTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      try {
        const res = await apiClient.post<UngroupTasksResponse>(
          `/projects/${projectId}/tasks/ungroup/`,
          { task_id: taskId },
        );
        return res.data;
      } catch (error) {
        return asRefusal(error);
      }
    },
    onSuccess: () => invalidateRestructure(queryClient, projectId),
  });
}
