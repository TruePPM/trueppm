/**
 * useCalendarTasks — fetch tasks for a date window from the API.
 *
 * Uses start__gte / finish__lte filters added in issue #40 to return only
 * tasks that overlap the requested calendar window.  Mirrors the Task shape
 * used by useScheduleTasks so CalendarView and ResourceView share one type.
 */

import { useQuery } from '@tanstack/react-query';
import { useProjectId } from '@/hooks/useProjectId';
import { apiClient } from '@/api/client';
import type { Task, TaskAssignee, TaskStatus } from '@/types';
import type { PaginatedResponse } from '@/api/types';

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
  notes?: string;
  assignments?: Array<{
    resource_id: string;
    resource_name: string;
    units: number;
  }>;
}

function mapTask(t: ApiTask): Task {
  const start = t.early_start ?? t.planned_start ?? '';
  const assignees: TaskAssignee[] = (t.assignments ?? []).map((a) => ({
    resourceId: a.resource_id,
    name: a.resource_name,
    units: a.units,
  }));
  return {
    id: t.id,
    wbs: t.wbs_path ?? '',
    name: t.name,
    start,
    finish: t.early_finish ?? start,
    duration: t.duration,
    progress: t.percent_complete,
    parentId: t.parent_id,
    isCritical: t.is_critical,
    isComplete: t.status === 'COMPLETE',
    isSummary: t.is_summary,
    isMilestone: t.is_milestone,
    status: t.status,
    assignees,
    notes: t.notes ?? '',
  };
}

interface UseCalendarTasksOptions {
  /** ISO date string — only tasks finishing on or after this date are returned. */
  startGte?: string;
  /** ISO date string — only tasks starting on or before this date are returned. */
  finishLte?: string;
}

interface UseCalendarTasksReturn {
  tasks: Task[];
  isLoading: boolean;
  error: Error | null;
}

export function useCalendarTasks(options: UseCalendarTasksOptions = {}): UseCalendarTasksReturn {
  const projectId = useProjectId();
  const { startGte, finishLte } = options;

  const query = useQuery({
    queryKey: ['calendarTasks', projectId, startGte, finishLte],
    enabled: !!projectId,
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (projectId) params['project'] = projectId;
      if (startGte) params['start__gte'] = startGte;
      if (finishLte) params['finish__lte'] = finishLte;

      // Fetch all pages (calendar windows are date-bounded so page count is small).
      const allTasks: ApiTask[] = [];
      let nextUrl: string | null;
      const firstPage = await apiClient.get<PaginatedResponse<ApiTask>>('/tasks/', { params });
      allTasks.push(...firstPage.data.results);
      nextUrl = firstPage.data.next ?? null;

      while (nextUrl) {
        const parsed = new URL(nextUrl);
        const pageRes = await apiClient.get<PaginatedResponse<ApiTask>>(
          parsed.pathname + parsed.search,
        );
        allTasks.push(...pageRes.data.results);
        nextUrl = pageRes.data.next ?? null;
      }

      return allTasks.map(mapTask);
    },
  });

  return {
    tasks: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
