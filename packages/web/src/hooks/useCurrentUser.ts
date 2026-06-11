import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

export interface CurrentUser {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  email: string;
  /**
   * Contributor-tier role signal (#855/#856, ADR-0118). Server-computed so the
   * client gates admin chrome on one boolean instead of fanning out per-project
   * membership lookups.
   *   - max_project_role: highest project Role ordinal across memberships (null
   *     if the user belongs to no projects).
   *   - workspace_role: WorkspaceRole ordinal (null if no workspace membership).
   *   - can_access_admin_settings: Admin+ in any project OR Admin+ at the
   *     workspace — gates the settings shell admin scopes and the Signal-only
   *     notification default.
   */
  max_project_role: number | null;
  workspace_role: number | null;
  can_access_admin_settings: boolean;
}

/**
 * Fetches GET /api/v1/auth/me/ and returns the current user's identity.
 * staleTime: 5 min — matches access token lifetime; avoids redundant refetches.
 */
export function useCurrentUser(): { user: CurrentUser | undefined; isLoading: boolean } {
  const { data, isPending } = useQuery<CurrentUser, AxiosError>({
    queryKey: ['current-user'],
    queryFn: async () => {
      const res = await apiClient.get<CurrentUser>('/auth/me/');
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return { user: data, isLoading: isPending };
}
