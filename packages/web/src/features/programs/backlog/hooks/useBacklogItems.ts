/**
 * Fixture-backed read layer for the program backlog.
 *
 * ADR-0069's endpoints (#737) and trigram search (#739) are not built yet, so
 * every query here resolves from the static fixtures in `../fixtures`. The
 * hook signatures and query keys are the contract: when the API lands, only
 * the `queryFn` bodies change — components, mutations, and the cache-update
 * helpers keep working unchanged.
 *
 * `staleTime: Infinity` means the seed fetch runs once per session; thereafter
 * the TanStack cache *is* the store, and the mutation hooks edit it in place.
 * (With a real API this becomes a normal stale-while-revalidate query.)
 */

import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { BACKLOG_ITEMS, BACKLOG_MEMBERS, MEMBER_PROJECTS } from '../fixtures';
import type { BacklogItem, BacklogMember, MemberProject } from '../types';

export const backlogKeys = {
  items: (programId: string | undefined) => ['program-backlog', programId, 'items'] as const,
  members: (programId: string | undefined) => ['program-backlog', programId, 'members'] as const,
  projects: (programId: string | undefined) => ['program-backlog', programId, 'projects'] as const,
};

const FIXTURE_LATENCY_MS = 280;

function delay<T>(value: T, ms = FIXTURE_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * GET /api/v1/programs/{id}/backlog-items/ — the full set (counts derived
 * client-side). Until the API exists the fixture stands in for *any* program
 * so the page renders live in the running app; the sentinel id `__empty__`
 * returns nothing, which lets the empty-state path be exercised by a route.
 */
export function useBacklogItems(programId: string | undefined): UseQueryResult<BacklogItem[]> {
  return useQuery({
    queryKey: backlogKeys.items(programId),
    queryFn: () =>
      delay(
        programId === '__empty__'
          ? []
          : BACKLOG_ITEMS.map((item) => ({ ...item, tags: [...item.tags] })),
      ),
    enabled: !!programId,
    staleTime: Infinity,
    gcTime: Infinity,
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

export function useBacklogMembers(programId: string | undefined): UseQueryResult<BacklogMember[]> {
  return useQuery({
    queryKey: backlogKeys.members(programId),
    queryFn: () => delay(BACKLOG_MEMBERS),
    enabled: !!programId,
    staleTime: Infinity,
  });
}

/** Member projects = the candidate pull targets for this program. */
export function useMemberProjects(programId: string | undefined): UseQueryResult<MemberProject[]> {
  return useQuery({
    queryKey: backlogKeys.projects(programId),
    queryFn: () => delay(programId === '__empty__' ? [] : MEMBER_PROJECTS),
    enabled: !!programId,
    staleTime: Infinity,
  });
}

/**
 * Apply an in-place edit to the cached item list. The single seam every
 * mutation funnels through, so swapping the read layer for a real API later
 * only means deleting the optimistic cache writes — not rewriting callers.
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

/** Snapshot/restore helper for optimistic rollback. */
export function readBacklogCache(
  queryClient: QueryClient,
  programId: string | undefined,
): BacklogItem[] | undefined {
  return queryClient.getQueryData<BacklogItem[]>(backlogKeys.items(programId));
}

export function useBacklogQueryClient(): QueryClient {
  return useQueryClient();
}
