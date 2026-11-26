import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { apiClient } from '@/api/client';
import type { ResolveResponse } from '@/api/types';
import { looksLikeRef } from '@/features/shell/commandPalette/refSearch';

/** Same request spacing as the palette's omni-search, so one pause fires both. */
const REF_LOOKUP_DEBOUNCE_MS = 200;

/**
 * The ⌘K palette's find-by-key lookup (#3888): `GET /api/v1/resolve/?kind=project`
 * for a query shaped like a key or a `PLAT-T-10` reference.
 *
 * Debounced, gated on an open palette and on {@link looksLikeRef}, so ordinary
 * word searches never reach the resolver (it shares a 120/min throttle with the key
 * check). Cached under its own `['resolve', 'palette', ref]` key, not the route
 * boundary's: this hook stores a 404 as `null`, which the boundary must never read
 * back as a resolution.
 *
 * A 4xx is an answer, not an error: the server returns one byte-identical 404 for
 * "missing" and "not yours", and the palette shows its ordinary "No matches" for
 * both. It resolves to `null` and is never retried.
 *
 * @param query - The raw palette query; sent untouched (the web never parses a ref).
 * @param enabled - Whether the palette is open.
 * @returns The resolution, `null` for no match, or `undefined` while idle/loading.
 */
export function usePaletteRefLookup(
  query: string,
  enabled: boolean,
): ResolveResponse | null | undefined {
  const trimmed = query.trim();
  const [debounced, setDebounced] = useState(trimmed);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(trimmed), REF_LOOKUP_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [trimmed]);

  // Only the settled query counts, so a stale answer for an earlier keystroke is
  // never shown against what the user has since typed.
  const active = enabled && debounced === trimmed && looksLikeRef(debounced);
  const { data } = useQuery({
    queryKey: ['resolve', 'palette', debounced],
    queryFn: async (): Promise<ResolveResponse | null> => {
      try {
        const res = await apiClient.get<ResolveResponse>('/resolve/', {
          params: { kind: 'project', ref: debounced },
        });
        return res.data;
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status !== undefined && status >= 400 && status < 500) return null;
        throw error;
      }
    },
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });
  return active ? data : undefined;
}
