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
 * Invalidates `['task-dependencies', successor]` and
 * `['task-dependencies', predecessor]` so both endpoints of the edge see
 * the new connection. Cycles are not validated client- or server-side
 * today (ADR-0052 §8 — file follow-up); CPM recalculation handles them.
 */
export function useAddDependency() {
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
 * The viewset enqueues a CPM recalc on commit, so cache invalidation is
 * sufficient on the client side; the next poll picks up updated dates.
 */
export function useRemoveDependency() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: RemoveDependencyPayload) => {
      await apiClient.delete(`/dependencies/${payload.id}/`);
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['task-dependencies', variables.successor] });
      void queryClient.invalidateQueries({ queryKey: ['task-dependencies', variables.predecessor] });
    },
  });
}
