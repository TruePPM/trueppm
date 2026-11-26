import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';
import type { PaginatedResponse } from '@/api/types';

// ---------------------------------------------------------------------------
// API shapes (matches BaselineSerializer / BaselineDetailSerializer)
// ---------------------------------------------------------------------------

export interface ApiBaseline {
  id: string;
  project: string;
  name: string;
  created_by: number | null;
  created_at: string;
  is_active: boolean;
  has_cpm_dates: boolean;
  task_count: number;
}

export interface ApiBaselineTask {
  task_id: string;
  task_name: string;
  start: string;
  finish: string;
  duration: number;
}

export interface ApiBaselineDetail extends ApiBaseline {
  tasks: ApiBaselineTask[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** List all baselines for a project. */
export function useBaselines(projectId: string | null | undefined) {
  return useQuery<ApiBaseline[], Error>({
    queryKey: ['baselines', projectId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiBaseline>>(
        `/projects/${projectId}/baselines/`,
      );
      return res.data.results;
    },
    enabled: !!projectId,
  });
}

/** Retrieve a single baseline with its full task snapshot. */
export function useBaselineDetail(
  projectId: string | null | undefined,
  baselineId: string | null | undefined,
) {
  return useQuery<ApiBaselineDetail, Error>({
    queryKey: ['baselines', projectId, baselineId],
    queryFn: async () => {
      const res = await apiClient.get<ApiBaselineDetail>(
        `/projects/${projectId}/baselines/${baselineId}/`,
      );
      return res.data;
    },
    enabled: !!projectId && !!baselineId,
  });
}

/**
 * Join the ACTIVE baseline's snapshot to a `task_id → {start, finish}` map for
 * the canvas ghost bars (#3821).
 *
 * Built once per baseline-detail change (react-query returns a stable `data`
 * reference), never per paint or per zoom: the engine converts these ISO dates
 * through its memoized date→x map, so a zoom re-derives x without re-parsing.
 * `dates` is null when there is no active baseline, or its detail has not
 * loaded — in both cases nothing is drawn. Rows with an empty start/finish
 * (a task unscheduled at capture) are skipped rather than drawn at the epoch.
 * One list read + one detail read per project, shared with the baseline
 * manager's cache keys, so there is no per-task fetch.
 */
export function useActiveBaselineDates(projectId: string | null | undefined): {
  hasActiveBaseline: boolean;
  dates: ReadonlyMap<string, { start: string; finish: string }> | null;
} {
  const { data: baselines } = useBaselines(projectId);
  const activeId = baselines?.find((b) => b.is_active)?.id ?? null;
  const { data: detail } = useBaselineDetail(projectId, activeId);
  const dates = useMemo(() => buildBaselineDateMap(detail?.tasks), [detail]);
  return { hasActiveBaseline: activeId !== null, dates };
}

/** Pure join used by {@link useActiveBaselineDates}; exported for unit tests. */
export function buildBaselineDateMap(
  tasks: readonly ApiBaselineTask[] | undefined,
): ReadonlyMap<string, { start: string; finish: string }> | null {
  if (!tasks) return null;
  const map = new Map<string, { start: string; finish: string }>();
  for (const t of tasks) {
    if (t.start && t.finish) map.set(t.task_id, { start: t.start, finish: t.finish });
  }
  return map;
}

/**
 * Create a new baseline snapshot (POST — optionally pass { name }).
 *
 * Auto-activates the FIRST baseline (#2215). Server-side board-card readiness
 * (`TaskSerializer.get_readiness`) only resolves to `baselined` under the
 * project's ACTIVE baseline, but capture saves `is_active=false`, so a first
 * capture would otherwise leave every card at `estimated` until a separate
 * "Set active" step — contradicting the confirm dialog's promise that the
 * snapshot becomes the active baseline. When the project has no active baseline
 * yet, this chains the activate call and refreshes `['tasks']` so the cards flip
 * with no extra step. Capturing an ADDITIONAL baseline while one is already
 * active must NOT silently reactivate — "Set active" stays the explicit path —
 * so the activate is skipped in that case.
 */
export function useCreateBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiBaseline, Error, { name?: string } | void>({
    mutationFn: async (body) => {
      const res = await apiClient.post<ApiBaseline>(
        `/projects/${projectId}/baselines/`,
        body ?? {},
      );
      const created = res.data;
      // Decide auto-activation from the authoritative list rather than the
      // possibly-cold ['baselines'] cache (the quick-capture path in
      // ScheduleView never mounts the manager that populates it). The
      // just-created row is always inactive, so exclude it before checking.
      const list = await apiClient.get<PaginatedResponse<ApiBaseline>>(
        `/projects/${projectId}/baselines/`,
      );
      const hasActiveBaseline = list.data.results.some((b) => b.is_active && b.id !== created.id);
      if (hasActiveBaseline) return created;
      try {
        const activated = await apiClient.post<ApiBaseline>(
          `/projects/${projectId}/baselines/${created.id}/activate/`,
        );
        return activated.data;
      } catch (err) {
        // A committed plan refuses activate (ADR-1477, `use_baseline_decision`):
        // the capture still stands as a named comparison baseline.
        if (isUseBaselineDecision(err)) return created;
        throw err;
      }
    },
    onSuccess: (baseline) => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      // An auto-activated first baseline becomes the overlay applied to tasks,
      // so readiness/board cards must refresh. A non-activating capture (an
      // additional baseline) leaves task readiness unchanged.
      if (baseline.is_active) {
        void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      }
    },
  });
}

/** True when the server refused an activate because the plan is committed (ADR-1477). */
export function isUseBaselineDecision(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  const data = response?.data;
  return (
    response?.status === 409 &&
    typeof data === 'object' &&
    data !== null &&
    (data as { code?: unknown }).code === 'use_baseline_decision'
  );
}

/** Activate an existing baseline. */
export function useActivateBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiBaseline, Error, string>({
    mutationFn: async (baselineId) => {
      const res = await apiClient.post<ApiBaseline>(
        `/projects/${projectId}/baselines/${baselineId}/activate/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      // Active baseline changes which overlay is applied to tasks.
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/** Soft-delete a baseline. */
export function useDeleteBaseline(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (baselineId) => {
      await apiClient.delete(`/projects/${projectId}/baselines/${baselineId}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Baseline variance (ADR-1485 D3) — only the rollup is read here
// ---------------------------------------------------------------------------

export interface ApiDerivationRef {
  task_id: string;
  quantity: 'early_finish';
}

export interface ApiBaselineTopSlip {
  task_id: string;
  task_name: string;
  baseline_finish: string | null;
  current_finish: string | null;
  finish_delta_working_days: number;
  cause: string | null;
  derivation_ref: ApiDerivationRef | null;
}

/** The server's "what moved" rollup over every variance row, the same on every page. */
export interface ApiBaselineVarianceSummary {
  tasks_moved: number;
  tasks_finishing_later: number;
  tasks_finishing_earlier: number;
  finish_slip_working_days_total: number;
  top_slip: ApiBaselineTopSlip | null;
  project_finish: {
    baseline_finish: string | null;
    current_finish: string | null;
    delta_working_days: number | null;
  };
}

export interface ApiBaselineVariance {
  count: number;
  baseline_id: string;
  baseline_name: string;
  has_cpm_dates: boolean;
  min_days: number;
  added: number;
  removed: number;
  summary: ApiBaselineVarianceSummary;
  as_of: string;
}

/**
 * The variance read against one baseline, for its `summary` rollup.
 *
 * The read runs a CPM pass server-side to explain each finish (`cpm_on_read`
 * throttle), so it is not polled: a minute's staleness is fine for a summary, and
 * a failure is not retried automatically (rule 452 — the caller offers Retry).
 * Page 1 only; the summary is identical on every page.
 */
export function useBaselineVariance(
  projectId: string | null | undefined,
  baselineId: string | null | undefined,
) {
  return useQuery<ApiBaselineVariance, Error>({
    queryKey: ['baselines', projectId, baselineId, 'variance'],
    queryFn: async () => {
      const res = await apiClient.get<ApiBaselineVariance>(
        `/projects/${projectId}/baselines/${baselineId}/variance/`,
      );
      return res.data;
    },
    enabled: !!projectId && !!baselineId,
    staleTime: 60_000,
    retry: false,
  });
}
