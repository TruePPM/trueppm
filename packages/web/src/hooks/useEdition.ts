import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

export type Edition = 'community' | 'enterprise';

interface EditionResponse {
  edition: Edition;
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
      return res.data.edition;
    },
    staleTime: Infinity,
    // Disable refetch-on-window-focus — edition is immutable within a session.
    refetchOnWindowFocus: false,
  });

  return {
    edition: data ?? 'community',
    isLoading,
  };
}
