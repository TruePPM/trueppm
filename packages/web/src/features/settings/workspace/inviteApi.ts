/**
 * API call + response classification for the public invite-accept flow (#2035).
 *
 * The endpoint (`POST /api/v1/workspace/invites/accept/`) is unauthenticated —
 * the one-time token in the body is the credential — so we use bare `axios` (no
 * apiClient auth interceptor), exactly like the login and password-reset flows.
 *
 * On success it returns `{ detail, username }` at 200 and establishes **no**
 * session (no JWT is minted), so the caller cannot auto-login — it redirects to
 * `/login` with the returned username pre-filled instead.
 *
 * On failure it returns a single `{ detail }` string at 400 (the backend keeps
 * errors generic to avoid token enumeration). The distinct server messages are
 * folded into a discriminated union here so the component can `switch` on `.kind`
 * and place each error at the right field, replacing the old
 * `Object.values(data).flat().join(' ')` blob. Kept pure and out of the component
 * so the branch logic is unit-testable.
 */

import axios from 'axios';

/** Result of an invite-accept attempt, mapped from the API response. */
export type AcceptOutcome =
  /** Account provisioned or linked. `username` is the server's canonical value. */
  | { kind: 'success'; username: string }
  /** Token invalid, unknown, expired, or already used → terminal "bad link" state. */
  | { kind: 'invalid_token' }
  /** Password failed the server policy → render `message` under the password field. */
  | { kind: 'weak_password'; message: string }
  /** Chosen username collides with an existing account → render under the username field. */
  | { kind: 'username_taken' }
  /**
   * The invite has no existing account and the token-only ("I already have an
   * account") path was used → prompt the user to create an account instead.
   */
  | { kind: 'account_required' }
  /** Membership is deactivated; an admin must reactivate before the invite works. */
  | { kind: 'deactivated'; message: string }
  /** Rate limited (429) → ask the user to wait. */
  | { kind: 'rate_limited' }
  /** Network / unexpected error → generic retry copy. */
  | { kind: 'error' };

/** Body for the accept request. Omit username/password for the existing-account path. */
export interface AcceptInviteInput {
  token: string;
  username?: string;
  password?: string;
}

/**
 * Accept an invite. Never throws — every branch is folded into an `AcceptOutcome`
 * so the component can render the outcome without touching axios internals.
 */
export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptOutcome> {
  try {
    const body: Record<string, string> = { token: input.token };
    if (input.username && input.username.trim()) body.username = input.username.trim();
    if (input.password) body.password = input.password;
    const res = await axios.post<{ detail: string; username: string }>(
      '/api/v1/workspace/invites/accept/',
      body,
    );
    return { kind: 'success', username: res.data.username };
  } catch (err: unknown) {
    return classifyAcceptError(err);
  }
}

/**
 * Map a caught error from the accept endpoint to an `AcceptOutcome`. Exported for
 * unit-testing the branch logic without a live request.
 *
 * The backend returns a single generic `detail` string (no machine-readable
 * `code`), so classification matches the known server messages. Anything else
 * that is a 400 with a `detail` is treated as a password-policy rejection (the
 * `validate_password` messages the backend joins for a new account) and shown
 * under the password field — never dumped as an opaque object.
 */
export function classifyAcceptError(err: unknown): AcceptOutcome {
  if (!axios.isAxiosError(err)) return { kind: 'error' };
  const status = err.response?.status;
  if (status === 429) return { kind: 'rate_limited' };
  if (status !== 400) return { kind: 'error' };

  const data = err.response?.data as Record<string, unknown> | undefined;
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  if (!detail) return { kind: 'error' };

  const lower = detail.toLowerCase();
  if (lower.includes('invalid') || lower.includes('expired')) return { kind: 'invalid_token' };
  if (lower.includes('username is already taken')) return { kind: 'username_taken' };
  if (lower.includes('username and password are required')) return { kind: 'account_required' };
  if (lower.includes('deactivated')) return { kind: 'deactivated', message: detail };
  // Fall-through: the server's joined password-policy messages.
  return { kind: 'weak_password', message: detail };
}
