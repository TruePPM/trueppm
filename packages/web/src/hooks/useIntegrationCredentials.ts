/**
 * Hooks for the per-user integration credentials list (ADR-0049 §3, #587).
 *
 * Backed by /api/v1/me/credentials/ — list returns one row per registered
 * provider (so the Connected Accounts page can render "Not connected"
 * sections without a second request), connect/rotate share a code path
 * (single POST endpoint per provider), and revoke is idempotent. The
 * encrypted PAT secret is never returned to the client.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

const CREDENTIALS_KEY = ['me-integration-credentials'];

/**
 * Summary row for a single provider in the Connected Accounts list.
 *
 * `exists === false` rows still appear so the page can render the
 * "Connect" call to action. `requires_credential` is false for the
 * `generic` provider — the page hides the Connect button when so.
 */
export interface IntegrationCredentialSummary {
  provider: string;
  name: string;
  exists: boolean;
  base_url: string;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  requires_credential: boolean;
}

/** GET /api/v1/me/credentials/ */
export function useIntegrationCredentials() {
  const query = useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: async () => {
      const res = await apiClient.get<IntegrationCredentialSummary[]>('/me/credentials/');
      return res.data;
    },
  });

  return {
    credentials: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface UpsertCredentialVars {
  provider: string;
  secret: string;
  base_url?: string;
  expires_at?: string | null;
}

/**
 * POST /api/v1/me/credentials/{provider}/ — connect or rotate.
 *
 * The server response includes the full refreshed list so the cache can
 * be set without a second GET. Optimistic updates aren't worth it here
 * (a connect changes server state that only the server knows about — the
 * timestamp, the encrypted hash — and the success toast is what the user
 * is reading anyway).
 */
export function useUpsertIntegrationCredential() {
  const queryClient = useQueryClient();
  return useMutation<IntegrationCredentialSummary[], Error, UpsertCredentialVars>({
    mutationFn: async ({ provider, secret, base_url, expires_at }) => {
      const payload: Record<string, unknown> = { secret };
      if (base_url !== undefined) payload.base_url = base_url;
      if (expires_at !== undefined) payload.expires_at = expires_at;
      const res = await apiClient.post<IntegrationCredentialSummary[]>(
        `/me/credentials/${provider}/`,
        payload,
      );
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(CREDENTIALS_KEY, data);
    },
  });
}

/** DELETE /api/v1/me/credentials/{provider}/ — revoke (idempotent). */
export function useRevokeIntegrationCredential() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { provider: string }>({
    mutationFn: async ({ provider }) => {
      await apiClient.delete(`/me/credentials/${provider}/`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY });
    },
  });
}
