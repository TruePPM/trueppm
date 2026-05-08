import { useMemo } from 'react';
import { useProjectResourcePool } from './useProjectResourcePool';

export interface UseCurrentUserResourceIdResult {
  /** The Resource.id linked to the current user via Resource.user FK or
   *  legacy email match. Null when the user has no resource on this project. */
  resourceId: string | null;
  isLoading: boolean;
}

/**
 * Resolves the current user's Resource id within a project.
 *
 * The server-side `is_me` flag on ResourceSerializer (true when
 * `Resource.user == request.user` or, for legacy rows, when the email
 * matches) is the source of truth. If multiple resources are flagged
 * (rare — e.g. a user split across two roster rows during cleanup), the
 * first one is returned; the M2M-through filter on the API still matches
 * tasks for any of them.
 */
export function useCurrentUserResourceId(
  projectId: string | undefined,
): UseCurrentUserResourceIdResult {
  const { data, isLoading } = useProjectResourcePool(projectId ?? '');
  const resourceId = useMemo(() => {
    if (!data) return null;
    const mine = data.find((pr) => pr.resource.isMe === true);
    return mine ? mine.resourceId : null;
  }, [data]);
  return { resourceId, isLoading };
}
