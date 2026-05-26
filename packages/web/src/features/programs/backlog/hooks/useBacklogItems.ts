/**
 * Read layer for the program backlog, wired to the ADR-0069 API (#737).
 *
 * The list is fetched whole and filtered/sorted/searched client-side (see
 * `../filter`), so the query is a single GET. NOTE: the endpoint paginates at
 * 50; we request a larger page defensively, but a program backlog that exceeds
 * the page size will need server-side filtering — tracked as follow-up. The
 * mutation hooks edit the cached list through `patchBacklogCache`.
 */

import { useMemo } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { fromApiItem, toMemberProject, type ApiBacklogItem } from '../api';
import type { BacklogItem, MemberProject } from '../types';

export const backlogKeys = {
  items: (programId: string | undefined) => ['program-backlog', programId, 'items'] as const,
};

interface Paginated<T> {
  results: T[];
}

function unwrap<T>(data: T[] | Paginated<T>): T[] {
  return Array.isArray(data) ? data : (data.results ?? []);
}

/** GET /api/v1/programs/{id}/backlog-items/ — the full set (counts derived client-side). */
export function useBacklogItems(programId: string | undefined): UseQueryResult<BacklogItem[]> {
  return useQuery({
    queryKey: backlogKeys.items(programId),
    queryFn: async () => {
      const res = await apiClient.get<ApiBacklogItem[] | Paginated<ApiBacklogItem>>(
        `/programs/${programId}/backlog-items/`,
        { params: { page_size: 200 } },
      );
      return unwrap(res.data).map(fromApiItem);
    },
    enabled: !!programId,
  });
}

/** Derive a single item from the already-fetched list — no extra round-trip. */
export function useBacklogItem(
  programId: string | undefined,
  itemId: string | null,
): BacklogItem | undefined {
  const { data } = useBacklogItems(programId);
  if (!itemId) return undefined;
  return data?.find((item) => item.id === itemId);
}

/** Member projects = the candidate pull targets, mapped from the program's projects. */
export function useMemberProjects(programId: string | undefined): { data: MemberProject[] } {
  const query = useProgramProjects(programId);
  const data = useMemo(() => (query.data ?? []).map(toMemberProject), [query.data]);
  return { data };
}

/**
 * Apply an in-place edit to the cached item list — the single seam every
 * optimistic mutation funnels through.
 */
export function patchBacklogCache(
  queryClient: QueryClient,
  programId: string | undefined,
  updater: (items: BacklogItem[]) => BacklogItem[],
): void {
  queryClient.setQueryData<BacklogItem[]>(backlogKeys.items(programId), (prev) =>
    updater(prev ?? []),
  );
}

/** Snapshot for optimistic rollback. */
export function readBacklogCache(
  queryClient: QueryClient,
  programId: string | undefined,
): BacklogItem[] | undefined {
  return queryClient.getQueryData<BacklogItem[]>(backlogKeys.items(programId));
}

export function useBacklogQueryClient(): QueryClient {
  return useQueryClient();
}
