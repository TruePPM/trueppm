import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { Methodology } from '@/types';

interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string | null;
  methodology?: Methodology;
}

// ---------------------------------------------------------------------------
// useCreateProject — POST /api/v1/projects/
// ---------------------------------------------------------------------------

export interface CreateProjectPayload {
  name: string;
  start_date: string;
  description?: string;
  /** Project planning methodology (ADR-0041). Server defaults to HYBRID when omitted. */
  methodology?: Methodology;
  /** Sprint/story-points UI gate (ADR-0037). True for AGILE and HYBRID projects. */
  agile_features?: boolean;
  /** Optional Program assignment at creation time (ADR-0070). Requires ADMIN on the target program. */
  program?: string;
}

/** POST /api/v1/projects/ — create a new project and invalidate the project list cache. */
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateProjectPayload) => {
      const res = await apiClient.post<ApiProject>('/projects/', payload);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateProject — PATCH /api/v1/projects/:id/
// ---------------------------------------------------------------------------

export interface UpdateProjectPayload {
  name?: string;
  description?: string;
}

/**
 * PATCH /api/v1/projects/:id/ — update editable project fields and invalidate
 * the project detail + list caches. Used by the settings save bar (#536) for
 * the Project General page. Extended fields (code, health, visibility,
 * timezone, calendar, default view) ship via #520 layering on the same call.
 */
export function useUpdateProject(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateProjectPayload) => {
      if (!projectId) throw new Error('projectId is required');
      const res = await apiClient.patch<ApiProject>(`/projects/${projectId}/`, payload);
      return res.data;
    },
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useCalendars — GET /api/v1/calendars/ (optional; used to offer a picker)
// ---------------------------------------------------------------------------

export interface ApiCalendar {
  id: string;
  name: string;
}

/** GET /api/v1/calendars/ — fetch available calendars for the project creation picker. */
export function useCalendars() {
  return useQuery({
    queryKey: ['calendars'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiCalendar>>('/calendars/');
      return res.data.results;
    },
  });
}
