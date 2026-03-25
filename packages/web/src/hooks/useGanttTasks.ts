import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api';
import type { Task, TaskLink, LinkType } from '@/types';

// ---------------------------------------------------------------------------
// API response shapes (snake_case, matches DRF TaskSerializer / DependencySerializer)
// ---------------------------------------------------------------------------

interface ApiTask {
  id: string;
  wbs_path: string;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  duration: number;
  percent_complete: number;
  is_critical: boolean;
  is_milestone: boolean;
  // Summary tasks have a null parent — inferred from wbs_path depth in the UI
  // (no explicit is_summary field on the API yet).
}

interface ApiDependency {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapTask(t: ApiTask): Task {
  return {
    id: t.id,
    wbs: t.wbs_path,
    name: t.name,
    // Fall back to empty string when CPM hasn't run yet (early_start is null).
    start: t.early_start ?? '',
    finish: t.early_finish ?? '',
    duration: t.duration,
    progress: t.percent_complete,
    parentId: null, // WBS hierarchy is reconstructed from wbs_path by SVAR
    isCritical: t.is_critical,
    isComplete: t.percent_complete >= 100,
    isSummary: false, // placeholder — summary flag added in issue #57
    isMilestone: t.is_milestone,
  };
}

function mapDependency(d: ApiDependency): TaskLink {
  return {
    id: d.id,
    sourceId: d.predecessor,
    targetId: d.successor,
    type: d.dep_type as LinkType,
    isCritical: false, // not yet computed server-side; updated when CPM exposes this
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseGanttTasksResult {
  tasks: Task[] | undefined;
  links: TaskLink[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useGanttTasks(projectId?: string): UseGanttTasksResult {
  const tasksQuery = useQuery<Task[], Error>({
    queryKey: ['tasks', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ApiTask[]>('/tasks/', { params: { project: projectId } });
      return res.data.map(mapTask);
    },
    enabled: !!projectId,
  });

  const linksQuery = useQuery<TaskLink[], Error>({
    queryKey: ['dependencies', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ApiDependency[]>('/dependencies/', {
        params: { project: projectId },
      });
      return res.data.map(mapDependency);
    },
    enabled: !!projectId,
  });

  return {
    tasks: tasksQuery.data,
    links: linksQuery.data,
    isLoading: tasksQuery.isLoading || linksQuery.isLoading,
    error: tasksQuery.error ?? linksQuery.error,
  };
}
