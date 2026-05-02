import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ApiSprint, SprintState } from '@/types';

interface PaginatedSprintResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: ApiSprint[];
}

export interface UseSprintsResult {
  sprints: ApiSprint[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * GET /api/v1/projects/{id}/sprints/ — fetch every sprint for a project.
 *
 * Returns the full list (PLANNED, ACTIVE, COMPLETED, CANCELLED) in
 * chronological order so the timeline strip can render with one query.
 * The active sprint is derived from the same payload via
 * `useActiveSprint`; no separate request is needed.
 */
export function useSprints(projectId: string | null | undefined): UseSprintsResult {
  const query = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedSprintResponse>(
        `/projects/${projectId}/sprints/`,
      );
      return res.data.results;
    },
    enabled: !!projectId,
  });

  return {
    sprints: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * Derive the current active sprint from `useSprints` — the API guarantees
 * at most one `ACTIVE` sprint per project (ADR-0037 single-active rule).
 *
 * Returns `null` while the underlying query is loading or the project has
 * no active sprint. Does not fire a separate request — it reads from the
 * already-cached list, so callers can mount this hook freely without
 * worrying about double-fetching.
 */
export function useActiveSprint(projectId: string | null | undefined): {
  sprint: ApiSprint | null;
  isLoading: boolean;
} {
  const { sprints, isLoading } = useSprints(projectId);
  const sprint = useMemo(
    () => sprints.find((s) => s.state === 'ACTIVE') ?? null,
    [sprints],
  );
  return { sprint, isLoading };
}

export interface SprintsByState {
  closed: ApiSprint[];
  active: ApiSprint | null;
  planned: ApiSprint[];
}

/**
 * Bucket sprints into closed / active / planned for the timeline strip.
 *
 * `closed` aggregates `COMPLETED` and `CANCELLED` (the strip greys both).
 * Each bucket is sorted by `start_date` ascending so the user reads the
 * project's history left-to-right.
 */
export function useSprintsByState(projectId: string | null | undefined): SprintsByState & {
  isLoading: boolean;
  error: Error | null;
} {
  const { sprints, isLoading, error } = useSprints(projectId);
  return useMemo(() => {
    const sorted = [...sprints].sort((a, b) => a.start_date.localeCompare(b.start_date));
    const closed: ApiSprint[] = [];
    const planned: ApiSprint[] = [];
    let active: ApiSprint | null = null;
    for (const s of sorted) {
      if (s.state === 'ACTIVE') active = s;
      else if (s.state === 'COMPLETED' || s.state === 'CANCELLED') closed.push(s);
      else planned.push(s);
    }
    return { closed, active, planned, isLoading, error };
  }, [sprints, isLoading, error]);
}

export interface CreateSprintPayload {
  name: string;
  goal?: string;
  start_date: string;
  finish_date: string;
  /** Optional milestone task ID this sprint advances toward. */
  target_milestone?: string | null;
}

export interface CloseSprintPayload {
  /**
   * Carry-over policy for incomplete tasks (ADR-0037 §Q2):
   *  - `'backlog'` (default): clear sprint FK, set status=BACKLOG
   *  - `'none'`: leave tasks attached to the closed sprint (retro fidelity)
   *  - `<sprint-id>`: reassign incomplete tasks to that sprint
   */
  carry_over_to: string;
}

interface CloseSprintResponse {
  queued: true;
  request_id: string;
}

/**
 * Sprint write mutations: create a planned sprint and close the active
 * sprint via the outbox endpoint. Both invalidate the sprint list cache so
 * the UI refreshes without a manual refetch. Close returns 202 + request
 * id; callers poll the sprint detail (or subscribe via WebSocket) to
 * observe `state=COMPLETED`.
 */
export function useSprintMutations(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  const createSprint = useMutation({
    mutationFn: async (payload: CreateSprintPayload) => {
      const res = await apiClient.post<ApiSprint>(
        `/projects/${projectId}/sprints/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
    },
  });

  const closeSprint = useMutation({
    mutationFn: async ({
      sprintId,
      payload,
    }: {
      sprintId: string;
      payload: CloseSprintPayload;
    }) => {
      const res = await apiClient.post<CloseSprintResponse>(
        `/sprints/${sprintId}/close/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
    },
  });

  return { createSprint, closeSprint };
}

// ---------------------------------------------------------------------------
// Burndown / capacity / velocity reads (issue #228)
// ---------------------------------------------------------------------------

export interface SprintBurnSnapshot {
  id: string;
  snapshot_date: string;
  remaining_points: number;
  remaining_task_count: number;
  completed_points: number;
  completed_task_count: number;
  scope_change_points: number;
  scope_change_task_count: number;
  created_at: string;
}

export interface SprintBurndown {
  sprint: ApiSprint;
  snapshots: SprintBurnSnapshot[];
}

/** GET /api/v1/sprints/{id}/burndown/ — sprint metadata + actual burn series. */
export function useSprintBurndown(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'burndown'],
    queryFn: async () => {
      const res = await apiClient.get<SprintBurndown>(`/sprints/${sprintId}/burndown/`);
      return res.data;
    },
    enabled: !!sprintId,
  });
}

export interface SprintCapacityMember {
  member_id: string;
  member_name: string;
  initials: string;
  committed_hours: number;
  available_hours: number;
  ratio: number;
  is_over: boolean;
}

export interface SprintCapacity {
  members: SprintCapacityMember[];
  totals: {
    committed_hours: number;
    available_hours: number;
    ratio: number;
    buffer_hours: number;
    label: 'on_track' | 'at_risk' | 'over_capacity';
    pto_days: number;
  };
  working_days: number;
  hours_per_day: number;
}

/** GET /api/v1/sprints/{id}/capacity/ — per-person + aggregate capacity (#228). */
export function useSprintCapacity(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'capacity'],
    queryFn: async () => {
      const res = await apiClient.get<SprintCapacity>(`/sprints/${sprintId}/capacity/`);
      return res.data;
    },
    enabled: !!sprintId,
  });
}

export interface VelocitySprintEntry {
  id: string;
  name: string;
  start_date: string;
  finish_date: string;
  committed_points: number | null;
  completed_points: number | null;
  committed_task_count: number | null;
  completed_task_count: number | null;
}

export interface ProjectVelocity {
  sprints: VelocitySprintEntry[];
  rolling_avg_points: number | null;
  rolling_stdev_points: number | null;
  forecast_range_low: number | null;
  forecast_range_high: number | null;
  rolling_avg_tasks: number | null;
  rolling_stdev_tasks: number | null;
}

/** GET /api/v1/projects/{id}/velocity/ — last-8 closed sprint stats. */
export function useProjectVelocity(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ['project', projectId, 'velocity'],
    queryFn: async () => {
      const res = await apiClient.get<ProjectVelocity>(`/projects/${projectId}/velocity/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}


// ---------------------------------------------------------------------------
// Sprint retrospective (issue #231)
// ---------------------------------------------------------------------------

export interface SprintRetroActionItemInput {
  text: string;
  assignee?: string | null;
  story_points?: number | null;
  promote?: boolean;
}

export interface SprintRetroActionItem {
  id: string;
  text: string;
  assignee: string | null;
  assignee_username: string | null;
  story_points: number | null;
  promoted_task_id: string | null;
  created_at: string;
}

export interface SprintRetroPayload {
  id: string;
  sprint: string;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  action_items: SprintRetroActionItem[];
}

/** GET /api/v1/sprints/{id}/retro/ — current retrospective (404 = not yet written). */
export function useSprintRetro(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'retro'],
    queryFn: async () => {
      try {
        const res = await apiClient.get<SprintRetroPayload>(`/sprints/${sprintId}/retro/`);
        return res.data;
      } catch (err) {
        // Translate the 404 into a sentinel `null` so consumers can branch
        // on "no retro yet" without inspecting the axios error shape.
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) return null;
        throw err;
      }
    },
    enabled: !!sprintId,
  });
}

export interface SaveRetroPayload {
  notes: string;
  action_items: SprintRetroActionItemInput[];
  promote_to_sprint_id?: string | null;
}

/** POST /api/v1/sprints/{id}/retro/ — upsert notes + replace action item set. */
export function useSaveSprintRetro(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SaveRetroPayload) => {
      const res = await apiClient.post<SprintRetroPayload>(
        `/sprints/${sprintId}/retro/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'retro'] });
      // Promotion may have created tasks in another sprint — bust the
      // sprint backlog cache too.
      void queryClient.invalidateQueries({ queryKey: ['sprint-backlog'] });
    },
  });
}


/** Helper exposed for tests — keeps the bucketing logic hot-swappable. */
export const __testing = {
  bucketByState(sprints: ApiSprint[]): SprintsByState {
    const sorted = [...sprints].sort((a, b) => a.start_date.localeCompare(b.start_date));
    const closed: ApiSprint[] = [];
    const planned: ApiSprint[] = [];
    let active: ApiSprint | null = null;
    for (const s of sorted) {
      if (s.state === 'ACTIVE') active = s;
      else if (s.state === 'COMPLETED' || s.state === 'CANCELLED') closed.push(s);
      else planned.push(s);
    }
    return { closed, active, planned };
  },
};

export type { SprintState };
