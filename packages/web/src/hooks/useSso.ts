/**
 * Basic SSO (OIDC) — admin config hooks (#1392, ADR-0187).
 *
 * The authed half of the SSO surface against the frozen #1405 backend contract:
 * `useOidcProvider` / `useUpdateOidcProvider` / `useDeleteOidcProvider` /
 * `useTestOidcConnection` against the singleton `/workspace/sso/`
 * (IsWorkspaceAdmin). The client secret is write-only — the read shape reports
 * only `secret_set`, and sending `client_secret` on PUT rotates it (blank/omitted
 * keeps the stored secret). The public login helpers live in {@link ssoLogin}
 * so the login screen never pulls in `apiClient`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';

/** `GET /workspace/sso/` read shape — secret reduced to `secret_set`. */
export interface OidcProviderConfig {
  enabled: boolean;
  display_name: string;
  issuer_url: string;
  client_id: string;
  scopes: string[];
  allowed_email_domains: string[];
  auto_create_members: boolean;
  default_role: number;
  allow_password_signin: boolean;
  /** Always false in OSS — enforcement of the OFF state is an Enterprise capability. */
  allow_password_signin_enforced: boolean;
  secret_set: boolean;
  redirect_uri: string;
  created_at: string;
  updated_at: string;
}

/** `PUT /workspace/sso/` partial body. `client_secret` omitted/blank keeps the stored secret. */
export interface OidcProviderUpdate {
  enabled?: boolean;
  display_name?: string;
  issuer_url?: string;
  client_id?: string;
  client_secret?: string;
  allowed_email_domains?: string[];
  auto_create_members?: boolean;
  default_role?: number;
  allow_password_signin?: boolean;
}

/** `POST /workspace/sso/test-connection/` structured probe result. */
export interface OidcTestResult {
  ok: boolean;
  issuer?: string;
  endpoints?: Record<string, string>;
  error?: string;
  detail?: string;
}

const PROVIDER_KEY = ['workspace-sso-provider'] as const;

/** GET /workspace/sso/ — the singleton provider config (IsWorkspaceAdmin). */
export function useOidcProvider() {
  return useQuery<OidcProviderConfig, Error>({
    queryKey: PROVIDER_KEY,
    queryFn: async () => {
      const res = await apiClient.get<OidcProviderConfig>('/workspace/sso/');
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** PUT /workspace/sso/ — replace the config (sending `client_secret` rotates it). */
export function useUpdateOidcProvider() {
  const qc = useQueryClient();
  return useMutation<OidcProviderConfig, Error, OidcProviderUpdate>({
    mutationFn: async (body: OidcProviderUpdate) => {
      const res = await apiClient.put<OidcProviderConfig>('/workspace/sso/', body);
      return res.data;
    },
    onSuccess: (data) => {
      qc.setQueryData(PROVIDER_KEY, data);
      void qc.invalidateQueries({ queryKey: PROVIDER_KEY });
    },
  });
}

/** DELETE /workspace/sso/ — remove the config entirely (disables SSO). */
export function useDeleteOidcProvider() {
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      await apiClient.delete('/workspace/sso/');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROVIDER_KEY });
    },
  });
}

/** Narrow an axios-style rejection to its response body without an `any` cast. */
function responseBody<T>(err: unknown): T | undefined {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const response = (err as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      return (response as { data?: T }).data;
    }
  }
  return undefined;
}

/**
 * POST /workspace/sso/test-connection/ — probe discovery + JWKS reachability.
 *
 * The endpoint returns 200 with `{ ok }` in both the success and the
 * reachable-but-invalid case; a thrown error carrying an `ok` body is normalized
 * back into the result so the caller renders one inline outcome.
 */
export function useTestOidcConnection() {
  return useMutation<OidcTestResult, Error, { issuer_url?: string } | void>({
    mutationFn: async (vars) => {
      try {
        const res = await apiClient.post<OidcTestResult>(
          '/workspace/sso/test-connection/',
          vars ?? {},
        );
        return res.data;
      } catch (err) {
        const body = responseBody<OidcTestResult>(err);
        if (body && typeof body.ok === 'boolean') return body;
        throw err;
      }
    },
  });
}
