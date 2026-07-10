/**
 * Client-side identity derivation for the account chip and the sidebar "You"
 * card / "Signed in" footer.
 *
 * The `/auth/me/` serializer already falls back `display_name → username` and
 * `initials → username[:2]`, so a resolved session is normally never name-less.
 * These helpers are the client-side safety net: if any of those fields arrives
 * empty (email-only account, an SSO profile with no name, a stale/partial
 * payload), the account control must still self-identify — it must never render
 * a literal "?" (which reads as Help, not "your account") nor a bare "Account".
 *
 * Fallback chain, longest-lived name first: display_name → username → email
 * local-part → a neutral last resort.
 */

import { initialsOf } from './initials';

interface IdentitySource {
  display_name?: string | null;
  username?: string | null;
  email?: string | null;
}

/** Rendered only for an unresolved/anonymous session — never for a signed-in user. */
const LAST_RESORT_INITIALS = '··';
const LAST_RESORT_LABEL = 'Account';

function firstNonEmpty(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** "kelly.hair@example.com" → "kelly.hair"; undefined for a blank/absent email. */
function emailLocalPart(email: string | null | undefined): string | undefined {
  const trimmed = email?.trim();
  if (!trimmed) return undefined;
  const at = trimmed.indexOf('@');
  const local = at === -1 ? trimmed : trimmed.slice(0, at);
  return local.trim() || undefined;
}

/**
 * Human-readable identity label: display_name → username → email local-part →
 * "Account". A resolved session always has a username, so "Account" only shows
 * while unauthenticated/loading.
 */
export function labelForUser(user: IdentitySource | undefined | null): string {
  return (
    firstNonEmpty(user?.display_name, user?.username, emailLocalPart(user?.email)) ??
    LAST_RESORT_LABEL
  );
}

/**
 * Two-letter initials for the avatar chip — never "?".
 * display_name → username → email local-part → "··".
 * Email/username separators (`. _ + -`) are treated as word boundaries so
 * "kelly.hair" and "kelly_hair" both yield "KH", not "KE".
 */
export function initialsForUser(user: IdentitySource | undefined | null): string {
  const source = firstNonEmpty(user?.display_name, user?.username, emailLocalPart(user?.email));
  if (!source) return LAST_RESORT_INITIALS;
  const normalized = source.replace(/[._+-]+/g, ' ');
  return initialsOf(normalized) ?? LAST_RESORT_INITIALS;
}

/**
 * Accessible name / tooltip for the account control, e.g. "Account — Kelly Hair",
 * so the top-right chip self-identifies as the profile/account home rather than
 * reading as a generic "User menu". Falls back to "Account" for an unresolved
 * session.
 */
export function accountAccessibleName(user: IdentitySource | undefined | null): string {
  const label = labelForUser(user);
  return label === LAST_RESORT_LABEL ? 'Account' : `Account — ${label}`;
}
