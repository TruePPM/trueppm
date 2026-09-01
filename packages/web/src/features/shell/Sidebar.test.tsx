import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { registry } from '@/lib/widget-registry';
import { useShellStore, selectSidebarWidth } from '@/stores/shellStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { Sidebar } from './Sidebar';

// Spy on navigation so post-create / loadDemo / go() route changes are observable
// (MemoryRouter's navigate has no observable output without a matching route).
const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});
// Toast is fired by the pin toggle (info) and the loadDemo failure path (error).
const { toastInfo, toastError } = vi.hoisted(() => ({ toastInfo: vi.fn(), toastError: vi.fn() }));
vi.mock('@/components/Toast', () => ({
  toast: { info: toastInfo, error: toastError, success: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/hooks/useProjects', () => ({ useProjects: vi.fn() }));
vi.mock('@/hooks/usePrograms', () => ({ usePrograms: vi.fn() }));
vi.mock('@/hooks/useProgramSeedIo', () => ({ useLoadSampleProgram: vi.fn() }));
vi.mock('@/hooks/useMyWork', () => ({ useMyWork: vi.fn() }));
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
vi.mock('@/hooks/useEdition', () => ({ useEdition: vi.fn(() => ({ edition: 'community' })) }));
// Default: off a project. Tier-2 tests override to a project id.
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: vi.fn(() => undefined) }));
// Default: off a program. The "This program" tier tests override to a program id.
vi.mock('@/hooks/useProgramId', () => ({ useProgramId: vi.fn(() => undefined) }));

/**
 * Pins are server state as of #2390, so the rail's Pinned band is seeded through
 * the query rather than through `useShellStore`. `mockPinned` is the list
 * `/auth/me/pinned/` would return; `mockTogglePin` records what a click sends.
 */
const mockTogglePin = vi.fn();
let mockPinned: { kind: string; id: string; name: string; code: string | null }[] | undefined = [];
let mockPinsState = { isLoading: false, isError: false };
vi.mock('@/hooks/usePins', () => ({
  usePinned: () => ({ data: mockPinned, ...mockPinsState }),
  useTogglePin: () => ({ mutate: mockTogglePin, isPending: false }),
}));
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
  useCurrentUserRole: vi.fn(() => ({ role: 200, roleLabel: 'Resource Manager', isLoading: false })),
}));
vi.mock('@/hooks/useNotifications', () => ({
  useUnreadNotificationCount: vi.fn(() => ({ count: 0, isLoading: false })),
}));
// The three creation modals are covered by their own suites; here they are
// stubbed to a tiny harness exposing their onCreated/onClose props so the rail's
// post-create navigation callbacks (lines 924-955) can be exercised. They only
// mount when their open flag is set, so the default rail render is unaffected.
vi.mock('./NewProjectModal', () => ({
  NewProjectModal: ({
    onCreated,
    onClose,
  }: {
    onCreated: (id: string) => void;
    onClose: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onCreated('np1')}>
        stub-project-created
      </button>
      <button type="button" onClick={onClose}>
        stub-project-close
      </button>
    </div>
  ),
}));
vi.mock('@/features/programs/NewProgramModal', () => ({
  NewProgramModal: ({
    onCreated,
    onClose,
  }: {
    onCreated: (id: string) => void;
    onClose: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onCreated('npg1')}>
        stub-program-created
      </button>
      <button type="button" onClick={onClose}>
        stub-program-close
      </button>
    </div>
  ),
}));
vi.mock('@/components/import/ImportProjectModal', () => ({
  ImportProjectModal: ({
    onCreated,
    onProgramImported,
    onClose,
  }: {
    onCreated: (id: string) => void;
    onProgramImported: (id: string) => void;
    onClose: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onCreated('imp1')}>
        stub-import-project
      </button>
      <button type="button" onClick={() => onProgramImported('impg1')}>
        stub-import-program
      </button>
      <button type="button" onClick={onClose}>
        stub-import-close
      </button>
    </div>
  ),
}));
// The relocated Customize-views control (#1680) owns its own data/mutation hooks and
// is covered by ViewsMenu.test; stub it to a labelled button so these structural
// tests assert only its mount point (and avoid needing a QueryClient here).
vi.mock('./ViewsMenu', () => ({
  ViewsMenu: () => <button type="button" aria-label="Customize views" />,
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUnreadNotificationCount } from '@/hooks/useNotifications';
import { useProjects } from '@/hooks/useProjects';
import { usePrograms } from '@/hooks/usePrograms';
import { useMyWork } from '@/hooks/useMyWork';
import { useEdition } from '@/hooks/useEdition';
import { useLoadSampleProgram } from '@/hooks/useProgramSeedIo';
import type { LoadSampleResult } from '@/hooks/useProgramSeedIo';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProgramId = useProgramId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;
const mockUseRole = useCurrentUserRole as ReturnType<typeof vi.fn>;
const mockUseCurrentUser = useCurrentUser as ReturnType<typeof vi.fn>;
const mockUseUnreadCount = useUnreadNotificationCount as ReturnType<typeof vi.fn>;
const mockUseProjects = useProjects as ReturnType<typeof vi.fn>;
const mockUsePrograms = usePrograms as ReturnType<typeof vi.fn>;
const mockUseMyWork = useMyWork as ReturnType<typeof vi.fn>;
const mockUseEdition = useEdition as ReturnType<typeof vi.fn>;
const mockUseLoadSample = useLoadSampleProgram as ReturnType<typeof vi.fn>;

// Default project/program datasets. Individual tests override these to exercise
// empty, orphan, critical-health, overflow, and single-open-task branches.
const DEFAULT_PROJECTS = [
  // Real, server-mapped health + open-task count (#960).
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
];
const DEFAULT_PROGRAMS = [{ id: 'prog1', name: 'Artemis', code: 'ART', color: null }];
// The mutation's `mutate(sample, options)` shape as the sidebar consumes it: the
// success callback only reads `program.id` alongside the landing fields, so the
// mock types `program` as the structural subset the component actually touches.
type LoadSampleMutateOptions = {
  onSuccess: (result: Omit<LoadSampleResult, 'program'> & { program: { id: string } }) => void;
  onError: (error: Error) => void;
};
const loadSampleMutate =
  vi.fn<(sample: string | undefined, options: LoadSampleMutateOptions) => void>();

function renderRail(props = {}) {
  return render(
    <MemoryRouter>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

/** Same rail, mounted at a specific route so NavLink active states resolve. */
function renderRailAt(path: string, props = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

// The cross-program Portfolio rollup renders through an extension-point slot the
// enterprise module registers against (rule 231 / ADR-0266); register a stand-in
// once so the OSS rail's empty-slot mapping is exercised.
registry.register('nav.portfolio_section', {
  id: 'test-portfolio-slot',
  priority: 10,
  component: () => <div>ee-portfolio-slot</div>,
});

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
    expandedProgramIds: [],
  });
  mockPinned = [];
  mockPinsState = { isLoading: false, isError: false };
  mockTogglePin.mockClear();
  useCommandPaletteStore.setState({ open: false });
  mockUseProjectId.mockReturnValue(undefined);
  mockUseProgramId.mockReturnValue(undefined);
  mockUseProject.mockReturnValue({ data: HYBRID_PROJECT, isLoading: false, error: null });
  mockUseRole.mockReturnValue({ role: 200, roleLabel: 'Resource Manager', isLoading: false });
  mockUseCurrentUser.mockReturnValue(DEFAULT_USER);
  mockUseUnreadCount.mockReturnValue({ count: 0, isLoading: false });
  mockUseProjects.mockReturnValue({ data: DEFAULT_PROJECTS, count: undefined });
  mockUsePrograms.mockReturnValue({ data: DEFAULT_PROGRAMS });
  mockUseMyWork.mockReturnValue({ data: { pages: [{ due_today_count: 3 }] } });
  mockUseEdition.mockReturnValue({ edition: 'community' });
  loadSampleMutate.mockReset();
  mockUseLoadSample.mockReturnValue({ mutate: loadSampleMutate, isPending: false });
  navigateSpy.mockReset();
  toastInfo.mockReset();
  toastError.mockReset();
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
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('shows the role label under the name, sourced from useCurrentUserRole (#1919)', () => {
    mockUseProjectId.mockReturnValue('p1');
    mockUseRole.mockReturnValue({ role: 300, roleLabel: 'Project Manager', isLoading: false });
    renderRail();
    expect(screen.getByText('Project Manager')).toBeInTheDocument();
  });

  it('omits the role line off a project, where useCurrentUserRole resolves to null (#1919)', () => {
    mockUseProjectId.mockReturnValue(undefined);
    mockUseRole.mockReturnValue({ role: null, roleLabel: null, isLoading: true });
    renderRail();
    expect(screen.queryByText('Project Manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Resource Manager')).not.toBeInTheDocument();
  });

  it('shows an unread-count badge on the Notifications row (#1919)', () => {
    mockUseUnreadCount.mockReturnValue({ count: 5, isLoading: false });
    renderRail();
    expect(screen.getByRole('link', { name: 'Notifications, 5 unread' })).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('hides the Notifications badge at zero unread (#1919)', () => {
    mockUseUnreadCount.mockReturnValue({ count: 0, isLoading: false });
    renderRail();
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('caps the Notifications badge display at 99+ (#1919)', () => {
    mockUseUnreadCount.mockReturnValue({ count: 150, isLoading: false });
    renderRail();
    expect(screen.getByRole('link', { name: 'Notifications, 150 unread' })).toBeInTheDocument();
    expect(screen.getByText('99+')).toBeInTheDocument();
  });
});

describe('Sidebar footer — identity + settings gear', () => {
  it('routes the gear to personal settings for a non-admin — never a dead end (#1793/#2298)', () => {
    // The gear is role-aware (#2298): a non-admin (no workspace_role) lands on
    // their own settings, which every role can reach — never the workspace
    // `/settings` hub RequireAdminSettings would bounce them from (#1738/#2033).
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: false },
    });
    renderRail();
    const gear = screen.getByRole('link', { name: 'Personal settings' });
    expect(gear).toHaveAttribute('href', '/me/settings/general');
  });

  it('routes the gear to workspace settings for a workspace admin (#2298)', () => {
    // A workspace admin (workspace_role >= WORKSPACE_ADMIN_ROLE 300) gets a
    // persistent one-click route to the workspace hub, and the tooltip/label
    // names the destination so the icon is unambiguous.
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, workspace_role: 300 },
    });
    renderRail();
    const gear = screen.getByRole('link', { name: 'Workspace settings' });
    expect(gear).toHaveAttribute('href', '/settings');
    expect(gear).toHaveAttribute('title', 'Workspace settings');
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

  it('closes the switcher when a project is selected — close-on-select (#1964)', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }));
    // Selecting a destination is terminal — the popover dismisses itself.
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
  });

  it('closes the switcher when an org destination (Programs) is selected (#1964)', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    fireEvent.click(screen.getByRole('link', { name: 'Programs' }));
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
  });

  it('keeps the switcher open when a program is expanded — disclosure is not navigation (#1964)', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    // Drilling into a program to find a project must NOT dismiss the switcher.
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }),
    ).toBeInTheDocument();
  });

  it('offers a pin toggle on the program header that sends the pin (#1682, #2390)', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
    const pin = screen.getByRole('button', { name: 'Pin Artemis' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pin);
    // The toggle now writes through the API, not the shell store.
    expect(mockTogglePin).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'program', id: 'prog1', next: true }),
      expect.anything(),
    );
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
    mockPinned = [{ kind: 'project', id: 'p1', name: 'Alpha Platform', code: null }];
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
    mockPinned = [
      { kind: 'program', id: 'prog1', name: 'Artemis', code: 'ART' },
      { kind: 'project', id: 'p1', name: 'Alpha Platform', code: null },
    ];
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
      'Pin a project from its Overview, or a program from the Programs list.',
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
    expect(screen.getByText('Hybrid methodology')).toBeInTheDocument();
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

  it('leads TRACK with Dashboard, still linking to the /overview segment (rule 108)', () => {
    renderRail();
    // The label is "Dashboard" (ADR-0942 §7) but the ROUTE SEGMENT is untouched — a
    // rename that moved the URL would break every bookmark and deep link in the wild.
    const dashboard = screen.getByRole('link', { name: 'Dashboard' });
    expect(dashboard).toHaveAttribute('href', '/projects/p1/overview');
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    // The band headers are present with their accessible names (rule 172).
    expect(screen.getByRole('group', { name: 'Plan views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Deliver views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Track views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Workspace views' })).toBeInTheDocument();
    // PEOPLE is retired (ADR-0942 §5) — its fourteen-month bet on a second
    // people-surface was falsified, and Team moved beside Settings.
    expect(screen.queryByRole('group', { name: 'People views' })).not.toBeInTheDocument();
    // Dashboard leads TRACK; Today follows it (ADR-0942 §8).
    const track = screen.getByRole('group', { name: 'Track views' });
    const trackLinks = within(track).getAllByRole('link');
    expect(trackLinks[0]).toHaveAccessibleName('Dashboard');
    expect(trackLinks[1]).toHaveAccessibleName('Today');
  });

  it('ends the rail at the WORKSPACE scope band — Team then Settings (ADR-0942)', () => {
    renderRail();
    const workspace = screen.getByRole('group', { name: 'Workspace views' });
    expect(within(workspace).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Team',
      'Settings',
    ]);
    expect(within(workspace).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/projects/p1/settings',
    );
    // Settings is a band member now, not a loose trailing row outside every landmark.
    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(settings.closest('[role="group"]')).toBe(workspace);
    // The scope band is LAST in the nav, and its position is `mt-auto` — a function of
    // the rail's height, not of how many bands sit above it (ADR-0942 §2).
    const nav = screen.getByRole('navigation', { name: 'View' });
    const bands = within(nav).getAllByRole('group');
    expect(bands[bands.length - 1]).toBe(workspace);
    expect(workspace.className).toContain('mt-auto');
  });

  it('draws the scope band with a rule and a raised ground, never with dimming', () => {
    // ADR-0942 §2/§11: the distinction is carried by the CONTAINER. Contrast, size,
    // weight and opacity each read as "less important" in DS v1.0 and three of them read
    // as "unavailable" — and a self-hoster lives in Settings in week one. The full-bleed
    // rule is the rail's only rule, so it means exactly one thing.
    renderRail();
    const workspace = screen.getByRole('group', { name: 'Workspace views' });
    expect(workspace.className).toContain('border-t');
    // The CHROME ramp, not the neutral one. ADR-0942 §11's table originally named
    // `neutral-*`; its dated correction records why that was wrong — the rail is painted
    // `chrome-surface`, and `neutral-surface-raised` on it measures 1.01:1 in light theme
    // (no lift at all) while reading as a real lift in dark, so the defect would have been
    // invisible to a dark-mode screenshot. `chrome-surface-raised` is 1.10:1 light /
    // 1.14:1 dark. See packages/web/CLAUDE.md rule 365 — and note that this assertion can
    // only prove the token was TYPED, never that the surface lifts.
    expect(workspace.className).toContain('border-chrome-border/25');
    expect(workspace.className).toContain('bg-chrome-surface-raised');
    expect(workspace.className).toContain('-mx-2'); // full-bleed past the rail's 8px inset
    expect(workspace.className).not.toContain('neutral-text-disabled');
    expect(workspace.className).not.toContain('opacity-');
    // Its rows are the same rows as a verb band's — same type, weight, colour, height
    // and active-state vocabulary (ADR-0942 §2). The ONE permitted difference is the
    // focus ring's offset colour: that offset is a 1px gap painted in a literal colour,
    // so on the raised ground it has to be the raised token or the halo shows a seam of
    // the rail's ground (rule 365). Compared with that one class normalized away, rather
    // than by listing the classes that must match — a whitelist would silently stop
    // covering anything added to `rowClass` later.
    const plan = screen.getByRole('group', { name: 'Plan views' });
    const planRow = within(plan).getByRole('link', { name: 'Grid' });
    const scopeRow = within(workspace).getByRole('link', { name: 'Settings' });
    const normalizeRingOffset = (cls: string) =>
      cls.replace('focus:ring-offset-chrome-surface-raised', 'focus:ring-offset-chrome-surface');
    expect(normalizeRingOffset(scopeRow.className)).toBe(normalizeRingOffset(planRow.className));
    // …and the difference is exactly that, not an accidental extra class.
    expect(scopeRow.className).toContain('focus:ring-offset-chrome-surface-raised');
    expect(planRow.className).toContain('focus:ring-offset-chrome-surface');
    expect(planRow.className).not.toContain('focus:ring-offset-chrome-surface-raised');
  });

  it('hides the Settings row from a non-admin — RequireAdminSettings would bounce them (#2147)', () => {
    // `/projects/:id/settings` redirects a user who is admin nowhere to their
    // personal notification prefs; the row must not lead there for them.
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: false },
    });
    renderRail();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    // The rest of the project views still render — only Settings is gated. The WORKSPACE
    // band survives on Team alone (a scope band renders with either member, ADR-0942 §2).
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
    const workspace = screen.getByRole('group', { name: 'Workspace views' });
    expect(within(workspace).getAllByRole('link').map((l) => l.textContent)).toEqual(['Team']);
  });

  it('drops the whole WORKSPACE band — rule and ground included — when neither member survives', () => {
    // A Member below Scheduler who also cannot reach project Settings. The empty-band
    // rule (ADR-0128 §A, applied unchanged by ADR-0942 §2) must remove the container, not
    // leave a bare rule and a raised strip with nothing in it.
    mockUseRole.mockReturnValue({ role: 100, isLoading: false }); // MEMBER
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: false },
    });
    renderRail();
    expect(screen.queryByRole('group', { name: 'Workspace views' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    // The verb bands are untouched — the rail is not empty, it just ends at TRACK.
    expect(screen.getByRole('group', { name: 'Track views' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('keeps the Settings row visible while the role signal is still loading (#2147)', () => {
    // Strict `!== false`: an absent/loading `can_access_admin_settings` falls
    // through so an admin never sees a flash-hidden row (mirrors the guard).
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: undefined },
    });
    renderRail();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
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
    // The WORKSPACE band stays — Settings is still reachable for this user.
    const workspace = screen.getByRole('group', { name: 'Workspace views' });
    expect(within(workspace).getAllByRole('link').map((l) => l.textContent)).toEqual(['Settings']);
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
    // coverage the pre-#1680 bar `MethodWorkspaceLabel` used to carry, now shared
    // with the restored bar `MethodologyIndicator`, #1907).
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, methodology: 'AGILE', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByText('Waterfall methodology')).toBeInTheDocument();
    expect(screen.queryByText('Agile methodology')).not.toBeInTheDocument();
  });

  // #2619: the subtitle no longer says "workspace" — that wording described the
  // workspace's methodology when the value shown is this project's own resolved
  // preset. It now names the fact the client can verify: whether the project
  // currently matches the workspace default.
  // The qualifier lives on the line's `title`, not in the visible string: the full
  // phrase is wider than the rail and used to overflow the card and be clipped
  // mid-word by the rail's `overflow-hidden`.
  it('appends "(workspace default)" only when inherited_methodology matches effective_methodology (#2619)', () => {
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, inherited_methodology: 'HYBRID' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByText('Hybrid methodology')).toBeInTheDocument();
    expect(
      screen.getByTitle('Artemis · Hybrid methodology (workspace default)'),
    ).toBeInTheDocument();
  });

  it('omits the qualifier when the project overrides the workspace default (#2619)', () => {
    mockUseProject.mockReturnValue({
      data: {
        ...HYBRID_PROJECT,
        methodology: 'WATERFALL',
        effective_methodology: 'WATERFALL',
        inherited_methodology: 'HYBRID',
      },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByText('Waterfall methodology')).toBeInTheDocument();
    expect(screen.queryByText(/workspace default/)).not.toBeInTheDocument();
  });
});

describe('Sidebar rail — Tier 2 "This program" (#1920)', () => {
  // The program analog of "This project". It is the sole nav home for the program
  // views after ProgramTabs was removed from the TopBar — the rail must list every
  // one, or backlog/schedule/resources/members/assets become URL-only dead ends.
  const PROGRAM_VIEWS = [
    'Overview',
    'Backlog',
    'Labels',
    'Projects',
    'Schedule',
    'Resources',
    'Members',
    'Assets',
    'Settings',
  ] as const;

  beforeEach(() => {
    mockUseProgramId.mockReturnValue('prog1');
  });

  it('renders the "This program" header card + ALL nine program-view links', () => {
    renderRail();
    expect(screen.getByText('This program')).toBeInTheDocument();
    // Header card shows the active program's name (from usePrograms).
    expect(screen.getByText('Artemis')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Program' });
    for (const label of PROGRAM_VIEWS) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('links each program view to its /programs/:id/:view segment', () => {
    renderRail();
    const nav = screen.getByRole('navigation', { name: 'Program' });
    expect(within(nav).getByRole('link', { name: 'Backlog' })).toHaveAttribute(
      'href',
      '/programs/prog1/backlog',
    );
    expect(within(nav).getByRole('link', { name: 'Schedule' })).toHaveAttribute(
      'href',
      '/programs/prog1/schedule',
    );
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/programs/prog1/settings',
    );
  });

  it('does not render the "This program" tier off a program route', () => {
    mockUseProgramId.mockReturnValue(undefined);
    renderRail();
    expect(screen.queryByText('This program')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Program' })).not.toBeInTheDocument();
  });

  it('a project context takes precedence over a program context (mutually exclusive URLs)', () => {
    // Defense-in-depth: a URL is either /projects/:id or /programs/:id, never both,
    // but if both hooks somehow resolved the project tier must win (it is checked
    // first) so the rail never double-renders.
    mockUseProjectId.mockReturnValue('p1');
    mockUseProgramId.mockReturnValue('prog1');
    renderRail();
    expect(screen.getByText('This project')).toBeInTheDocument();
    expect(screen.queryByText('This program')).not.toBeInTheDocument();
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

  // ── The collapsed-rail contract, REVERSED by ADR-0979 ────────────────────
  //
  // These replace a single test that asserted the rail was `inert`,
  // `aria-hidden`, and absent from the a11y tree when collapsed (ADR-0127
  // Decision D's 0px hide). The old assertions are written out below rather than
  // deleted, because ADR-0979 §5 is explicit that this is a CHANGE of contract
  // and not a strict improvement: "collapsed" stops meaning "not there", and the
  // tab order now grows by the rail's item count in a state where it previously
  // grew by zero. A reader bisecting to here should find the reversal argued,
  // not discover it as a silent flip.
  //
  // The ADR also names this as the risk most likely to be got wrong and least
  // likely to be caught: the old tests keep PASSING against a wrong
  // implementation, because "is not in the a11y tree" is satisfied by a rail
  // that renders nothing at all.

  it('keeps the collapsed rail in the a11y tree — no inert, no aria-hidden (ADR-0979 §5)', () => {
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderRail();
    const rail = document.getElementById('primary-nav-rail');
    // WAS: expect(rail).toHaveAttribute('aria-hidden', 'true');
    // WAS: expect(rail).toHaveAttribute('inert');
    expect(rail).not.toHaveAttribute('aria-hidden');
    expect(rail).not.toHaveAttribute('inert');
    expect(rail).toHaveAttribute('data-collapsed');
  });

  it('keeps every collapsed row reachable AND named — the icons are not mystery meat', () => {
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderRail();
    // WAS: expect(screen.queryByRole('link', { name: /My Work/ })).not.toBeInTheDocument();
    //
    // The label is `sr-only`, not dropped — that is what makes screen-reader
    // traversal identical in both states. Asserting the accessible NAME (rather
    // than merely that some link exists) is the whole point: a 64px rail of
    // unnamed icons would satisfy "reachable" and fail WCAG 4.1.2, which is the
    // combination ADR-0979 rejects outright.
    // `exact` matters here: the brand link is named "TruePPM — My Work", so a
    // substring match on /My Work/ resolves to two elements and the assertion
    // stops being about the Tier-1 row it was written for.
    expect(screen.getByRole('link', { name: 'Timesheet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Assets' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    // And the COUNT survives collapse, on the accessible name rather than only
    // as a corner pill. "Is anything waiting for me" is one of the three
    // questions ADR-0979 §2 says the icon rail exists to answer, and it is the
    // one a screen-reader user would lose if the badge were merely visual.
    expect(
      screen.getByRole('link', { name: 'My Work, 3 due today' }),
    ).toBeInTheDocument();
  });

  it('renders a screen reader the SAME rows collapsed and expanded (ADR-0979 §5)', () => {
    // The identical-traversal property, asserted as an identity rather than as a
    // list anyone has to keep in sync by hand.
    const names = () =>
      screen
        .getAllByRole('link')
        .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '');

    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: true });
    const expanded = renderRail();
    const expandedNames = names();
    expanded.unmount();

    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderRail();

    // Tier 3's Browse switcher is a BUTTON, not a link, so it does not appear in
    // either list; the tiers that differ collapsed are covered by their own tests
    // below. Every link the expanded rail offers is offered collapsed too.
    for (const name of expandedNames) {
      expect(names()).toContain(name);
    }
  });

  it('names the Tier-2 view rows at 64px, where the LABEL is the accessible name', () => {
    // Tier-1's rows carry an explicit `aria-label`, so their accessible name
    // survives however the visible label is hidden. The VIEW rows have no
    // `aria-label` — their name IS the span — so this is the tier where the
    // choice of hiding mechanism is load-bearing.
    //
    // Read the class assertion below as the real point, and note what this file
    // CANNOT check: jsdom applies no stylesheet, so `sr-only` and `hidden` are
    // indistinguishable here — both leave the text in the DOM and in the
    // computed accessible name. Mutating `labelClass` to `hidden` leaves this
    // whole suite green, which is measured, not assumed. The behavioral
    // assertion therefore lives in `e2e/sidebar-collapsed-rail.spec.ts`, which
    // reads the label's COMPUTED display in a real browser — and note it has to
    // check that rather than the accessible name, because each row also carries
    // a `title` tooltip and `title` is an accname fallback, so the name resolves
    // either way. `title` carrying it alone is the weak contract we are avoiding.
    //
    // This is exactly the failure mode ADR-0979 §Risks names: the tests keep
    // passing against a wrong implementation, so a green run here is evidence
    // about the DOM and not about the accessibility tree.
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    mockUseProjectId.mockReturnValue('p1');
    renderRail();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeInTheDocument();
    // The bands keep their accessible names too, so group traversal is
    // unchanged — only the visible uppercase word goes.
    expect(screen.getByRole('group', { name: 'Plan views' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Workspace views' })).toBeInTheDocument();
    // Pin the MECHANISM, since the behavior is unobservable in jsdom: the label
    // must be clipped (`sr-only`), never `display:none`.
    const label = screen.getByRole('link', { name: 'Schedule' }).querySelector('span');
    expect(label).toHaveClass('sr-only');
    expect(label).not.toHaveClass('hidden');
  });

  it('auto-collapse below lg SHRINKS the rail rather than hiding it (ADR-0979)', () => {
    // The auto-collapse path is the one where losing the rail hurt most — a
    // narrow viewport is exactly when a user needs to keep their bearings — and
    // it is the arm least likely to be exercised by hand. `useAutoCollapseSidebar`
    // needed no change: it sets `sidebarCollapsed` and the width derives.
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 1023px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      renderRail();
      expect(useShellStore.getState().sidebarCollapsed).toBe(true);
      // Shrunk, not gone: still a landmark, still holding its rows.
      expect(document.getElementById('primary-nav-rail')).toBeInTheDocument();
      expect(selectSidebarWidth(useShellStore.getState())).toBe(64);
    } finally {
      // `finally`, not a trailing line: a failed assertion above would otherwise
      // leave every later test in this file running against a stubbed
      // matchMedia, which reports as five unrelated failures in the modal specs.
      window.matchMedia = realMatchMedia;
    }
  });

  it('drops the Jump tier at 64px — its panel is wider than the rail it hangs off', () => {
    // WAS asserted as part of "content leaves the accessibility tree", which
    // conflated two different reasons for absence. This one is a design call
    // (ADR-0979 delegated per-item design at 64px to #3279), not an a11y
    // contract, and it is the ONLY tier that goes away.
    useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: true });
    renderRail();
    expect(screen.queryByRole('button', { name: /Search or jump to/i })).not.toBeInTheDocument();
  });
});

// ── Added coverage (#2235): create/import navigation, empty & overflow states,
//    pinned-band navigation, demo loading, health/role active states, and the
//    project/program tier fallbacks. ──────────────────────────────────────────

function openSwitcher() {
  fireEvent.click(screen.getByRole('button', { name: 'Browse projects and programs' }));
}

describe('Sidebar rail — Tier 3 create / import / overflow actions', () => {
  it('opens the New program modal and navigates to the created program on success', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'New program' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-program-created' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/npg1/projects');
  });

  it('opens the New project modal from the switcher and navigates to the created project', () => {
    renderRail();
    openSwitcher();
    // The switcher's "+ New project" affordance (distinct from the empty-state one).
    fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-project-created' }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/np1/overview');
  });

  it('closes the New project modal without navigating when dismissed', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-project-close' }));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'stub-project-created' })).not.toBeInTheDocument();
  });

  it('imports a single project and lands on its overview', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Import a project from a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-import-project' }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/imp1/overview');
  });

  it('imports a whole program seed and lands on the program overview (ADR-0222)', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Import a project from a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-import-program' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/impg1/overview');
  });

  it('surfaces an overflow cue that opens the palette when the tree is truncated (#1940)', () => {
    mockUseProjects.mockReturnValue({ data: DEFAULT_PROJECTS, count: 50 });
    renderRail();
    openSwitcher();
    const overflow = screen.getByRole('button', {
      name: /Showing 3 of 50 projects — search in ⌘K/,
    });
    fireEvent.click(overflow);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('shows "No projects" under an expanded program that has none', () => {
    mockUsePrograms.mockReturnValue({
      data: [...DEFAULT_PROGRAMS, { id: 'prog2', name: 'Orion', code: 'ORI', color: null }],
    });
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Expand Orion/ }));
    expect(screen.getByText('No projects')).toBeInTheDocument();
  });

  it('navigates to a program overview from its name button in the switcher', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Artemis' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/prog1/overview');
  });

  it('navigates to a project opened from inside an expanded program', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    fireEvent.click(screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/overview');
  });

  it('navigates to a standalone (no-program) project and can pin it from the switcher', () => {
    renderRail();
    openSwitcher();
    fireEvent.click(
      screen.getByRole('button', { name: /Standalone Site, health unknown, 4 open tasks/ }),
    );
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p3/overview');

    // Re-open (navigation dismissed it) and pin the standalone project.
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Standalone Site' }));
    expect(mockTogglePin).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'project', id: 'p3', next: true }),
      expect.anything(),
    );
  });

  it('renders no built-in Portfolio rollup link, in either edition (#2609)', () => {
    // The rail used to hardcode a NavLink to /portfolio behind an
    // `edition === 'enterprise'` check. Nothing in OSS serves that route, and
    // ADR-0029's overlay loader — the thing that would let the enterprise module
    // register the route AND the nav row — does not exist, so on an enterprise
    // deployment the link pointed at a route nothing provides.
    //
    // The nav.portfolio_section slot beside it is the designed replacement: one
    // mechanism that brings the row and its destination together, or neither.
    mockUseEdition.mockReturnValue({ edition: 'enterprise' });
    renderRail();
    openSwitcher();
    expect(screen.queryByRole('link', { name: 'Portfolio rollup' })).not.toBeInTheDocument();
  });
});

describe('Sidebar rail — pinned-band navigation and pin writes', () => {
  it('navigates to a pinned program from the off-project pinned band (#1682)', () => {
    mockPinned = [{ kind: 'program', id: 'prog1', name: 'Artemis', code: 'ART' }];
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Artemis' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/prog1/overview');
  });

  it('navigates to a pinned project from the pinned band', () => {
    mockPinned = [{ kind: 'project', id: 'p1', name: 'Alpha Platform', code: null }];
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/overview');
  });

  it('unpinning a pinned program sends next:false', () => {
    mockPinned = [{ kind: 'program', id: 'prog1', name: 'Artemis', code: 'ART' }];
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Artemis' }));
    expect(mockTogglePin).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'program', id: 'prog1', name: 'Artemis', next: false }),
      expect.anything(),
    );
  });

  it('renders a pinned project whose row is NOT on the loaded project page (#2390)', () => {
    // The pre-#2390 rail resolved pins by id against the loaded project list, so
    // a pin past the page ceiling silently vanished. Identity now comes from the
    // pins endpoint, so the row renders with a neutral dot and no count.
    mockPinned = [{ kind: 'project', id: 'not-on-this-page', name: 'Far Project', code: null }];
    renderRail();
    expect(screen.getByRole('button', { name: /Far Project, health unknown/ })).toBeInTheDocument();
  });

  it('shows a skeleton, not the empty hint, while pins are still loading (#2390)', () => {
    mockPinsState = { isLoading: true, isError: false };
    renderRail();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    // Telling a user with pins that they have none is worse than a placeholder.
    expect(screen.queryByText(/Pin a project from its Overview/)).not.toBeInTheDocument();
  });

  it('surfaces a load failure in the band rather than rendering "no pins" (#2390)', () => {
    mockPinsState = { isLoading: false, isError: true };
    renderRail();
    expect(screen.getByText(/Couldn.t load pins/)).toBeInTheDocument();
  });
});

// ── Branch coverage (#2459): switcher outside-click dismissal, the zero-project
//    first-run CTA and its demo loader, drawer close-on-navigate, active-row
//    states, and the not-yet-loaded fallbacks for every data source. ──────────

describe('Sidebar Browse switcher dismissal', () => {
  it('closes on a pointer press outside the panel', () => {
    renderRail();
    openSwitcher();
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
  });

  it('stays open on a pointer press inside the panel', () => {
    renderRail();
    openSwitcher();
    fireEvent.mouseDown(screen.getByRole('link', { name: 'Resources catalog' }));
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
  });

  it('stays open on a pointer press on its own trigger (the click toggles it)', () => {
    renderRail();
    const trigger = screen.getByRole('button', { name: 'Browse projects and programs' });
    fireEvent.click(trigger);
    fireEvent.mouseDown(trigger);
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
  });

  it('renders the enterprise portfolio slot registration inside the switcher', () => {
    renderRail();
    openSwitcher();
    expect(screen.getByText('ee-portfolio-slot')).toBeInTheDocument();
  });
});

describe('Sidebar zero-project first run (#2034)', () => {
  beforeEach(() => {
    mockUseProjects.mockReturnValue({ data: [], count: 0 });
    mockUsePrograms.mockReturnValue({ data: [] });
  });

  it('offers create + demo instead of the "pin something" advice', () => {
    renderRail();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No projects yet — create one or load a demo.',
    );
    expect(screen.queryByText(/Pin a project from its Overview/)).not.toBeInTheDocument();
  });

  it('opens the New project modal from the empty-state CTA', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
    expect(screen.getByRole('button', { name: 'stub-project-created' })).toBeInTheDocument();
  });

  it('lands the user on the board holding their freshly assigned sprint', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Load a demo' }));
    expect(loadSampleMutate).toHaveBeenCalledTimes(1);

    act(() => {
      loadSampleMutate.mock.calls[0][1].onSuccess({
        program: { id: 'demo-prog' },
        landing_project_id: 'demo-proj',
        sample_key: 'construction',
      });
    });
    expect(navigateSpy).toHaveBeenCalledWith('/projects/demo-proj/board', {
      state: { startExploringSample: 'construction' },
    });
  });

  it('falls back to the program overview when the sample has no landing project', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Load a demo' }));

    act(() => {
      loadSampleMutate.mock.calls[0][1].onSuccess({
        program: { id: 'demo-prog' },
        landing_project_id: null,
        sample_key: 'software',
      });
    });
    expect(navigateSpy).toHaveBeenCalledWith('/programs/demo-prog/overview', {
      state: { startExploringSample: 'software' },
    });
  });

  it('surfaces a toast and stays put when the demo fails to load', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Load a demo' }));

    act(() => {
      loadSampleMutate.mock.calls[0][1].onError(new Error('boom'));
    });
    expect(toastError).toHaveBeenCalledWith("Couldn't load the demo — please try again.");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('disables the demo action while the sample is loading', () => {
    mockUseLoadSample.mockReturnValue({ mutate: loadSampleMutate, isPending: true });
    renderRail();
    const demo = screen.getByRole('button', { name: 'Loading demo…' });
    expect(demo).toBeDisabled();
  });
});

describe('Sidebar drawer close-on-navigate', () => {
  const drawerProps = (onClose: () => void) => ({ isDrawer: true, onClose });

  it('closes the drawer when a personal destination is chosen', () => {
    const onClose = vi.fn();
    renderRail(drawerProps(onClose));
    fireEvent.click(screen.getByRole('link', { name: 'My Work, 3 due today' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the drawer when a project view row is chosen', () => {
    mockUseProjectId.mockReturnValue('p1');
    const onClose = vi.fn();
    renderRail(drawerProps(onClose));
    fireEvent.click(screen.getByRole('link', { name: 'Board' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the drawer when the project Settings row is chosen', () => {
    mockUseProjectId.mockReturnValue('p1');
    const onClose = vi.fn();
    renderRail(drawerProps(onClose));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the drawer when a program view row is chosen', () => {
    mockUseProgramId.mockReturnValue('prog1');
    const onClose = vi.fn();
    renderRail(drawerProps(onClose));
    const nav = screen.getByRole('navigation', { name: 'Program' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Backlog' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the drawer when the settings gear is chosen', () => {
    const onClose = vi.fn();
    renderRail(drawerProps(onClose));
    fireEvent.click(screen.getByRole('link', { name: 'Personal settings' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the drawer after creating a project, a program, or importing', () => {
    const onClose = vi.fn();
    renderRail(drawerProps(onClose));

    fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-project-created' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'New program' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-program-created' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(navigateSpy).toHaveBeenCalledWith('/programs/npg1/projects');

    fireEvent.click(screen.getByRole('button', { name: 'Import a project from a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-import-project' }));
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Import a project from a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-import-program' }));
    expect(onClose).toHaveBeenCalledTimes(4);
    expect(navigateSpy).toHaveBeenCalledWith('/programs/impg1/overview');
  });

  it('dismisses the New program and Import modals without navigating', () => {
    renderRail();
    openSwitcher();

    fireEvent.click(screen.getByRole('button', { name: 'New program' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-program-close' }));
    expect(screen.queryByRole('button', { name: 'stub-program-created' })).not.toBeInTheDocument();

    // The switcher stayed open — opening a modal is not navigation.
    fireEvent.click(screen.getByRole('button', { name: 'Import a project from a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-import-close' }));
    expect(screen.queryByRole('button', { name: 'stub-import-project' })).not.toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe('Sidebar active-row states', () => {
  it('marks the active personal row in the You card', () => {
    renderRailAt('/me/work');
    expect(screen.getByRole('link', { name: 'My Work, 3 due today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the settings gear active on the workspace settings route', () => {
    mockUseCurrentUser.mockReturnValue({ user: { ...DEFAULT_USER.user, workspace_role: 300 } });
    renderRailAt('/settings');
    expect(screen.getByRole('link', { name: 'Workspace settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the active Organization row inside the switcher', () => {
    renderRailAt('/resources');
    openSwitcher();
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the Programs gateway link active on /programs', () => {
    renderRailAt('/programs');
    openSwitcher();
    expect(screen.getByRole('link', { name: 'Programs' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks the active project view row', () => {
    mockUseProjectId.mockReturnValue('p1');
    renderRailAt('/projects/p1/board');
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('Sidebar health dots and open-task counts', () => {
  it('renders a critical project and pluralizes a single open task correctly', () => {
    mockUseProjects.mockReturnValue({
      data: [
        {
          id: 'c1',
          name: 'Red Project',
          programId: null,
          healthState: 'critical',
          openTaskCount: 1,
        },
        { id: 'c2', name: 'Unknown Project', programId: null, openTaskCount: null },
      ],
      count: undefined,
    });
    renderRail();
    openSwitcher();

    expect(
      screen.getByRole('button', { name: 'Red Project, critical, 1 open task' }),
    ).toBeInTheDocument();
    // No health field at all → the honest hollow dot + "health unknown" wording.
    expect(
      screen.getByRole('button', { name: 'Unknown Project, health unknown' }),
    ).toBeInTheDocument();
  });

  it('renders a pinned project with a zero open-task count without a badge', () => {
    mockPinned = [{ kind: 'project', id: 'p2', name: 'Beta Migration', code: null }];
    renderRail();
    // p2 is on-track with 0 open tasks — the count rides the aria-label only.
    expect(
      screen.getByRole('button', { name: 'Beta Migration, on track, 0 open tasks' }),
    ).toBeInTheDocument();
  });
});

describe('Sidebar pinned items not present in the loaded lists (#2390)', () => {
  it('renders a pinned program from the pin payload alone and still jumps to it', () => {
    mockUsePrograms.mockReturnValue({ data: [] });
    mockPinned = [{ kind: 'program', id: 'ghost', name: 'Ghost Program', code: null }];
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Ghost Program' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/ghost/overview');
  });
});

describe('Sidebar before any data source has loaded', () => {
  beforeEach(() => {
    mockUseProjects.mockReturnValue({ data: undefined, count: undefined });
    mockUsePrograms.mockReturnValue({ data: undefined });
    mockUseMyWork.mockReturnValue({ data: undefined });
    mockPinned = undefined;
  });

  it('renders the rail with no badges and no tree rows', () => {
    renderRail();
    // No due-today count → the plain accessible name, no numeric badge.
    expect(screen.getAllByRole('link', { name: 'My Work' })).toHaveLength(1);
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    openSwitcher();
    expect(screen.queryByRole('button', { name: /Expand/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });

  it('falls back to neutral project-tier copy while the project is still loading', () => {
    mockUseProjectId.mockReturnValue('p1');
    mockUseProject.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderRail();

    expect(screen.getByText('Project')).toBeInTheDocument();
    // No resolved methodology yet → the HYBRID default, and an unknown health dot.
    expect(screen.getByText('Hybrid methodology')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'health unknown' })).toBeInTheDocument();
  });

  it('falls back to neutral program-tier copy while the program list is still loading', () => {
    mockUseProgramId.mockReturnValue('prog1');
    renderRail();
    expect(screen.getByText('Program')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Program' })).toBeInTheDocument();
  });
});

describe('Sidebar dismissal key filtering', () => {
  it('leaves the drawer open for keys other than Escape', () => {
    const onClose = vi.fn();
    renderRail({ isDrawer: true, onClose });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the Browse switcher open for keys other than Escape', () => {
    renderRail();
    openSwitcher();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
  });
});

describe('Sidebar desktop rail never fires the drawer-close callback', () => {
  it('keeps onClose untouched when navigating from the desktop rail', () => {
    const onClose = vi.fn();
    mockUseProjectId.mockReturnValue('p1');
    renderRail({ onClose });

    fireEvent.click(screen.getByRole('link', { name: 'My Work, 3 due today' }));
    fireEvent.click(screen.getByRole('link', { name: 'Board' }));
    fireEvent.click(screen.getByRole('link', { name: 'Personal settings' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps onClose untouched when navigating the program tier on desktop', () => {
    const onClose = vi.fn();
    mockUseProgramId.mockReturnValue('prog1');
    renderRail({ onClose });

    const nav = screen.getByRole('navigation', { name: 'Program' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Backlog' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Sidebar program tree with an unloaded project list', () => {
  beforeEach(() => {
    mockUseProjects.mockReturnValue({ data: undefined, count: 12 });
  });

  it('shows a zero child count, an empty expansion, and an honest overflow cue', () => {
    renderRail();
    openSwitcher();

    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));
    expect(screen.getByText('No projects')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Showing 0 of 12 projects — search in ⌘K/ }),
    ).toBeInTheDocument();
  });
});

describe('Sidebar unannotated rows', () => {
  it('renders a program child with no health field as health unknown', () => {
    mockUseProjects.mockReturnValue({
      data: [{ id: 'k1', name: 'Kid Project', programId: 'prog1', openTaskCount: 2 }],
      count: undefined,
    });
    renderRail();
    openSwitcher();
    fireEvent.click(screen.getByRole('button', { name: /Expand Artemis/ }));

    expect(
      screen.getByRole('button', { name: 'Kid Project, health unknown, 2 open tasks' }),
    ).toBeInTheDocument();
  });

  it('treats an unrecognized project health value as unknown in the project tier', () => {
    mockUseProjectId.mockReturnValue('p1');
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, health: 'RETIRED' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByRole('img', { name: 'health unknown' })).toBeInTheDocument();
  });
});
