/**
 * Hooks for a single user-scoped external task-source connection (#1420/#1421,
 * ADR-0291 / ADR-0313).
 *
 * Read state is backed by `GET /api/v1/me/connections/<source>/` (ADR-0097 §3,
 * #1418) — the self-scoped, read-only summary of whether the current user has
 * connected an external source (e.g. Jira Cloud) that feeds their My Work.
 * Distinct from `useIntegrationCredentials` (`/me/credentials/`, ADR-0049
 * task-link previews): that is a *different* registry for a *different* feature
 * on the same page.
 *
 * The connect/manage flow (#1421, ADR-0313) adds the write hooks — connect
 * (`PUT`), sync (`POST …/sync/`), disconnect (`DELETE`) — plus the cached-items
 * read (`GET /me/external-items/`) the connected card renders a "recently
 * pulled" preview from.
 *
 * The read hook is fail-soft by design (ADR-0291 risk #2): a non-200 — including
 * the `400` the backend returns for a source it does not register — resolves to
 * `null` (treated as "not connected"), never a surfaced error. A source the user
 * cannot yet connect must never render as broken. `retry: false` so a
 * deterministic 4xx is not retried. The **write** hooks are the opposite: they
 * surface the backend error so the connect dialog can show why a credential was
 * rejected (a `422` with a `detail`).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { isAxiosError } from 'axios';
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

// ---------------------------------------------------------------------------
// Connect flow (#1421, ADR-0313) — write hooks + cached-items read.
// ---------------------------------------------------------------------------

/** One read-only cached external work item (mirrors `ExternalWorkItemSerializer`). */
export interface ExternalWorkItem {
  id: string;
  /** Backend field is `source` but the serializer echoes it as `source_key`. */
  source_key: string;
  external_id: string;
  external_url: string;
  title: string;
  external_status: string;
  /** Coarse status bucket: `todo` | `in_progress` | `done`. */
  display_bucket: string;
  last_synced_at: string | null;
}

/** Payload for `PUT /me/connections/<source>/` — the connect dialog's fields. */
export interface ConnectExternalSourceInput {
  secret: string;
  base_url: string;
  account_email?: string;
  jql?: string;
  project_keys?: string[];
}

export function externalItemsKey(): string[] {
  return ['me-external-items'];
}

/**
 * Pull the backend `detail` out of a failed request for user-facing display.
 *
 * The connection endpoints answer a rejected credential with `422 {detail, code,
 * reason}` and a blocked host with `400 {detail, code}` — surface the `detail`
 * verbatim (it is already an operator-safe, actionable sentence). Falls back to a
 * generic message for a network/other error where no `detail` is present.
 */
export function extractConnectionError(err: unknown, fallback: string): string {
  if (isAxiosError(err)) {
    const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string' && detail.trim() !== '') return detail;
  }
  return fallback;
}

/**
 * `GET /api/v1/me/external-items/` — the user's cached external work items.
 *
 * Personal and read-only; the connected card renders a "recently pulled" preview
 * from these. The endpoint returns *all* of a user's items across sources
 * (limit/offset paginated), so callers filter by `source_key` client-side. Kept
 * fail-soft (`[]` on error) like the connection read: a transient items failure
 * must never break the connected card. `enabled` gates the fetch to connected
 * sources so a disconnected page issues no request.
 */
export function useExternalItems(enabled = true) {
  const query = useQuery<ExternalWorkItem[]>({
    queryKey: externalItemsKey(),
    enabled,
    retry: false,
    queryFn: async () => {
      try {
        const res = await apiClient.get<
          ExternalWorkItem[] | { results?: ExternalWorkItem[] }
        >('/me/external-items/');
        // The list view is paginated (`{count,results}`) but a caller could also
        // receive a bare array from a stub — accept both shapes.
        return Array.isArray(res.data) ? res.data : (res.data.results ?? []);
      } catch {
        return [];
      }
    },
  });
  return { items: query.data ?? [], isLoading: query.isLoading };
}

/**
 * `PUT /me/connections/<source>/` — connect or update an external source.
 *
 * The backend allow-lists the host, verifies the credential against the source,
 * and only then stores it — so a `422`/`400` here is a real rejection the dialog
 * must show. On success we invalidate both the connection summary and the cached
 * items so the card flips to its connected state.
 */
export function useConnectExternalSource(
  source: string,
): UseMutationResult<ExternalConnectionSummary, unknown, ConnectExternalSourceInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectExternalSourceInput) => {
      const res = await apiClient.put<ExternalConnectionSummary>(
        `/me/connections/${source}/`,
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalConnectionKey(source) });
      void qc.invalidateQueries({ queryKey: externalItemsKey() });
    },
  });
}

/**
 * `POST /me/connections/<source>/sync/` — trigger a read-only pull.
 *
 * Returns `202 {queued:true}`; a `429` means the per-connection cooldown is
 * active (the dialog/card surfaces `detail`). Invalidates the connection + items
 * so a completed pull's fresh `last_synced_at` and rows appear on next read.
 */
export function useSyncExternalSource(
  source: string,
): UseMutationResult<{ queued: boolean }, unknown, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<{ queued: boolean }>(
        `/me/connections/${source}/sync/`,
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalConnectionKey(source) });
      void qc.invalidateQueries({ queryKey: externalItemsKey() });
    },
  });
}

/**
 * `DELETE /me/connections/<source>/` — disconnect (hard-remove credential + cache).
 *
 * Idempotent server-side. Invalidates the connection + items so the card returns
 * to its "Connect" affordance and the removed rows leave My Work.
 */
export function useDisconnectExternalSource(
  source: string,
): UseMutationResult<void, unknown, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiClient.delete(`/me/connections/${source}/`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalConnectionKey(source) });
      void qc.invalidateQueries({ queryKey: externalItemsKey() });
    },
  });
}
