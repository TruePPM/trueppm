import { createBrowserRouter, Navigate, useNavigate } from 'react-router';
import { lazy, Suspense, useEffect } from 'react';
import { useProjects } from '@/hooks/useProjects';
import { AppShell } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/project/ProjectShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';

// Route-level code splitting — each chunk is loaded only when the route is
// first visited, keeping the initial bundle (login + shell) minimal.
const ProjectOverviewPage = lazy(() =>
  import('@/features/project/ProjectOverviewPage').then((m) => ({ default: m.ProjectOverviewPage }))
);
const ScheduleView = lazy(() =>
  import('@/features/schedule/ScheduleView').then((m) => ({ default: m.ScheduleView }))
);
const GridView = lazy(() =>
  import('@/features/grid/GridView').then((m) => ({ default: m.GridView }))
);
const BoardView = lazy(() =>
  import('@/features/board/BoardView').then((m) => ({ default: m.BoardView }))
);
const SprintsView = lazy(() =>
  import('@/features/sprints/SprintsView').then((m) => ({ default: m.SprintsView }))
);
const CalendarView = lazy(() =>
  import('@/features/calendar/CalendarView').then((m) => ({ default: m.CalendarView }))
);
const ResourceView = lazy(() =>
  import('@/features/resource/ResourceView').then((m) => ({ default: m.ResourceView }))
);
const HeatmapPage = lazy(() =>
  import('@/features/resource/HeatmapPage').then((m) => ({ default: m.HeatmapPage }))
);
const TeamView = lazy(() =>
  import('@/features/roster/TeamView').then((m) => ({ default: m.TeamView }))
);
const RosterPage = lazy(() =>
  import('@/features/roster/RosterPage').then((m) => ({ default: m.RosterPage }))
);
const RiskRegisterView = lazy(() =>
  import('@/features/risk/RiskRegisterView').then((m) => ({ default: m.RiskRegisterView }))
);
const ReportsView = lazy(() =>
  import('@/features/reports/ReportsView').then((m) => ({ default: m.ReportsView }))
);
const ResourcesPage = lazy(() =>
  import('@/features/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage }))
);
const ProjectSettingsPage = lazy(() =>
  import('@/features/settings/ProjectSettingsPage').then((m) => ({
    default: m.ProjectSettingsPage,
  }))
);
const MembersTab = lazy(() =>
  import('@/features/settings/members/MembersTab').then((m) => ({ default: m.MembersTab }))
);
const MyWorkPage = lazy(() =>
  import('@/features/me/MyWorkPage').then((m) => ({ default: m.MyWorkPage }))
);

/** Fallback rendered inside Suspense while a lazy chunk is loading. */
function RouteLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full text-sm text-neutral-text-secondary">
      Loading…
    </div>
  );
}

/**
 * Redirects to the first project's overview when landing on `/` with no project
 * selected. Overview is the canonical landing surface (ADR-0030).
 */
function RootRedirect() {
  const { data: projects, isLoading } = useProjects();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading || !projects) return;
    const first = projects[0];
    if (first) {
      void navigate(`/projects/${first.id}/overview`, { replace: true });
    }
  }, [projects, isLoading, navigate]);

  if (isLoading) return null;

  return (
    <div className="flex items-center justify-center h-full text-sm text-neutral-text-secondary">
      Select a project from the sidebar to get started.
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          // Project-scoped routes — projectId in path for shareable URLs (ADR-0030)
          {
            path: 'projects/:projectId',
            element: <ProjectShell />,
            children: [
              // /projects/:projectId → redirect to overview (canonical landing surface, ADR-0030)
              { index: true, element: <Navigate to="overview" replace /> },
              {
                path: 'overview',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProjectOverviewPage />
                  </Suspense>
                ),
              },
              {
                path: 'schedule',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ScheduleView />
                  </Suspense>
                ),
              },
              {
                path: 'grid',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <GridView />
                  </Suspense>
                ),
              },
              // Legacy routes — redirect to /grid so old bookmarks and shared
              // links keep working after the WBS / Table consolidation (#334).
              { path: 'wbs', element: <Navigate to="../grid" replace /> },
              { path: 'list', element: <Navigate to="../grid" replace /> },
              {
                path: 'board',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <BoardView />
                  </Suspense>
                ),
              },
              {
                path: 'sprints',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SprintsView />
                  </Suspense>
                ),
              },
              {
                path: 'calendar',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <CalendarView />
                  </Suspense>
                ),
              },
              {
                path: 'resources',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TeamView />
                  </Suspense>
                ),
                children: [
                  { index: true, element: <Navigate to="roster" replace /> },
                  { path: 'roster', element: <RosterPage /> },
                  { path: 'allocation', element: <ResourceView /> },
                  { path: 'heatmap', element: <HeatmapPage /> },
                ],
              },
              {
                path: 'risk',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <RiskRegisterView />
                  </Suspense>
                ),
              },
              {
                path: 'reports',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ReportsView />
                  </Suspense>
                ),
              },
              {
                path: 'settings',
                element: (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProjectSettingsPage />
                  </Suspense>
                ),
                children: [
                  { index: true, element: <Navigate to="members" replace /> },
                  { path: 'members', element: <MembersTab /> },
                ],
              },
            ],
          },
          // Org-level resource catalog
          {
            path: 'resources',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ResourcesPage />
              </Suspense>
            ),
          },
          // My Work — cross-project contributor surface (#499, ADR-0065 Gap 2)
          {
            path: 'me/work',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <MyWorkPage />
              </Suspense>
            ),
          },
          // Root: redirect to first project overview, or prompt to select one.
          { index: true, element: <RootRedirect /> },
        ],
      },
    ],
  },
  {
    path: '*',
    element: (
      <div className="min-h-screen flex items-center justify-center bg-neutral-surface-raised">
        <div className="text-center">
          <p className="text-4xl font-semibold text-neutral-text-primary">404</p>
          <p className="mt-2 text-sm text-neutral-text-secondary">Page not found</p>
        </div>
      </div>
    ),
  },
]);
