import { useCurrentUser } from './useCurrentUser';

/**
 * What `/auth/me` can say about the signed-in user's admin-settings access.
 *
 * `can_access_admin_settings` is the org-wide "Admin+ in at least one project"
 * predicate the server computes on `MeSerializer` (ADR-0122). This type splits
 * the two situations a plain `boolean | undefined` read collapses into a single
 * falsy value, because a route guard cannot treat them the same way: `loading`
 * is transient and self-clearing, `unknown` is terminal (`retry: false` on the
 * `/auth/me` query) and needs a way out. Collapsing them either admits on a dead
 * request or renders a skeleton that never resolves (rule 246 / #3298).
 *
 *  - `admin`      — `/auth/me` answered `can_access_admin_settings: true`.
 *  - `not-admin`  — `/auth/me` answered `can_access_admin_settings: false`.
 *  - `loading`    — the read is in flight; no verdict exists yet.
 *  - `unknown`    — the read failed, or answered without a boolean
 *                   `can_access_admin_settings` (a payload from a server old
 *                   enough to omit the declared field). No verdict can be
 *                   derived and none will arrive without a refetch.
 *
 * Mirrors `useWorkspaceAdminStatus` (#3330) for the sibling signal; the two
 * gate different scopes (`workspace_role >= ADMIN` vs. Admin+ in any project)
 * and are deliberately not merged.
 */
export type AdminSettingsVerdict = 'admin' | 'not-admin' | 'loading' | 'unknown';

export interface AdminSettingsAccess {
  verdict: AdminSettingsVerdict;
  /**
   * Re-run the `/auth/me` read. The escape hatch from `unknown`, which is
   * otherwise terminal. A no-op when the underlying hook is mocked without one.
   */
  refetch: () => void;
}

/**
 * Whether the signed-in user may reach the admin settings shells, as a
 * four-state verdict.
 *
 * Prefer this over reading `user?.can_access_admin_settings` directly anywhere
 * the *absence* of a verdict must drive a different rendering than the verdict
 * itself — a route guard, or any surface that has to show a loading or error
 * state rather than guessing. Surfaces that merely soften a nav affordance keep
 * reading the raw field with `!== false` (rule 379: an absent capability read to
 * WITHDRAW something defaults to silent), because hiding a link on a slow
 * `/auth/me` is a worse trade than a link that 403s.
 */
export function useAdminSettingsAccess(): AdminSettingsAccess {
  const { user, isLoading, isError, refetch } = useCurrentUser();
  const retry = refetch ?? (() => {});

  if (isLoading) return { verdict: 'loading', refetch: retry };
  if ((isError ?? false) || !user) return { verdict: 'unknown', refetch: retry };

  // Read through `unknown` on purpose. `CurrentUser` declares the field as a
  // required `boolean` — that is an assertion about `MeSerializer`, not about the
  // bytes on the wire — so tsc alone would narrow this branch away and leave the
  // guard admitting on any payload that omits it (an older API, or a fixture that
  // was never representable). The verdict has to be derived from what arrived.
  const canAccess: unknown = user.can_access_admin_settings;
  if (typeof canAccess !== 'boolean') return { verdict: 'unknown', refetch: retry };
  return { verdict: canAccess ? 'admin' : 'not-admin', refetch: retry };
}
