import { RouterProvider } from 'react-router';
import { router } from './router';
import { useThemeInit } from '@/hooks/useThemeInit';

// QueryClientProvider lives inside AppShell so route loaders can access queryClient
// via closure from router.tsx without needing React context.
export function App() {
  useThemeInit();
  return <RouterProvider router={router} />;
}
