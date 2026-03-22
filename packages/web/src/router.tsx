import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/features/shell/AppShell';
import { PlaceholderView } from '@/features/shell/PlaceholderView';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <PlaceholderView name="Gantt" /> },
      { path: 'gantt', element: <PlaceholderView name="Gantt" /> },
      { path: 'board', element: <PlaceholderView name="Board" /> },
      { path: 'list', element: <PlaceholderView name="List" /> },
      { path: 'calendar', element: <PlaceholderView name="Calendar" /> },
      { path: 'resources', element: <PlaceholderView name="Resources" /> },
    ],
  },
]);
