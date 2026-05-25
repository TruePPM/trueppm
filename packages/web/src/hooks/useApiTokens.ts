/**
 * API token CRUD hooks (#600), scope-parameterized over project | program.
 *
 * Endpoints: /api/v1/{scope}s/{id}/api-tokens/. The raw token is returned
 * exactly once, on create — useCreateApiToken's result carries `token`, and it
 * is never retrievable again (the one-time-reveal contract, ADR-0068).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';
import type { PaginatedResponse } from '@/api/types';
import type { IntegrationScope } from './useWebhooks';

function basePath(scope: IntegrationScope): string {
  return `/${scope.kind}s/${scope.id}/api-tokens/`;
}

function tokensKey(scope: IntegrationScope) {
  return ['api-tokens', scope.kind, scope.id] as const;
}

// ---------------------------------------------------------------------------
// API shapes (match ProjectApiTokenSerializer)
// ---------------------------------------------------------------------------

export interface ApiToken {
  id: string;
  project: string | null;
  program: string | null;
  name: string;
  token_prefix: string;
  status_map: Record<string, string>;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  is_revoked: boolean;
}

/** Create response = the serialized token plus the one-time raw `token`. */
export interface CreatedApiToken extends ApiToken {
  token: string;
}

export interface ApiTokenCreateBody {
  name: string;
  status_map?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** List tokens for the given scope (includes revoked, sorted newest first). */
export function useApiTokens(scope: IntegrationScope | null | undefined) {
  return useQuery<ApiToken[], Error>({
    queryKey: scope ? tokensKey(scope) : ['api-tokens', 'none'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiToken>>(basePath(scope!));
      return res.data.results;
    },
    enabled: !!scope?.id,
    retry: false,
  });
}

export function useCreateApiToken(scope: IntegrationScope) {
  const qc = useQueryClient();
  return useMutation<CreatedApiToken, Error, ApiTokenCreateBody>({
    mutationFn: async (body) => {
      const res = await apiClient.post<CreatedApiToken>(basePath(scope), body);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tokensKey(scope) });
      void qc.invalidateQueries({ queryKey: [`${scope.kind}-integrations-summary`, scope.id] });
    },
  });
}

/** Revoke (soft-delete) a token. Idempotent server-side. */
export function useRevokeApiToken(scope: IntegrationScope) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiClient.delete(`${basePath(scope)}${id}/`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tokensKey(scope) });
      void qc.invalidateQueries({ queryKey: [`${scope.kind}-integrations-summary`, scope.id] });
    },
  });
}
