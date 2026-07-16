import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { AppShell } from '@/features/shell/AppShell';

// createCpmWorker uses `new Worker(new URL(..., import.meta.url))` which triggers
// Vite's worker bundling pipeline — unsupported in jsdom. Mock the factory so
// App-level smoke tests render without hanging.
vi.mock('@/workers/createCpmWorker', () => ({
  createCpmWorker: () => ({
    onmessage: null,
    postMessage: () => {},
    terminate: () => {},
  }),
}));

// ViewTabs hides itself when there is no :projectId in the URL path (ADR-0030).
// Provide one so the nav renders in the smoke test.
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'test-project-id',
}));

// The devtools gate (#1674) is about AppShell's own conditional render, not
// the real devtools panel's internals — stub the library's export to a
// locatable marker so the test doesn't couple to @tanstack/react-query-devtools'
// DOM shape.
vi.mock('@tanstack/react-query-devtools', () => ({
  ReactQueryDevtools: () => <div data-testid="react-query-devtools-stub" />,
}));

// App previously used createBrowserRouter which doesn't work in jsdom (AbortSignal
// mismatch). These smoke tests now render AppShell directly via renderWithRouter
// (createMemoryRouter) to verify the landmark structure without the browser router.
describe('App', () => {
  it('renders the application shell landmark regions', () => {
    renderWithRouter(<AppShell />);
    // Shell renders header, navigations (sidebar view tier + bottom rail), and main
    expect(screen.getByRole('banner')).toBeInTheDocument(); // <header> in TopBar
    // Both the rail's ProjectViewsTier and BottomNav are aria-label="View" (one hidden per breakpoint in real browser)
    expect(screen.getAllByRole('navigation', { name: /view/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the TruePPM logo', () => {
    renderWithRouter(<AppShell />);
    // Wordmark is two-color ("True" navy + "PPM" sage) so the text is split
    // across spans; the accessible name lives on the lockup's aria-label.
    expect(screen.getByLabelText('TruePPM')).toBeInTheDocument();
  });

  // --- React Query devtools opt-in gate (#1674) ---

  describe('React Query devtools panel', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('stays off by default, even in a DEV build (Vitest runs with import.meta.env.DEV true)', () => {
      renderWithRouter(<AppShell />);
      expect(screen.queryByTestId('react-query-devtools-stub')).not.toBeInTheDocument();
    });

    it('stays off when VITE_REACT_QUERY_DEVTOOLS is set to anything other than the literal string "true"', () => {
      vi.stubEnv('VITE_REACT_QUERY_DEVTOOLS', '1');
      renderWithRouter(<AppShell />);
      expect(screen.queryByTestId('react-query-devtools-stub')).not.toBeInTheDocument();
    });

    it('renders when VITE_REACT_QUERY_DEVTOOLS=true', () => {
      vi.stubEnv('VITE_REACT_QUERY_DEVTOOLS', 'true');
      renderWithRouter(<AppShell />);
      expect(screen.getByTestId('react-query-devtools-stub')).toBeInTheDocument();
    });
  });
});
