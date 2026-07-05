/**
 * Personal Access Token (PAT) CRUD hooks (issue 648, ADR-0214).
 *
 * A PAT is a user-scoped API credential: it authenticates a script *as you*, so
 * it carries exactly your RBAC — never more. These hooks target the auto-scoped
 * `/api/v1/me/api-tokens/` endpoints (no project/program in the path — the server
 * scopes every request to `owner=request.user`).
 *
 * The raw token is returned exactly once, on create — `useCreateMyApiToken`'s
 * result carries `token`, and it is never retrievable again (the one-time-reveal
 * contract, shared with the project/program token surface).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';
import type { PaginatedResponse } from '@/api/types';

const BASE_PATH = '/me/api-tokens/';
const TOKENS_KEY = ['me', 'api-tokens'] as const;

/** Maximum number of *active* PATs a user may hold at once (server-enforced). */
export const MAX_PERSONAL_ACCESS_TOKENS = 10;

// ---------------------------------------------------------------------------
// API shapes (match MyApiTokenSerializer)
// ---------------------------------------------------------------------------

/**
 * A user's own Personal Access Token, as returned by the list/detail endpoint.
 *
 * The raw token and its hash are never present — only `token_prefix` (enough to
 * tell tokens apart) and the lifecycle state needed to render the list.
 */
export interface MyApiToken {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  /** Optional expiry; null = non-expiring. */
  expires_at: string | null;
  revoked_at: string | null;
  is_revoked: boolean;
  is_expired: boolean;
}

/** Create response = the serialized token plus the one-time raw `token`. */
export interface CreatedMyApiToken extends MyApiToken {
  token: string;
}

export interface MyApiTokenCreateBody {
  name: string;
  /** ISO-8601 timestamp; omit for a non-expiring token. */
  expires_at?: string | null;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** List the current user's tokens (includes revoked, sorted newest first). */
export function useMyApiTokens() {
  return useQuery<MyApiToken[], Error>({
    queryKey: TOKENS_KEY,
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<MyApiToken>>(BASE_PATH);
      return res.data.results;
    },
    retry: false,
  });
}

/**
 * Whether a token is currently active (usable): not revoked and not expired.
 * Centralized so the list, the cap counter, and the row state agree.
 */
export function isTokenActive(token: MyApiToken): boolean {
  return !token.is_revoked && !token.is_expired;
}

export function useCreateMyApiToken() {
  const qc = useQueryClient();
  return useMutation<CreatedMyApiToken, Error, MyApiTokenCreateBody>({
    mutationFn: async (body) => {
      const res = await apiClient.post<CreatedMyApiToken>(BASE_PATH, body);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });
}

/** Revoke (soft-delete) a token. Idempotent server-side. */
export function useRevokeMyApiToken() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiClient.delete(`${BASE_PATH}${id}/`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });
}
