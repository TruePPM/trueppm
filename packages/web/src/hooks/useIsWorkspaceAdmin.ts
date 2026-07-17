import { useCurrentUser } from './useCurrentUser';

/**
 * WorkspaceRole.ADMIN ordinal (backend `apps/workspace/models.py`, ADR-0072
 * 100-unit banding). Workspace-scoped settings writes gate on
 * `role >= WorkspaceRole.ADMIN` server-side (`IsWorkspaceAdmin`); this mirrors
 * that threshold for render-gates only — the server is always authoritative.
 */
export const WORKSPACE_ADMIN_ROLE = 300;

/**
 * Whether the signed-in user is a workspace admin (or owner) and may edit
 * workspace-scoped settings.
 *
 * Deliberately tri-state: returns `null` while the role signal is loading or
 * absent, and only `false` once `/auth/me` has *positively* reported a
 * sub-admin `workspace_role`. Callers gate on `=== false` for redirects/disables
 * so a real admin never flash-redirects and a stale `/auth/me` payload (missing
 * the field) can't lock admins out — the server still 403s any unauthorized
 * write. Mirrors the conservative posture of {@link RequireAdminSettings}.
 */
export function useIsWorkspaceAdmin(): boolean | null {
  const { user, isLoading } = useCurrentUser();
  if (isLoading || !user) return null;
  const role = user.workspace_role;
  if (typeof role !== 'number') return null;
  return role >= WORKSPACE_ADMIN_ROLE;
}
