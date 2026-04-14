import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { TaskAssignment } from '@/types';
import type { PaginatedResponse } from '@/api/types';

interface ApiTaskResource {
  id: string;
  resource: string;
  resource_name: string;
  units: number;
}

function mapAssignment(a: ApiTaskResource): TaskAssignment {
  return {
    id: a.id,
    resourceId: a.resource,
    resourceName: a.resource_name,
    units: a.units,
  };
}

export function useTaskAssignments(taskId: string) {
  return useQuery({
    queryKey: ['task-assignments', taskId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiTaskResource>>(
        '/task-resources/',
        { params: { task: taskId } },
      );
      return res.data.results.map(mapAssignment);
    },
    enabled: !!taskId,
    staleTime: 0,
  });
}
