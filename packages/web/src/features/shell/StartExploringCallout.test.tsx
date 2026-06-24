import { render, screen, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type InitialEntry } from 'react-router';
import { describe, it, expect } from 'vitest';
import { StartExploringCallout } from './StartExploringCallout';

/**
 * Render the callout at a concrete route so `useParams()` resolves (the board
 * variant keys off `:projectId`) and with a router-state entry carrying the
 * `startExploringSample` signal the load flow passes on navigation.
 */
function renderAt(path: string, entry: InitialEntry) {
  const router = createMemoryRouter([{ path, element: <StartExploringCallout /> }], {
    initialEntries: [entry],
  });
  return render(<RouterProvider router={router} />);
}

const region = () => screen.queryByRole('region', { name: 'Start exploring this demo' });

describe('StartExploringCallout (issue 1054)', () => {
  it('renders the sample-keyed steps on a program-overview landing', () => {
    renderAt('/programs/:programId/overview', {
      pathname: '/programs/p1/overview',
      state: { startExploringSample: 'atlas-platform-launch' },
    });
    expect(region()).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Start exploring — Atlas Platform Launch' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Schedule for the CPM critical path/i)).toBeInTheDocument();
    // No board-landing line on a program route.
    expect(screen.queryByText(/Your assigned tasks are on this board/i)).toBeNull();
  });

  it('leads with the contributor line when landing on a board route', () => {
    renderAt('/projects/:projectId/board', {
      pathname: '/projects/pr1/board',
      state: { startExploringSample: 'aurora-mobile-app' },
    });
    expect(screen.getByText(/Your assigned tasks are on this board/i)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Start exploring — Aurora Mobile App' }),
    ).toBeInTheDocument();
  });

  it('renders nothing on a direct visit (no router state)', () => {
    renderAt('/programs/:programId/overview', '/programs/p1/overview');
    expect(region()).toBeNull();
  });

  it('renders nothing for an unknown sample key', () => {
    renderAt('/programs/:programId/overview', {
      pathname: '/programs/p1/overview',
      state: { startExploringSample: 'no-such-sample' },
    });
    expect(region()).toBeNull();
  });

  it('dismissing hides the callout', () => {
    renderAt('/programs/:programId/overview', {
      pathname: '/programs/p1/overview',
      state: { startExploringSample: 'bayside-civic-center' },
    });
    expect(region()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(region()).toBeNull();
  });
});
