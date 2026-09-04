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
 * ## Decision (#3330): the guard neither admits nor redirects without a verdict
 *
 * The guard used to redirect only on a positively-resolved `false` and fall
 * through on `null`, so its documented failure mode was **to admit**. The
 * reasoning was sound but the conclusion did not follow: the two constraints
 * were "a real admin must never flash-redirect" and "a payload missing
 * `workspace_role` must not lock admins out", and *admitting* is only one of the
 * ways to satisfy both. Rendering the absence is the other, and it also
 * satisfies "a non-admin is never admitted", which admitting cannot.
 *
 * This matters because the guard is the only control on most of what it wraps.
 * It wraps one route — `/settings` — but that route is the consolidated
 * scrolling page, and of its 19 sections only three gate themselves on a role
 * (Methodology, #3314; Programs; Email, via the server's `can_edit`). The other
 * sixteen carry no role check at all, and nine of those mutate — General,
 * Members, Groups, SSO, Calendar, Attachments, Danger (workspace delete),
 * Retention (purge) and Feedback — so on a `null` verdict they rendered live,
 * armed controls to whoever asked. Fixing that per page is nine changes plus a
 * standing obligation on every section added later; fixing it here is one.
 *
 * So the verdict drives the render (see `useWorkspaceAdminStatus`):
 *  - `admin`      → the settings page.
 *  - `not-admin`  → redirect to personal settings, unchanged from #2012.
 *  - `loading`    → a skeleton. No admin is redirected by a slow `/auth/me`,
 *                   because a slow read is never a verdict; and no non-admin is
 *                   admitted while the answer is still coming.
 *  - `unknown`    → `QueryErrorState` with a retry. NOT a skeleton: the query
 *                   sets `retry: false`, so a failed read is terminal and a
 *                   skeleton there would pulse forever (rule 246, #3298). NOT a
 *                   redirect either — bouncing a real admin off a transient
 *                   network error is the lockout the old default existed to
 *                   avoid, and the retry is the way back that the old default
 *                   never had.
 *
 * The server refuses every workspace write regardless (`IsWorkspaceAdmin`), so
 * this is UI integrity, not data integrity. Per-page gates stay valuable as
 * defense in depth and are not being removed — #3314's page keeps its own.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useWorkspaceAdminStatus } from '@/hooks/useIsWorkspaceAdmin';

export function RequireWorkspaceAdmin({ children }: { children: ReactNode }) {
  const { verdict, refetch } = useWorkspaceAdminStatus();

  switch (verdict) {
    case 'admin':
      return <>{children}</>;
    case 'not-admin':
      return <Navigate to="/me/settings/notifications" replace />;
    case 'loading':
      // Same shape as the route-level Suspense fallback this guard sits outside
      // of, so a cold `/settings` load holds one steady ghost instead of
      // swapping between two (rule 248).
      return <LoadingSkeleton label="Loading workspace settings…" variant="shell" rows={4} />;
    case 'unknown':
      return <QueryErrorState message="Couldn't confirm your workspace role." onRetry={refetch} />;
  }
}
