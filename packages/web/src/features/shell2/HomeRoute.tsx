import { lazy, Suspense, useMemo } from 'react';
import { Navigate } from 'react-router';
import { useFeatureFlag } from '@/lib/featureFlags';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { safeLandingPath } from '@/features/me/landing';
import { ProgramRefContext } from '@/router/refContext';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { SHELL_V2_FLAG } from './shellFlag';
import { resolveHomeSurface } from './homeModel';

const MyWorkPage = lazy(() =>
  import('@/features/me/MyWorkPage').then((m) => ({ default: m.MyWorkPage })),
);
const ProgramListPage = lazy(() =>
  import('@/features/programs/ProgramListPage').then((m) => ({ default: m.ProgramListPage })),
);
const ResourcesPage = lazy(() =>
  import('@/features/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage })),
);
const ProgramOverviewPage = lazy(() =>
  import('@/features/programs/ProgramOverviewPage').then((m) => ({
    default: m.ProgramOverviewPage,
  })),
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
  const programId = surface.kind === 'program-overview' ? surface.programId : null;
  // The overview reads its program from ProgramRefContext (what the
  // /programs/:programId boundary provides); `/home` has no param, so supply the
  // server-chosen id directly.
  const programRef = useMemo(
    () => (programId ? { id: programId, ref: programId } : null),
    [programId],
  );

  return (
    <Suspense fallback={<LoadingSkeleton label="Loading…" variant="shell" rows={4} />}>
      {surface.kind === 'my-work' && <MyWorkPage />}
      {surface.kind === 'programs' && <ProgramListPage />}
      {surface.kind === 'resources' && <ResourcesPage />}
      {programRef && (
        <ProgramRefContext.Provider value={programRef}>
          <ProgramOverviewPage />
        </ProgramRefContext.Provider>
      )}
    </Suspense>
  );
}
