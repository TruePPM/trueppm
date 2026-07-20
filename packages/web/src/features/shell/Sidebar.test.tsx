import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { useShellStore } from '@/stores/shellStore';
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
  NewProgramModal: ({ onCreated }: { onCreated: (id: string) => void }) => (
    <button type="button" onClick={() => onCreated('npg1')}>
      stub-program-created
    </button>
  ),
}));
vi.mock('@/components/import/ImportProjectModal', () => ({
  ImportProjectModal: ({
    onCreated,
    onProgramImported,
  }: {
    onCreated: (id: string) => void;
    onProgramImported: (id: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onCreated('imp1')}>
        stub-import-project
      </button>
      <button type="button" onClick={() => onProgramImported('impg1')}>
        stub-import-program
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
  it('routes the gear to personal settings — a real destination for a non-admin (#1793)', () => {
    // The gear under the identity opens the user's own settings, which every
    // role can reach. It must NOT target the workspace `/settings` hub, from
    // which RequireAdminSettings redirects non-admins away (silent dead end).
    // The destination is the same for all roles (#1738) — it never branches.
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: false },
    });
    renderRail();
    const gear = screen.getByRole('link', { name: 'Personal settings' });
    expect(gear).toHaveAttribute('href', '/me/settings/general');
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

  it('trails with Settings, mirroring the program tier (#2045)', () => {
    renderRail();
    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('href', '/projects/p1/settings');
    // It is a standalone trailing row — outside every grouped landmark — so it
    // must not live inside one of the PLAN/DELIVER/TRACK/PEOPLE groups.
    expect(settings.closest('[role="group"]')).toBeNull();
  });

  it('hides the Settings row from a non-admin — RequireAdminSettings would bounce them (#2147)', () => {
    // `/projects/:id/settings` redirects a user who is admin nowhere to their
    // personal notification prefs; the row must not lead there for them.
    mockUseCurrentUser.mockReturnValue({
      user: { ...DEFAULT_USER.user, can_access_admin_settings: false },
    });
    renderRail();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    // The rest of the project views still render — only Settings is gated.
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
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
    // coverage the pre-#1680 bar `MethodWorkspaceLabel` used to carry, now shared
    // with the restored bar `MethodologyIndicator`, #1907).
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

describe('Sidebar rail — Tier 2 "This program" (#1920)', () => {
  // The program analog of "This project". It is the sole nav home for the program
  // views after ProgramTabs was removed from the TopBar — the rail must list every
  // one, or backlog/schedule/resources/members/assets become URL-only dead ends.
  const PROGRAM_VIEWS = [
    'Overview',
    'Backlog',
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

  it('renders the "This program" header card + ALL eight program-view links', () => {
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

// ── Added coverage (#2235): create/import navigation, empty & overflow states,
//    pinned-band navigation, demo loading, health/role active states, and the
//    project/program tier fallbacks. ──────────────────────────────────────────

function renderRailAt(path: string, props = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

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
    expect(useShellStore.getState().pinnedProjectIds).toEqual(['p3']);
    expect(toastInfo).toHaveBeenCalledWith('Pinned Standalone Site');
  });

  it('renders the Portfolio rollup link only under the enterprise edition', () => {
    mockUseEdition.mockReturnValue({ edition: 'enterprise' });
    renderRail();
    openSwitcher();
    expect(screen.getByRole('link', { name: 'Portfolio rollup' })).toHaveAttribute(
      'href',
      '/portfolio',
    );
  });
});

describe('Sidebar rail — pinned-band navigation and pin toasts', () => {
  it('navigates to a pinned program from the off-project pinned band (#1682)', () => {
    useShellStore.setState({ pinnedProgramIds: ['prog1'] });
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Artemis' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/prog1/overview');
  });

  it('navigates to a pinned project from the pinned band', () => {
    useShellStore.setState({ pinnedProjectIds: ['p1'] });
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Alpha Platform, at risk, 7 open tasks/ }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/p1/overview');
  });

  it('unpinning a pinned program toasts "Unpinned" and clears it from the store', () => {
    useShellStore.setState({ pinnedProgramIds: ['prog1'] });
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Artemis' }));
    expect(useShellStore.getState().pinnedProgramIds).toEqual([]);
    expect(toastInfo).toHaveBeenCalledWith('Unpinned Artemis');
  });

  it('pinning a project toasts "Pinned" (pre-toggle state drives the message)', () => {
    useShellStore.setState({ pinnedProjectIds: ['p1'] });
    renderRail();
    // The pinned project's own toggle is currently pressed; unpin it → "Unpinned".
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Alpha Platform' }));
    expect(toastInfo).toHaveBeenCalledWith('Unpinned Alpha Platform');
  });
});

describe('Sidebar rail — zero-project empty state (#2034)', () => {
  beforeEach(() => {
    mockUseProjects.mockReturnValue({ data: [], count: undefined });
    mockUsePrograms.mockReturnValue({ data: [] });
  });

  it('offers create + load-a-demo actions instead of pin advice when there are no projects', () => {
    renderRail();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No projects yet — create one or load a demo.',
    );
    expect(screen.getByRole('button', { name: '+ New project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load a demo' })).toBeInTheDocument();
  });

  it('opens the New project modal from the empty-state CTA', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
    expect(screen.getByRole('button', { name: 'stub-project-created' })).toBeInTheDocument();
  });

  it('loads the demo and lands on the freshly-assigned board on success', () => {
    loadSampleMutate.mockImplementation((_arg, { onSuccess }) =>
      onSuccess({ landing_project_id: 'lp1', program: { id: 'pg9' }, sample_key: 'agile' }),
    );
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Load a demo' }));
    expect(navigateSpy).toHaveBeenCalledWith('/projects/lp1/board', {
      state: { startExploringSample: 'agile' },
    });
  });

  it('falls back to the program overview when the demo has no landing project', () => {
    loadSampleMutate.mockImplementation((_arg, { onSuccess }) =>
      onSuccess({ landing_project_id: null, program: { id: 'pg9' }, sample_key: 'wf' }),
    );
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Load a demo' }));
    expect(navigateSpy).toHaveBeenCalledWith('/programs/pg9/overview', {
      state: { startExploringSample: 'wf' },
    });
  });

  it('toasts an error and does not navigate when the demo fails to load', () => {
    loadSampleMutate.mockImplementation((_arg, { onError }) => onError(new Error('boom')));
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Load a demo' }));
    expect(toastError).toHaveBeenCalledWith("Couldn't load the demo — please try again.");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('shows a disabled "Loading demo…" label while the sample import is pending', () => {
    mockUseLoadSample.mockReturnValue({ mutate: loadSampleMutate, isPending: true });
    renderRail();
    expect(screen.getByRole('button', { name: 'Loading demo…' })).toBeDisabled();
  });
});

describe('Sidebar rail — Tier 1 due-today badge and active row states', () => {
  it('hides the due-today badge and switches the aria-label when nothing is due', () => {
    mockUseMyWork.mockReturnValue({ data: { pages: [{ due_today_count: 0 }] } });
    renderRail();
    expect(screen.getByRole('link', { name: 'My Work' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /due today/ })).not.toBeInTheDocument();
  });

  it('marks the My Work row active when the route matches it', () => {
    renderRailAt('/me/work');
    const myWork = screen.getByRole('link', { name: 'My Work, 3 due today' });
    // The You-card active treatment is a bordered lifted surface (rule 1).
    expect(myWork.className).toMatch(/bg-neutral-surface/);
  });

  it('marks the settings gear active on the personal-settings route', () => {
    renderRailAt('/me/settings/general');
    const gear = screen.getByRole('link', { name: 'Personal settings' });
    expect(gear.className).toMatch(/bg-brand-primary\/10/);
  });
});

describe('Sidebar rail — Tier 2 "This project" fallbacks', () => {
  beforeEach(() => {
    mockUseProjectId.mockReturnValue('p1');
  });

  it('falls back to a generic "Project" header when the project data is not loaded', () => {
    mockUseProject.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderRail();
    expect(screen.getByText('Project')).toBeInTheDocument();
    // Missing methodology defaults to a Hybrid workspace and unknown health.
    expect(screen.getByText('Hybrid workspace')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'health unknown' })).toBeInTheDocument();
  });

  it('renders a green health circle for an on-track project', () => {
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, health: 'ON_TRACK' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByRole('img', { name: 'on track' })).toBeInTheDocument();
  });

  it('renders a critical health circle for a critical project', () => {
    mockUseProject.mockReturnValue({
      data: { ...HYBRID_PROJECT, health: 'CRITICAL' },
      isLoading: false,
      error: null,
    });
    renderRail();
    expect(screen.getByRole('img', { name: 'critical' })).toBeInTheDocument();
  });

  it('closes the drawer when a project view link is followed', () => {
    const onClose = vi.fn();
    renderRail({ isDrawer: true, onClose });
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Sidebar rail — Tier 2 "This program" fallbacks', () => {
  it('falls back to a generic "Program" header when the program is not in the list', () => {
    mockUseProgramId.mockReturnValue('ghost');
    renderRail();
    const nav = screen.getByRole('navigation', { name: 'Program' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    // Header card falls back to the literal name since usePrograms has no match.
    expect(screen.getByText('Program')).toBeInTheDocument();
  });

  it('closes the drawer when a program view link is followed', () => {
    mockUseProgramId.mockReturnValue('prog1');
    const onClose = vi.fn();
    renderRail({ isDrawer: true, onClose });
    const nav = screen.getByRole('navigation', { name: 'Program' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Backlog' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Sidebar rail — ProjectRow aria-label variants', () => {
  it('uses a singular "task" and omits the count when unknown', () => {
    mockUseProjects.mockReturnValue({
      data: [
        { id: 'o1', name: 'Single Task Proj', programId: null, healthState: 'on-track', openTaskCount: 1 },
        { id: 'o2', name: 'No Count Proj', programId: null, healthState: 'unknown', openTaskCount: null },
      ],
      count: undefined,
    });
    renderRail();
    openSwitcher();
    expect(
      screen.getByRole('button', { name: 'Single Task Proj, on track, 1 open task' }),
    ).toBeInTheDocument();
    // openTaskCount null → the count is dropped entirely from the label.
    expect(
      screen.getByRole('button', { name: 'No Count Proj, health unknown' }),
    ).toBeInTheDocument();
  });
});

describe('Sidebar rail — switcher outside-click + auto-collapse', () => {
  it('closes the Browse switcher on an outside pointer press', () => {
    renderRail();
    openSwitcher();
    expect(screen.getByRole('link', { name: 'Resources catalog' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('link', { name: 'Resources catalog' })).not.toBeInTheDocument();
  });

  it('auto-collapses below the lg breakpoint when the user has not taken control', () => {
    const mql = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mql));
    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
    renderRail();
    expect(useShellStore.getState().sidebarCollapsed).toBe(true);
    vi.unstubAllGlobals();
  });
});
