import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RootRedirect, ProjectIndexRedirect } from './router';

/**
 * `RootRedirect` (the app's `/` front door) and `ProjectIndexRedirect`
 * (`/projects/:id`'s entry route) both gate on `useCurrentUser()` (#3542).
 * Isolated from the full route tree — mounting through it would drag in
 * AppShell and every lazy-loaded page chunk for what is a small guard
 * around one query.
 */

const mockUseCurrentUser = vi.fn();
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUseCurrentUser() as unknown,
}));

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

const refetch = vi.fn();

function renderRoot() {
  return render(
    <MemoryRouter>
      <RootRedirect />
    </MemoryRouter>,
  );
}

function renderProjectIndex() {
  return render(
    <MemoryRouter>
      <ProjectIndexRedirect />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RootRedirect — failed /auth/me/ (#3542)', () => {
  // Before the fix, `isLoading || !user` never cleared on a failed GET
  // (`isLoading` settles to false on a terminal failure — `retry: false` — but
  // `!user` stays true forever) — the app's `/` front door hung on "Taking you
  // to your home screen…" forever with no error and no retry.
  it('renders an error with Retry, not a perpetual "Taking you to your home screen…", when /auth/me/ fails', () => {
    mockUseCurrentUser.mockReturnValue({
      user: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderRoot();

    expect(screen.getByText("Couldn't sign you in.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/Taking you to your home screen/i)).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('retries the current-user query on click', async () => {
    const user = userEvent.setup();
    mockUseCurrentUser.mockReturnValue({
      user: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderRoot();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('still navigates to the resolved landing path on success', () => {
    mockUseCurrentUser.mockReturnValue({
      user: { landing: { path: '/me/work' } },
      isLoading: false,
      isError: false,
      refetch,
    });
    renderRoot();

    expect(mockNavigate).toHaveBeenCalledWith('/me/work', { replace: true });
  });
});

describe('ProjectIndexRedirect — failed /auth/me/ (#3542)', () => {
  // Before the fix, `isLoading || !user` returning `null` forever meant the
  // project-entry route rendered nothing — a blank pane inside the still-painted
  // ProjectShell chrome, with no error and no way forward.
  it('renders an error with Retry, not a blank pane, when /auth/me/ fails', () => {
    mockUseCurrentUser.mockReturnValue({
      user: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    const { container } = renderProjectIndex();

    expect(screen.getByText("Couldn't determine where to take you.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
  });

  it('retries the current-user query on click', async () => {
    const user = userEvent.setup();
    mockUseCurrentUser.mockReturnValue({
      user: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderProjectIndex();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
