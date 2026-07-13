import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AxiosError } from 'axios';

interface MembershipRow {
  id: string;
  role: number;
  role_label: string;
}

export interface UseCurrentUserRoleResult {
  role: number | null;
  /**
   * Server-supplied display label for `role` (e.g. "Project Manager"), the
   * same `role_label` the settings team/member rows render (ADR-0072) — never
   * reformat the ordinal client-side, the server owns the persona copy.
   *
   * Optional in the type (not at runtime — the hook always sets it) purely so
   * the many existing `useCurrentUserRole` test mocks that only care about
   * `role` don't all need a mechanical `roleLabel` addition; new callers that
   * consume the label (like the rail identity block, #1919) should not treat
   * `undefined` as a real state — narrow to `roleLabel ?? null`.
   */
  roleLabel?: string | null;
  isLoading: boolean;
}

/**
 * Returns the current user's role ordinal for the given project.
 * Fetches GET /api/v1/projects/{id}/members/?self=true and reads the first row.
 *
 * Returns { role: null, roleLabel: null, isLoading: true } while loading so
 * callers can hide role-gated UI pessimistically (avoids flash-of-forbidden-content).
 *
 * Role ordinals are defined in `@/lib/roles` (ADR-0072): VIEWER=0, MEMBER=100,
 * SCHEDULER=200, ADMIN=300, OWNER=400. Always compare via the symbolic
 * constants from that module — never hardcode the numeric values.
 */
export function useCurrentUserRole(
  projectId: string | undefined,
): UseCurrentUserRoleResult {
  const query = useQuery<MembershipRow | null, AxiosError>({
    queryKey: ['project-member-self', projectId],
    queryFn: async () => {
      const res = await apiClient.get<MembershipRow[]>(
        `/projects/${projectId}/members/`,
        { params: { self: 'true' } },
      );
      return res.data[0] ?? null;
    },
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000, // role changes are rare; 5-min cache is safe
    retry: false,
  });

  if (!projectId || query.isPending) {
    return { role: null, roleLabel: null, isLoading: true };
  }

  return {
    role: query.data?.role ?? null,
    roleLabel: query.data?.role_label ?? null,
    isLoading: false,
  };
}
