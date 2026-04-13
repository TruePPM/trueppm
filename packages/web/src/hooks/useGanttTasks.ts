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
  return {
    id: t.id,
    wbs: t.wbs_path ?? '',
    name: t.name,
    start: t.early_start ?? '',
    finish: t.early_finish ?? '',
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
