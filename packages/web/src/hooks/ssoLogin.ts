/**
 * Multi-provider SSO — public login helpers (#2108, ADR-0517, supersedes #1392).
 *
 * The unauthenticated half of the SSO surface, deliberately kept separate from
 * the authed admin hooks in {@link useSso} so the login screen never imports
 * `apiClient`: these calls must not go through the 401→refresh interceptor (the
 * user has no session yet), and the login screen stays a leaf that depends only
 * on bare `axios`, mirroring {@link useEdition}.
 */

import axios from 'axios';

/** The unauthenticated endpoint the browser is redirected to to begin login. */
export const SSO_LOGIN_PATH = '/api/v1/auth/oidc/login';

/** A single enabled provider as surfaced by discover (no config leak). */
export interface SsoProviderSummary {
  slug: string;
  display_name: string;
}

/** `GET /auth/oidc/discover` — domain-level only, never leaks account existence. */
export interface SsoDiscoverResult {
  provider_present: boolean;
  /** Enabled providers to render a sign-in button for (all, or domain-matched). */
  providers: SsoProviderSummary[];
}

/**
 * List the enabled SSO providers, optionally narrowed to an email's domain.
 *
 * With no `email` it returns every enabled provider (the login screen renders a
 * button per provider). With an `email` it returns only the providers whose
 * domain allow-list admits that address — domain-level only, so it never reveals
 * whether an account exists. Bare `axios` (public endpoint). Always resolves — a
 * network error degrades to an empty list so the login screen simply falls back
 * to password entry rather than surfacing an error the user cannot act on.
 */
export async function discoverSsoProviders(email?: string): Promise<SsoDiscoverResult> {
  try {
    const res = await axios.get<Partial<SsoDiscoverResult>>(
      '/api/v1/auth/oidc/discover/',
      email ? { params: { email } } : undefined,
    );
    const data = res.data ?? {};
    return {
      provider_present: Boolean(data.provider_present),
      providers: Array.isArray(data.providers) ? data.providers : [],
    };
  } catch {
    return { provider_present: false, providers: [] };
  }
}

/** The unauthenticated login URL for a specific provider slug (top-level nav). */
export function ssoLoginUrl(slug: string): string {
  return `${SSO_LOGIN_PATH}?provider=${encodeURIComponent(slug)}`;
}
