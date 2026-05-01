import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskStatus } from '@/types';
import type { PaginatedResponse } from '@/api/types';

export interface SprintBacklogAssignee {
  resource_id: string;
  resource_name: string;
  units: number;
}

export interface SprintBacklogTask {
  id: string;
  short_id: string;
  name: string;
  wbs_path: string | null;
  status: TaskStatus;
  story_points: number | null;
  is_critical: boolean;
  assignments: SprintBacklogAssignee[];
}

interface ApiSprintTask {
  id: string;
  short_id?: string;
  short_id_display?: string;
  name: string;
  wbs_path: string | null;
  status: TaskStatus;
  story_points: number | null;
  is_critical: boolean;
  assignments?: SprintBacklogAssignee[];
}

/**
 * GET /api/v1/tasks/?project={projectId}&sprint={sprintId} — fetch every task
 * assigned to the given sprint.
 *
 * The TaskSerializer already returns ``story_points`` and ``sprint`` (added
 * in #234) plus ``is_critical``. The hook trims that payload to the subset
 * the SprintBacklogTable consumes so the table can stay independent of the
 * heavy global ``Task`` view-model.
 */
export function useSprintBacklog(
  projectId: string | null | undefined,
  sprintId: string | null | undefined,
) {
  return useQuery({
    queryKey: ['sprint-backlog', projectId, sprintId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiSprintTask>>(
        `/tasks/?project=${projectId}&sprint=${sprintId}`,
      );
      const rows: SprintBacklogTask[] = res.data.results.map((t) => ({
        id: t.id,
        short_id:
          t.short_id_display ?? (t.short_id ? `T-${t.short_id}` : `T-${t.id.slice(0, 6)}`),
        name: t.name,
        wbs_path: t.wbs_path,
        status: t.status,
        story_points: t.story_points,
        is_critical: t.is_critical,
        assignments: t.assignments ?? [],
      }));
      return rows;
    },
    enabled: !!projectId && !!sprintId,
  });
}
