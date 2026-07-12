/**
 * Basic SSO (OIDC) — public login helpers (#1392, ADR-0187).
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

/** `GET /auth/oidc/discover` — domain-level only, never leaks account existence. */
export interface SsoDiscoverResult {
  provider_present: boolean;
  display_name?: string;
  issuer?: string;
}

/**
 * Probe whether an email's domain is served by the configured SSO provider.
 *
 * Bare `axios` (public endpoint). Always resolves — a network error degrades to
 * `{ provider_present: false }` so the login screen simply falls back to password
 * entry rather than surfacing an error the user cannot act on.
 */
export async function discoverSso(email: string): Promise<SsoDiscoverResult> {
  try {
    const res = await axios.get<SsoDiscoverResult>('/api/v1/auth/oidc/discover/', {
      params: { email },
    });
    return res.data;
  } catch {
    return { provider_present: false };
  }
}
