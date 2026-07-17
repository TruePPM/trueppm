import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AgentAction, AgentActionVerdict, PaginatedResponse } from '@/api/types';

type ActionPage = PaginatedResponse<AgentAction>;

export interface UseProgramAgentActionsOptions {
  /** ISO-8601 lower bound on `occurred_at` (the Range filter). Undefined = all time. */
  since?: string;
  /** Narrow to a single verdict — `refused` powers the Refusals view. */
  verdict?: AgentActionVerdict;
}

/**
 * Paginated read of a program's agent-action chain (#2020) — the projection the
 * oversight panel renders. Reads `GET /api/v1/agent-actions/?program=<id>`, which
 * is the union of the chain across the program's readable member projects,
 * membership-scoped server-side (a non-member gains nothing).
 *
 * Uses `useInfiniteQuery` + "Load older" because the append-only chain can be
 * long; never load it unbounded (the same reason `useNotifications` paginates).
 * `since` and `verdict` are part of the query key so switching the Range filter or
 * the Activity↔Refusals view re-fetches instead of colliding on one cache slot.
 */
export function useProgramAgentActions(
  programId: string | undefined,
  { since, verdict }: UseProgramAgentActionsOptions = {},
) {
  const query = useInfiniteQuery<ActionPage, Error, { pages: ActionPage[] }, unknown[], number>({
    queryKey: ['program-agent-actions', programId, since ?? null, verdict ?? null],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { program: programId ?? '', page: pageParam };
      if (since) params.since = since;
      if (verdict) params.verdict = verdict;
      const res = await apiClient.get<ActionPage>('/agent-actions/', { params });
      return res.data;
    },
    // DRF returns a full `next` URL; presence means there is another page.
    getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),
    enabled: !!programId,
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
