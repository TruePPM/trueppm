import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

// App previously used createBrowserRouter which doesn't work in jsdom (AbortSignal
// mismatch). These smoke tests now render AppShell directly via renderWithRouter
// (createMemoryRouter) to verify the landmark structure without the browser router.
describe('App', () => {
  it('renders the application shell landmark regions', () => {
    renderWithRouter(<AppShell />);
    // Shell renders header, navigations (view tabs + bottom rail + sidebar), and main
    expect(screen.getByRole('banner')).toBeInTheDocument(); // <header> in TopBar
    // Both ViewTabs and BottomNav are aria-label="View" (one hidden per breakpoint in real browser)
    expect(screen.getAllByRole('navigation', { name: /view/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the TruePPM logo text', () => {
    renderWithRouter(<AppShell />);
    expect(screen.getByText('TruePPM')).toBeInTheDocument();
  });
});
