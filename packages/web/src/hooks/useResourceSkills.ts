import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { Proficiency, ResourceSkill } from '@/types';

interface ApiResourceSkill {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: Proficiency;
}

function mapResourceSkill(s: ApiResourceSkill): ResourceSkill {
  return {
    id: s.id,
    resourceId: s.resource,
    skillId: s.skill,
    skill: { id: s.skill, name: s.skill_name, normalizedName: '', category: '' },
    proficiency: s.proficiency,
  };
}

/** GET /api/v1/resource-skills/?resource={resourceId} */
export function useResourceSkills(resourceId: string) {
  return useQuery({
    queryKey: ['resource-skills', resourceId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiResourceSkill>>('/resource-skills/', {
        params: { resource: resourceId },
      });
      return res.data.results.map(mapResourceSkill);
    },
    enabled: Boolean(resourceId),
    staleTime: 30_000,
  });
}

/** POST /api/v1/resource-skills/ */
export function useAddResourceSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillId,
      proficiency,
    }: {
      skillId: string;
      proficiency: Proficiency;
    }) => {
      const res = await apiClient.post<ApiResourceSkill>('/resource-skills/', {
        resource: resourceId,
        skill: skillId,
        proficiency,
      });
      return mapResourceSkill(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['resource-skills', resourceId] });
    },
  });
}

/** PATCH /api/v1/resource-skills/{id}/ */
export function useUpdateResourceSkillProficiency(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, proficiency }: { id: string; proficiency: Proficiency }) => {
      const res = await apiClient.patch<ApiResourceSkill>(`/resource-skills/${id}/`, {
        proficiency,
      });
      return mapResourceSkill(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['resource-skills', resourceId] });
    },
  });
}

/** DELETE /api/v1/resource-skills/{id}/ */
export function useRemoveResourceSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/resource-skills/${id}/`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['resource-skills', resourceId] });
    },
  });
}
