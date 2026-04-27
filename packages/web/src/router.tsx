import { createBrowserRouter, Navigate, useNavigate } from 'react-router';
import { useEffect } from 'react';
import { useProjects } from '@/hooks/useProjects';
import { AppShell } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/project/ProjectShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { ProjectOverviewPage } from '@/features/project/ProjectOverviewPage';
import { GanttView } from '@/features/gantt/GanttView';
import { WbsView } from '@/features/wbs/WbsView';
import { TaskListView } from '@/features/tasklist/TaskListView';
import { BoardView } from '@/features/board/BoardView';
import { CalendarView } from '@/features/calendar/CalendarView';
import { ResourceView } from '@/features/resource/ResourceView';
import { TeamView } from '@/features/roster/TeamView';
import { RosterPage } from '@/features/roster/RosterPage';
import { RiskRegisterView } from '@/features/risk/RiskRegisterView';
import { ResourcesPage } from '@/features/resources/ResourcesPage';

/**
 * Redirects to the first project's board when landing on `/` with no project
 * selected. Board is the canonical planning surface — first tab, default view.
 */
function RootRedirect() {
  const { data: projects, isLoading } = useProjects();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading || !projects) return;
    const first = projects[0];
    if (first) {
      void navigate(`/projects/${first.id}/board`, { replace: true });
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
              // /projects/:projectId → redirect to board (canonical planning surface)
              { index: true, element: <Navigate to="board" replace /> },
              { path: 'overview', element: <ProjectOverviewPage /> },
              { path: 'schedule', element: <GanttView /> },
              { path: 'wbs', element: <WbsView /> },
              { path: 'board', element: <BoardView /> },
              { path: 'list', element: <TaskListView /> },
              { path: 'calendar', element: <CalendarView /> },
              {
                path: 'resources',
                element: <TeamView />,
                children: [
                  { index: true, element: <Navigate to="roster" replace /> },
                  { path: 'roster', element: <RosterPage /> },
                  { path: 'allocation', element: <ResourceView /> },
                ],
              },
              { path: 'risk', element: <RiskRegisterView /> },
            ],
          },
          // Org-level resource catalog
          { path: 'resources', element: <ResourcesPage /> },
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
