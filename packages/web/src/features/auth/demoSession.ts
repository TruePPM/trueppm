import axios from 'axios';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { editionQueryOptions, type EditionResponse } from '@/hooks/useEdition';
import { markDemoSession } from './demoMarker';

/** The route guard renders nothing while the silent login is pending, so each call is short. */
export const SILENT_EDITION_TIMEOUT_MS = 4000;
export const SILENT_TOKEN_TIMEOUT_MS = 4000;

interface TokenResponse {
  access: string;
}

/**
 * POST the credential to the token endpoint and install the access token.
 *
 * The one sign-in call shared by the login form, the demo's "Explore the demo" click
 * and the silent demo re-login below, so the demo has no auth path of its own (D2's
 * allowlist, D1's method fence and D6's throttles apply unchanged). The refresh token
 * arrives as an httpOnly cookie (#897); `remember` decides whether it outlives the browser
 * session. `timeoutMs` bounds the request for callers that block rendering on it.
 */
export async function requestSession(
  username: string,
  password: string,
  remember: boolean,
  timeoutMs?: number,
): Promise<string> {
  const body = { username, password, remember_me: remember };
  const response =
    timeoutMs === undefined
      ? await axios.post<TokenResponse>('/api/v1/auth/token/', body)
      : await axios.post<TokenResponse>('/api/v1/auth/token/', body, { timeout: timeoutMs });
  useAuthStore.getState().setAccessToken(response.data.access);
  queryClient.clear();
  return response.data.access;
}

/**
 * Silently re-open the read-only demo when no usable session exists (#4500).
 *
 * Two callers need it: a fresh visitor who pastes a deep link (no session at all), and
 * a returning demo visitor whose refresh has genuinely failed (browser restart, long
 * idle, a sample reset). "Explore the demo" signs in with `remember_me: false` on purpose
 * (ADR-1197 Amendment 2026-09-26), and the credential is already public on the login
 * screen, so re-submitting it on the visitor's behalf discloses nothing and keeps the
 * same browser-session semantics. A plain reload does not need this: the browser-session
 * refresh cookie survives it.
 *
 * Fires only when the server itself says this deployment is a read-only demo AND
 * publishes a credential — the same two facts the login screen requires. A real
 * install's `/edition/` carries neither. Whether the CALLER may renew an expired session
 * (only a demo-marked one) is the route guard's decision, not this function's. Never
 * throws: any failure (edition unreadable, 401 mid-reset, network, timeout) resolves
 * `false` and the caller falls back to the existing modal or redirect.
 */
export async function silentDemoLogin(): Promise<boolean> {
  try {
    const edition = await queryClient.fetchQuery({
      ...editionQueryOptions,
      // Same key and shape as the shared query, but bounded: on a hung API the guard
      // would otherwise hold a blank screen where it used to redirect or show the modal.
      queryFn: async (): Promise<EditionResponse> =>
        (
          await axios.get<EditionResponse>('/api/v1/edition/', {
            timeout: SILENT_EDITION_TIMEOUT_MS,
          })
        ).data,
      retry: false,
    });
    const hint = edition.demo_read_only === true ? edition.demo_login_hint : null;
    if (!hint) return false;
    await requestSession(hint.username, hint.password, false, SILENT_TOKEN_TIMEOUT_MS);
    markDemoSession();
    return true;
  } catch {
    return false;
  }
}
