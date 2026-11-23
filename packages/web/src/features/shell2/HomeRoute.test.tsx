import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from './shellFlag';
import { HomeRoute } from './HomeRoute';

const me = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => me.current }));

vi.mock('./homes/ContributorHome', () => ({
  ContributorHome: () => <div>contributor-surface</div>,
}));
vi.mock('./homes/PmHome', () => ({ PmHome: () => <div>pm-surface</div> }));
vi.mock('./homes/ExecHome', () => ({
  ExecHome: ({ initialProgramId }: { initialProgramId: string | null }) => (
    <div>exec-surface:{initialProgramId ?? 'none'}</div>
  ),
}));
vi.mock('@/features/homes/RmHome', () => ({
  RmHome: () => <div>rm-home-surface</div>,
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
    expect(screen.queryByText('contributor-surface')).toBeNull();
  });

  it('shows an error with retry, never a home, when the user read fails', () => {
    me.current = { user: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(screen.getByText("Couldn't load your home.")).toBeInTheDocument();
  });

  it.each([
    ['contributor', 'contributor-surface'],
    ['pm', 'pm-surface'],
    ['rm', 'rm-home-surface'],
  ])('renders the %s home in place', async (home, text) => {
    withLanding({ home });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('renders the exec home on the server-chosen program', async () => {
    withLanding({ home: 'exec', home_program: { id: 'prog-1' } });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(await screen.findByText('exec-surface:prog-1')).toBeInTheDocument();
  });

  it('renders the exec home on its empty state for an exec with no program', async () => {
    withLanding({ home: 'exec', home_program: null });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(await screen.findByText('exec-surface:none')).toBeInTheDocument();
  });

  it('redirects away from /home when the flag is off', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    withLanding({ home: 'pm', path: '/programs' });
    renderWithRouter(<HomeRoute />, { initialEntries: ['/home'] });
    expect(screen.queryByText('pm-surface')).toBeNull();
    expect(screen.queryByText('contributor-surface')).toBeNull();
  });
});
