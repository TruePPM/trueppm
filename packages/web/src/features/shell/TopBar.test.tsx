import { within, screen, fireEvent } from '@testing-library/react';
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
vi.mock('./CurrentSprintButton', () => ({ CurrentSprintButton: () => null }));
vi.mock('@/features/programs/ProgramIdentitySquare', () => ({
  ProgramIdentitySquare: () => <span data-testid="identity-square" aria-hidden="true" />,
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

  it('groups views into PLAN / DELIVER / TRACK / PEOPLE with Board co-located in DELIVER (ADR-0128 §A / ADR-0195 / ADR-0203)', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('group', { name: /plan views/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /deliver views/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /track views/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /people views/i })).toBeInTheDocument();
    const sprint = screen.getByRole('group', { name: /deliver views/i });
    expect(within(sprint).getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });

  it('renders the methodology workspace tag and health cluster', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByText(/hybrid workspace/i)).toBeInTheDocument();
    expect(screen.getByTestId('health-cluster')).toBeInTheDocument();
  });

  it('renders hamburger + user menu', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /open sidebar/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /user menu/i }).length).toBeGreaterThan(0);
  });

  it('calls onHamburgerClick when the hamburger is clicked', async () => {
    const user = userEvent.setup();
    const onHamburgerClick = vi.fn();
    renderWithRouter(<TopBar onHamburgerClick={onHamburgerClick} />);
    await user.click(screen.getByRole('button', { name: /open sidebar/i }));
    expect(onHamburgerClick).toHaveBeenCalledOnce();
  });

  it('marks the Board tab active on the board route', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
    expect(screen.getByRole('link', { name: /Board/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Schedule/i })).not.toHaveAttribute('aria-current');
  });

  // --- ADR-0134: adaptive identity (the breadcrumb absorbed from the old ContextBar) ---

  it('builds Workspace › Program › Project, project as the leaf', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByRole('link', { name: 'Workspace' })).toBeInTheDocument();
    expect(within(crumb).getByRole('link', { name: 'Apollo' })).toHaveAttribute(
      'href',
      '/programs/prog-1/overview',
    );
    expect(within(crumb).getByText('Launch Site')).toHaveAttribute('aria-current', 'page');
  });

  it('adaptive identity: hidden on desktop when the rail is open, shown when collapsed', () => {
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    // Rail open (default): the identity is display:none on md+ (removed from the a11y
    // tree, not aria-hidden) so it never duplicates the rail.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).className).toContain('md:hidden');

    // Collapse the rail via the ≡ toggle: identity becomes visible at all widths (it
    // is now the only wayfinding, and the hidden rail freed the width).
    fireEvent.click(screen.getByRole('button', { name: 'Hide navigation' }));
    const crumbCollapsed = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbCollapsed.className).toContain('block');
    expect(crumbCollapsed.className).not.toContain('md:hidden');
  });

  it('shows the program as the leaf on a program route', () => {
    projectId = undefined;
    projectData = undefined;
    programId = 'prog-1';
    renderWithRouter(<TopBar onHamburgerClick={vi.fn()} />);
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('Apollo')).toHaveAttribute('aria-current', 'page');
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
