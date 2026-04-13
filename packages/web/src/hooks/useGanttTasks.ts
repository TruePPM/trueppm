import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { apiClient } from '@/api/client';
import type { Task, TaskLink, TaskStatus, LinkType } from '@/types';
import type { PaginatedResponse } from '@/api/types';

export interface UseGanttTasksResult {
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
  baseline_start: string | null;
  baseline_finish: string | null;
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

  // Derive finish from start + duration rather than early_finish directly.
  // early_finish is only updated after CPM runs; using start + duration means
  // the bar width is always consistent with the duration the user just set.
  const finish = (start && t.duration > 0)
    ? new Date(
        new Date(start + 'T00:00:00Z').getTime() + t.duration * 86_400_000,
      ).toISOString().slice(0, 10)
    : (t.early_finish ?? '');

  return {
    id: t.id,
    wbs: t.wbs_path ?? '',
    name: t.name,
    start,
    finish,
    duration: t.duration,
    progress: t.percent_complete,
    parentId: t.parent_id,
    isCritical: t.is_critical,
    isComplete: t.percent_complete >= 100,
    isSummary: t.is_summary,
    isMilestone: t.is_milestone,
    status: t.status,
    baselineStart: t.baseline_start ?? undefined,
    baselineFinish: t.baseline_finish ?? undefined,
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

export function useGanttTasks(projectId?: string): UseGanttTasksResult {
  const [searchParams] = useSearchParams();
  const resolvedId = projectId ?? searchParams.get('project') ?? undefined;

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
      return res.data.results.map(mapTask);
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
