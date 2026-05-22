import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ProjectDefaultView, ProjectHealth, ProjectVisibility } from '@/api/types';
import type { Methodology } from '@/types';

export interface ApiProjectDetail {
  id: string;
  server_version: number;
  name: string;
  description: string;
  start_date: string;
  calendar: string | null;
  estimation_mode: string;
  agile_features: boolean;
  methodology: Methodology;
  /** Optional short code (uppercase A-Z, 0-9, hyphen; ≤12 chars). Empty when unset. */
  code: string;
  /** PM health override; AUTO defers to the (future) rollup. */
  health: ProjectHealth;
  /** Workspace or private listing scope. */
  visibility: ProjectVisibility;
  /** IANA timezone identifier; empty string defers to the workspace default. */
  timezone: string;
  /** Default landing view when the project is opened without one in the URL. */
  default_view: ProjectDefaultView;
}

/**
 * GET /api/v1/projects/{id}/ — fetch a single project's full record.
 *
 * Used by shell components (ViewTabs, BottomNav) that need methodology to
 * determine tab visibility. The `enabled` flag suppresses the request when
 * no projectId is in the route, avoiding a 404 on shell mount.
 */
export function useProject(projectId: string | null | undefined): UseQueryResult<ApiProjectDetail> {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ApiProjectDetail>(`/projects/${projectId}/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}
