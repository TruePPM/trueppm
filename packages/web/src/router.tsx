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
import { RiskRegisterView } from '@/features/risk/RiskRegisterView';

/**
 * Redirects to the first project's overview when landing on `/` with no project
 * selected. Shows a neutral message while the project list loads.
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
              // /projects/:projectId → redirect to overview
              { index: true, element: <Navigate to="overview" replace /> },
              { path: 'overview', element: <ProjectOverviewPage /> },
              { path: 'gantt', element: <GanttView /> },
              { path: 'wbs', element: <WbsView /> },
              { path: 'board', element: <BoardView /> },
              { path: 'list', element: <TaskListView /> },
              { path: 'calendar', element: <CalendarView /> },
              { path: 'resources', element: <ResourceView /> },
              { path: 'risk', element: <RiskRegisterView /> },
            ],
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
