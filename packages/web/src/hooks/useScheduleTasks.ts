import { useQuery } from '@tanstack/react-query';
import { useProjectId } from '@/hooks/useProjectId';
import { apiClient } from '@/api/client';
import type { Task, TaskAssignee, TaskLink, TaskStatus, LinkType, TaskReadiness } from '@/types';
import type { PaginatedResponse } from '@/api/types';
import { computeWbsCodes } from '@/utils/computeWbsCodes';

export interface UseScheduleTasksResult {
  tasks: Task[] | undefined;
  links: TaskLink[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

interface ApiTask {
  id: string;
  wbs_path: string | null;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  planned_start: string | null;
  duration: number;
  percent_complete: number;
  is_critical: boolean;
  status: TaskStatus;
  is_milestone: boolean;
  is_summary: boolean;
  parent_id: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  schedule_variance_days: number | null;
  baseline_start: string | null;
  baseline_finish: string | null;
  optimistic_duration: number | null;
  most_likely_duration: number | null;
  pessimistic_duration: number | null;
  estimate_status: 'pending' | 'accepted' | null;
  total_float: number | null;
  // Board batch 3 (ADR-0035) — PPM signal annotations.
  predecessor_count?: number;
  is_blocked?: boolean;
  linked_risks_count?: number;
  linked_risks_max_severity?: number | null;
  // Board batch 5 (issue #105) — entry stamps, priority rank, readiness.
  status_changed_at?: string | null;
  priority_rank?: number | null;
  readiness?: string | null;
  // Wave 3 (#210) — passive overalloc indicator in task drawer.
  assignee_is_overallocated?: boolean;
  assignments?: Array<{
    resource_id: string;
    resource_name: string;
    units: number;
  }>;
}

interface ApiDependency {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
  is_critical: boolean;
}

function mapTask(t: ApiTask): Task {
  // Use the later of planned_start (SNET constraint) and early_start (CPM result).
  //
  // CPM guarantees early_start = max(forward-pass result, planned_start), so after
  // CPM runs, early_start ≥ planned_start. Taking max() here means:
  //   • Right after a drag (planned_start updated, CPM pending): planned_start wins ✓
  //   • After CPM with a new dependency pushing the task later: early_start wins ✓
  //   • No SNET constraint (planned_start = null): early_start is used directly ✓
  const p = t.planned_start;
  const e = t.early_start;
  const start = (p && e) ? (p >= e ? p : e) : (p ?? e ?? '');

  // Summary tasks: start/finish always come from CPM rollup (early_start / early_finish).
  // Duration is also CPM-derived (calendar-day span written back by the scheduler).
  // We must not compute finish from duration here — the stored duration may be stale
  // before the first CPM run, or the span may not match the stored working-day count.
  //
  // Leaf tasks: derive finish from start + duration rather than early_finish directly.
  // early_finish is only updated after CPM runs; using start + duration means
  // the bar width is always consistent with the duration the user just set.
  const finish = t.is_summary
    ? (t.early_finish ?? '')
    : (start && t.duration > 0)
      ? new Date(
          new Date(start + 'T00:00:00Z').getTime() + t.duration * 86_400_000,
        ).toISOString().slice(0, 10)
      : (t.early_finish ?? '');

  // For summary tasks that have CPM dates, compute a display duration as the
  // calendar-day span. This matches what the backend writes back during CPM so
  // both representations stay consistent.
  const displayDuration =
    t.is_summary && t.early_start && t.early_finish
      ? Math.max(
          1,
          Math.round(
            (new Date(t.early_finish).getTime() - new Date(t.early_start).getTime()) /
              86_400_000,
          ),
        )
      : t.duration;

  return {
    id: t.id,
    wbs: t.wbs_path ?? '',
    name: t.name,
    start,
    finish,
    duration: displayDuration,
    progress: t.percent_complete,
    parentId: t.parent_id,
    isCritical: t.is_critical,
    isComplete: t.percent_complete >= 100,
    isSummary: t.is_summary,
    isMilestone: t.is_milestone,
    status: t.status,
    actualStart: t.actual_start ?? undefined,
    actualFinish: t.actual_finish ?? undefined,
    scheduleVarianceDays: t.schedule_variance_days,
    baselineStart: t.baseline_start ?? undefined,
    baselineFinish: t.baseline_finish ?? undefined,
    assignees: (t.assignments ?? []).map(
      (a): TaskAssignee => ({
        resourceId: a.resource_id,
        name: a.resource_name,
        units: a.units,
      }),
    ),
    optimisticDuration: t.optimistic_duration,
    mostLikelyDuration: t.most_likely_duration,
    pessimisticDuration: t.pessimistic_duration,
    estimateStatus: t.estimate_status,
    totalFloat: t.total_float,
    predecessorCount: t.predecessor_count ?? 0,
    isBlocked: t.is_blocked ?? false,
    linkedRisksCount: t.linked_risks_count ?? 0,
    linkedRisksMaxSeverity: t.linked_risks_max_severity ?? null,
    statusEnteredAt: t.status_changed_at ?? undefined,
    priorityRank: t.priority_rank ?? undefined,
    readiness: (t.readiness as TaskReadiness | undefined) ?? undefined,
    assigneeIsOverallocated: t.assignee_is_overallocated ?? false,
  };
}

function mapDependency(d: ApiDependency): TaskLink {
  return {
    id: d.id,
    sourceId: d.predecessor,
    targetId: d.successor,
    type: d.dep_type as LinkType,
    lag: d.lag,
    isCritical: d.is_critical,
  };
}

/**
 * Fetch tasks and dependency links for the Gantt view.
 *
 * Reads projectId from the `:projectId` path param (ADR-0030).
 * An explicit `projectId` argument overrides the URL param for cases
 * where the hook is used outside the project route (e.g. tests).
 */
export function useScheduleTasks(projectId?: string): UseScheduleTasksResult {
  const paramId = useProjectId();
  const resolvedId = projectId ?? paramId;

  const tasksQuery = useQuery({
    queryKey: ['tasks', resolvedId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiTask>>('/tasks/', {
        params: { project: resolvedId },
      });
      // Only include tasks that have been scheduled — null dates crash the
      // Gantt engine's date-to-canvas conversion. New tasks appear once the
      // CPM worker assigns early_start / early_finish.
      // Pass all tasks to the engine — _paintTaskAt skips bars for unscheduled
      // tasks (empty start/finish), and _updateProjectRange defaults to today
      // ±30 days when no task has dates yet. Filtering here caused the task list
      // to show "No tasks yet" even when the project had unscheduled tasks.
      const rawTasks = res.data.results.map(mapTask);
      // Compute WBS display codes from tree position (parentId + sibling order)
      // rather than passing through wbs_path directly. This ensures codes are
      // always sequential and correct — including for tasks created in the UI
      // before wbs_path is assigned, or after indent/outdent operations.
      const wbsCodes = computeWbsCodes(rawTasks);
      return rawTasks.map((t) => ({ ...t, wbs: wbsCodes.get(t.id) ?? t.wbs }));
    },
    enabled: !!resolvedId,
    // Poll every 2 s so CPM-computed dates (early_start/early_finish) propagate
    // to the canvas and task list without requiring a manual page refresh.
    refetchInterval: 2000,
  });

  const linksQuery = useQuery({
    queryKey: ['dependencies', resolvedId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiDependency>>('/dependencies/', {
        params: { project: resolvedId },
      });
      return res.data.results.map(mapDependency);
    },
    enabled: !!resolvedId,
  });

  return {
    tasks: tasksQuery.data,
    links: linksQuery.data,
    isLoading: tasksQuery.isLoading || linksQuery.isLoading,
    error: tasksQuery.error ?? linksQuery.error,
  };
}
