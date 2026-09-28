import { useCurrentUser } from './useCurrentUser';

/**
 * WorkspaceRole.OWNER ordinal (backend `apps/workspace/models.py`, ADR-0072
 * 100-unit banding). The workspace lifecycle endpoints — transfer ownership,
 * export (create / status / download), and hard-delete — gate on
 * `role >= WorkspaceRole.OWNER` server-side (`IsWorkspaceOwner`, and the inline
 * `request_is_workspace_owner()` check `WorkspaceSettingsView.delete` uses);
 * this mirrors that threshold for render-gates only — the server is always
 * authoritative. One band above `WORKSPACE_ADMIN_ROLE` in `useIsWorkspaceAdmin`.
 */
export const WORKSPACE_OWNER_ROLE = 400;

/**
 * What `/auth/me` can say about the signed-in user's workspace OWNERSHIP.
 *
 * Mirrors `WorkspaceAdminVerdict` one band higher (#4210): `WorkspaceDangerPage`
 * used to render Export / Transfer ownership / Delete workspace enabled to any
 * workspace Admin (role 300) — those three actions are Owner-only server-side —
 * so a plain Admin's click 403'd every time. Same "enabled-but-403 shell of
 * controls" defect #2012/#3330 fixed at the route level, recurring one role band
 * down where `RequireWorkspaceAdmin` (Admin-threshold) can't reach it.
 *
 *  - `owner`     — `/auth/me` answered with `workspace_role >= OWNER`.
 *  - `not-owner` — `/auth/me` answered with a positively sub-owner ordinal.
 *  - `loading`   — the read is in flight; no verdict exists yet.
 *  - `unknown`   — the read failed, or answered without a numeric
 *                  `workspace_role` (a `null` ordinal, i.e. a deactivated
 *                  membership, or a payload from a server old enough to omit
 *                  the field). No verdict can be derived and none will arrive
 *                  without a refetch.
 */
export type WorkspaceOwnerVerdict = 'owner' | 'not-owner' | 'loading' | 'unknown';

export interface WorkspaceOwnerStatus {
  verdict: WorkspaceOwnerVerdict;
  /**
   * Re-run the `/auth/me` read. The escape hatch from `unknown`, which is
   * otherwise terminal. A no-op when the underlying hook is mocked without one.
   */
  refetch: () => void;
}

/**
 * Whether the signed-in user is the workspace Owner, as a four-state verdict.
 *
 * Prefer this over {@link useIsWorkspaceOwner} anywhere the *absence* of a
 * verdict drives a different rendering than the verdict itself — see
 * `useWorkspaceAdminStatus` for the sibling threshold this mirrors.
 */
export function useWorkspaceOwnerStatus(): WorkspaceOwnerStatus {
  const { user, isLoading, isError, refetch } = useCurrentUser();
  const retry = refetch ?? (() => {});

  if (isLoading) return { verdict: 'loading', refetch: retry };
  if ((isError ?? false) || !user) return { verdict: 'unknown', refetch: retry };

  const role = user.workspace_role;
  if (typeof role !== 'number') return { verdict: 'unknown', refetch: retry };
  return { verdict: role >= WORKSPACE_OWNER_ROLE ? 'owner' : 'not-owner', refetch: retry };
}

/**
 * Whether the signed-in user is the workspace Owner (narrow form).
 *
 * Deliberately lossy, like {@link useIsWorkspaceAdmin}: `null` collapses
 * "loading" and "errored / no numeric role" into one value. Callers gate
 * **render permission** on `=== true` (fail closed: anything but a positive
 * yes stays disabled) — the server still 403s any unauthorized write.
 */
export function useIsWorkspaceOwner(): boolean | null {
  const { verdict } = useWorkspaceOwnerStatus();
  if (verdict === 'owner') return true;
  if (verdict === 'not-owner') return false;
  return null;
}
