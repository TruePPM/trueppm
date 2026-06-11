/**
 * Route guard for the admin settings shell (Workspace / Project / Program
 * scopes) — #856, ADR-0122.
 *
 * A contributor (no Admin+ role in any project and not a workspace admin) has no
 * business on the Methodology / Workflow / Roles / Groups pages; the server 403s
 * their writes anyway, but a settings shell full of controls they can't use reads
 * as "not my tool". This guard bounces them to their own notification settings.
 * Admins fall through to the shell.
 *
 * While the role signal is still loading we render the children rather than a
 * spinner so an admin never sees a flash-redirect; the gate only fires once
 * ``can_access_admin_settings`` resolves to ``false``.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';

export function RequireAdminSettings({ children }: { children: ReactNode }) {
  const { user, isLoading } = useCurrentUser();
  // Strict `=== false`: only redirect once the server has positively said this
  // user is not an admin anywhere. An absent/loading signal falls through to the
  // shell (the server still 403s any write), so an admin never sees a
  // flash-redirect and an older /auth/me payload doesn't lock admins out.
  if (!isLoading && user?.can_access_admin_settings === false) {
    return <Navigate to="/me/settings/notifications" replace />;
  }
  return <>{children}</>;
}
