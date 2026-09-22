import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

export type Edition = 'community' | 'enterprise';

/** The shared credential a read-only demo publishes on its login screen (ADR-1197 D3). */
export interface DemoLoginHint {
  username: string;
  password: string;
}

/**
 * An external identity gate the operator has declared in front of a demo host
 * (ADR-1197 D8 resolution, #3969).
 *
 * `provider` is the gate's display name — operator-supplied, not a fixed constant,
 * because the same demo mode may run behind Cloudflare Access, Authelia, Authentik or
 * Google IAP, and naming the wrong one is exactly the false claim this field exists
 * to avoid. Render it verbatim; never substitute a hardcoded vendor.
 */
export interface DemoAccessGate {
  provider: string;
  /** Privacy statement covering what the gate collects. Optional. */
  privacy_url: string | null;
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
  /**
   * The external gate that collected the visitor's email before they reached this
   * app (#3969). Like `demo_login_hint`, non-null only while `demo_read_only` is
   * true; `null` or absent on every normal install and on a demo with no gate.
   */
  demo_access_gate?: DemoAccessGate | null;
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

/**
 * The external access gate to disclose, or `null` when there is nothing to disclose
 * (ADR-1197 D8 resolution, #3969).
 *
 * Rides the shared `['edition']` query for the same reason the demo mode itself does
 * (see `useDemoMode`): the fact is a property of the *deployment*, not of the build,
 * and the visitor needs it on the login screen — before there is a session. A
 * build-time global would be wrong here for exactly the reason it is wrong there: one
 * image serves the gated hosted demo and an ungated self-hosted one.
 *
 * Returns `null` on every normal install, on a demo with no gate declared, and on a
 * failed or unresolved `/edition/` read. That last case is deliberate and matches
 * `useDemoMode`'s handling: a disclosure we cannot confirm must not be invented, and
 * the server withholds the field unless demo mode is on, so absence already means
 * "nothing to say" rather than "unknown".
 */
export function useDemoAccessGate(): DemoAccessGate | null {
  const { data, isError } = useQuery(editionQueryOptions);
  const gate = (isError ? undefined : data?.demo_access_gate) ?? null;
  if (!gate) return null;
  // Third check on the same value, and deliberately not redundant. `privacy_url`
  // becomes an `href` on a pre-auth page, so `javascript:` must be unreachable. The
  // chart refuses to render one and the API refuses to boot on one — but both of
  // those are bypassed by an operator who sets DEMO_ACCESS_GATE in their own settings
  // module, and this is the only check on the path that actually renders the link.
  // Drop the URL rather than the notice: the disclosure is the part that matters.
  if (gate.privacy_url && !/^https?:\/\//i.test(gate.privacy_url)) {
    return { ...gate, privacy_url: null };
  }
  return gate;
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
