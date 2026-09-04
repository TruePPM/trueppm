import { useCurrentUser } from './useCurrentUser';

/**
 * WorkspaceRole.ADMIN ordinal (backend `apps/workspace/models.py`, ADR-0072
 * 100-unit banding). Workspace-scoped settings writes gate on
 * `role >= WorkspaceRole.ADMIN` server-side (`IsWorkspaceAdmin`); this mirrors
 * that threshold for render-gates only — the server is always authoritative.
 */
export const WORKSPACE_ADMIN_ROLE = 300;

/**
 * What `/auth/me` can say about the signed-in user's workspace role.
 *
 * `loading` and `unknown` are the two situations the `boolean | null` form of
 * this signal collapses into a single `null`, which is why they are split here:
 * `loading` is transient and self-clearing, `unknown` is terminal (`retry:
 * false` on the query) and needs a way out. A caller that treats them the same
 * either admits on a dead request or renders a skeleton that never resolves
 * (rule 246 / #3298). See {@link useIsWorkspaceAdmin} for the narrow form.
 *
 *  - `admin`      — `/auth/me` answered with `workspace_role >= ADMIN`.
 *  - `not-admin`  — `/auth/me` answered with a positively sub-admin ordinal.
 *  - `loading`    — the read is in flight; no verdict exists yet.
 *  - `unknown`    — the read failed, or answered without a numeric
 *                   `workspace_role` (a `null` ordinal, i.e. a deactivated
 *                   membership, or a payload from a server old enough to omit
 *                   the field). No verdict can be derived and none will arrive
 *                   without a refetch.
 */
export type WorkspaceAdminVerdict = 'admin' | 'not-admin' | 'loading' | 'unknown';

export interface WorkspaceAdminStatus {
  verdict: WorkspaceAdminVerdict;
  /**
   * Re-run the `/auth/me` read. The escape hatch from `unknown`, which is
   * otherwise terminal. A no-op when the underlying hook is mocked without one.
   */
  refetch: () => void;
}

/**
 * Whether the signed-in user is a workspace admin, as a four-state verdict.
 *
 * Prefer this over {@link useIsWorkspaceAdmin} anywhere the *absence* of a
 * verdict drives a different rendering than the verdict itself — a route guard,
 * or any surface that must show a loading or error state rather than guessing.
 */
export function useWorkspaceAdminStatus(): WorkspaceAdminStatus {
  const { user, isLoading, isError, refetch } = useCurrentUser();
  const retry = refetch ?? (() => {});

  if (isLoading) return { verdict: 'loading', refetch: retry };
  if ((isError ?? false) || !user) return { verdict: 'unknown', refetch: retry };

  const role = user.workspace_role;
  if (typeof role !== 'number') return { verdict: 'unknown', refetch: retry };
  return { verdict: role >= WORKSPACE_ADMIN_ROLE ? 'admin' : 'not-admin', refetch: retry };
}

/**
 * Whether the signed-in user is a workspace admin (or owner) and may edit
 * workspace-scoped settings.
 *
 * Deliberately tri-state: returns `null` while the role signal is loading or
 * absent, and only `false` once `/auth/me` has *positively* reported a
 * sub-admin `workspace_role`. Callers gate **render permission** on `=== true`
 * (fail closed: anything but a positive yes is read-only) and **redirects or
 * removals** on `=== false` (fail open: never act on an unresolved signal) —
 * the server still 403s any unauthorized write.
 *
 * This is the narrow form and it is lossy on purpose: `null` means "loading" and
 * "errored / no numeric role" at once. A caller that must tell those apart —
 * because it renders a skeleton for one and an error for the other — takes
 * {@link useWorkspaceAdminStatus} instead (#3330).
 */
export function useIsWorkspaceAdmin(): boolean | null {
  const { verdict } = useWorkspaceAdminStatus();
  if (verdict === 'admin') return true;
  if (verdict === 'not-admin') return false;
  return null;
}
