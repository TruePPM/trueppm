import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/features/shell/AppShell';
import { PlaceholderView } from '@/features/shell/PlaceholderView';
import { ProjectShell } from '@/features/project/ProjectShell';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <ProjectShell /> },
      { path: 'gantt', element: <ProjectShell /> },
      { path: 'board', element: <PlaceholderView name="Board" /> },
      { path: 'list', element: <PlaceholderView name="List" /> },
      { path: 'calendar', element: <PlaceholderView name="Calendar" /> },
      { path: 'resources', element: <PlaceholderView name="Resources" /> },
    ],
  },
]);
