import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router';
import { useFeatureFlag } from '@/lib/featureFlags';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { safeLandingPath } from '@/features/me/landing';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { SHELL_V2_FLAG } from './shellFlag';
import { resolveHomeSurface } from './homeModel';

const ContributorHome = lazy(() =>
  import('./homes/ContributorHome').then((m) => ({ default: m.ContributorHome })),
);
const PmHome = lazy(() => import('./homes/PmHome').then((m) => ({ default: m.PmHome })));
const ExecHome = lazy(() => import('./homes/ExecHome').then((m) => ({ default: m.ExecHome })));
const ResourcesPage = lazy(() =>
  import('@/features/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage })),
);

/**
 * `/home` — the shell-v2 front door.
 *
 * Renders the server-resolved home **in place** rather than redirecting, so the
 * rail's Home item stays active while the person is on it. With the flag off it
 * replace-redirects to the v1 `landing.path`, so a bookmarked `/home` behaves.
 */
export function HomeRoute() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  const { user, isLoading, isError, refetch } = useCurrentUser();

  if (isError) {
    return <QueryErrorState message="Couldn't load your home." onRetry={() => refetch?.()} />;
  }
  if (isLoading || !user) {
    return <LoadingSkeleton label="Loading…" variant="shell" rows={4} />;
  }
  if (!v2) return <Navigate to={safeLandingPath(user.landing?.path)} replace />;
  return <HomeSurfaceView landing={user.landing} />;
}

function HomeSurfaceView({ landing }: { landing: Parameters<typeof resolveHomeSurface>[0] }) {
  const surface = resolveHomeSurface(landing);
  return (
    <Suspense fallback={<LoadingSkeleton label="Loading…" variant="shell" rows={4} />}>
      {surface.kind === 'contributor' && <ContributorHome />}
      {surface.kind === 'pm' && <PmHome />}
      {surface.kind === 'resources' && <ResourcesPage />}
      {surface.kind === 'exec' && <ExecHome initialProgramId={surface.programId} />}
    </Suspense>
  );
}
