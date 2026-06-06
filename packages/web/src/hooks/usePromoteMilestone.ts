import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ApiSprint } from '@/types';

/**
 * Sprint → schedule-milestone binding (DA-02 / ADR-0106 §2).
 *
 * Promote binds a sprint's commitment to a schedule milestone so the sprint's
 * velocity reforecasts the milestone's CPM finish on close. The binding is the
 * existing `Sprint.target_milestone` FK enriched with provenance; the only
 * writes go through the two dedicated actions below (never a bare PATCH of
 * `target_milestone` — that would set the FK without provenance and is exactly
 * the silent-drift path the ADR forbids).
 *
 * Contract (ADR-0106 §2):
 *   POST /sprints/{id}/promote-to-milestone/
 *     body {}                  → create a milestone (named from sprint.goal,
 *                                 dated at sprint.finish_date) and bind it
 *     body { milestone_id }     → bind an existing project milestone
 *     200/201 → updated SprintSerializer
 *     409 { code: "sprint_already_bound" } when re-binding to a *different*
 *         milestone (binding never silently re-points — unbind first)
 *   POST /sprints/{id}/unbind-milestone/  → 200 updated SprintSerializer
 */

/** Structured 409 body returned when a sprint is already bound (ADR-0106 §2). */
export const SPRINT_ALREADY_BOUND = 'sprint_already_bound' as const;

interface ApiErrorBody {
  code?: string;
  detail?: string;
}

/** Narrow an unknown mutation error to the ADR-0106 already-bound 409. */
export function isSprintAlreadyBound(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: ApiErrorBody } };
  return (
    e?.response?.status === 409 &&
    e?.response?.data?.code === SPRINT_ALREADY_BOUND
  );
}

export interface PromotePayload {
  sprintId: string;
  /** Omit (or pass null) to create+bind a new milestone; pass an id to bind an
   *  existing one. Mirrors the ADR `{}` vs `{ milestone_id }` body split. */
  milestoneId?: string | null;
  /** Create-mode only (ADR-0106 §E1.2): optional milestone name. Blank/undefined
   *  → the backend's goal-derived default. Ignored on the bind-existing path. */
  name?: string;
  /** Create-mode only (ADR-0106 §E1.2): optional ISO target date (the milestone's
   *  planned_start floor). Undefined → the sprint finish date. Ignored on bind. */
  targetDate?: string;
}

/**
 * Promote a sprint's commitment to a schedule milestone (create+bind or bind
 * existing). Invalidates the sprint list (the binding + provenance live on the
 * sprint) and the project task list (create+bind adds a milestone task).
 */
export function usePromoteSprintToMilestone(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiSprint, unknown, PromotePayload>({
    mutationFn: async ({ sprintId, milestoneId, name, targetDate }) => {
      // bind-existing → { milestone_id }; create+bind → {} plus the optional
      // create overrides (§E1.2). A blank name/date is omitted so the backend
      // applies its goal-name / sprint-finish defaults.
      let body: Record<string, unknown>;
      if (milestoneId) {
        body = { milestone_id: milestoneId };
      } else {
        body = {};
        const trimmedName = name?.trim();
        if (trimmedName) body.name = trimmedName;
        if (targetDate) body.target_date = targetDate;
      }
      const res = await apiClient.post<ApiSprint>(
        `/sprints/${sprintId}/promote-to-milestone/`,
        body,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      // A create+bind mints a new milestone task; refresh the schedule too.
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/**
 * Unbind a sprint from its milestone (ADR-0106 §2). Clears the FK + all three
 * provenance fields server-side; the milestone reverts to its CPM-only forecast.
 */
export function useUnbindSprintMilestone(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiSprint, unknown, { sprintId: string }>({
    mutationFn: async ({ sprintId }) => {
      const res = await apiClient.post<ApiSprint>(
        `/sprints/${sprintId}/unbind-milestone/`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Bind-existing candidates — real data from the schedule task list.
// ---------------------------------------------------------------------------

export interface MilestoneCandidate {
  id: string;
  name: string;
  /** WBS display code, e.g. "1.3.1". Empty string when unassigned. */
  wbs: string;
  /** ISO date — the milestone's CPM finish, or empty when CPM has not run. */
  finish: string;
  /** True when at least one sprint already targets this milestone (ADR-0106
   *  §E1.3 `is_bound`). A binding is many-sprints-to-one, so a bound milestone is
   *  still a valid target — surfaced as an annotation, not a disable. */
  isBound: boolean;
}

/** Slim milestone row from `GET /projects/{id}/milestones/` (ADR-0106 §E1.3). */
interface ApiMilestoneRow {
  id: string;
  name: string;
  wbs_path: string | null;
  early_finish: string | null;
  is_bound: boolean;
}

/**
 * Milestone tasks in the project, offered as bind targets in "Bind existing"
 * mode. Reads the dedicated slim endpoint `GET /projects/{id}/milestones/`
 * (ADR-0106 §E1.3) rather than scanning the full schedule task list — the rows
 * already carry `is_bound`, server-sorted by finish date.
 *
 * A sprint→milestone binding is many-sprints-to-one-milestone, so we fetch ALL
 * milestones (not `?unbound=true`) and surface `isBound` as an annotation —
 * binding to an already-targeted milestone is allowed. Only the milestone this
 * sprint is *currently* bound to is excluded (the picker shows *other* targets).
 * The server remains the authority on validity (rejects cross-project/deleted).
 */
export function useMilestoneCandidates(
  projectId: string | null | undefined,
  excludeMilestoneId?: string | null,
): { candidates: MilestoneCandidate[]; isLoading: boolean } {
  const query = useQuery<MilestoneCandidate[], Error>({
    queryKey: ['project-milestones', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ApiMilestoneRow[]>(`/projects/${projectId}/milestones/`);
      return res.data.map((m) => ({
        id: m.id,
        name: m.name,
        wbs: m.wbs_path ?? '',
        finish: m.early_finish ?? '',
        isBound: m.is_bound,
      }));
    },
    enabled: !!projectId,
  });
  const candidates = useMemo(
    () => (query.data ?? []).filter((m) => m.id !== excludeMilestoneId),
    [query.data, excludeMilestoneId],
  );
  return { candidates, isLoading: query.isLoading };
}

// ---------------------------------------------------------------------------
// Live reforecast preview (variant B showpiece).
// ---------------------------------------------------------------------------

export interface ReforecastPreview {
  /** Which path produced the range — mirrors ADR-0106 §3 `basis`. */
  basis: 'monte_carlo' | 'velocity_band';
  /** ISO date — the milestone's current CPM-only finish (no velocity input). */
  cpmFinish: string;
  /** ISO dates — projected percentile finishes once this sprint's velocity feeds
   *  the milestone's predecessors. */
  p50: string;
  p80: string;
  p95: string;
  /** Team-pace band in points/sprint (the velocity range), for the caption.
   *  Null below the 2-closed-sprint velocity floor (no defensible band). */
  teamPaceLow: number | null;
  teamPaceHigh: number | null;
  /** ADR-0106 §4 — true when the milestone has an upstream predecessor not in
   *  this sprint, so the range may be optimistic. */
  unmodeledDependency: boolean;
}

/** Wire shape of `GET /sprints/{id}/reforecast-preview/` (ADR-0106 §E1.1). */
interface ApiReforecastPreview {
  basis: string;
  cpm_finish: string | null;
  p50: string | null;
  p80: string | null;
  p95: string | null;
  velocity_low: number | null;
  velocity_high: number | null;
  unmodeled_dependency: boolean;
  unmodeled_predecessor_ids: string[];
}

/**
 * Live dry-run reforecast preview for the promote dialog (ADR-0106 §E1.1, #933).
 *
 * Reads `GET /sprints/{id}/reforecast-preview/` — create-mode omits `milestone_id`
 * (the spine is the sprint finish); bind-mode passes the selected milestone id (its
 * CPM finish is the spine, and its out-of-sprint predecessors light the
 * unmodeled-dependency caveat). Until #411's agile-aware Monte Carlo lands the
 * backend returns `basis="velocity_band"`; the UI keeps its honest "projection,
 * committed on close" framing. Returns `null` when there is no CPM anchor, so the
 * panel falls back to the "reforecasts on close" note.
 */
export function useReforecastPreview(
  sprintId: string | null | undefined,
  milestoneId: string | null | undefined,
  enabled: boolean,
): { preview: ReforecastPreview | null; isLoading: boolean } {
  const query = useQuery<ReforecastPreview | null, Error>({
    queryKey: ['reforecast-preview', sprintId, milestoneId ?? null],
    queryFn: async () => {
      const res = await apiClient.get<ApiReforecastPreview>(
        `/sprints/${sprintId}/reforecast-preview/`,
        { params: milestoneId ? { milestone_id: milestoneId } : {} },
      );
      const d = res.data;
      // No CPM spine → nothing to chart; the panel shows the honest fallback note.
      if (!d.cpm_finish) return null;
      return {
        basis: d.basis === 'monte_carlo' ? 'monte_carlo' : 'velocity_band',
        cpmFinish: d.cpm_finish,
        // p50/p80/p95 collapse to cpm_finish below the velocity floor (API already
        // does this; the ?? is defensive so the bar never renders an empty date).
        p50: d.p50 ?? d.cpm_finish,
        p80: d.p80 ?? d.cpm_finish,
        p95: d.p95 ?? d.cpm_finish,
        teamPaceLow: d.velocity_low,
        teamPaceHigh: d.velocity_high,
        unmodeledDependency: d.unmodeled_dependency,
      };
    },
    enabled: enabled && !!sprintId,
  });

  return { preview: query.data ?? null, isLoading: query.isLoading };
}
