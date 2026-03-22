import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/features/shell/AppShell';
import { PlaceholderView } from '@/features/shell/PlaceholderView';
import { GanttView } from '@/features/gantt/GanttView';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <GanttView /> },
      { path: 'gantt', element: <GanttView /> },
      { path: 'board', element: <PlaceholderView name="Board" /> },
      { path: 'list', element: <PlaceholderView name="List" /> },
      { path: 'calendar', element: <PlaceholderView name="Calendar" /> },
      { path: 'resources', element: <PlaceholderView name="Resources" /> },
    ],
  },
]);
