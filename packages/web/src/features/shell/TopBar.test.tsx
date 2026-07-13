import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useThemeStore } from '@/stores/themeStore';
import { useShellStore } from '@/stores/shellStore';
import { TopBar } from './TopBar';

// Route + data hooks are driven by mutable fixtures so each test can pick a context.
let projectId: string | undefined = 'test-project-id';
let programId: string | undefined;
let projectData: unknown = {
  id: 'test-project-id',
  name: 'Launch Site',
  methodology: 'HYBRID',
  program_detail: { id: 'prog-1', name: 'Apollo' },
};
let programData: unknown = { id: 'prog-1', name: 'Apollo', color: '#3E8C6D', code: 'APL' };
let presenceUsers: { user_id: string; display_name: string }[] = [];
let currentUser: { id: string } | null = null;

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId }));
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: () => programId }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: projectData, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useProgram', () => ({ useProgram: () => ({ data: programData }) }));
vi.mock('@/hooks/useProjectPresence', () => ({
  useProjectPresence: (id: string | undefined) => (id ? presenceUsers : []),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: currentUser, isLoading: false }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 200, isLoading: false }),
}));
vi.mock('@/hooks/useNotifications', () => ({
  useUnreadNotificationCount: () => ({ count: 0, isLoading: false }),
}));
// The health cluster + create menu own their own data hooks and are covered by their
// own specs; stub them so the structural TopBar tests don't fire their XHRs.
vi.mock('./HealthCluster', () => ({ HealthCluster: () => <div data-testid="health-cluster" /> }));
vi.mock('./CreateMenu', () => ({ CreateMenu: () => null }));
// The running-timer chip owns its own /me/timer/ query (covered by its own spec);
// stub it so the structural TopBar tests don't fire that XHR (#1415).
vi.mock('@/features/timer/TimerChip', () => ({ TimerChip: () => null }));
vi.mock('@/features/programs/ProgramIdentitySquare', () => ({
  ProgramIdentitySquare: () => <span data-testid="identity-square" aria-hidden="true" />,
}));
// The location switcher owns its own route/data hooks and is covered by its own
// specs; stub it so the structural TopBar tests assert the bar's composition, not
// the switcher's internals (#1643).
vi.mock('./LocationSwitcher', () => ({
  LocationSwitcher: () => <nav data-testid="location-switcher" aria-label="Location" />,
}));

// Stub useNavigate to avoid react-router navigation side-effects in JSDOM tests.
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  projectId = 'test-project-id';
  programId = undefined;
  projectData = {
    id: 'test-project-id',
    name: 'Launch Site',
    methodology: 'HYBRID',
    program_detail: { id: 'prog-1', name: 'Apollo' },
  };
  programData = { id: 'prog-1', name: 'Apollo', color: '#3E8C6D', code: 'APL' };
  presenceUsers = [];
  currentUser = null;
  useThemeStore.setState({ theme: 'auto' });
  useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
});

describe('TopBar (unified shell bar, ADR-0134)', () => {
  it('renders the logo (mobile brand)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByLabelText('TruePPM')).toBeInTheDocument();
  });

  it('renders the location switcher (replaces the breadcrumb + in-chrome ProjectSwitcher)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByTestId('location-switcher')).toBeInTheDocument();
  });

  it('no longer carries the view-tab strip in the bar — the rail owns view switching (#1642/#1643)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // The bar's only nav is the location switcher; the old grouped view-tab nav and
    // its Schedule/Board/Grid links are gone (they live in the left rail now).
    expect(screen.queryByRole('navigation', { name: /^view$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /plan views/i })).not.toBeInTheDocument();
  });

  it('renders the health cluster and no longer carries the relocated affordances (#1680)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByTestId('health-cluster')).toBeInTheDocument();
    // Customize-views (→ rail) and the current-sprint jump (→ health popover) left
    // the bar's right cluster in #1680. The methodology tag also left for the rail
    // subtitle, but only while the rail is expanded — this test's default
    // `sidebarCollapsed: false` state is exactly that, so the bar's restored
    // `MethodologyIndicator` (#1907) correctly renders nothing here too; see the
    // dedicated `MethodologyIndicator` describe block below for the collapsed case.
    expect(screen.queryByRole('button', { name: 'Customize views' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /current sprint/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace/i)).not.toBeInTheDocument();
  });

  describe('MethodologyIndicator wiring (issue #1907)', () => {
    it('shows the always-visible methodology badge while the rail is collapsed', () => {
      useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: false });
      renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      expect(screen.getByRole('img', { name: 'Hybrid workspace' })).toHaveTextContent('HY');
    });

    it('hides the bar badge once the rail is expanded, so the rail subtitle is the sole signal', () => {
      useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
      renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
      expect(screen.queryByRole('img', { name: /workspace$/i })).not.toBeInTheDocument();
    });
  });

  it('renders hamburger + account menu', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /open sidebar/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /account/i }).length).toBeGreaterThan(0);
  });

  it('calls onHamburgerClick when the hamburger is clicked', async () => {
    const user = userEvent.setup();
    const onHamburgerClick = vi.fn();
    renderWithRouter(<TopBar onHamburgerClick={onHamburgerClick} />);
    await user.click(screen.getByRole('button', { name: /open sidebar/i }));
    expect(onHamburgerClick).toHaveBeenCalledOnce();
  });

  // --- presence (absorbed from the old ContextBar, ADR-0127/0134) ---

  it('shows presence avatars on a project route, excluding self', () => {
    currentUser = { id: 'me' };
    presenceUsers = [
      { user_id: 'me', display_name: 'Me Myself' },
      { user_id: 'u-alice', display_name: 'Alice Smith' },
    ];
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Disambiguate from the SyncStatusBadge's own aria-live status region (#374)
    // by the presence accessible name.
    const presence = screen.getByRole('status', { name: /viewing|Alice Smith/ });
    expect(presence).toHaveAccessibleName(/Alice Smith/);
    expect(presence).not.toHaveAccessibleName(/Me Myself/);
  });

  // --- rail re-open toggle (absorbed from the old ContextBar, ADR-0127) ---

  it('toggles the rail and reflects state via aria-expanded', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Hide navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Show navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
