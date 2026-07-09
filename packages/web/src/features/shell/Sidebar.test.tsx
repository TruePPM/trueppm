import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { useShellStore } from '@/stores/shellStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { Sidebar } from './Sidebar';

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    data: [
      // Real, server-mapped health + open-task count (#960) — the dot colors and
      // the count badge render from data, not a hardcoded 'unknown'.
      {
        id: 'p1',
        name: 'Alpha Platform',
        programId: 'prog1',
        healthState: 'at-risk',
        openTaskCount: 7,
        colorDot: '#3E8C6D',
      },
      {
        id: 'p2',
        name: 'Beta Migration',
        programId: 'prog1',
        healthState: 'on-track',
        openTaskCount: 0,
        colorDot: '#E8A020',
      },
      {
        id: 'p3',
        name: 'Standalone Site',
        programId: null,
        healthState: 'unknown',
        openTaskCount: 4,
        colorDot: '#B91C1C',
      },
    ],
  }),
}));
vi.mock('@/hooks/usePrograms', () => ({
  usePrograms: () => ({ data: [{ id: 'prog1', name: 'Artemis', code: 'ART', color: null }] }),
}));
vi.mock('@/hooks/useMyWork', () => ({
  useMyWork: () => ({ data: { pages: [{ due_today_count: 3 }] } }),
}));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(() => ({
    user: {
      initials: 'AK',
      display_name: 'Anika K.',
      can_access_admin_settings: true,
      hidden_views: [],
      role_context: 'unified',
    },
  })),
}));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ edition: 'community' }) }));
// Default: off a project. Tier-2 tests override to a project id.
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: vi.fn(() => undefined) }));
// Default: a HYBRID project with a program. Methodology tests override per-case.
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: {
      id: 'p1',
      name: 'Alpha Platform',
      program: 'prog1',
      program_detail: { id: 'prog1', name: 'Artemis' },
      health: 'AT_RISK',
      methodology: 'HYBRID',
      effective_methodology: 'HYBRID',
    },
    isLoading: false,
    error: null,
  })),
}));
// Default: SCHEDULER so the Team view is visible. Role-gate test overrides.
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(() => ({ role: 200, isLoading: false })),
}));
vi.mock('./NewProjectModal', () => ({ NewProjectModal: () => null }));
vi.mock('@/features/programs/NewProgramModal', () => ({ NewProgramModal: () => null }));
vi.mock('@/components/import/ImportProjectModal', () => ({ ImportProjectModal: () => null }));
// The relocated Customize-views control (#1680) owns its own data/mutation hooks and
// is covered by ViewsMenu.test; stub it to a labelled button so these structural
// tests assert only its mount point (and avoid needing a QueryClient here).
vi.mock('./ViewsMenu', () => ({
  ViewsMenu: () => <button type="button" aria-label="Customize views" />,
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;
const mockUseRole = useCurrentUserRole as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;

function renderRail(props = {}) {
  return render(
    <MemoryRouter>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

const HYBRID_PROJECT = {
  id: 'p1',
  name: 'Alpha Platform',
  program: 'prog1',
  program_detail: { id: 'prog1', name: 'Artemis' },
  health: 'AT_RISK',
  methodology: 'HYBRID',
  effective_methodology: 'HYBRID',
};

const DEFAULT_USER = {
  user: {
    initials: 'AK',
    display_name: 'Anika K.',
    can_access_admin_settings: true,
    hidden_views: [],
    role_context: 'unified',
  },
};

beforeEach(() => {
  localStorage.clear();
  useShellStore.setState({
    sidebarCollapsed: false,
    sidebarUserControlled: false,
    pinnedProjectIds: [],
    pinnedProgramIds: [],
    expandedProgramIds: [],
  });
  useCommandPaletteStore.setState({ open: false });
  mockUseProjectId.mockReturnValue(undefined);
  mockUseProject.mockReturnValue({ data: HYBRID_PROJECT, isLoading: false, error: null });
  mockUseRole.mockReturnValue({ role: 200, isLoading: false });
  mockUseCurrentUser.mockReturnValue(DEFAULT_USER);
});

describe('Sidebar rail — Tier 1 "You"', () => {
  it('renders the brand and the identity + personal destinations in the You card', () => {
    renderRail();
    expect(screen.getByText('True')).toBeInTheDocument();
    expect(screen.getByText('PPM')).toBeInTheDocument();
    // Identity appears in both the You card and the footer — assert at least one.
    expect(screen.getAllByText('Anika K.').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /My Work, 3 due today/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Timesheet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
  });
});

describe('Sidebar footer — identity + settings gear', () => {
  it('routes the gear to the settings hub deterministically, even for a non-admin (#1738)', () => {
    // The gear must NOT branch to /me/settings/notifications by role — an
    // identical control never changes destination. It always opens the hub;
    // RequireAdminSettings redirects a non-admin on to their reachable scope.
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: false },
    });
    renderRail();
    const gear = screen.getByRole('link', { name: 'Settings' });
    expect(gear).toHaveAttribute('href', '/settings');
  });

  it('shows identity as a name-only "Signed in" label, not a tappable avatar (#1737)', () => {
    renderRail();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getAllByText('Anika K.').length).toBeGreaterThan(0);
  });
});

describe('Sidebar rail — Tier 3 "Jump"', () => {
  it('opens the command palette from the ⌘K trigger', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/i }));
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('hosts Organization + Programs behind the Browse switcher (closed by default)', () => {
    renderRail();
    // The Organization group is not in the a11y tree until the switcher opens.
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Programs' })).toHaveAttribute('href', '/programs');
    // Community edition: the cross-program Portfolio rollup renders NOTHING on the
    // OSS daily path (rule 231 / ADR-0266, #1677) — it is an empty
    // `nav.portfolio_section` slot, not a padlocked row; discovery moves to /programs.
    expect(screen.queryByRole('button', { name: /Portfolio rollup/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Portfolio rollup/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Portfolio rollup')).not.toBeInTheDocument();
  });

  it('does not use the "Switch project" accessible name (avoids the TopBar switcher collision)', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: /Switch project/ })).not.toBeInTheDocument();
  });

  it('closes the Browse switcher on Escape and returns focus to the trigger', () => {
    renderRail();
    const trigger = screen.getByRole('button', { name: 'Browse projects and programs' });
    fireEvent.click(trigger);
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('expands a program inside the switcher to reveal its projects', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    expect(screen.queryByRole('button', { name: /Alpha Platform/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    expect(
      screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta Migration, on track/ })).toBeInTheDocument();
  });

  it('offers a pin toggle on the program header that updates the store (#1682)', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    const pin = screen.getByRole('button', { name: 'Pin Artemis' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pin);
    expect(useShellStore.getState().pinnedProgramIds).toEqual(['prog1']);
    // Once pinned, the program shows both in the switcher header and in the
    // Pinned band — every instance reads as pressed ("Unpin Artemis").
    const unpins = screen.getAllByRole('button', { name: 'Unpin Artemis' });
    expect(unpins.length).toBeGreaterThan(0);
    for (const btn of unpins) expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows standalone (no-program) projects inside the switcher', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Standalone Site, health unknown, 4 open tasks/ }),
    ).toBeInTheDocument();
  });
});

describe('Sidebar rail — Tier 2 off-project (pinned list)', () => {
  it('shows a pinned band, not a "This project" view band', () => {
    useShellStore.setState({ pinnedProjectIds: ['p1'] });
    renderRail();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.queryByText('This project')).not.toBeInTheDocument();
    // No view groups off a project.
    expect(screen.queryByRole('group', { name: 'Track views' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }),
    ).toBeInTheDocument();
  });

  it('lists pinned programs above pinned projects in the Pinned band (#1682)', () => {
    useShellStore.setState({ pinnedProgramIds: ['prog1'], pinnedProjectIds: ['p1'] });
    renderRail();
    // The pinned program is a jump-link with an "Unpin Artemis" toggle...
    expect(screen.getByRole('button', { name: 'Unpin Artemis' })).toBeInTheDocument();
    // ...and the pinned project keeps its own toggle.
    expect(screen.getByRole('button', { name: 'Unpin Alpha Platform' })).toBeInTheDocument();
    // Program renders before project in the DOM (programs-first ordering).
    const band = screen.getByText('Pinned').closest('nav')!;
    const html = band.innerHTML;
    expect(html.indexOf('Unpin Artemis')).toBeLessThan(html.indexOf('Unpin Alpha Platform'));
  });

  it('shows a calm empty state when nothing is pinned (never a blank band)', () => {
    renderRail();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Pin a program or project for quick access.',
    );
  });
});

describe('Sidebar rail — Tier 2 "This project" (grouped views)', () => {
  beforeEach(() => {
    mockUseProjectId.mockReturnValue('p1');
  });

  it('renders the project header card + ALL HYBRID grouped views, incl. Activity + Assets', () => {
    renderRail();
    expect(screen.getByText('This project')).toBeInTheDocument();
    // Header card: program · methodology subtitle + a health circle carrying the word.
    expect(screen.getByText('Artemis')).toBeInTheDocument();
    expect(screen.getByText('Hybrid workspace')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'at risk' })).toBeInTheDocument();
    // The Customize-views control now lives here in the rail band (#1680).
    expect(screen.getByRole('button', { name: 'Customize views' })).toBeInTheDocument();
    // Post-mockup regression guard: Activity (ADR-0201) + Assets (ADR-0215) present.
    expect(screen.getByRole('link', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assets' })).toBeInTheDocument();
    // The rest of the HYBRID set.
    for (const label of [
      'Schedule',
      'Grid',
      'Calendar',
      'Backlog',
      'Sprints',
      'Board',
      'Risks',
      'Reports',
      'Team',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('leads with Overview, linking to the /overview segment (rule 108)', () => {
    renderRail();
    const overview = screen.getByRole('link', { name: 'Overview' });
    expect(overview).toHaveAttribute('href', '/projects/p1/overview');
    // The grouped headers are present with their accessible names (rule 172).
    expect(screen.getByRole('group', { name: 'Plan views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Deliver views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Track views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'People views' })).toBeInTheDocument();
  });

  it('AGILE hides Schedule/Calendar and keeps the DELIVER trio', () => {
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, effective_methodology: 'AGILE' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Calendar' })).not.toBeInTheDocument();
    const deliver = screen.getByRole('group', { name: 'Deliver views' });
    expect(within(deliver).getByRole('link', { name: 'Backlog' })).toBeInTheDocument();
    expect(within(deliver).getByRole('link', { name: 'Sprints' })).toBeInTheDocument();
    expect(within(deliver).getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });

  it('WATERFALL hides Sprints/Backlog and Board falls to TRACK (no DELIVER group)', () => {
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.queryByRole('link', { name: 'Sprints' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backlog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Deliver views' })).not.toBeInTheDocument();
    const track = screen.getByRole('group', { name: 'Track views' });
    expect(within(track).getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });

  it('hides the Team view below Scheduler role (pessimistic gate)', () => {
    mockUseRole.mockReturnValue({ role: 100, isLoading: false }); // MEMBER
    renderRail();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'People views' })).not.toBeInTheDocument();
  });

  it('removes a personally-hidden view from the rail (ADR-0139)', () => {
    mockUseCurrentUser.mockReturnValue({
      user: {
        initials: 'AK',
        display_name: 'Anika K.',
        can_access_admin_settings: true,
        hidden_views: ['schedule'],
        role_context: 'unified',
      },
    });
    renderRail();
    expect(screen.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grid' })).toBeInTheDocument();
  });

  it('drives the set from effective_methodology, not the raw override (rule 196)', () => {
    // Raw AGILE but server-resolved WATERFALL — the WATERFALL set must win.
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, methodology: 'AGILE', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sprints' })).not.toBeInTheDocument();
  });

  it('shows the effective_methodology as the card subtitle, not the raw override (#1680, rule 196)', () => {
    // Raw AGILE but server-resolved WATERFALL — the resolved label must win (the
    // coverage the removed bar `MethodWorkspaceLabel` used to carry).
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, methodology: 'AGILE', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByText('Waterfall workspace')).toBeInTheDocument();
    expect(screen.queryByText('Agile workspace')).not.toBeInTheDocument();
  });
});

describe('Sidebar rail — preserved behaviors', () => {
  it('toggles collapse', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Collapse sidebar/i }));
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
  });

  it('calls onClose on Escape in drawer mode', () => {
    const onClose = vi.fn();
    renderRail({ isDrawer: true, onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('in the drawer the switcher content is inline-expanded (no Browse button)', () => {
    renderRail({ isDrawer: true, onClose: vi.fn() });
    // Drawer expands every tier — Organization/Programs are visible without a toggle.
    expect(
      screen.queryByRole('button', { name: 'Browse projects and programs' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Programs' })).toBeInTheDocument();
  });

  it('scrolls the drawer body as one region so the inlined Programs tree is reachable (#1688)', () => {
    renderRail({ isDrawer: true, onClose: vi.fn() });
    const rail = document.getElementById('primary-nav-rail');
    // The whole tier column (You + views + the inlined browse tree) scrolls as one.
    // Before the fix the browse tree sat in a `shrink-0` band below the only scroll
    // region and overflowed the `overflow-hidden` aside — unreachable on a phone.
    const scroller = screen.getByRole('link', { name: 'Programs' }).closest('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(rail).toContainElement(scroller as HTMLElement);
    // The inner Workspace nav must not own a second, competing scroll region.
    const nav = screen.getByRole('navigation', { name: 'Workspace navigation' });
    expect(nav.className).not.toMatch(/overflow-y-auto/);
  });

  it('keeps the desktop Tier-2 nav as the scroll region and browse behind its popover', () => {
    renderRail(); // desktop, off a project
    const nav = screen.getByRole('navigation', { name: 'Workspace navigation' });
    expect(nav.className).toMatch(/flex-1/);
    expect(nav.className).toMatch(/overflow-y-auto/);
    // Desktop does not inline the browse tree — it opens from the Browse button.
    expect(
      screen.getByRole('button', { name: 'Browse projects and programs' }),
    ).toBeInTheDocument();
  });

  it('fully hides the desktop rail when collapsed — inert + out of the a11y tree (ADR-0127)', () => {
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderRail();
    const rail = document.getElementById('primary-nav-rail');
    expect(rail).toHaveAttribute('aria-hidden', 'true');
    expect(rail).toHaveAttribute('inert');
    // Content leaves the accessibility tree.
    expect(screen.queryByRole('link', { name: /My Work/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Search or jump to/i })).not.toBeInTheDocument();
  });
});
