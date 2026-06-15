import { within, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useThemeStore } from '@/stores/themeStore';
import { TopBar } from './TopBar';

// ViewTabs hides itself when there is no :projectId in the URL path (ADR-0030).
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'test-project-id',
}));

// Stub useNavigate to avoid react-router navigation side-effects in JSDOM tests.
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// The health cluster owns its own data hooks (useSprints, useProjectVelocity,
// useShellStats, …) and is covered by HealthCluster.test.tsx. Stub it here so the
// TopBar structural tests don't fire its (unmocked) XHRs / crash the worker.
vi.mock('./HealthCluster', () => ({
  HealthCluster: () => <div data-testid="health-cluster" />,
}));

vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: () => [],
}));

vi.mock('@/hooks/useNotifications', () => ({
  useUnreadNotificationCount: () => ({ count: 0, isLoading: false }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: null, isLoading: false }),
}));

// ViewTabs (rendered inside TopBar) calls useProject and useCurrentUserRole.
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { id: 'test-project-id', methodology: 'HYBRID' }, isLoading: false, error: null }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 200, isLoading: false }),
}));

beforeEach(() => {
  useThemeStore.setState({ theme: 'auto' });
});

describe('TopBar', () => {
  it('renders the logo', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Two-color wordmark splits the text across spans; assert the accessible name.
    expect(screen.getByLabelText('TruePPM')).toBeInTheDocument();
  });

  it('renders the grouped project view bar with the canonical view set', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: /view/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grid' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'WBS' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Table' })).not.toBeInTheDocument();
  });

  it('Overview leads as the standalone first tab (ADR-0030/0128)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: /view/i });
    const links = within(nav).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Overview');
  });

  it('groups views into PLAN / TRACK / PEOPLE (ADR-0128)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('group', { name: /plan views/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /track views/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /people views/i })).toBeInTheDocument();
    // Board lives in TRACK; Backlog in PLAN.
    const track = screen.getByRole('group', { name: /track views/i });
    expect(within(track).getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });

  it('renders the methodology workspace tag', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByText(/hybrid workspace/i)).toBeInTheDocument();
  });

  it('renders the health cluster', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByTestId('health-cluster')).toBeInTheDocument();
  });

  it('renders hamburger button for mobile', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /open sidebar/i })).toBeInTheDocument();
  });

  it('renders user avatar button', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /user menu/i }).length).toBeGreaterThan(0);
  });

  it('calls onHamburgerClick when hamburger button is clicked', async () => {
    const user = userEvent.setup();
    const onHamburgerClick = vi.fn();
    renderWithRouter(<TopBar onHamburgerClick={onHamburgerClick} />);
    await user.click(screen.getByRole('button', { name: /open sidebar/i }));
    expect(onHamburgerClick).toHaveBeenCalledOnce();
  });

  it('marks the Board tab as active when on the board route', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
    const boardLink = screen.getByRole('link', { name: /Board/i });
    expect(boardLink).toHaveAttribute('aria-current', 'page');
    const scheduleLink = screen.getByRole('link', { name: /Schedule/i });
    expect(scheduleLink).not.toHaveAttribute('aria-current');
  });
});
