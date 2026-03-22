import { RouterProvider } from 'react-router';
import { router } from './router';

// QueryClientProvider lives inside AppShell so route loaders can access queryClient
// via closure from router.tsx without needing React context.
export function App() {
  return <RouterProvider router={router} />;
}
