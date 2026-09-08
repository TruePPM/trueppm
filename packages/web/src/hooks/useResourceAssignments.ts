import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { TaskStatus } from '@/types';

interface ApiResourceAssignment {
  id: string;
  task: string;
  task_name: string;
  project: string;
  project_name: string;
  status: TaskStatus;
  percent_complete: number;
  units: string;
}

/** One task a resource is assigned to, carrying its project context for grouping. */
export interface ResourceAssignment {
  /** Assignment (TaskResource) id — the stable list key. */
  id: string;
  taskId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  /** 0-100. */
  percentComplete: number;
  /** Allocation fraction of full capacity (1 = 100%). */
  units: number;
}

function mapAssignment(a: ApiResourceAssignment): ResourceAssignment {
  return {
    id: a.id,
    taskId: a.task,
    taskName: a.task_name,
    projectId: a.project,
    projectName: a.project_name,
    status: a.status,
    percentComplete: a.percent_complete,
    units: Number(a.units),
  };
}

/**
 * GET /api/v1/resources/{id}/assignments/ — cross-project task assignments for one
 * resource (#2047). The endpoint requires `IsWorkspaceOperator` — the installation
 * superuser (#3569 raised it from `IsOrgAdmin`, which any account self-granted by
 * creating a project). A 403 surfaces as the query's error state and the section
 * renders nothing.
 *
 * Expect 403 to be the *common* case, not an exceptional one: the upstream
 * `can_access_admin_settings` gate on the section is much broader than the server's
 * operator check, so ordinary project admins reach this hook and are refused.
 * Narrowing that gate needs a server-computed operator flag on `/me`, which does
 * not exist yet.
 */
export function useResourceAssignments(resourceId: string | undefined) {
  return useQuery({
    queryKey: ['resource-assignments', resourceId],
    queryFn: async () => {
      const res = await apiClient.get<
        PaginatedResponse<ApiResourceAssignment> | ApiResourceAssignment[]
      >(`/resources/${resourceId}/assignments/`);
      const rows = Array.isArray(res.data) ? res.data : res.data.results;
      return rows.map(mapAssignment);
    },
    enabled: !!resourceId,
    staleTime: 30_000,
  });
}
