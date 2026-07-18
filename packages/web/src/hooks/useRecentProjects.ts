import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface RecentProject {
  id: string;
  name: string;
  program_id: string | null;
  program_name: string | null;
  visited_at: string;
}

/**
 * GET /api/v1/me/recent-projects/ — the caller's recently-visited projects for
 * the ⌘K "Recent" group (ADR-0508, #1557).
 *
 * A fixed navigation strip (server default 5, hard max 10), newest-first, filtered
 * server-side to projects the user still belongs to (a revoked/archived/deleted
 * project never surfaces from a stale visit row). Not paginated — the endpoint
 * returns a plain array. Gated with `enabled` so it fires only while the palette
 * is open; a short `staleTime` lets a just-visited project surface on the next
 * open without hammering the endpoint on every render.
 */
export function useRecentProjects(enabled = true) {
  return useQuery({
    queryKey: ['me', 'recent-projects'],
    queryFn: async () => {
      const res = await apiClient.get<RecentProject[]>('/me/recent-projects/');
      // The endpoint returns a plain array; guard the shape so a malformed or
      // list-envelope response (e.g. an e2e catch-all `{count,results}`) can never
      // reach `.map` in the palette and tear down the app via the error boundary.
      return Array.isArray(res.data) ? res.data : [];
    },
    staleTime: 30_000,
    enabled,
  });
}
