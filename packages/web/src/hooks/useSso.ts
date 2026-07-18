/**
 * Multi-provider SSO — admin config hooks (#2108, ADR-0517, supersedes #1392).
 *
 * The authed half of the SSO surface against the `/workspace/sso/providers/`
 * collection (list/create + `{slug}/` item + `{slug}/test-connection/`), all
 * `IsWorkspaceAdminStrict`. Each provider is an allauth `SocialApp` + an
 * `SsoProviderPolicy` side row, presented as one flat object. The client secret
 * is write-only — the read shape reports only `secret_set`, and sending
 * `client_secret` on create/update stores/rotates it (blank/omitted keeps the
 * stored value). The public login helpers live in {@link ssoLogin} so the login
 * screen never pulls in `apiClient`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';

/** One configured provider — the collection read shape. Secret → `secret_set`. */
export interface SsoProvider {
  /** Registry slug (`generic`/`google`/`entra`/… ) — the API + `SocialAccount` key. */
  slug: string;
  /** allauth provider name (`openid_connect` | `github`) — informational. */
  provider: string;
  /** Registry kind (`free`/`fixed`/`derived`/`oauth`) — drives the panel. */
  kind: string;
  display_name: string;
  enabled: boolean;
  client_id: string;
  /** OIDC issuer (empty for GitHub, which has no discovery). */
  server_url: string;
  /** GitHub-only org restriction (empty for OIDC). */
  github_org: string;
  scopes: string[];
  allowed_email_domains: string[];
  auto_create_members: boolean;
  default_role: number;
  allow_password_signin: boolean;
  /** Always false in OSS — enforcing the OFF state is an Enterprise capability. */
  allow_password_signin_enforced: boolean;
  secret_set: boolean;
  /** Server-derived, copy-only. Identical for every provider (callback unchanged). */
  redirect_uri: string;
  created_at: string;
  updated_at: string;
}

/** Create/update body. `client_secret` omitted/blank keeps the stored secret. */
export interface SsoProviderWrite {
  /** Required on create (selects the registry type); immutable on update. */
  slug?: string;
  display_name?: string;
  client_id?: string;
  client_secret?: string;
  server_url?: string;
  github_org?: string;
  enabled?: boolean;
  allowed_email_domains?: string[];
  auto_create_members?: boolean;
  default_role?: number;
}

/** `POST …/{slug}/test-connection/` structured probe result. */
export interface SsoTestResult {
  ok: boolean;
  issuer?: string;
  endpoints?: Record<string, string>;
  error?: string;
  detail?: string;
}

const PROVIDERS_KEY = ['workspace-sso-providers'] as const;
const COLLECTION = '/workspace/sso/providers/';
const item = (slug: string) => `${COLLECTION}${encodeURIComponent(slug)}/`;

/** GET the configured provider collection (IsWorkspaceAdminStrict). */
export function useSsoProviders() {
  return useQuery<SsoProvider[], Error>({
    queryKey: PROVIDERS_KEY,
    queryFn: async () => {
      const res = await apiClient.get<SsoProvider[]>(COLLECTION);
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** POST a new provider (sending `client_secret` stores it). */
export function useCreateSsoProvider() {
  const qc = useQueryClient();
  return useMutation<SsoProvider, Error, SsoProviderWrite>({
    mutationFn: async (body) => {
      const res = await apiClient.post<SsoProvider>(COLLECTION, body);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
  });
}

/** PUT a provider by slug (sending `client_secret` rotates it). */
export function useUpdateSsoProvider() {
  const qc = useQueryClient();
  return useMutation<SsoProvider, Error, { slug: string; body: SsoProviderWrite }>({
    mutationFn: async ({ slug, body }) => {
      const res = await apiClient.put<SsoProvider>(item(slug), body);
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
  });
}

/** DELETE a provider by slug (removes the config; purges its bindings server-side). */
export function useDeleteSsoProvider() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (slug) => {
      await apiClient.delete(item(slug));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
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
 * POST …/{slug}/test-connection/ — probe discovery + JWKS (OIDC) or API (GitHub).
 *
 * The endpoint returns 200 with `{ ok }` in both the success and the
 * reachable-but-invalid case; a thrown error carrying an `ok` body is normalized
 * back into the result so the caller renders one inline outcome.
 */
export function useTestSsoConnection() {
  return useMutation<SsoTestResult, Error, string>({
    mutationFn: async (slug) => {
      try {
        const res = await apiClient.post<SsoTestResult>(`${item(slug)}test-connection/`, {});
        return res.data;
      } catch (err) {
        const body = responseBody<SsoTestResult>(err);
        if (body && typeof body.ok === 'boolean') return body;
        throw err;
      }
    },
  });
}
