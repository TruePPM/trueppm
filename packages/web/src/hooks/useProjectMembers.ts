/**
 * Hook for the project member list used by @mention autocomplete (#311).
 *
 * Returns just enough per-member data for the dropdown: user id + username +
 * role ordinal (so consumers can label cluster suggestions, e.g. "Member").
 * Lives at a different cache key than useCurrentUserRole so a self-only query
 * stays cheap.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface MentionMemberOption {
  id: string;
  username: string;
  role: number;
}

interface MembershipRow {
  id: string;
  user_detail: { id: string; username: string };
  role: number;
}

/** GET /api/v1/projects/{id}/members/ — full project member roster. */
export function useProjectMembers(projectId: string | undefined) {
  const query = useQuery({
    queryKey: ['project-members-mentions', projectId],
    queryFn: async () => {
      const res = await apiClient.get<MembershipRow[]>(`/projects/${projectId}/members/`);
      return res.data.map<MentionMemberOption>((row) => ({
        id: row.user_detail.id,
        username: row.user_detail.username,
        role: row.role,
      }));
    },
    enabled: !!projectId,
    // Member roster changes rarely; 5-min cache mirrors useCurrentUserRole
    // and keeps the autocomplete popover snappy.
    staleTime: 5 * 60 * 1000,
  });

  return {
    members: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
