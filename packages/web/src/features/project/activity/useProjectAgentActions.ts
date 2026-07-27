import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AgentAction, AgentActionVerdict, PaginatedResponse } from '@/api/types';

type ActionPage = PaginatedResponse<AgentAction>;

export interface UseProjectAgentActionsOptions {
  /** ISO-8601 lower bound on `occurred_at` (the Range filter). Undefined = all time. */
  since?: string;
  /** Narrow to a single verdict — `refused` powers the "Refusals only" chip. */
  verdict?: AgentActionVerdict;
}

/**
 * Paginated read of a single project's agent-action chain (#2481, ADR-0677) — the
 * team-facing half of the oversight surface. Reads
 * `GET /api/v1/agent-actions/?project=<id>`, which `AgentActionViewSet` already
 * scopes to the caller's `ProjectMembership`, so naming a project the caller is not
 * a member of narrows the result to nothing rather than widening it.
 *
 * The program-scoped sibling is `features/programs/agents/useProgramAgentActions`;
 * the two differ only in which filter they send. They are deliberately NOT merged
 * into one parameterized hook: the query keys must stay distinct so switching
 * between the program panel and a member project's panel refetches instead of
 * showing the other scope's cached rows under the wrong heading.
 *
 * Uses `useInfiniteQuery` + "Load older" because the append-only chain can be long;
 * never load it unbounded. `since` and `verdict` are part of the query key so
 * changing the Range or toggling Refusals refetches rather than colliding on one
 * cache slot.
 */
export function useProjectAgentActions(
  projectId: string | undefined,
  { since, verdict }: UseProjectAgentActionsOptions = {},
) {
  const query = useInfiniteQuery<ActionPage, Error, { pages: ActionPage[] }, unknown[], number>({
    queryKey: ['project-agent-actions', projectId, since ?? null, verdict ?? null],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { project: projectId ?? '', page: pageParam };
      if (since) params.since = since;
      if (verdict) params.verdict = verdict;
      const res = await apiClient.get<ActionPage>('/agent-actions/', { params });
      return res.data;
    },
    // DRF returns a full `next` URL; presence means there is another page.
    getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),
    enabled: !!projectId,
  });

  return {
    actions: query.data?.pages.flatMap((p) => p.results) ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    // Void-returning wrappers so consumers can pass these straight to onClick /
    // onRetry props without tripping no-misused-promises on the raw Promise.
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
    hasNextPage: query.hasNextPage,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
