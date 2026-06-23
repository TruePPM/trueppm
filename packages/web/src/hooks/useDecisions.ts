/**
 * Hooks for the project + sprint Decisions views (ADR-0167, issue 748).
 *
 * `useDecisions` reads the paginated decision-flagged notes for a project, optionally
 * scoped to one sprint (the sprint view passes the active sprint id; the project view
 * omits it and sees every decision, closed sprints included). The visibility gate is
 * server-enforced: a denied oversight reader gets a 403, surfaced here as `isLocked`
 * so the view can render an explanatory locked state rather than a generic error.
 *
 * `useDecisionsPolicy` / `useSetDecisionsPolicy` read and flip the team-owned
 * oversight-visibility switch (Admin+ writes; the read carries `can_edit`).
 */

import type { AxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { DecisionNote, DecisionsPolicy } from '@/types';

/** Query key for the Decisions list — `['decisions', projectId, sprintId|'all']`. */
export const decisionsKey = (projectId: string, sprintId: string | null) => [
  'decisions',
  projectId,
  sprintId ?? 'all',
];

/** Query key for the Decisions visibility policy. */
export const decisionsPolicyKey = (projectId: string) => ['decisions-policy', projectId];

/**
 * GET /api/v1/projects/{projectId}/decisions/?sprint={sprintId}
 *
 * Page-number pagination accumulated via `useInfiniteQuery` so the view can "Load more".
 * A 403 (oversight reader without consent) resolves to `isLocked`, not a thrown error
 * state, so the caller renders the team-owned locked copy.
 */
export function useDecisions(projectId: string, sprintId: string | null) {
  const query = useInfiniteQuery<
    PaginatedResponse<DecisionNote>,
    AxiosError,
    { pages: PaginatedResponse<DecisionNote>[] },
    ReturnType<typeof decisionsKey>,
    number
  >({
    queryKey: decisionsKey(projectId, sprintId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { page: pageParam };
      if (sprintId) params.sprint = sprintId;
      const res = await apiClient.get<PaginatedResponse<DecisionNote>>(
        `/projects/${projectId}/decisions/`,
        { params },
      );
      return res.data;
    },
    // DRF returns a full `next` URL; presence means there is another page.
    getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),
    enabled: !!projectId,
    // A denied oversight reader gets a stable 403 — don't hammer it with retries.
    retry: (failureCount, error) => error.response?.status !== 403 && failureCount < 2,
  });

  const decisions = query.data?.pages.flatMap((p) => p.results) ?? [];
  const isLocked = query.error?.response?.status === 403;

  return {
    decisions,
    isLoading: query.isLoading,
    isLocked,
    // A non-403 error is a real failure (the locked state is handled separately).
    error: isLocked ? null : query.error,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/** GET /api/v1/projects/{projectId}/decisions-policy/ — posture + whether the requester may edit. */
export function useDecisionsPolicy(projectId: string) {
  return useQuery<DecisionsPolicy, AxiosError>({
    queryKey: decisionsPolicyKey(projectId),
    queryFn: async () => {
      const res = await apiClient.get<DecisionsPolicy>(`/projects/${projectId}/decisions-policy/`);
      return res.data;
    },
    enabled: !!projectId,
  });
}

interface SetPolicyVars {
  projectId: string;
  oversightVisible: boolean;
}

/**
 * PATCH /api/v1/projects/{projectId}/decisions-policy/
 *
 * Flip the team's oversight-visibility switch (Admin+; server-enforced). Invalidates the
 * policy read and the Decisions list (a newly-allowed reader's list must re-fetch).
 */
export function useSetDecisionsPolicy() {
  const queryClient = useQueryClient();
  return useMutation<DecisionsPolicy, AxiosError, SetPolicyVars>({
    mutationFn: async ({ projectId, oversightVisible }) => {
      const res = await apiClient.patch<DecisionsPolicy>(
        `/projects/${projectId}/decisions-policy/`,
        { oversight_visible: oversightVisible },
      );
      return res.data;
    },
    onSuccess: (data, { projectId }) => {
      queryClient.setQueryData(decisionsPolicyKey(projectId), data);
      void queryClient.invalidateQueries({ queryKey: ['decisions', projectId] });
    },
  });
}
