import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Task } from '@/types';

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
}

/** PATCH /api/v1/tasks/{id}/ — update task fields; immediately invalidates the task cache. */
export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, projectId: _projectId, ...data }: UpdateTaskPayload) => {
      const res = await apiClient.patch<ApiTaskResponse>(`/tasks/${id}/`, data);
      return res.data;
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
    mutationFn: async ({
      id,
      projectId: _p,
      optimistic: _o,
      ...data
    }: RescheduleTaskPayload) => {
      await apiClient.patch(`/tasks/${id}/`, data);
    },
    onMutate: async ({ id, projectId, planned_start, optimistic }) => {
      // Cancel any in-flight fetches so they don't overwrite our optimistic data
      await queryClient.cancelQueries({ queryKey: ['tasks', projectId] });
      const snapshot = queryClient.getQueryData<Task[]>(['tasks', projectId]);
      const todayIso = new Date().toISOString().slice(0, 10);
      queryClient.setQueryData<Task[]>(['tasks', projectId], (old) =>
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
}

/**
 * PATCH /api/v1/tasks/{id}/ to promote an unscheduled task onto the timeline.
 *
 * Sends only `planned_start`; the server (`TaskSerializer.update`) applies the
 * date-gated NOT_STARTED → IN_PROGRESS rule consistently across every
 * planned_start mutation path (#336). Keeping the rule server-side means
 * Gantt drag, drawer date edits, and integration sync all behave identically —
 * and the rule is auditable in one place rather than replicated per hook.
 */
export function usePromoteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, planned_start }: PromoteTaskPayload) => {
      await apiClient.patch(`/tasks/${id}/`, { planned_start });
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
}

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
      void queryClient.invalidateQueries({ queryKey: ['task-dependencies', variables.predecessor] });
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
      void queryClient.invalidateQueries({ queryKey: ['task-dependencies', variables.predecessor] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? undefined] });
      void queryClient.invalidateQueries({ queryKey: ['dependencies', projectId ?? undefined] });
    },
  });
}
