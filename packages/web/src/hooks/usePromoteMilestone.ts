import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useProjectVelocity } from '@/hooks/useSprints';
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
}

/**
 * Promote a sprint's commitment to a schedule milestone (create+bind or bind
 * existing). Invalidates the sprint list (the binding + provenance live on the
 * sprint) and the project task list (create+bind adds a milestone task).
 */
export function usePromoteSprintToMilestone(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiSprint, unknown, PromotePayload>({
    mutationFn: async ({ sprintId, milestoneId }) => {
      const body = milestoneId ? { milestone_id: milestoneId } : {};
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
}

/**
 * Milestone tasks in the project, offered as bind targets in "Bind existing"
 * mode. Sourced from the live schedule task list (`useScheduleTasks`) filtered
 * to `isMilestone`, sorted by finish date. The currently-bound milestone (if
 * any) is excluded so the picker only shows *other* targets.
 *
 * A sprint→milestone binding is many-sprints-to-one-milestone, so we do NOT
 * hide milestones that already have other sprints — only the one this sprint is
 * already bound to. The server is the authority on validity (it rejects a
 * cross-project or deleted milestone).
 */
export function useMilestoneCandidates(
  projectId: string | null | undefined,
  excludeMilestoneId?: string | null,
): { candidates: MilestoneCandidate[]; isLoading: boolean } {
  const { tasks, isLoading } = useScheduleTasks(projectId ?? undefined);
  const candidates = useMemo(() => {
    return (tasks ?? [])
      .filter((t) => t.isMilestone && t.id !== excludeMilestoneId)
      .map((t) => ({ id: t.id, name: t.name, wbs: t.wbs, finish: t.finish }))
      .sort((a, b) => a.finish.localeCompare(b.finish));
  }, [tasks, excludeMilestoneId]);
  return { candidates, isLoading };
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
  /** Team-pace band in points/sprint (the velocity range), for the caption. */
  teamPaceLow: number;
  teamPaceHigh: number;
  /** ADR-0106 §4 — true when the milestone has an upstream predecessor not in
   *  this sprint, so the range may be optimistic. */
  unmodeledDependency: boolean;
}

function shiftIso(iso: string, days: number): string {
  if (!iso) return iso;
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Reforecast preview for variant B's "watch the CPM finish reforecast" panel.
 *
 * Stubbed read (web-rule 11): ADR-0106 §2/§3 define the reforecast as a write that runs
 * on *sprint close* (`reforecast_bound_milestone`) — there is no pre-bind
 * dry-run endpoint yet, so this hook derives an illustrative projection from the
 * already-loaded velocity band and the milestone's current CPM finish. It is
 * explicitly labelled "preview/projection" in the UI; the authoritative range is
 * computed and recorded on close. When a `GET /sprints/{id}/reforecast-preview/`
 * dry-run endpoint ships, swap the body of this hook for the live read — the
 * `ReforecastPreview` shape is the contract. The dialog renders correctly when
 * this returns `null` (it falls back to the honest "reforecasts on close" note).
 *
 * TODO: replace the derived projection with a real dry-run endpoint (see the
 * "DA-02 contract gaps" note handed to the ADR-0106 owner).
 */
export function useReforecastPreview(
  projectId: string | null | undefined,
  milestoneFinishIso: string | null | undefined,
  enabled: boolean,
): { preview: ReforecastPreview | null; isLoading: boolean } {
  const { data: velocity, isLoading } = useProjectVelocity(enabled ? projectId : null);

  const preview = useMemo<ReforecastPreview | null>(() => {
    if (!enabled || !milestoneFinishIso) return null;
    const low = velocity?.forecast_range_low ?? null;
    const high = velocity?.forecast_range_high ?? null;
    const avg = velocity?.rolling_avg_points ?? null;
    // Without at least one closed sprint of velocity there is nothing to project.
    if (low == null || high == null || avg == null) return null;

    // Illustrative pull-in: a wider, healthier band pulls the finish in a little;
    // this is a preview heuristic only — the real engine runs the agile-aware
    // Monte Carlo / velocity-band math on close (ADR-0106 §3).
    const pull = Math.min(6, Math.max(0, Math.round((high - low) / 2)));
    return {
      basis: 'velocity_band',
      cpmFinish: milestoneFinishIso,
      p50: shiftIso(milestoneFinishIso, -(pull + 2)),
      p80: shiftIso(milestoneFinishIso, -pull),
      p95: shiftIso(milestoneFinishIso, 1),
      teamPaceLow: low,
      teamPaceHigh: high,
      unmodeledDependency: false,
    };
  }, [enabled, milestoneFinishIso, velocity]);

  return { preview, isLoading };
}
