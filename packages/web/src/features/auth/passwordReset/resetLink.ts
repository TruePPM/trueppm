/**
 * Reset-link credential transport — URL fragment, not URL path (issue #3553).
 *
 * The `(uid, token)` pair emailed to a user IS a bearer credential: whoever holds
 * it can set that account's password for the next 30 minutes. It used to ride in
 * the route path (`/reset-password/confirm/:uid/:token`), which exports it three
 * ways the app does not control:
 *
 *   1. `telemetry.ts` puts `window.location.pathname` in every envelope, so a
 *      render error on the reset screen shipped a live takeover credential to the
 *      operator's collector;
 *   2. `RouteErrorBoundary` sends the same pathname as `route`;
 *   3. a cross-origin navigation off the reset page sends the whole URL as
 *      `Referer`.
 *
 * The fragment closes all three **at source** rather than by filtering: browsers
 * never transmit it to any server, RFC 7231 §5.5.2 strips it from `Referer`
 * unconditionally, and it is not part of `window.location.pathname`. Path-logging
 * proxies in front of the SPA stop seeing it for the same reason.
 *
 * The fragment is deliberately NOT cleared from the address bar after it is read.
 * Clearing it would make a reload — an ordinary thing to do mid-form while a
 * password manager is generating a password — lose the credential and strand the
 * user on the expired screen. Browser history retaining the link is an accepted
 * risk, bounded by the token's 30-minute single-use expiry; it is unavoidable for
 * any emailed-link recovery flow and is not what #3553 set out to fix.
 */

/** The `(uid, token)` pair carried in a reset link's fragment. */
export interface ResetCredential {
  uid: string;
  token: string;
}

/**
 * Parse a reset credential out of a URL fragment, or `null` when it is absent or
 * incomplete.
 *
 * Accepts the fragment with or without its leading `#` so callers can pass
 * `window.location.hash` (which includes it) or React Router's `location.hash`
 * (which also includes it) without normalizing first.
 *
 * Returns `null` rather than a partial credential when either half is missing:
 * a half-present credential can only ever produce a server rejection, and the
 * caller routes a `null` straight to the expired screen instead of letting the
 * user type a new password first. That path is reachable in practice — an email
 * URL-rewriting proxy that drops the fragment yields exactly this shape.
 */
export function parseResetCredential(hash: string): ResetCredential | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const uid = params.get('uid') ?? '';
  const token = params.get('token') ?? '';
  if (!uid || !token) return null;

  return { uid, token };
}

/**
 * Build the SPA-relative reset-confirm link for a credential.
 *
 * The API builds the emailed copy of this URL itself (`core/password_reset.py`);
 * this exists for the legacy-path redirect, which has to reconstruct the
 * fragment form of a link minted before #3553.
 */
export function buildResetConfirmPath(credential: ResetCredential): string {
  const params = new URLSearchParams({ uid: credential.uid, token: credential.token });
  return `/reset-password/confirm#${params.toString()}`;
}
