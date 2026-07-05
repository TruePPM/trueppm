import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { handleSyncConflict } from '@/api/conflict';
import type { Task, TaskType, GovernanceClass, DeliveryMode } from '@/types';

// ---------------------------------------------------------------------------
// Shared API shape — returned by POST /tasks/ and PATCH /tasks/{id}/
// ---------------------------------------------------------------------------

interface ApiTaskResponse {
  id: string;
  name: string;
  project: string;
  wbs_path: string | null;
  duration: number;
  status: string;
  percent_complete: number;
}

// ---------------------------------------------------------------------------
// useCreateTask — POST /api/v1/tasks/
// ---------------------------------------------------------------------------

export interface CreateTaskPayload {
  name: string;
  duration: number;
  /** UUID of the parent task. Omit or pass null to create at root level. */
  parent_id?: string | null;
  /** Initial board status. Defaults to NOT_STARTED if omitted. */
  status?: string;
  /** SNET planned start date (ISO `YYYY-MM-DD`). Optional. */
  planned_start?: string | null;
  /** Long-form description / notes. Stored as Task.notes. */
  notes?: string;
  /** Sprint UUID — null leaves the task unassigned. Only writable when
   *  the project has agile features enabled (ADR-0037). */
  sprint?: string | null;
  /** Mark the task as a milestone (server requires duration=0 alongside). */
  is_milestone?: boolean;
  /** Mark the task as a subtask of `parent_id` (ADR-0060 #308). Depth is limited to 1. */
  is_subtask?: boolean;
  /** Work-item type (ADR-0105). Defaults server-side to 'task' when omitted. */
  type?: TaskType;
  /** Governance overlay (ADR-0036/#407). Defaults server-side to 'flow'. */
  governance_class?: GovernanceClass;
  /** Execution / rollup mode (ADR-0036/#407). Defaults server-side to 'waterfall'. */
  delivery_mode?: DeliveryMode;
}

/** POST /api/v1/tasks/ — create a new task in the given project. */
export function useCreateTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateTaskPayload) => {
      const res = await apiClient.post<ApiTaskResponse>('/tasks/', {
        project: projectId,
        name: payload.name,
        duration: payload.duration,
        ...(payload.parent_id != null ? { parent_id: payload.parent_id } : {}),
        ...(payload.status != null ? { status: payload.status } : {}),
        ...(payload.planned_start !== undefined ? { planned_start: payload.planned_start } : {}),
        ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
        ...(payload.sprint !== undefined ? { sprint: payload.sprint } : {}),
        ...(payload.is_milestone ? { is_milestone: true } : {}),
        ...(payload.is_subtask ? { is_subtask: true } : {}),
        ...(payload.type !== undefined ? { type: payload.type } : {}),
        ...(payload.governance_class !== undefined ? { governance_class: payload.governance_class } : {}),
        ...(payload.delivery_mode !== undefined ? { delivery_mode: payload.delivery_mode } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateTask — PATCH /api/v1/tasks/{id}/
// ---------------------------------------------------------------------------

export interface UpdateTaskPayload {
  id: string;
  projectId: string;
  name?: string;
  duration?: number;
  percent_complete?: number;
  planned_start?: string | null;
  status?: string;
  actual_start?: string | null;
  actual_finish?: string | null;
  /** Long-form description / notes. Stored as Task.notes. */
  notes?: string;
  /** Sprint UUID — null removes the task from any sprint. */
  sprint?: string | null;
  /** Original commitment estimate in story points. */
  story_points?: number | null;
  /** Live remaining-effort for burndown (issue #366). Auto-zeroed on COMPLETE by the API. */
  remaining_points?: number | null;
  /** Work-item type (ADR-0105). Changing to/from 'epic' is structural — the
   *  server gates it (PO/Admin) and 400s otherwise; surfaced as a submit error. */
  type?: TaskType;
  /** Governance overlay (ADR-0036/#407). */
  governance_class?: GovernanceClass;
  /** Execution / rollup mode (ADR-0036/#407). */
  delivery_mode?: DeliveryMode;
  /** Human blocker flag (ADR-0124). `blocked_reason` is the flag of
   *  record — non-empty flags the task, '' unflags it (the server then clears
   *  blocker_type / blocking_task / blocked_since). `blocking_task` is a soft
   *  "waiting on" link (NOT a CPM edge); null clears it. */
  blocked_reason?: string;
  blocker_type?: string;
  blocking_task?: string | null;
  /**
   * The `serverVersion` this edit was based on (ADR-0217, issue 322). When provided,
   * the server does field-level merge: a disjoint concurrent edit merges (200),
   * an overlapping one returns 409 and surfaces the "Someone else changed this"
   * toast. Omit for legacy last-writer-wins.
   */
  baseVersion?: number;
}

/**
 * Map the snake_case PATCH payload to the camelCase {@link Task} cache shape for
 * the optimistic update. Only the fields a user edits directly in the drawer /
 * board are mapped — server-derived fields (CPM dates, float, criticality) are
 * reconciled by the success invalidation. Returns only the keys present on the
 * payload so untouched fields are never clobbered.
 */
function optimisticTaskPatch(vars: UpdateTaskPayload): Partial<Task> {
  const patch: Partial<Task> = {};
  if (vars.name !== undefined) patch.name = vars.name;
  if (vars.notes !== undefined) patch.notes = vars.notes;
  if (vars.percent_complete !== undefined) patch.progress = vars.percent_complete;
  if (vars.status !== undefined) patch.status = vars.status as Task['status'];
  if (vars.duration !== undefined) patch.duration = vars.duration;
  if (vars.planned_start !== undefined) patch.plannedStart = vars.planned_start;
  if (vars.story_points !== undefined) patch.storyPoints = vars.story_points;
  if (vars.remaining_points !== undefined) patch.remainingPoints = vars.remaining_points;
  if (vars.sprint !== undefined) patch.sprintId = vars.sprint;
  if (vars.type !== undefined) patch.taskType = vars.type;
  if (vars.governance_class !== undefined) patch.governanceClass = vars.governance_class;
  if (vars.delivery_mode !== undefined) patch.deliveryMode = vars.delivery_mode;
  // Human blocker flag (ADR-0124). blocked_since / blocked_by / age are
  // server-stamped on the flag transition, so they are NOT optimistically set —
  // the post-mutation refetch fills them. We only reflect what the user typed.
  if (vars.blocked_reason !== undefined) patch.blockedReason = vars.blocked_reason;
  if (vars.blocker_type !== undefined) patch.blockerType = vars.blocker_type;
  if (vars.blocking_task !== undefined) patch.blockingTask = vars.blocking_task;
  return patch;
}

/**
 * PATCH /api/v1/tasks/{id}/ — update task fields.
 *
 * Applies an optimistic cache update in `onMutate` so an edited field (progress,
 * status, name, description…) reflects instantly without waiting on the network
 * round-trip — eliminating the brief revert-to-old-value flicker on a slider
 * release or status change (#965). `onSuccess` still invalidates the task cache
 * so server-authoritative fields (CPM dates after a schedule-affecting edit,
 * status side-effects, `server_version`) reconcile; `onError` rolls the
 * optimistic patch back.
 */
export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      projectId: _projectId,
      baseVersion,
      ...data
    }: UpdateTaskPayload) => {
      // Opt into field-level merge (ADR-0217) by declaring the version this edit was
      // based on; the server merges a disjoint concurrent edit or 409s an overlap.
      // Only pass a config arg when opting in, so the default LWW call shape is unchanged.
      const res =
        baseVersion !== undefined
          ? await apiClient.patch<ApiTaskResponse>(`/tasks/${id}/`, data, {
              headers: { 'X-Base-Version': String(baseVersion) },
            })
          : await apiClient.patch<ApiTaskResponse>(`/tasks/${id}/`, data);
      return res.data;
    },
    onMutate: async (variables) => {
      const { id, projectId } = variables;
      // Cancel in-flight fetches so a late response can't clobber the optimistic data.
      await queryClient.cancelQueries({ queryKey: ['tasks', projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', projectId]);
      const patch = optimisticTaskPatch(variables);
      queryClient.setQueryData<Task[]>(
        ['tasks', projectId],
        (old) => old?.map((t) => (t.id === id ? { ...t, ...patch } : t)) ?? [],
      );
      return { snapshot };
    },
    onError: (err, variables, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(['tasks', variables.projectId], context.snapshot);
      }
      // On an overlapping concurrent edit (409), surface the conflict toast with a
      // Reload action that refetches the server's current state (ADR-0217, issue 322).
      handleSyncConflict(err, () => {
        void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
      });
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useRescheduleTask — PATCH for drag/resize with optimistic cache update
//
// Unlike useUpdateTask (which invalidates immediately), this hook applies an
// optimistic patch to the React Query cache in onMutate so both the canvas
// and task list update instantly. It does NOT call invalidateQueries — instead
// useScheduleTasks polls every 2 s, which picks up CPM-computed dates once Celery
// finishes without causing a stale-data snap-back.
// ---------------------------------------------------------------------------

export interface RescheduleTaskPayload {
  id: string;
  projectId: string;
  planned_start?: string | null;
  duration?: number;
  /** Target finish date (#951) — the server derives the working-day `duration`
   *  from the project calendar. Sent by the Gantt resize commit in place of
   *  `duration` so a bar dragged across a weekend commits the correct
   *  working-day span, not the inflated calendar span. */
  planned_finish?: string | null;
  /** Partial Task values applied to the cache immediately (optimistic UI). */
  optimistic: Partial<Task>;
}

/**
 * PATCH /api/v1/tasks/{id}/ for drag/resize — applies an optimistic cache update
 * so the Gantt reflects the new position instantly. Does not invalidate the cache on
 * success; useScheduleTasks' refetchInterval picks up CPM-computed dates once Celery finishes.
 */
export function useRescheduleTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, projectId: _p, optimistic: _o, ...data }: RescheduleTaskPayload) => {
      await apiClient.patch(`/tasks/${id}/`, data);
    },
    onMutate: async ({ id, projectId, planned_start, optimistic }) => {
      // Cancel any in-flight fetches so they don't overwrite our optimistic data
      await queryClient.cancelQueries({ queryKey: ['tasks', projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', projectId]);
      const todayIso = new Date().toISOString().slice(0, 10);
      queryClient.setQueryData<Task[]>(
        ['tasks', projectId],
        (old) =>
          old?.map((t) => {
            if (t.id !== id) return t;
            // Mirror the server's date-gated NOT_STARTED → IN_PROGRESS rule (#336)
            // so the board doesn't flicker after a today-drag round-trip. Applied
            // only when the caller didn't explicitly include a status of its own.
            const willPromote =
              t.status === 'NOT_STARTED' &&
              optimistic.status === undefined &&
              planned_start != null &&
              planned_start <= todayIso;
            return {
              ...t,
              ...optimistic,
              ...(willPromote ? { status: 'IN_PROGRESS' as const } : {}),
            };
          }) ?? [],
      );
      return { snapshot };
    },
    onError: (_err, { projectId }, context) => {
      // Roll back on API error
      if (context?.snapshot) {
        queryClient.setQueryData(['tasks', projectId], context.snapshot);
      }
    },
    // No onSuccess invalidation — useScheduleTasks refetchInterval picks up CPM results
  });
}

// ---------------------------------------------------------------------------
// useIndentTask — POST /api/v1/projects/{pk}/tasks/{id}/indent/
// ---------------------------------------------------------------------------

export interface IndentOutdentResponse {
  updated: Array<{ id: string; wbs_path: string }>;
  warning: 'has_assignments' | null;
}

/** POST /api/v1/projects/{pk}/tasks/{id}/indent/ — make a task a child of the preceding sibling. */
export function useIndentTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiClient.post<IndentOutdentResponse>(
        `/projects/${projectId}/tasks/${taskId}/indent/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useOutdentTask — POST /api/v1/projects/{pk}/tasks/{id}/outdent/
// ---------------------------------------------------------------------------

/** POST /api/v1/projects/{pk}/tasks/{id}/outdent/ — promote a task one level up in the WBS. */
export function useOutdentTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiClient.post<IndentOutdentResponse>(
        `/projects/${projectId}/tasks/${taskId}/outdent/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useReparentTask — POST /api/v1/projects/{pk}/tasks/{id}/reparent/
// ---------------------------------------------------------------------------

export interface ReparentTaskPayload {
  taskId: string;
  /** UUID of the target parent, or null to promote to root level. */
  newParentId: string | null;
}

/** POST /api/v1/projects/{pk}/tasks/{id}/reparent/ — move a task under a new parent (or to root). */
export function useReparentTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, newParentId }: ReparentTaskPayload) => {
      const res = await apiClient.post<IndentOutdentResponse>(
        `/projects/${projectId}/tasks/${taskId}/reparent/`,
        { new_parent_id: newParentId },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// usePromoteTask — PATCH planned_start + status for unscheduled gutter (#213)
// ---------------------------------------------------------------------------

export interface PromoteTaskPayload {
  id: string;
  projectId: string;
  planned_start: string;
  /**
   * Optional explicit status. The To Do gutter path omits it (sends only
   * `planned_start`) so the server applies its date-gated NOT_STARTED →
   * IN_PROGRESS rule. The BACKLOG-promote path (#318) sends an explicit
   * `status: 'NOT_STARTED'` so the promotion lands deterministically in
   * To Do regardless of the drop date — sending `status` in the body skips
   * the server's auto-bump (decision A2). Mirrors the optimistic cache logic.
   */
  status?: string;
}

/**
 * PATCH /api/v1/tasks/{id}/ to promote an unscheduled task onto the timeline.
 *
 * The To Do gutter path sends only `planned_start`; the server
 * (`TaskSerializer.update`) applies the date-gated NOT_STARTED → IN_PROGRESS
 * rule consistently across every planned_start-only mutation path (#336), so
 * Gantt drag, drawer date edits, and integration sync behave identically.
 *
 * The BACKLOG-promote path (#318) additionally sends an explicit
 * `status: 'NOT_STARTED'`. An explicit status in the request body skips the
 * server's date-gated auto-bump, giving a deterministic To Do landing for a
 * backlog idea regardless of the chosen date (decision A2).
 *
 * Optimistic: applies the move to the React Query cache in `onMutate` so the
 * chip leaves the gutter immediately, and rolls back on error — mirroring
 * {@link useUpdateTask}/{@link useToggleComplete}.
 */
export function usePromoteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, planned_start, status }: PromoteTaskPayload) => {
      await apiClient.patch(`/tasks/${id}/`, {
        planned_start,
        ...(status !== undefined ? { status } : {}),
      });
    },
    onMutate: async ({ id, projectId, planned_start, status }) => {
      // Cancel in-flight fetches so they don't clobber the optimistic patch.
      await queryClient.cancelQueries({ queryKey: ['tasks', projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', projectId]);
      const todayIso = new Date().toISOString().slice(0, 10);
      queryClient.setQueryData<Task[]>(
        ['tasks', projectId],
        (old) =>
          old?.map((t) => {
            if (t.id !== id) return t;
            // When the caller sends no explicit status (To Do path), mirror the
            // server's date-gated NOT_STARTED → IN_PROGRESS rule so the row
            // doesn't flicker after the round-trip. When the caller IS explicit
            // (#318 backlog promote → NOT_STARTED), honor it and skip the bump.
            const willPromote =
              status === undefined && t.status === 'NOT_STARTED' && planned_start <= todayIso;
            return {
              ...t,
              plannedStart: planned_start,
              ...(status !== undefined ? { status: status as Task['status'] } : {}),
              ...(willPromote ? { status: 'IN_PROGRESS' as const } : {}),
            };
          }) ?? [],
      );
      return { snapshot };
    },
    onError: (_err, { projectId }, context) => {
      // Roll back to the pre-mutation snapshot — the chip returns to its section.
      if (context?.snapshot) {
        queryClient.setQueryData(['tasks', projectId], context.snapshot);
      }
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useDeleteTask — DELETE /api/v1/tasks/{id}/
// ---------------------------------------------------------------------------

/** DELETE /api/v1/tasks/{id}/ — delete a single task. */
export function useDeleteTask(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      await apiClient.delete(`/tasks/${taskId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useBulkDeleteTasks — POST /api/v1/projects/{pk}/tasks/bulk/ (delete ops)
// ---------------------------------------------------------------------------

/** POST /api/v1/projects/{pk}/tasks/bulk/ — delete multiple tasks in a single atomic request. */
export function useBulkDeleteTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskIds: string[]) => {
      await apiClient.post(`/projects/${projectId}/tasks/bulk/`, {
        operations: taskIds.map((id) => ({ op: 'delete', id })),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useReorderTasks — POST /api/v1/projects/{pk}/tasks/reorder/
// ---------------------------------------------------------------------------

export interface ReorderTasksPayload {
  /** ltree path of the common parent, or "" for root level. */
  parent_path: string;
  /** All live siblings in desired order — partial lists are rejected by the API. */
  ordered_ids: string[];
}

/**
 * POST /api/v1/projects/{pk}/tasks/reorder/ — reorder all siblings under a WBS parent.
 * The full sibling list must be provided; partial lists are rejected by the API.
 */
export function useReorderTasks(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: ReorderTasksPayload) => {
      await apiClient.post(`/projects/${projectId}/tasks/reorder/`, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// Dependency mutations (issue #305 / ADR-0052 §8)
// ---------------------------------------------------------------------------

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

/**
 * Server-side cycle-detection error payload (ADR-0055).
 *
 * Issued by `POST /dependencies/` and `PATCH /dependencies/{id}/` when the
 * proposed edge would close a logical cycle on the expanded leaf graph.
 * Each `cycle` entry carries the task name + hex_id so the toast can render
 * a path like `A → B → A` without needing to look the task up in cache.
 */
export interface CyclicDependencyError {
  detail: 'cyclic_dependency';
  cycle: { id: string; name: string; hex_id: string }[];
}

/**
 * Render a {@link CyclicDependencyError} as a single-line user-facing string.
 *
 * Joins the cycle path with `→`. Cycles longer than four nodes get the middle
 * truncated with `…` while preserving the first and last (closing) nodes —
 * the issue spec's threshold for keeping the offending edge visible without
 * overwhelming the toast (#356 AC).
 */
export function formatCycleMessage(err: CyclicDependencyError): string {
  const names = err.cycle.map((node) => node.name || node.hex_id || node.id);
  const path =
    names.length <= 4
      ? names.join(' → ')
      : `${names[0]} → ${names[1]} → … → ${names[names.length - 1]}`;
  return `This would create a circular dependency: ${path}. Remove one of these edges first.`;
}

/**
 * Narrow an unknown caught error to a {@link CyclicDependencyError} payload.
 *
 * Returns the parsed payload or `null` for any other error shape so callers
 * can branch on cycle vs. generic failure without `as` casts.
 */
export function parseCyclicDependencyError(err: unknown): CyclicDependencyError | null {
  if (typeof err !== 'object' || err === null) return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const detail = (data as { detail?: unknown }).detail;
  const cycle = (data as { cycle?: unknown }).cycle;
  if (detail !== 'cyclic_dependency' || !Array.isArray(cycle)) return null;
  for (const node of cycle) {
    if (
      typeof node !== 'object' ||
      node === null ||
      typeof (node as { id?: unknown }).id !== 'string' ||
      typeof (node as { name?: unknown }).name !== 'string' ||
      typeof (node as { hex_id?: unknown }).hex_id !== 'string'
    ) {
      return null;
    }
  }
  return data as CyclicDependencyError;
}

/**
 * Progress-anchor gate error — issued by `PATCH /tasks/{id}/` when
 * `percent_complete > 0` but the task has no `planned_start` and no sprint
 * (ADR-0057 Q5). The `suggested_action` field tells the frontend which
 * resolution path to surface first.
 */
export interface ProgressAnchorError {
  code: 'progress_requires_anchor';
  detail: string;
  suggested_action: 'set_planned_start' | 'assign_sprint';
}

/**
 * Narrow an unknown caught error to a {@link ProgressAnchorError} payload.
 *
 * Returns the parsed payload or `null` for any other error shape.
 */
export function parseProgressAnchorError(err: unknown): ProgressAnchorError | null {
  if (typeof err !== 'object' || err === null) return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { code?: unknown }).code;
  if (code !== 'progress_requires_anchor') return null;
  return data as ProgressAnchorError;
}

/**
 * Milestone rollup lock error — issued by `PATCH /tasks/{id}/` when
 * `percent_complete` is written on a milestone task that has at least one
 * live targeting sprint (ADR-0074). The UI surfaces a toast with the lock
 * copy and points the user at the linked sprint(s).
 */
export interface MilestoneRollupLockedError {
  code: 'milestone_rollup_locked';
  detail: string;
  suggested_action: 'unlink_or_close_sprint';
}

/**
 * Narrow an unknown caught error to a {@link MilestoneRollupLockedError} payload.
 */
export function parseMilestoneRollupLockedError(err: unknown): MilestoneRollupLockedError | null {
  if (typeof err !== 'object' || err === null) return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { code?: unknown }).code;
  if (code !== 'milestone_rollup_locked') return null;
  return data as MilestoneRollupLockedError;
}

// ---------------------------------------------------------------------------
// Sprint/Phase/WBS guardrails (ADR-0101)
//
// Two shapes from the same PATCH /tasks/{id}/:
//  - WARN: the write SUCCEEDS (200) and carries a `warnings` array. The client
//    shows a non-blocking notice with a one-tap override (the assignment already
//    happened) — see GuardrailNotice.
//  - BLOCK: the write FAILS (400) with code `guardrail_blocked`. Overridable only
//    by removing the offending state, never silently.
// ---------------------------------------------------------------------------

/** Stable rule keys shared with the backend evaluator (ADR-0101). */
export type GuardrailRule =
  | 'summary_in_sprint'
  | 'phase_in_sprint'
  | 'task_outside_sprint_window'
  | 'recurring_in_sprint'
  | 'subtasks_split';

/** One warn-level guardrail the server flagged on a successful task write. */
export interface GuardrailWarning {
  rule: GuardrailRule;
  detail: string;
}

/**
 * Extract the `warnings` array from a successful task PATCH response.
 *
 * Returns `[]` when the response carries no warnings (the common, clean case),
 * so callers can treat the result uniformly without a null check.
 */
export function parseGuardrailWarnings(data: unknown): GuardrailWarning[] {
  if (typeof data !== 'object' || data === null) return [];
  const warnings = (data as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter(
    (w): w is GuardrailWarning =>
      typeof w === 'object' &&
      w !== null &&
      typeof (w as { rule?: unknown }).rule === 'string' &&
      typeof (w as { detail?: unknown }).detail === 'string',
  );
}

/** Block-level guardrail error — issued (400) when an Owner has escalated a rule. */
export interface GuardrailBlockedError {
  code: 'guardrail_blocked';
  rule: GuardrailRule;
  detail: string;
  suggested_action: string;
}

/**
 * Narrow an unknown caught error to a {@link GuardrailBlockedError} payload.
 * Returns the parsed payload or `null` for any other error shape.
 */
export function parseGuardrailBlockedError(err: unknown): GuardrailBlockedError | null {
  if (typeof err !== 'object' || err === null) return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { code?: unknown }).code;
  if (code !== 'guardrail_blocked') return null;
  return data as GuardrailBlockedError;
}

export interface AddDependencyPayload {
  /** UUID of the predecessor task. */
  predecessor: string;
  /** UUID of the successor task. */
  successor: string;
  /** Defaults to 'FS' per ADR-0052 §8 — the modal's predecessor editor does
   *  not expose type/lag controls; deeper editing lives in the drawer. */
  dep_type?: DependencyType;
  /** Calendar-day lag. Default 0. */
  lag?: number;
}

interface ApiDependencyResponse {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: DependencyType;
  lag: number;
  /**
   * ADR-0120 D2 consent gate. `true` when a same-program cross-project edge was
   * created inert, awaiting the counterpart team's acceptance (creator held
   * Scheduler+ on only one side). `false`/absent for same-project edges and for
   * cross-project edges the creator could accept on both sides. The cross-project
   * picker branches its confirmation toast on this.
   */
  pending_acceptance?: boolean;
}

/** {@link useAddDependency} exposes the raw create response so callers can read
 *  `pending_acceptance` (the consent-gate outcome) in their `onSuccess`. */
export type AddDependencyResult = ApiDependencyResponse;

/**
 * POST /api/v1/dependencies/ — add a predecessor/successor edge.
 *
 * Invalidates four cache keys on success:
 *   - `['task-dependencies', successor]` and `['task-dependencies', predecessor]`
 *     for the per-task drawer / modal predecessor lists.
 *   - `['tasks', projectId]` so post-CPM `early_start` / `early_finish`
 *     refetches into the Schedule list.
 *   - `['dependencies', projectId]` so the Schedule canvas redraws the new
 *     arrow without waiting on the next 2 s poll.
 *
 * The project-scoped keys matter because the WebSocket `dependency_created`
 * event is the only other invalidation path, and the WS goes silent under
 * auth expiry, dev StrictMode races, or any network hiccup (#353).
 *
 * Cycle detection is enforced server-side at create time (ADR-0055); a 400
 * with `{detail: "cyclic_dependency", cycle: [...]}` surfaces to callers via
 * the mutation's `onError` and is parseable with {@link parseCyclicDependencyError}.
 */
export function useAddDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: AddDependencyPayload) => {
      const res = await apiClient.post<ApiDependencyResponse>('/dependencies/', {
        predecessor: payload.predecessor,
        successor: payload.successor,
        dep_type: payload.dep_type ?? 'FS',
        lag: payload.lag ?? 0,
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['task-dependencies', variables.successor] });
      void queryClient.invalidateQueries({
        queryKey: ['task-dependencies', variables.predecessor],
      });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
      void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId ?? undefined] });
    },
  });
}

export interface RemoveDependencyPayload {
  /** UUID of the dependency edge to delete. */
  id: string;
  /** Both endpoints — needed only to invalidate their dependency caches. */
  predecessor: string;
  successor: string;
}

/**
 * DELETE /api/v1/dependencies/{id}/ — remove a predecessor/successor edge.
 *
 * Invalidates the per-task and project-level dep + task caches for the same
 * reasons as {@link useAddDependency}: the Schedule list and arrow canvas
 * must refresh without waiting on the WebSocket broadcast, which can be
 * silently dead (#353).
 */
export function useRemoveDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: RemoveDependencyPayload) => {
      await apiClient.delete(`/dependencies/${payload.id}/`);
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['task-dependencies', variables.successor] });
      void queryClient.invalidateQueries({
        queryKey: ['task-dependencies', variables.predecessor],
      });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
      void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId ?? undefined] });
    },
  });
}

// ---------------------------------------------------------------------------
// useToggleComplete — Space-toggle Mark complete from Schedule canvas (#477)
//
// Thin wrapper over PATCH /tasks/{id}/ with optimistic flip + rollback.
// The server auto-injects `actual_finish`, `actual_start`, and zeroes
// `remaining_points` on COMPLETE; `Task.save()` coerces percent_complete=100.
// Client only sends `{status}`. The toggle reverses by re-PATCHing the
// previous status snapshotted at click time (ADR-0066 Q3).
// ---------------------------------------------------------------------------

export interface ToggleCompletePayload {
  id: string;
  projectId: string;
  /** Status the task held before this toggle — used as the "off" state. */
  previousStatus: Task['status'];
}

export function useToggleComplete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, previousStatus }: ToggleCompletePayload) => {
      const nextStatus = previousStatus === 'COMPLETE' ? 'NOT_STARTED' : 'COMPLETE';
      const res = await apiClient.patch<ApiTaskResponse>(`/tasks/${id}/`, {
        status: nextStatus,
      });
      return res.data;
    },
    onMutate: async ({ id, projectId, previousStatus }) => {
      await queryClient.cancelQueries({ queryKey: ['tasks', projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', projectId]);
      const nextStatus = previousStatus === 'COMPLETE' ? 'NOT_STARTED' : 'COMPLETE';
      queryClient.setQueryData<Task[]>(
        ['tasks', projectId],
        (old) =>
          old?.map((t) => {
            if (t.id !== id) return t;
            // Match the server's COMPLETE coercion (`progress` is the TS-side
            // mirror of API `percent_complete` — useScheduleTasks line 135) so
            // the row settles to its final state immediately, no green-flash
            // → snap-back when the server confirms (~150 ms typical).
            return nextStatus === 'COMPLETE'
              ? { ...t, status: nextStatus, progress: 100, isComplete: true }
              : { ...t, status: nextStatus };
          }) ?? [],
      );
      return { snapshot };
    },
    onError: (_err, { projectId }, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(['tasks', projectId], context.snapshot);
      }
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useDuplicateTask — ⌘D / context-menu Duplicate from Schedule canvas (#477)
//
// Reads the source task's name/duration/parent/sprint and POSTs a new task
// with a `(copy)` (or `(copy N)`) suffix. Dependencies are never cloned
// (ADR-0066 Q1). Sprint inheritance follows ADR-0066 Q2: clone inherits the
// source's sprint_id; when source's sprint is ACTIVE the caller surfaces an
// Undo toast separately — the hook itself is mechanical.
//
// Frontend-only via the existing POST endpoint: the server already places
// the task under `parent_id` with `select_for_update()` and bumps server_version.
// ---------------------------------------------------------------------------

export interface DuplicateTaskPayload {
  /** Project UUID — used for cache invalidation. */
  projectId: string;
  /** Source task fields the clone needs. */
  source: {
    name: string;
    duration: number;
    parent_id: string | null;
    sprint_id: string | null;
    /** Preserve milestone shape (duration 0 stays as a milestone). */
    is_milestone: boolean;
  };
  /** Existing sibling names — used to compute the "(copy)" suffix uniquely. */
  siblingNames: string[];
}

/** Build the "(copy)" suffix that doesn't collide with an existing sibling. */
export function buildCopyName(sourceName: string, siblingNames: string[]): string {
  // Strip an existing "(copy)" or "(copy N)" suffix so re-duplicating a copy
  // doesn't produce "Foo (copy) (copy)".
  const stripped = sourceName.replace(/\s*\(copy(?:\s+\d+)?\)\s*$/i, '');
  const taken = new Set(siblingNames);
  if (!taken.has(`${stripped} (copy)`)) return `${stripped} (copy)`;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stripped} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological fallback — exceedingly unlikely to hit in real projects.
  return `${stripped} (copy ${Date.now()})`;
}

export function useDuplicateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ projectId, source, siblingNames }: DuplicateTaskPayload) => {
      const name = buildCopyName(source.name, siblingNames);
      const res = await apiClient.post<ApiTaskResponse>('/tasks/', {
        project: projectId,
        name,
        duration: source.duration,
        ...(source.parent_id != null ? { parent_id: source.parent_id } : {}),
        ...(source.sprint_id != null ? { sprint: source.sprint_id } : {}),
        ...(source.is_milestone ? { is_milestone: true } : {}),
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
    },
  });
}
