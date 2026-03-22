import { type ReactElement, type ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // No retries in tests — fail fast
        retry: false,
        staleTime: 0,
      },
    },
  });
}

function Providers({ children }: { children: ReactNode }) {
  const testQueryClient = createTestQueryClient();
  return <QueryClientProvider client={testQueryClient}>{children}</QueryClientProvider>;
}

export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return render(ui, { wrapper: Providers, ...options });
}

/**
 * Render a component inside a MemoryRouter with QueryClientProvider.
 * Use for components that contain NavLink, useMatch, useNavigate, etc.
 */
export function renderWithRouter(
  element: ReactElement,
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
) {
  const testQueryClient = createTestQueryClient();
  const testRouter = createMemoryRouter([{ path: '*', element }], { initialEntries });
  return render(
    <QueryClientProvider client={testQueryClient}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}
