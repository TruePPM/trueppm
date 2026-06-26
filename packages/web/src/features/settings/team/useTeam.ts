/**
 * Data hooks for the Project Settings → Team tab (ADR-0078 §E, #927).
 *
 * Types are declared inline (mirroring useProjectMembers / useCurrentUserRole)
 * rather than pulled from the generated `@/api/types`, so the tab does not depend
 * on a schema-codegen run to compile.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { fetchAllPages } from '@/api/pagination';

/** One facet flag. The two are independent of the access role. */
export type TeamFacet = 'is_scrum_master' | 'is_product_owner';

export type TeamRole = 'member' | 'admin';

export interface TeamSummary {
  id: string;
  project: string;
  name: string;
  is_default: boolean;
  member_count: number;
}

export interface TeamMember {
  id: string;
  user: string;
  user_detail: { id: string; username: string; email: string };
  role: TeamRole;
  role_label: string;
  is_scrum_master: boolean;
  is_product_owner: boolean;
}

/**
 * Resolve a project's default team (the only team in 0.3). Returns the first —
 * and currently only — team row; multi-team selection lands with #599.
 */
export function useDefaultTeam(projectId: string | undefined): UseQueryResult<TeamSummary | null> {
  return useQuery({
    queryKey: ['project-teams', projectId],
    queryFn: async () => {
      // The teams list is paginated (issue 1317); page through so the default-team
      // lookup never misses a team that fell past the first page.
      const teams = await fetchAllPages<TeamSummary>(`/projects/${projectId}/teams/`);
      return teams.find((t) => t.is_default) ?? teams[0] ?? null;
    },
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Roster for a team, including each member's role and facet flags. */
export function useTeamMembers(teamId: string | undefined): UseQueryResult<TeamMember[]> {
  return useQuery({
    queryKey: ['team-members', teamId],
    queryFn: async () => {
      // The roster is paginated (issue 1317); page through so the whole team is
      // shown — the facet matrix needs every member, not just the first page.
      return fetchAllPages<TeamMember>(`/teams/${teamId}/members/`);
    },
    enabled: !!teamId,
  });
}

export interface UpdateTeamMemberPayload {
  membershipId: string;
  /** Any subset of role / facet flags. A facet set true reassigns it server-side. */
  changes: Partial<Pick<TeamMember, 'role' | 'is_scrum_master' | 'is_product_owner'>>;
}

/**
 * PATCH a team member's role or facet. The server enforces the soft-singleton
 * (assigning a facet clears the prior holder), so on success we invalidate the
 * whole roster rather than patching one row — the prior holder changed too.
 */
export function useUpdateTeamMember(teamId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ membershipId, changes }: UpdateTeamMemberPayload) => {
      const res = await apiClient.patch<TeamMember>(
        `/teams/${teamId}/members/${membershipId}/`,
        changes,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team-members', teamId] });
    },
  });
}
