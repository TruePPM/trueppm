/**
 * API calls + response classification for the password-reset flow (issue 765, ADR-0209).
 *
 * Both endpoints are unauthenticated (`AllowAny`), so we use bare `axios` (no
 * apiClient auth interceptor) exactly like `LoginPage`. The confirm endpoint
 * returns two distinct 400 error codes that drive different screens, so the outcome
 * is normalized into a discriminated union here — keeping the branching logic pure
 * and unit-testable, out of the components.
 */

import axios from 'axios';

/** Result of a reset-confirm attempt, mapped from the API response. */
export type ConfirmOutcome =
  | { kind: 'success' }
  /** uid/token invalid, unknown, or expired → route to the "expired link" screen. */
  | { kind: 'invalid_token' }
  /** Password failed policy → render `messages` inline. */
  | { kind: 'weak_password'; messages: string[] }
  /** Rate limited (429) → ask the user to wait. */
  | { kind: 'rate_limited' }
  /** Network / unexpected error → generic retry copy. */
  | { kind: 'error' };

/**
 * Request a reset link. The endpoint always returns 200 (no user enumeration), so a
 * resolved promise means "the request was accepted", NOT "an account exists". The
 * caller navigates to the confirmation screen regardless. Rejects only on a real
 * transport/HTTP failure (network down, 429, 5xx) so the caller can show an error.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await axios.post('/api/v1/auth/password/reset/', { email });
}

/** True when the rejection is an HTTP 429 (throttled). */
export function isRateLimited(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 429;
}

/**
 * Confirm a reset. Never throws — every branch (success, invalid token, weak
 * password, throttled, network error) is folded into a `ConfirmOutcome` so the
 * component can `switch` on `.kind` without touching axios internals.
 */
export async function confirmPasswordReset(
  uid: string,
  token: string,
  newPassword: string,
): Promise<ConfirmOutcome> {
  try {
    await axios.post('/api/v1/auth/password/reset/confirm/', {
      uid,
      token,
      new_password: newPassword,
    });
    return { kind: 'success' };
  } catch (err: unknown) {
    return classifyConfirmError(err);
  }
}

/**
 * Map a caught error from the confirm endpoint to a `ConfirmOutcome`. Exported for
 * unit testing the branch logic without a live request.
 */
export function classifyConfirmError(err: unknown): ConfirmOutcome {
  if (!axios.isAxiosError(err)) return { kind: 'error' };
  const status = err.response?.status;
  if (status === 429) return { kind: 'rate_limited' };
  if (status === 400) {
    const data = err.response?.data as { code?: string; messages?: unknown } | undefined;
    if (data?.code === 'invalid_token') return { kind: 'invalid_token' };
    if (data?.code === 'weak_password') {
      const messages = Array.isArray(data.messages)
        ? data.messages.filter((m): m is string => typeof m === 'string')
        : [];
      return { kind: 'weak_password', messages };
    }
  }
  return { kind: 'error' };
}

/**
 * Redact an email address for the "we sent a link to …" confirmation screen: keep
 * the first character of the local part and the full domain, mask the rest. Never
 * reveals the full address on-screen. Falls back to a neutral placeholder for a
 * value that is not a plausible address.
 *
 * `anna.khoury@example.com` → `a•••@example.com`
 */
export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return 'your email address';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return 'your email address';
  const first = local[0];
  return `${first}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
