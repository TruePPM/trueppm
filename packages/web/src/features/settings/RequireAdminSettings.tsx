/**
 * Route guard for the admin settings shells — #856, ADR-0122.
 *
 * A contributor (no Admin+ role in any project and not a workspace admin) has no
 * business on the Program settings page, the Observability setup or the System
 * Health tools; the server 403s their writes anyway, but a settings shell full of
 * controls they can't use reads as "not my tool". This guard bounces them to
 * their own notification settings. Admins fall through to the shell.
 *
 * ## Decision (#3350): the guard neither admits nor redirects without a verdict
 *
 * The guard used to redirect only on a positively-resolved
 * `can_access_admin_settings === false` and fall through otherwise, so its
 * documented failure mode was **to admit** — a `/auth/me` still loading, failed,
 * or carrying no boolean for the field let a non-admin straight into the shell.
 *
 * This is the same fail-open shape #3330 removed from {@link
 * RequireWorkspaceAdmin}, and that decision transfers unchanged: same signal
 * shape, same two constraints, same server-side enforcement making this UI
 * integrity rather than data integrity. The constraints were "a real admin must
 * never flash-redirect" and "a stale `/auth/me` payload must not lock admins
 * out", and *admitting* is only one of the ways to satisfy both. Rendering the
 * absence is the other, and it also satisfies "a non-admin is never admitted",
 * which admitting cannot.
 *
 * So the verdict drives the render (see `useAdminSettingsAccess`):
 *  - `admin`      → the settings shell.
 *  - `not-admin`  → redirect to personal settings, unchanged from #856.
 *  - `loading`    → a skeleton. No admin is redirected by a slow `/auth/me`,
 *                   because a slow read is never a verdict; and no non-admin is
 *                   admitted while the answer is still coming.
 *  - `unknown`    → `QueryErrorState` with a retry. NOT a skeleton: the query
 *                   sets `retry: false`, so a failed read is terminal and a
 *                   skeleton there would pulse forever (rule 246, #3298). NOT a
 *                   redirect either — bouncing a real admin off a transient
 *                   network error is the lockout the old default existed to
 *                   avoid, and the retry is the way back it never had.
 *
 * Scope note: the *project* settings page is deliberately not wrapped by this
 * guard (#2971) — it admits members and renders a reduced rail itself, because
 * one of its sections is a report about them. That is unaffected here; this
 * guard's three call sites in `router.tsx` are the program settings page,
 * `/settings/observability` and the `/settings/health/*` shell.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useAdminSettingsAccess } from '@/hooks/useAdminSettingsAccess';

export function RequireAdminSettings({ children }: { children: ReactNode }) {
  const { verdict, refetch } = useAdminSettingsAccess();

  switch (verdict) {
    case 'admin':
      return <>{children}</>;
    case 'not-admin':
      return <Navigate to="/me/settings/notifications" replace />;
    case 'loading':
      // Same shape as the route-level Suspense fallback this guard sits outside
      // of, so a cold settings load holds one steady ghost instead of swapping
      // between two (rule 248).
      return <LoadingSkeleton label="Loading settings…" variant="shell" rows={4} />;
    case 'unknown':
      return <QueryErrorState message="Couldn't confirm your settings access." onRetry={refetch} />;
  }
}
