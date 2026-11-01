/**
 * Server state for the program decision log (ADR-1310, #4772).
 *
 * Awaiting and made decisions are read as two separate lists because the server
 * orders them differently (awaiting by due date, made by most recently decided),
 * and each is page-number paginated. Writes invalidate the whole
 * `['program-decisions', programId]` prefix rather than patching the cache: a
 * status change moves a row from one list to the other, and only the server knows
 * where it now sorts.
 */
import type { AxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';
import type { ProgramDecision, ProgramDecisionStatus } from './decisionListModel';

const decisionsKey = (programId: string, status: ProgramDecisionStatus) => [
  'program-decisions',
  programId,
  status,
];

/** One status's decisions, with "Load more" over the server's pages. */
export function useProgramDecisions(programId: string | undefined, status: ProgramDecisionStatus) {
  const query = useInfiniteQuery<
    PaginatedResponse<ProgramDecision>,
    AxiosError,
    { pages: PaginatedResponse<ProgramDecision>[] },
    ReturnType<typeof decisionsKey>,
    number
  >({
    queryKey: decisionsKey(programId ?? '', status),
    initialPageParam: 1,
    enabled: Boolean(programId),
    queryFn: async ({ pageParam }) => {
      const res = await apiClient.get<PaginatedResponse<ProgramDecision>>(
        `/programs/${programId}/decisions/`,
        { params: { status, page: pageParam } },
      );
      return res.data;
    },
    getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),
  });
  return {
    decisions: query.data?.pages.flatMap((p) => p.results) ?? [],
    total: query.data?.pages[0]?.count ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

interface ProgramDecisionWrite {
  title?: string;
  owner?: number | null;
  due_date?: string | null;
  status?: ProgramDecisionStatus;
  impact_note?: string;
}

/** `POST` a new decision, or `PATCH` an existing one when `id` is given. */
export function useSaveProgramDecision(programId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ProgramDecision, AxiosError, { id?: string; body: ProgramDecisionWrite }>({
    mutationFn: async ({ id, body }) => {
      const base = `/programs/${programId}/decisions/`;
      const res = id
        ? await apiClient.patch<ProgramDecision>(`${base}${id}/`, body)
        : await apiClient.post<ProgramDecision>(base, body);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['program-decisions', programId] });
    },
  });
}
