import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from './shellFlag';
import { HomeRoute } from './HomeRoute';

const me = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => me.current }));

vi.mock('@/features/me/MyWorkPage', () => ({ MyWorkPage: () => <div>my-work-surface</div> }));
vi.mock('@/features/programs/ProgramListPage', () => ({
  ProgramListPage: () => <div>programs-surface</div>,
}));
vi.mock('@/features/resources/ResourcesPage', () => ({
  ResourcesPage: () => <div>resources-surface</div>,
}));
vi.mock('@/features/programs/ProgramOverviewPage', () => ({
  ProgramOverviewPage: () => <div>overview-surface</div>,
}));

function withLanding(landing: Record<string, unknown>) {
  me.current = { user: { landing }, isLoading: false, isError: false, refetch: vi.fn() };
}

describe('HomeRoute', () => {
  beforeEach(() => {
    localStorage.clear();
    setFeatureFlag(SHELL_V2_FLAG, true);
    withLanding({ home: 'contributor' });
  });

  it('shows a loading state while the user is unresolved', () => {
    me.current = { user: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(screen.queryByText('my-work-surface')).toBeNull();
  });

  it('shows an error with retry, never a home, when the user read fails', () => {
    me.current = { user: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(screen.getByText("Couldn't load your home.")).toBeInTheDocument();
  });

  it.each([
    ['contributor', 'my-work-surface'],
    ['pm', 'programs-surface'],
    ['rm', 'resources-surface'],
  ])('renders the %s home in place', async (home, text) => {
    withLanding({ home });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('renders the program overview for an exec with a home program', async () => {
    withLanding({ home: 'exec', home_program: { id: 'prog-1' } });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(await screen.findByText('overview-surface')).toBeInTheDocument();
  });

  it('falls back to the programs list for an exec with no program', async () => {
    withLanding({ home: 'exec', home_program: null });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(await screen.findByText('programs-surface')).toBeInTheDocument();
  });

  it('redirects away from /home when the flag is off', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    withLanding({ home: 'pm', path: '/programs' });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(screen.queryByText('programs-surface')).toBeNull();
    expect(screen.queryByText('my-work-surface')).toBeNull();
  });
});
