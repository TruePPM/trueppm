import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** Slim board-card search row returned by GET /tasks/search/ (#323, ADR-0145). */
export interface BoardCardSearchResult {
  id: string;
  name: string;
  status: string;
  short_id: string;
}

const DEBOUNCE_MS = 200;

export interface BoardCardSearch {
  /** Set of matching task IDs — fed to the board's dim plumbing. Empty when inert. */
  matchIds: Set<string>;
  /** Number of matches returned by the server for the active query. */
  matchCount: number;
  /** True while a non-empty query is in flight. */
  isSearching: boolean;
  /** The trimmed, debounced query actually sent to the server ('' when inert). */
  activeQuery: string;
}

/**
 * Board card full-text search (#323, ADR-0145).
 *
 * Debounces `query` (200 ms) and hits `GET /tasks/search/?project=&q=`, returning
 * the set of matching task IDs so the board can dim non-matching cards in place.
 * An empty or whitespace-only query is inert: no request fires and `matchIds` is
 * empty, so the board renders undimmed.
 */
export function useBoardCardSearch(
  projectId: string | null | undefined,
  query: string,
): BoardCardSearch {
  const trimmed = query.trim();
  const [debounced, setDebounced] = useState(trimmed);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [trimmed]);

  const enabled = !!projectId && debounced.length > 0;

  const { data, isFetching } = useQuery({
    queryKey: ['board-card-search', projectId, debounced],
    queryFn: async () => {
      const res = await apiClient.get<BoardCardSearchResult[]>('/tasks/search/', {
        params: { project: projectId, q: debounced },
      });
      return res.data;
    },
    enabled,
    staleTime: 30_000,
  });

  const matchIds = useMemo(() => new Set((data ?? []).map((r) => r.id)), [data]);

  return {
    matchIds,
    matchCount: data?.length ?? 0,
    isSearching: enabled && isFetching,
    activeQuery: enabled ? debounced : '',
  };
}
