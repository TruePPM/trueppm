/**
 * Hook for a single user-scoped external task-source connection (#1420, ADR-0291).
 *
 * Backed by `GET /api/v1/me/connections/<source>/` (ADR-0097 §3, #1418) — the
 * self-scoped, read-only summary of whether the current user has connected an
 * external source (e.g. Jira Cloud) that feeds their My Work. Distinct from
 * `useIntegrationCredentials` (`/me/credentials/`, ADR-0049 task-link previews):
 * that is a *different* registry for a *different* feature on the same page.
 *
 * Fail-soft by design (ADR-0291 risk #2): a non-200 — including the `400` the
 * backend returns for a source it does not register — resolves to `null` (treated
 * as "not connected"), never a surfaced error. A source the user cannot yet
 * connect must never render as broken. `retry: false` so a deterministic 4xx is
 * not retried.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Owner-facing summary of one external-source connection (never the secret).
 *
 * Mirrors the backend `ExternalConnectionSummarySerializer`. `exists` is the
 * connected-or-not flag the "Available sources" section renders against.
 */
export interface ExternalConnectionSummary {
  name: string;
  exists: boolean;
  base_url: string;
  account_email: string;
  status: string;
  last_synced_at: string | null;
  jql: string;
  project_keys: string[];
}

export function externalConnectionKey(source: string): string[] {
  return ['me-external-connection', source];
}

/**
 * GET /api/v1/me/connections/{source}/ — read one source's connection state.
 *
 * @param source - external source key (e.g. `'jira'`).
 * @param enabled - skip the fetch entirely for non-fetchable sources (e.g.
 *   `coming_soon` entries with no backend registration). Defaults to `true`.
 */
export function useExternalConnection(source: string, enabled = true) {
  const query = useQuery<ExternalConnectionSummary | null>({
    queryKey: externalConnectionKey(source),
    enabled,
    // A 4xx (unregistered source, etc.) is deterministic — don't retry it.
    retry: false,
    queryFn: async () => {
      try {
        const res = await apiClient.get<ExternalConnectionSummary>(
          `/me/connections/${source}/`,
        );
        return res.data;
      } catch {
        // Fail-soft: any error → "not connected", never a surfaced failure.
        return null;
      }
    },
  });

  return {
    connection: query.data ?? null,
    isConnected: query.data?.exists ?? false,
    isLoading: query.isLoading,
  };
}
