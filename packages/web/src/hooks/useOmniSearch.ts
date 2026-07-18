import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { OmniSearchResult, PaginatedResponse } from '@/api/types';

/** Minimum term length before the endpoint is called — mirrors the server's
 *  2-char floor so a single keystroke never fires a request. */
const OMNI_SEARCH_MIN_Q = 2;
/** Debounce window (ms). The palette query updates on every keystroke; hold the
 *  request until typing pauses so a fast typist fires one search, not one per key. */
const OMNI_SEARCH_DEBOUNCE_MS = 200;
/** Default agile kinds requested — the marquee "Epic ▸ Story" ask (ADR-0508 D4).
 *  `task` is deliberately excluded so the palette omni-search stays Epic/Story. */
const OMNI_SEARCH_DEFAULT_TYPES = 'epic,story';

/**
 * GET /api/v1/me/search/?q=&type= — the ⌘K palette's global cross-program
 * Epic/Story omni-search (ADR-0508 D4, #2103).
 *
 * Membership-scoped server-side (a Task via project membership, a BacklogItem via
 * program membership), so it never surfaces a title the caller cannot access. The
 * hook is **debounced** and **query-gated**: it fires only while the palette is
 * open (`enabled`) AND the trimmed query is at least {@link OMNI_SEARCH_MIN_Q}
 * characters, so a cold or closed palette never calls the endpoint.
 *
 * The response is the standard paginated envelope; the hook returns page 1's
 * `results` (a palette shows a capped, scannable set — it never pages). The shape
 * is guarded (`Array.isArray`) so a malformed or unexpected body can never reach
 * `.map` in the palette and tear the app down via the root error boundary.
 */
export function useOmniSearch(query: string, enabled = true, types = OMNI_SEARCH_DEFAULT_TYPES) {
  const trimmed = query.trim();

  // Local debounce: settle the query before it becomes a request. Kept in the hook
  // (not the palette) so every caller gets the same request-spacing for free.
  const [debounced, setDebounced] = useState(trimmed);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(trimmed), OMNI_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [trimmed]);

  const active = enabled && debounced.length >= OMNI_SEARCH_MIN_Q;

  return useQuery({
    queryKey: ['me', 'search', types, debounced],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<OmniSearchResult>>('/me/search/', {
        params: { q: debounced, type: types },
      });
      const results = res.data?.results;
      return Array.isArray(results) ? results : [];
    },
    staleTime: 30_000,
    enabled: active,
  });
}
