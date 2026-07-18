/**
 * Hooks for the org-level resource catalog (issue #155).
 *
 * Resources are org-scoped — not filtered by project. Any authenticated user
 * may read; writes require IsOrgAdmin on the API (PM or Owner on any project).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ResourceSkill } from '@/types';

// ---------------------------------------------------------------------------
// API shape (snake_case from backend)
// ---------------------------------------------------------------------------

interface ApiResourceSkill {
  id: string;
  resource: string;
  skill: string;
  skill_name: string;
  proficiency: 1 | 2 | 3;
}

interface ApiResource {
  id: string;
  server_version: number;
  name: string;
  email: string;
  job_role: string;
  calendar: string | null;
  max_units: string;
  is_deleted?: boolean;
  skills: ApiResourceSkill[];
}

interface ApiPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

export interface OrgResource {
  id: string;
  name: string;
  email: string;
  jobRole: string;
  calendarId: string | null;
  maxUnits: number;
  isDeleted: boolean;
  skills: ResourceSkill[];
}

function mapSkill(s: ApiResourceSkill): ResourceSkill {
  return {
    id: s.id,
    resourceId: s.resource,
    skillId: s.skill,
    skill: { id: s.skill, name: s.skill_name, normalizedName: '', category: '' },
    proficiency: s.proficiency,
  };
}

function mapResource(r: ApiResource): OrgResource {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    jobRole: r.job_role,
    calendarId: r.calendar,
    maxUnits: Number.parseFloat(r.max_units),
    isDeleted: r.is_deleted ?? false,
    skills: r.skills.map(mapSkill),
  };
}

// ---------------------------------------------------------------------------
// useResources — GET /api/v1/resources/
// ---------------------------------------------------------------------------

interface UseResourcesParams {
  search?: string;
  includeDeleted?: boolean;
}

export function useResources({ search = '', includeDeleted = false }: UseResourcesParams = {}) {
  return useQuery({
    queryKey: ['org-resources', { search, includeDeleted }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (includeDeleted) params.set('include_deleted', 'true');
      params.set('page_size', '200');
      const res = await apiClient.get<ApiPaginatedResponse<ApiResource>>(
        `/resources/?${params.toString()}`,
      );
      return res.data.results.map(mapResource);
    },
  });
}

// ---------------------------------------------------------------------------
// useResource — GET /api/v1/resources/{id}/
// ---------------------------------------------------------------------------

export function useResource(id: string | null) {
  return useQuery({
    queryKey: ['org-resource', id],
    queryFn: async () => {
      const res = await apiClient.get<ApiResource>(`/resources/${id}/`);
      return mapResource(res.data);
    },
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// useCreateResource — POST /api/v1/resources/
// ---------------------------------------------------------------------------

export interface CreateResourcePayload {
  name: string;
  email?: string;
  jobRole?: string;
  maxUnits?: number;
}

export function useCreateResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateResourcePayload) => {
      const res = await apiClient.post<ApiResource>('/resources/', {
        name: payload.name,
        email: payload.email ?? '',
        job_role: payload.jobRole ?? '',
        max_units: payload.maxUnits ?? 1.0,
      });
      return mapResource(res.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org-resources'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateResource — PATCH /api/v1/resources/{id}/
// ---------------------------------------------------------------------------

export interface UpdateResourcePayload {
  id: string;
  name?: string;
  email?: string;
  jobRole?: string;
  maxUnits?: number;
  calendarId?: string | null;
}

export function useUpdateResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...payload }: UpdateResourcePayload) => {
      const body: Record<string, unknown> = {};
      if (payload.name !== undefined) body.name = payload.name;
      if (payload.email !== undefined) body.email = payload.email;
      if (payload.jobRole !== undefined) body.job_role = payload.jobRole;
      if (payload.maxUnits !== undefined) body.max_units = payload.maxUnits;
      if (payload.calendarId !== undefined) body.calendar = payload.calendarId;
      const res = await apiClient.patch<ApiResource>(`/resources/${id}/`, body);
      return mapResource(res.data);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['org-resource', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['org-resources'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useDeactivateResource — DELETE /api/v1/resources/{id}/
// ---------------------------------------------------------------------------

export function useDeactivateResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/resources/${id}/`);
      return id;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org-resources'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useRestoreResource — POST /api/v1/resources/{id}/restore/
// ---------------------------------------------------------------------------

export function useRestoreResource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.post<ApiResource>(`/resources/${id}/restore/`);
      return mapResource(res.data);
    },
    onSuccess: (restored) => {
      queryClient.setQueryData(['org-resource', restored.id], restored);
      void queryClient.invalidateQueries({ queryKey: ['org-resources'] });
    },
  });
}
