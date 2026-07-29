import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Who `@program-stakeholders` actually reaches, counted per arm (#2529, ADR-0697).
 *
 * The two arms are returned — and must be rendered — separately, because they have
 * materially different fates today: `viewer_member_count` people get a durable
 * in-app notification, `external_stakeholder_count` people get nothing at all
 * (no account, and outbound delivery is deferred to #1675). The response carries
 * no total on purpose; do not add one client-side.
 *
 * The count is server-computed from the same querysets the mention resolver uses.
 * It cannot be derived in the browser: `/programs/{id}/members/` returns
 * `ProgramMembership`, which per ADR-0070 does not propagate to project access,
 * while the alias resolves the union of `ProjectMembership` across the program's
 * projects at an exact Viewer role.
 */

export interface ProgramMentionReach {
  group_key: string;
  viewer_member_count: number;
  external_stakeholder_count: number;
}

export function useProgramMentionReach(
  programId: string | undefined,
  /**
   * Whether the caller holds the program Admin role the read requires. A non-Admin
   * program member reaches this page but is 403'd on this endpoint, so the request
   * is not made at all — the strip states the withholding instead of degrading to
   * silence, which would read as "the alias reaches nobody".
   */
  canRead: boolean,
): UseQueryResult<ProgramMentionReach> {
  return useQuery({
    queryKey: ['program-mention-reach', programId],
    queryFn: async () => {
      const res = await apiClient.get<ProgramMentionReach>(
        `/programs/${programId}/mention-reach/`,
      );
      return res.data;
    },
    enabled: !!programId && canRead,
    // Belt to the `enabled` braces: a 403 here is deterministic, not transient.
    retry: false,
  });
}
