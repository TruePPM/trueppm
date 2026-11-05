import axios from 'axios';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { editionQueryOptions, type EditionResponse } from '@/hooks/useEdition';

/** The route guard renders nothing while this read is pending, so it must be short. */
export const SILENT_EDITION_TIMEOUT_MS = 4000;

interface TokenResponse {
  access: string;
}

/**
 * POST the credential to the token endpoint and install the access token.
 *
 * The one sign-in call shared by the login form, the demo's "Explore the demo" click
 * and the silent demo re-login below, so the demo has no auth path of its own (D2's
 * allowlist, D1's method fence and D6's throttles apply unchanged). The refresh token
 * arrives as an httpOnly cookie (#897); `remember` decides whether it outlives the tab.
 */
export async function requestSession(
  username: string,
  password: string,
  remember: boolean,
): Promise<string> {
  const response = await axios.post<TokenResponse>('/api/v1/auth/token/', {
    username,
    password,
    remember_me: remember,
  });
  useAuthStore.getState().setAccessToken(response.data.access);
  queryClient.clear();
  return response.data.access;
}

/**
 * Silently re-open the read-only demo for a visitor whose session is gone (#4500).
 *
 * Explore-the-demo signs in with `remember_me: false` on purpose (ADR-1197 Amendment
 * 2026-09-26: shared account, borrowed machine, no 30-day cookie), so the refresh
 * cookie dies with the tab and every reload or pasted deep link would otherwise land on
 * the signed-out modal. The credential is already public on the login screen, so
 * re-submitting it on the visitor's behalf discloses nothing and keeps the same
 * session-only semantics.
 *
 * Fires only when the server itself says this deployment is a read-only demo AND
 * publishes a credential — the same two facts the login screen requires. A real
 * install's `/edition/` carries neither, so a real account's expired session can never
 * reach this path. Never throws: any failure (edition unreadable, 401 mid-reset,
 * network) resolves `false` and the caller falls back to the existing modal.
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
    await requestSession(hint.username, hint.password, false);
    return true;
  } catch {
    return false;
  }
}
