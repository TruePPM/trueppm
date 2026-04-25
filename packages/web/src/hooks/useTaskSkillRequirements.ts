import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { Proficiency, TaskSkillRequirement } from '@/types';

interface ApiTaskSkillRequirement {
  id: string;
  task: string;
  skill: string;
  skill_name: string;
  min_proficiency: Proficiency;
}

function mapRequirement(r: ApiTaskSkillRequirement): TaskSkillRequirement {
  return {
    id: r.id,
    taskId: r.task,
    skillId: r.skill,
    skill: { id: r.skill, name: r.skill_name, normalizedName: '', category: '' },
    minProficiency: r.min_proficiency,
  };
}

/** GET /api/v1/task-skill-requirements/?task={taskId} */
export function useTaskSkillRequirements(taskId: string) {
  return useQuery({
    queryKey: ['task-skill-requirements', taskId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiTaskSkillRequirement>>(
        '/task-skill-requirements/',
        { params: { task: taskId } },
      );
      return res.data.results.map(mapRequirement);
    },
    enabled: Boolean(taskId),
    staleTime: 30_000,
  });
}

/** POST /api/v1/task-skill-requirements/ */
export function useAddTaskSkillRequirement(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillId,
      minProficiency,
    }: {
      skillId: string;
      minProficiency: Proficiency;
    }) => {
      const res = await apiClient.post<ApiTaskSkillRequirement>('/task-skill-requirements/', {
        task: taskId,
        skill: skillId,
        min_proficiency: minProficiency,
      });
      return mapRequirement(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-skill-requirements', taskId] });
    },
  });
}

/** PATCH /api/v1/task-skill-requirements/{id}/ */
export function useUpdateTaskSkillRequirement(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, minProficiency }: { id: string; minProficiency: Proficiency }) => {
      const res = await apiClient.patch<ApiTaskSkillRequirement>(
        `/task-skill-requirements/${id}/`,
        { min_proficiency: minProficiency },
      );
      return mapRequirement(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-skill-requirements', taskId] });
    },
  });
}

/** DELETE /api/v1/task-skill-requirements/{id}/ */
export function useRemoveTaskSkillRequirement(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/task-skill-requirements/${id}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-skill-requirements', taskId] });
    },
  });
}
