import { type ReactElement, type ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';

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
 * Like renderWithProviders, but also wraps in a MemoryRouter — for
 * components that read route context (useParams, Link, useNavigate) but
 * are not themselves routed pages, so createMemoryRouter's element-baked-in
 * config (see renderWithRouter below) would break `rerender`.
 */
export function renderWithProvidersAndRouter(
  ui: ReactElement,
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
) {
  const testQueryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
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
