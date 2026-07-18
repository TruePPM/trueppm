import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { ProjectResource } from '@/types';

interface ApiResourceSkill {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: 1 | 2 | 3;
}

interface ApiResourceDetail {
  id: string;
  name: string;
  email: string;
  job_role: string;
  max_units: string;
  calendar: string | null;
  skills: ApiResourceSkill[];
  is_me?: boolean;
}

interface ApiProjectResource {
  id: string;
  project: string;
  resource: string;
  resource_detail: ApiResourceDetail;
  role_title: string;
  units_override: string | null;
  effective_max_units: string;
  notes: string;
}

function mapProjectResource(r: ApiProjectResource): ProjectResource {
  return {
    id: r.id,
    projectId: r.project,
    resourceId: r.resource,
    resource: {
      id: r.resource_detail.id,
      name: r.resource_detail.name,
      email: r.resource_detail.email,
      jobRole: r.resource_detail.job_role,
      maxUnits: Number.parseFloat(r.resource_detail.max_units),
      calendarId: r.resource_detail.calendar,
      skills: r.resource_detail.skills.map((s) => ({
        id: s.id,
        resourceId: s.resource,
        skillId: s.skill,
        skill: { id: s.skill, name: s.skill_name, normalizedName: '', category: '' },
        proficiency: s.proficiency,
      })),
      isMe: r.resource_detail.is_me,
    },
    roleTitle: r.role_title,
    unitsOverride: r.units_override !== null ? Number.parseFloat(r.units_override) : null,
    effectiveMaxUnits: Number.parseFloat(r.effective_max_units),
    notes: r.notes,
  };
}

/** GET /api/v1/project-resources/?project={projectId} */
export function useProjectResourcePool(projectId: string) {
  return useQuery({
    queryKey: ['project-resource-pool', projectId],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiProjectResource>>(
        '/project-resources/',
        { params: { project: projectId } },
      );
      return res.data.results.map(mapProjectResource);
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

export interface AddProjectResourcePayload {
  projectId: string;
  resourceId: string;
  roleTitle?: string;
  unitsOverride?: number | null;
  notes?: string;
}

/** POST /api/v1/project-resources/ */
export function useAddProjectResource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: AddProjectResourcePayload) => {
      const res = await apiClient.post<ApiProjectResource>('/project-resources/', {
        project: payload.projectId,
        resource: payload.resourceId,
        role_title: payload.roleTitle ?? '',
        units_override: payload.unitsOverride ?? null,
        notes: payload.notes ?? '',
      });
      return mapProjectResource(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-resource-pool', projectId] });
    },
  });
}

export interface UpdateProjectResourcePayload {
  id: string;
  roleTitle?: string;
  unitsOverride?: number | null;
  notes?: string;
}

/** PATCH /api/v1/project-resources/{id}/ */
export function useUpdateProjectResource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, roleTitle, unitsOverride, notes }: UpdateProjectResourcePayload) => {
      const res = await apiClient.patch<ApiProjectResource>(`/project-resources/${id}/`, {
        ...(roleTitle !== undefined && { role_title: roleTitle }),
        ...(unitsOverride !== undefined && { units_override: unitsOverride }),
        ...(notes !== undefined && { notes }),
      });
      return mapProjectResource(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-resource-pool', projectId] });
    },
  });
}

export interface RemoveProjectResourceResult {
  detail: string;
  cascadedAssignmentCount: number;
}

/** DELETE /api/v1/project-resources/{id}/?force=true|false */
export function useRemoveProjectResource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    RemoveProjectResourceResult,
    { response?: { status: number; data: unknown } },
    { id: string; force: boolean }
  >({
    mutationFn: async ({ id, force }) => {
      const res = await apiClient.delete<{ detail: string; cascaded_assignment_count: number }>(
        `/project-resources/${id}/`,
        { params: force ? { force: 'true' } : {} },
      );
      return {
        detail: res.data.detail,
        cascadedAssignmentCount: res.data.cascaded_assignment_count,
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-resource-pool', projectId] });
    },
  });
}
