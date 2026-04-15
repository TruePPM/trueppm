import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

interface ApiProject {
  id: string;
  name: string;
  description: string;
  start_date: string;
  calendar: string | null;
}

// ---------------------------------------------------------------------------
// useCreateProject — POST /api/v1/projects/
// ---------------------------------------------------------------------------

export interface CreateProjectPayload {
  name: string;
  start_date: string;
  description?: string;
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
