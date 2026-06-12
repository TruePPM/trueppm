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
  /**
   * Hold this sprint out of the velocity average/band and forecast (ADR-0113) —
   * the "Sprint 0" / setup-iteration escape hatch. SCHEDULER+ only. Unlike
   * capacity_points, editable in EVERY state including COMPLETED (teams realise
   * the contamination retrospectively).
   */
  exclude_from_velocity?: boolean;
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
      // exclude_from_velocity (ADR-0113) changes the velocity average/band and
      // the milestone forecast, so refresh both cards — not just the sprint list.
      void queryClient.invalidateQueries({ queryKey: ['project', projectId, 'velocity'] });
      void queryClient.invalidateQueries({ queryKey: ['project', projectId, 'forecast'] });
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
  /** Current-sprint burn pace vs the ideal line (#984). */
  burn_status?: 'ahead' | 'behind' | 'on_track' | 'no_data';
  /** Signed: positive = ahead of ideal, negative = behind. Null with no data. */
  trend_points?: number | null;
  projected_finish_date?: string | null;
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

/** A single mid-sprint scope-change audit event (#543/#550). */
export interface ScopeChangeEvent {
  id: string;
  item_name: string;
  story_points: number | null;
  added_by_name: string | null;
  added_at: string;
  goal_impact: boolean;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface SprintScopeChanges {
  summary: {
    /** Story points still in the sprint (pending + accepted injections). */
    points_added: number;
    /** Story points injected then rejected (removed back out). */
    points_removed: number;
    /** Count of injected tasks still in the sprint — the SprintPanel badge number. */
    added_mid_sprint_count: number;
    /** Total scope-change rows (added + removed). */
    total: number;
  };
  events: ScopeChangeEvent[];
}

/**
 * GET /api/v1/sprints/{id}/scope-changes/ — mid-sprint scope-change audit + delta
 * (#543/#550). Drives the persistent "Scope changed" chip, its delta drawer, and
 * the SprintPanel "N added mid-sprint" badge. Aggregated point sums + ids only,
 * no per-assignee data (Morgan VoC guardrail).
 */
export function useSprintScopeChanges(sprintId: string | null | undefined) {
  return useQuery({
    queryKey: ['sprint', sprintId, 'scope-changes'],
    queryFn: async () => {
      const res = await apiClient.get<SprintScopeChanges>(
        `/sprints/${sprintId}/scope-changes/`,
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
  /**
   * ADR-0113: this sprint is held out of the velocity average/band and forecast
   * (a setup/ramp-up "Sprint 0"). The bar is rendered muted + hatched and marked,
   * not dropped — and it does not contribute to the rolling-avg line or ± band.
   */
  exclude_from_velocity: boolean;
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
   * ADR-0113: how many of the displayed sprints are excluded from velocity, so
   * the UI can render "N excluded from this forecast" without re-deriving it.
   */
  excluded_count: number;
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


/**
 * GET /api/v1/projects/{id}/sprint-forecast/ — backlog delivery forecast (#487).
 *
 * Velocity Monte Carlo: P50/P80 sprint counts + calendar dates to clear the
 * remaining committed backlog. `status` is `"warming_up"` (forecast fields null)
 * until there are >=2 closed sprints and a backlog. `basis` is always
 * `"monte_carlo"`, so percentile vocabulary is honest here (web-rule 166).
 */
export interface SprintForecast {
  status: 'ready' | 'warming_up';
  remaining_points: number | null;
  sample_count: number;
  p50_sprints: number | null;
  p80_sprints: number | null;
  p50_date: string | null;
  p80_date: string | null;
  basis: 'monte_carlo';
  velocity_suppressed: boolean;
}

export function useSprintForecast(
  projectId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ['project', projectId, 'sprint-forecast'],
    queryFn: async () => {
      const res = await apiClient.get<SprintForecast>(
        `/projects/${projectId}/sprint-forecast/`,
      );
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
 * A shipped (completed) story in the Sprint Review (#924, ADR-0118). Carries its
 * acceptance state (met/total criteria) and whether the team flagged it for the
 * stakeholder demo. `story_points` is null below the velocity audience (ADR-0104).
 * `outcome_id` is the SprintTaskOutcome row PK (the demo-toggle key); null for a
 * provisional sprint, where no snapshot row exists and demo curation is unavailable.
 */
export interface ReviewShippedStory {
  outcome_id: string | null;
  task_id: string | null;
  task_short_id: string;
  task_title: string;
  story_points: number | null;
  acceptance: { met: number; total: number };
  /** The specific UNMET criteria (names only) for the #1131 click-through; empty
   * when fully accepted or no criteria. */
  unmet_criteria: { id: string; text: string }[];
  /** Optional contributor note left at review (#1131); "" when unset. */
  review_note: string;
  /** True once the story has been carried forward to the backlog (#1132). */
  flagged_to_backlog: boolean;
  demo_ready: boolean;
  /** Dense demo walkthrough order (#1130); 0 when unset. */
  demo_order: number;
  /** Free-text presenter for the demo (#1130); "" when unset. */
  presenter: string;
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
  /**
   * Sprint Review breakdown (#924, ADR-0118). Counts always present; `*_points`
   * are null below the velocity audience (ADR-0104). `shipped` are the completed
   * stories (acceptance + demo candidates); `demo_list` is the team's curated
   * walkthrough (short ids; empty on a provisional sprint).
   */
  review: {
    accepted_count: number;
    not_accepted_count: number;
    no_criteria_count: number;
    accepted_points: number | null;
    not_accepted_points: number | null;
    shipped: ReviewShippedStory[];
    demo_list: string[];
    /** Committed-at-planning → shipped COUNT delta (#1129) — ALWAYS visible (never
     * velocity-gated; only points are gated). `carried_count` is null on a
     * provisional sprint (disposition not yet decided). */
    commitment: {
      committed_count: number | null;
      shipped_count: number;
      carried_count: number | null;
    };
  };
  // Realized milestone slip vs baseline (#1098) — schedule fact, not velocity-gated.
  // Present only on a CLOSED sprint bound to a milestone with a baselined finish.
  // slip_days is positive when late; basis is "actual" once the milestone finished.
  milestone_slip: {
    milestone_id: string;
    milestone_name: string;
    milestone_short_id: string;
    slip_days: number;
    baseline_finish: string;
    forecast_finish: string;
    basis: 'actual' | 'forecast';
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

/**
 * POST /api/v1/sprint-task-outcomes/{id}/toggle-demo/ — flag/unflag a shipped story
 * for the Sprint Review demo list (#924, ADR-0118). Member+, team-owned. Invalidates
 * the outcome read so the demo grouping refreshes.
 */
export function useToggleDemo(sprintId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ outcomeId, demoReady }: { outcomeId: string; demoReady: boolean }) => {
      const res = await apiClient.post<{ id: string; demo_ready: boolean }>(
        `/sprint-task-outcomes/${outcomeId}/toggle-demo/`,
        { demo_ready: demoReady },
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sprint', sprintId, 'outcome'] });
    },
  });
}

/**
 * POST /api/v1/sprints/{id}/demo-list/reorder — drag reorder of the Sprint Review
 * demo walkthrough (#1130, ADR-0118 amend). Member+, team-owned. Sends the complete
 * ordered list of demo-flagged outcome ids; invalidates the outcome read so the
 * demo grouping re-sorts.
 */
export function useReorderDemoList(sprintId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ outcomeIds }: { outcomeIds: string[] }) => {
      const res = await apiClient.post<{ updated: number }>(
        `/sprints/${sprintId}/demo-list/reorder/`,
        { outcome_ids: outcomeIds },
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sprint', sprintId, 'outcome'] });
    },
  });
}

/**
 * POST /api/v1/sprint-task-outcomes/{id}/set-presenter/ — set the per-story demo
 * presenter (#1130). Member+, team-owned.
 */
export function useSetPresenter(sprintId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ outcomeId, presenter }: { outcomeId: string; presenter: string }) => {
      const res = await apiClient.post<{ id: string; presenter: string }>(
        `/sprint-task-outcomes/${outcomeId}/set-presenter/`,
        { presenter },
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sprint', sprintId, 'outcome'] });
    },
  });
}

/**
 * POST /api/v1/sprint-task-outcomes/{id}/set-note/ — set the optional contributor
 * review note (#1131, ≤200 chars). Member+, team-owned.
 */
export function useSetReviewNote(sprintId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ outcomeId, note }: { outcomeId: string; note: string }) => {
      const res = await apiClient.post<{ id: string; review_note: string }>(
        `/sprint-task-outcomes/${outcomeId}/set-note/`,
        { note },
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sprint', sprintId, 'outcome'] });
    },
  });
}

/**
 * POST /api/v1/sprint-task-outcomes/{id}/flag-for-backlog/ — one-tap carry-forward
 * of a not-shipped story to the backlog (#1132). Member+, team-owned, idempotent.
 */
export function useFlagForBacklog(sprintId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ outcomeId }: { outcomeId: string }) => {
      const res = await apiClient.post<{
        id: string;
        flagged_to_backlog: boolean;
        task_id: string | null;
      }>(`/sprint-task-outcomes/${outcomeId}/flag-for-backlog/`, {});
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sprint', sprintId, 'outcome'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Daily standup delta — "what changed since yesterday" (#925, ADR-0121)
// ---------------------------------------------------------------------------

export interface DailyDeltaStatusChange {
  task_id: string;
  task_short_id: string;
  task_title: string;
  kind: 'status';
  from: string;
  to: string;
  actor_id: number | null;
  actor_username: string | null;
  at: string;
}

export interface DailyDeltaScopeItem {
  task_id: string | null;
  task_short_id: string;
  task_title: string;
  added_by_username: string | null;
  at: string;
  status: string;
  /** Point cost of the injected task. Null when unknown OR velocity-gated (#1127). */
  story_points: number | null;
  /** The task's epic grouping, or null when ungrouped (#1127). */
  epic: { id: string; name: string } | null;
}

/** Team-total counts — the anti-scoreboard aggregate (#1126). Viewers get only this. */
export interface DailyDeltaActorAggregate {
  moved: number;
  completed: number;
  added: number;
  blocked: number;
}

/**
 * Committed-vs-current point load for the sprint (#1127). Point figures are null
 * for a reader who cannot read the velocity signal (ADR-0104); the keys stay
 * present so the client can render the gated empty-state.
 */
export interface DailyDeltaSprintLoad {
  committed_points: number | null;
  current_points: number | null;
  delta_points: number | null;
  /** current / capacity (or commitment) as a 0–1 ratio; null when no basis. */
  pct_loaded: number | null;
}

export interface DailyDeltaBlocker {
  task_id: string;
  task_short_id: string;
  task_title: string;
  actor_username: string | null;
  at: string;
}

export interface DailyDeltaActor {
  actor_id: number | null;
  actor_username: string | null;
  moved: number;
  completed: number;
  added: number;
  blocked: number;
}

/**
 * Team standup delta (#925, ADR-0121). Server-computed from history/scope/burndown
 * — status-level only, never hours/keystroke. Team-private by membership.
 */
export interface SprintDailyDelta {
  sprint_id: string;
  since: string;
  until: string;
  task_changes: DailyDeltaStatusChange[];
  scope_added: DailyDeltaScopeItem[];
  new_blockers: DailyDeltaBlocker[];
  burndown_delta: {
    prior_date: string;
    prior_remaining: number;
    current_date: string;
    current_remaining: number;
    remaining_delta: number;
    completed_delta: number;
  } | null;
  /** Empty for a Viewer-role reader (#1126); they get actor_aggregate only. */
  per_actor: DailyDeltaActor[];
  actor_aggregate: DailyDeltaActorAggregate;
  sprint_load: DailyDeltaSprintLoad;
}

/** GET /api/v1/sprints/{id}/daily-delta/?since= — the team "what changed since yesterday" read. */
export function useSprintDailyDelta(
  sprintId: string | null | undefined,
  options: { enabled?: boolean; since?: string } = {},
) {
  const { enabled = true, since } = options;
  return useQuery({
    queryKey: ['sprint', sprintId, 'daily-delta', since ?? '24h'],
    queryFn: async () => {
      const res = await apiClient.get<SprintDailyDelta>(`/sprints/${sprintId}/daily-delta/`, {
        params: since ? { since } : undefined,
      });
      return res.data;
    },
    enabled: !!sprintId && enabled,
  });
}


// ---------------------------------------------------------------------------
// Sprint-health signals (issue #988, ADR-0101 §4)
// ---------------------------------------------------------------------------

/**
 * One tripped Tier-3 sprint-health signal (ADR-0101 §4, #988). Server-owned:
 * the count, the show/hide verdict, the tone, and the user-facing `detail`
 * copy are all decided on the API so headless/MCP clients get identical
 * guidance. The web renders `detail` verbatim (web-rule 141 — never re-invent
 * WBS jargon in the browser).
 */
export interface SprintHealthSignal {
  key: string;
  count: number;
  tone: 'info' | 'warn';
  /** User-facing outcome copy, rendered verbatim — never re-synthesized. */
  detail: string;
}

export interface SprintHealth {
  /** Only *tripped* signals — a healthy project yields an empty list. */
  signals: SprintHealthSignal[];
}

/**
 * GET /api/v1/projects/{id}/sprint-health/ — read-only team+coach health
 * signals for the Sprints view (#988). Returns only tripped signals; an empty
 * list means the badge row fades away. Disabled when `projectId` is null.
 */
export function useSprintHealth(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ['project', projectId, 'sprint-health'],
    queryFn: async () => {
      const res = await apiClient.get<SprintHealth>(
        `/projects/${projectId}/sprint-health/`,
      );
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
