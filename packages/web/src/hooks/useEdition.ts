import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

export type Edition = 'community' | 'enterprise';

interface EditionResponse {
  edition: Edition;
  /** Build identity (#2392); absent on a pre-0.4 server. */
  version?: string;
  build_sha?: string;
}

/**
 * GET /api/v1/edition/ — return the running edition.
 *
 * Public endpoint (no auth required). Used by the root router to decide the
 * post-login redirect target: community users land on the project overview;
 * enterprise users with ≥2 active projects in a portfolio land on the
 * portfolio view (ADR-0029, ADR-0030).
 *
 * Uses vanilla axios (not apiClient) because the edition endpoint is public
 * and must not trigger the 401→token-refresh interceptor on first load.
 * Cached indefinitely per session (staleTime: Infinity) — edition never
 * changes at runtime; a full page reload picks up any change.
 */
export function useEdition(): { edition: Edition; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['edition'],
    queryFn: async () => {
      const res = await axios.get<EditionResponse>('/api/v1/edition/');
      return res.data;
    },
    staleTime: Infinity,
    // Disable refetch-on-window-focus — edition is immutable within a session.
    refetchOnWindowFocus: false,
  });

  return {
    edition: data?.edition ?? 'community',
    isLoading,
  };
}

export interface BuildInfo {
  edition: Edition;
  version: string;
  buildSha: string;
}

/**
 * Build identity for a bug report (#2392).
 *
 * Shares the `['edition']` query — the endpoint is already fetched once at
 * startup and cached for the session, so naming the build costs no extra
 * request. A server older than 0.4 omits the fields; "unknown" is a more honest
 * value in a report than a version the client guessed.
 */
export function useBuildInfo(): BuildInfo {
  const { data } = useQuery({
    queryKey: ['edition'],
    queryFn: async () => {
      const res = await axios.get<EditionResponse>('/api/v1/edition/');
      return res.data;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return {
    edition: data?.edition ?? 'community',
    version: data?.version ?? 'unknown',
    buildSha: data?.build_sha ?? '',
  };
}
