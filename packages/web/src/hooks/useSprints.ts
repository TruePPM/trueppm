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
  /**
   * Disposition for tasks still pending acceptance at close (ADR-0102 §7).
   *  - `'carry'` (default): carry pending tasks to the next sprint, still
   *    flagged pending; a fresh PENDING scope-change row is recorded.
   *  - `'reject'`: reject all pending tasks (remove from sprint).
   * Advisory only — close is never blocked. Omit when nothing is pending. */
  pending_disposition?: 'carry' | 'reject';
}

interface CloseSprintResponse {
  queued: true;
  request_id: string;
  /**
   * Advisory present only when the sprint had pending scope changes at close
   * (ADR-0102 §7). Close is NEVER blocked by this. */
  scope_pending_on_close?: {
    code: 'scope_pending_on_close';
    detail: string;
    pending_count: number;
    items: Array<{ id: string; task: string; item_name: string }>;
    default_disposition: 'carry';
  };
}

export interface UpdateSprintPayload {
  name?: string;
  goal?: string;
  start_date?: string;
  finish_date?: string;
  target_milestone?: string | null;
  /**
   * Planning capacity in points (ADR-0073). Writable on PLANNED and ACTIVE
   * sprints; locked on COMPLETED and CANCELLED. Set to null to clear.
   */
  capacity_points?: number | null;
  /**
   * WIP-overload threshold (#546). Writable on PLANNED and ACTIVE sprints;
   * locked on COMPLETED and CANCELLED — same gate as capacity_points. Set to
   * null to clear (suppresses the WIP chip).
   */
  wip_limit?: number | null;
}

export interface CapacityWarning {
  resource_id: string;
  resource_name: string;
  load_factor: number;
  message: string;
}

/**
 * Activate response is the SprintSerializer payload plus a non-blocking
 * `warnings` array enumerating any capacity overruns at activation time
 * (ADR-0037 Q2 amendment). Callers surface the warnings inline; they do
 * not block the activation.
 */
export interface ActivateSprintResponse extends ApiSprint {
  warnings?: CapacityWarning[];
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

  // POST /api/v1/sprints/{id}/activate/ — PLANNED → ACTIVE.
  // The API enforces the single-active-sprint constraint (409 on conflict)
  // and returns the updated sprint plus a non-blocking capacity warnings
  // array; the caller renders them inline (issue #299).
  const activateSprint = useMutation({
    mutationFn: async (sprintId: string) => {
      const res = await apiClient.post<ActivateSprintResponse>(
        `/sprints/${sprintId}/activate/`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
    },
  });

  // PATCH /api/v1/sprints/{id}/ — edit a PLANNED sprint's name, goal, or
  // window. The serializer marks state / committed_* / activated_at as
  // read-only so this endpoint cannot transition a sprint by accident.
  const updateSprint = useMutation({
    mutationFn: async ({
      sprintId,
      payload,
    }: {
      sprintId: string;
      payload: UpdateSprintPayload;
    }) => {
      const res = await apiClient.patch<ApiSprint>(
        `/sprints/${sprintId}/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
    },
  });

  return { createSprint, closeSprint, activateSprint, updateSprint };
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

/** A prior-sprint unfinished task surfaced in the Planning carryover preview (#865). */
export interface IncomingCarryoverTask {
  /** Live task id, or null when the task was hard-deleted after close. */
  id: string | null;
  short_id: string;
  name: string;
  story_points: number | null;
  /** True when this task is now committed to the current PLANNED sprint. */
  pulled_in_to_current: boolean;
}

export interface IncomingCarryover {
  prior_sprint: {
    id: string;
    short_id_display: string;
    name: string;
    start_date: string;
    finish_date: string;
  } | null;
  tasks: IncomingCarryoverTask[];
}

/**
 * GET /api/v1/sprints/{id}/incoming_carryover/ — read-only "what rolled forward
 * from the prior sprint" preview for the Planning surface (#865, ADR-0094 §3).
 * Re-derives the prior closed sprint's unfinished tasks server-side; the sidebar
 * suppresses itself when `tasks` is empty.
 */
export function useIncomingCarryover(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'incoming-carryover'],
    queryFn: async () => {
      const res = await apiClient.get<IncomingCarryover>(
        `/sprints/${sprintId}/incoming_carryover/`,
      );
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
  /** Rolling 6-sprint team velocity in points-per-working-day (ADR-0065). */
  team_velocity_per_day: number | null;
  /**
   * Set by the server (ADR-0104 §2.1) when the requester's tier is below the
   * velocity signal's audience: the per-sprint series and the point-based
   * rolling/forecast numbers are nulled out. The client renders a "team-private"
   * gated state instead of a misleading "no sprints" empty state. Absent/false
   * for in-audience readers.
   */
  velocity_suppressed?: boolean;
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

/** A persisted milestone reforecast row (ADR-0106 §5, #860) — band + dates only. */
export interface ForecastSnapshot {
  id: string;
  milestone_id: string | null;
  milestone_name: string | null;
  basis: string;
  /** ISO date — the deterministic CPM finish. */
  cpm_finish: string | null;
  /** ISO date — Monte Carlo P50 / P80 finish. */
  p50: string | null;
  p80: string | null;
  velocity_low: number | null;
  velocity_high: number | null;
  confidence: string | null;
  unmodeled_dependency: boolean;
  taken_at: string;
}

/**
 * Project delivery forecast (ADR-0106 §5, #487/#860). `velocity` is the same
 * payload as {@link useProjectVelocity} (and inherits the ADR-0104 suppression);
 * `sprints_to_complete_*` re-paces the remaining committed backlog into a sprint
 * count range; `milestones` is the latest snapshot per bound milestone.
 */
export interface ProjectForecast {
  velocity: ProjectVelocity;
  remaining_committed_points: number;
  sprints_to_complete_low: number | null;
  sprints_to_complete_high: number | null;
  milestones: ForecastSnapshot[];
}

/**
 * GET /api/v1/projects/{id}/forecast/ — the bridge delivery forecast read.
 *
 * Gate the call on velocity NOT being suppressed (pass `enabled: false` when the
 * caller's velocity payload carries `velocity_suppressed`) so an out-of-audience
 * reader never pulls the sprints-to-complete range (which indirectly reveals the
 * team-private velocity band).
 */
export function useProjectForecast(
  projectId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ['project', projectId, 'forecast'],
    queryFn: async () => {
      const res = await apiClient.get<ProjectForecast>(`/projects/${projectId}/forecast/`);
      return res.data;
    },
    enabled: !!projectId && enabled,
  });
}


/** One task that was in the sprint at close but didn't complete (#985). */
export interface DidntShipItem {
  task_id: string | null;
  task_short_id: string;
  task_title: string;
  /** Null for readers below the velocity audience (ADR-0104 side-channel guard). */
  story_points: number | null;
  final_status: string;
  /** Null on a provisional (not-yet-closed) sprint — decided at close. */
  disposition: 'carried' | 'dropped' | 'completed' | null;
  next_sprint_id: string | null;
  next_sprint_name: string | null;
  was_pending: boolean;
}

/**
 * Consolidated sprint-review read (#985, ADR-0111 §3). The single server-owned
 * surface for review: commitment, goal verdict (#983), velocity Δ + burn status
 * (#984), the "didn't ship" list (#982), and a retro summary — nothing derived
 * client-side. `velocity` is null when the reader is below the velocity audience
 * (ADR-0104). `provisional` is true for ACTIVE/PLANNED (live, not snapshotted);
 * `outcome_recorded` is false for sprints closed before membership was captured.
 */
export interface SprintOutcome {
  sprint_id: string;
  state: SprintState;
  provisional: boolean;
  outcome_recorded: boolean;
  name: string;
  start_date: string;
  finish_date: string;
  closed_at: string | null;
  goal: string;
  goal_outcome: 'MET' | 'PARTIAL' | 'MISSED' | null;
  commitment: {
    committed_points: number | null;
    committed_task_count: number | null;
    completed_points: number | null;
    completed_task_count: number | null;
    completion_ratio_points: number | null;
    completion_ratio_tasks: number | null;
  };
  velocity: {
    completed_points: number | null;
    velocity_delta_points: number | null;
    rolling_avg_points: number | null;
    burn_status: 'ahead' | 'on_track' | 'behind' | 'no_data';
    trend_points: number | null;
    projected_finish_date: string | null;
  } | null;
  didnt_ship: DidntShipItem[];
  didnt_ship_summary: {
    carried_count: number;
    carried_points: number | null;
    dropped_count: number;
    dropped_points: number | null;
  };
  retro_summary: {
    retro_id: string;
    action_item_count: number;
    has_notes: boolean;
  } | null;
}

/** GET /api/v1/sprints/{id}/outcome/ — the consolidated sprint-review read (#985). */
export function useSprintOutcome(
  sprintId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ['sprint', sprintId, 'outcome'],
    queryFn: async () => {
      const res = await apiClient.get<SprintOutcome>(`/sprints/${sprintId}/outcome/`);
      return res.data;
    },
    enabled: !!sprintId && enabled,
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

export type RetroVisibility = 'team_only' | 'project' | 'org';

export interface SprintRetroPayload {
  kind: 'full';
  id: string;
  sprint: string;
  notes: string;
  team_visibility: RetroVisibility;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  action_items: SprintRetroActionItem[];
}

export interface SprintRetroSummaryPayload {
  kind: 'summary';
  id: string;
  sprint: string;
  team_visibility: RetroVisibility;
  created_at: string;
  updated_at: string;
  action_items_count: number;
  promoted_count: number;
}

export type SprintRetroResponse = SprintRetroPayload | SprintRetroSummaryPayload;

export function isFullRetro(payload: SprintRetroResponse): payload is SprintRetroPayload {
  return payload.kind === 'full';
}

/** GET /api/v1/sprints/{id}/retro/ — current retrospective (404 = not yet written). */
export function useSprintRetro(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'retro'],
    queryFn: async () => {
      try {
        const res = await apiClient.get<SprintRetroResponse>(`/sprints/${sprintId}/retro/`);
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
  team_visibility?: RetroVisibility;
}

/** POST /api/v1/sprints/{id}/retro/ — upsert notes + replace action item set. */
export function useSaveSprintRetro(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SaveRetroPayload) => {
      const res = await apiClient.post<SprintRetroResponse>(
        `/sprints/${sprintId}/retro/`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'retro'] });
    },
  });
}

/** PATCH /api/v1/sprints/{id}/retro/ — partial update (visibility toggle). */
export function useUpdateRetroVisibility(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (team_visibility: RetroVisibility) => {
      const res = await apiClient.patch<SprintRetroResponse>(`/sprints/${sprintId}/retro/`, {
        team_visibility,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'retro'] });
    },
  });
}

/** GET /api/v1/sprints/{id}/retrospective/prior/ — most recent prior retro. */
export function useSprintRetroPrior(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'retro', 'prior'],
    queryFn: async () => {
      try {
        const res = await apiClient.get<SprintRetroResponse>(
          `/sprints/${sprintId}/retrospective/prior/`,
        );
        return res.data;
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) return null;
        throw err;
      }
    },
    enabled: !!sprintId,
  });
}

export interface PromotedTaskPayload {
  task: {
    id: string;
    short_id: string;
    name: string;
    status: string;
    sprint: string | null;
    assignee: string | null;
  };
}

/** POST /api/v1/sprints/{sprintId}/retrospective/action-items/{itemId}/promote/ */
export function usePromoteRetroActionItem(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiClient.post<PromotedTaskPayload>(
        `/sprints/${sprintId}/retrospective/action-items/${itemId}/promote/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', sprintId, 'retro'] });
      void queryClient.invalidateQueries({ queryKey: ['sprint-backlog'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
  });
}

/** POST /api/v1/sprints/{sprintId}/retrospective/action-items/{itemId}/pull-to-sprint/ */
export function usePullCarryoverToSprint(sprintId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      itemId,
      targetSprintId,
    }: {
      itemId: string;
      targetSprintId: string;
    }) => {
      const res = await apiClient.post<PromotedTaskPayload>(
        `/sprints/${sprintId}/retrospective/action-items/${itemId}/pull-to-sprint/`,
        { target_sprint_id: targetSprintId },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint-backlog'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },
  });
}

export interface CarryoverItem {
  action_item_id: string;
  text: string;
  from_retro_id: string;
  from_sprint_id: string;
  from_sprint_short_id: string | null;
  promoted_task_id: string | null;
  promoted_task_status: string | null;
  promoted_task_short_id: string | null;
  age_days: number;
  assignee_id: number | null;
  assignee_username: string | null;
  story_points: number | null;
}

/** GET /api/v1/projects/{id}/retrospective/carryover/ */
export function useProjectRetroCarryover(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ['project', projectId, 'retro', 'carryover'],
    queryFn: async () => {
      const res = await apiClient.get<{ items: CarryoverItem[] }>(
        `/projects/${projectId}/retrospective/carryover/`,
      );
      return res.data.items;
    },
    enabled: !!projectId,
  });
}

// ---------------------------------------------------------------------------
// TaskSuggestedAssignee mutations (ADR-0071 §5)
// ---------------------------------------------------------------------------

interface SuggestionMutationResponse {
  id: string;
  state: 'pending' | 'accepted' | 'declined' | 'revoked';
  accepted_at?: string | null;
  declined_at?: string | null;
}

function useSuggestionAction(action: 'accept' | 'decline' | 'revoke') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      suggestionId,
    }: {
      taskId: string;
      suggestionId: string;
    }) => {
      const res = await apiClient.post<SuggestionMutationResponse>(
        `/tasks/${taskId}/suggestions/${suggestionId}/${action}/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me', 'work'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useAcceptSuggestion() {
  return useSuggestionAction('accept');
}

export function useDeclineSuggestion() {
  return useSuggestionAction('decline');
}

export function useRevokeSuggestion() {
  return useSuggestionAction('revoke');
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
