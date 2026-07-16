/**
 * Route guard for the workspace-scoped settings shell — the consolidated
 * `/settings` page (ADR-0146, #2012).
 *
 * {@link RequireAdminSettings} admits anyone with `can_access_admin_settings`,
 * which is `max_project_role >= ADMIN OR workspace_role >= ADMIN`. A plain
 * workspace *member* who is admin of a single project therefore reached the
 * Workspace settings page, where every save PATCH 403s (`IsWorkspaceAdmin`) and
 * some sections (Groups) 403 even the GET — a shell of enabled controls the user
 * can't actually use. This guard requires `workspace_role >= ADMIN` specifically
 * and bounces a non-workspace-admin to their personal settings, so the mixed
 * enabled-but-403 / error-boundary state can never render (issue #2012).
 *
 * Conservative, matching RequireAdminSettings: only redirect once the role
 * signal has positively resolved to "not a workspace admin" (`=== false`); a
 * loading/absent signal falls through so a real admin never sees a
 * flash-redirect and an older `/auth/me` payload can't lock admins out.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useIsWorkspaceAdmin } from '@/hooks/useIsWorkspaceAdmin';

export function RequireWorkspaceAdmin({ children }: { children: ReactNode }) {
  const isWorkspaceAdmin = useIsWorkspaceAdmin();
  if (isWorkspaceAdmin === false) {
    return <Navigate to="/me/settings/notifications" replace />;
  }
  return <>{children}</>;
}
