import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

export type Edition = 'community' | 'enterprise';

/** The shared credential a read-only demo publishes on its login screen (ADR-1197 D3). */
export interface DemoLoginHint {
  username: string;
  password: string;
}

export interface EditionResponse {
  edition: Edition;
  /** Build identity (#2392); absent on a pre-0.4 server. */
  version?: string;
  build_sha?: string;
  /**
   * Whether this deployment is a read-only demo (ADR-1197 D2/D3). Always present on a
   * server that ships #3926; absent on an older one, which reads the same as `false`.
   */
  demo_read_only?: boolean;
  /** Present only while `demo_read_only` is true; `null` otherwise. */
  demo_login_hint?: DemoLoginHint | null;
}

/**
 * The single `['edition']` query every reader of this endpoint shares.
 *
 * Three hooks read it — edition routing, build identity for a bug report, and the
 * demo mode the login screen renders — and a hand-copied `queryFn` in each is how one
 * cache entry becomes two network calls. Exported so they route through one object.
 *
 * Vanilla axios, not `apiClient`: the endpoint is public and the login screen calls it
 * *before* there is a session, so `apiClient`'s 401 → token-refresh interceptor must
 * not see it. `staleTime: Infinity` — none of these values change within a session, so
 * the extra reader on the login route costs no extra request.
 */
export const editionQueryOptions = {
  queryKey: ['edition'] as const,
  queryFn: async (): Promise<EditionResponse> => {
    const res = await axios.get<EditionResponse>('/api/v1/edition/');
    return res.data;
  },
  staleTime: Infinity,
  // Disable refetch-on-window-focus — edition is immutable within a session.
  refetchOnWindowFocus: false,
} as const;

/**
 * GET /api/v1/edition/ — return the running edition.
 *
 * Public endpoint (no auth required). Used by the root router to decide the
 * post-login redirect target: community users land on the project overview;
 * enterprise users with ≥2 active projects in a portfolio land on the
 * portfolio view (ADR-0029, ADR-0030).
 */
export function useEdition(): { edition: Edition; isLoading: boolean } {
  const { data, isLoading } = useQuery(editionQueryOptions);

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
  const { data } = useQuery(editionQueryOptions);
  return {
    edition: data?.edition ?? 'community',
    version: data?.version ?? 'unknown',
    buildSha: data?.build_sha ?? '',
  };
}
