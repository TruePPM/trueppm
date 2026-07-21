import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BoardView } from './BoardView';

// BoardView uses useSearchParams + useQueryClient — all renders need a Router
// context and a QueryClientProvider.
function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BoardView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Calm-toolbar (#382) helpers — controls were collapsed into chip popovers
// (Density) and a More⋯ overflow. Tests open the relevant popover before
// asserting on the underlying control. Each call clicks the popover's
// trigger; the popover stays open for subsequent assertions in the same test.
type UE = ReturnType<typeof userEvent.setup>;
async function openMore(user: UE) {
  await user.click(screen.getByRole('button', { name: 'More board controls' }));
}
async function openDensityChip(user: UE) {
  await user.click(screen.getByRole('button', { name: 'Card density' }));
}
const DENSITY_LABEL: Record<'compact' | 'comfortable' | 'detailed', string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  detailed: 'Detailed',
};
async function setBoardDensity(user: UE, value: 'compact' | 'comfortable' | 'detailed') {
  await openDensityChip(user);
  await user.click(
    screen.getByRole('radio', { name: `Board card density: ${DENSITY_LABEL[value]}` }),
  );
}
function expectBoardDensity(value: 'compact' | 'comfortable' | 'detailed') {
  const chip = screen.getByRole('button', { name: 'Card density' });
  expect(chip).toHaveTextContent(DENSITY_LABEL[value]);
}

// jsdom does not implement window.matchMedia — stub it.
// `mobile=false` (default) reports the `lg` desktop tier: max-width queries
// don't match, min-width queries do (used by `useBreakpoint`, #568).
// `mobile=true` reports the `sm` mobile tier: max-width queries match,
// min-width queries don't.
const makeMq = (mobile: boolean) => (query: string) => {
  const isMinWidth = /^\(min-width:/.test(query);
  return {
    matches: isMinWidth ? !mobile : mobile,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
};
vi.stubGlobal('matchMedia', vi.fn().mockImplementation(makeMq(false)));
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import type { Task, TaskStatus } from '@/types';
import type { FlowMetrics } from '@/hooks/useSprints';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';

// ---------------------------------------------------------------------------
// Mocks — module-scope mutable state lets each test choose which tasks /
// columns / loading state to render.
// ---------------------------------------------------------------------------

let mockTasks: Task[] | null = FIXTURE_TASKS;
let mockIsLoading = false;
let mockError: Error | null = null;
let mockColumns: { status: TaskStatus; label: string; visible: boolean; wipLimit?: number }[] = [
  { status: 'BACKLOG', label: 'BACKLOG', visible: true },
  { status: 'NOT_STARTED', label: 'TO DO', visible: true },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 3 },
  { status: 'REVIEW', label: 'REVIEW', visible: true, wipLimit: 2 },
  { status: 'COMPLETE', label: 'DONE', visible: true },
];

// Flow-metrics fixture for the WIP-creep trend arrow (issue 1213). Mutable so a
// test can inject a rising/falling CFD series or a suppressed payload; `undefined`
// (the default) means "no arrows", matching the board with no flow data.
let mockFlowMetrics: FlowMetrics | undefined = undefined;
const updateMutate = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'project-1',
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, isLoading: mockIsLoading, error: mockError }),
}));

vi.mock('@/hooks/useBoardTasks', () => ({
  useUpdateTaskStatus: () => ({ mutate: updateMutate }),
}));

vi.mock('@/hooks/useBoardConfig', () => ({
  useBoardConfig: () => ({
    columns: mockColumns,
    isLoading: false,
    save: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAddDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoveDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

// TaskFormModal (#305) hooks beyond useTaskMutations — stub for BoardView tests.
vi.mock('@/hooks/useAssignmentMutations', () => ({
  useAddAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoveAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

let mockProjectResourcePool: {
  id: string;
  resourceId: string;
  resource: { id: string; name: string; isMe?: boolean };
}[] = [];
vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: mockProjectResourcePool, isLoading: false }),
}));

// useMyTasksFilter (#198) — module-scope mock so individual tests can flip
// the filter on/off and verify the BoardView wiring without exercising
// localStorage + role-default plumbing (covered by the hook's own tests).
let mockMyTasksFilter = {
  enabled: false,
  isLoading: false,
  setEnabled: vi.fn() as (next: boolean) => void,
};
vi.mock('@/hooks/useMyTasksFilter', () => ({
  useMyTasksFilter: () => mockMyTasksFilter,
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: { id: 'project-1', name: 'Test Project', agile_features: false },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => ({ data: { pages: [] }, isLoading: false }),
}));

// Default to ADMIN (300) so the existing write-path tests apply; the #2146
// role-gating test lowers it to VIEWER.
let boardRoleMock: number | null = 300;
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: boardRoleMock, isLoading: false }),
}));

// PDF-export footer reads the current user's display name (issue 326). Mock so
// the board test never fires a real `/auth/me/` XHR.
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { display_name: 'Test User', initials: 'TU' },
    isLoading: false,
  }),
}));

// Workshop hooks — mutable so individual tests can simulate an active session
// and exercise the workshop-mode branches in BoardView (banner, exit dialog).
let mockWorkshopSession: {
  id: string;
  project_id: string;
  started_by_id: string | null;
  started_at: string;
  ended_at: string | null;
  participants: never[];
} | null = null;
const startWorkshopMutate = vi.fn();
const endWorkshopMutate = vi.fn();
let mockEndWorkshopPending = false;

vi.mock('@/hooks/useWorkshopSession', () => ({
  useWorkshopSession: () => ({ data: mockWorkshopSession, isLoading: false }),
  useStartWorkshop: () => ({
    mutate: startWorkshopMutate,
    isPending: false,
  }),
  useEndWorkshop: () => ({
    mutate: endWorkshopMutate,
    isPending: mockEndWorkshopPending,
  }),
}));

vi.mock('@/hooks/usePhaseReorder', () => ({
  usePhaseReorder: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Board batch 6 — stub saved views hook so BoardViewDropdown doesn't make network calls.
// mockSavedViews / mockCreateMutate are mutable (issue 1918) so individual tests can
// inject a saved view with filter facets and assert on what "Save current view" sends.
let mockSavedViews: import('@/hooks/useBoardSavedViews').BoardSavedView[] = [];
const mockCreateMutate = vi.fn();
vi.mock('@/hooks/useBoardSavedViews', () => ({
  useBoardSavedViews: () => ({
    views: mockSavedViews,
    isLoading: false,
    create: { mutate: mockCreateMutate, isPending: false },
    update: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  }),
}));

// Board batch 3 hooks — stub out network-dependent overallocation + dep fetches.
vi.mock('@/hooks/useBoardOverallocation', () => ({
  useBoardOverallocation: () => ({
    overallocByPair: new Map<string, number>(),
    threshold: 1.0,
    scheduleNotRun: false,
  }),
}));

// Stub the heavy registry-driven drawer — popover-integration tests only need
// to verify it mounts with a task name (issue #304); the section internals are
// covered by TaskDetailDrawer's own tests.
vi.mock('@/features/schedule/TaskDetailDrawer', () => ({
  TaskDetailDrawer: ({
    task,
    onClose,
  }: {
    task: { id: string; name: string } | null;
    onClose: () => void;
  }) =>
    task ? (
      <div role="dialog" aria-label={`Task drawer ${task.name}`}>
        <button type="button" onClick={onClose}>
          Close drawer
        </button>
      </div>
    ) : null,
}));

// useSprints is invoked by the popover when a task has sprintId — return an
// empty list so the chip renders as "Sprint: …" placeholder without an API hit.
// The SprintPanel embedded in BoardView also pulls useActiveSprint /
// useProjectVelocity / useSprintMutations from this module (ADR-0073); stub
// them all so BoardView renders without hitting the network. Each stub
// returns the "no active sprint" shape so SprintPanel renders nothing.
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [], isLoading: false }),
  useActiveSprint: () => ({ sprint: null, isLoading: false }),
  useProjectVelocity: () => ({ data: undefined, isLoading: false }),
  // FlowAnalyticsPanel (collapsed by default) calls this on every render (#1188);
  // BoardView also reads it for the column WIP-creep trend arrows (#1213).
  useFlowMetrics: () => ({ data: mockFlowMetrics, isLoading: false, isError: false }),
  // FlowAnalyticsPanel also calls useSprintForecast unconditionally for the
  // throughput forecast card (issue 1280); stub it so the panel renders offline.
  useSprintForecast: () => ({ data: undefined, isLoading: false, isError: false }),
  useSprintMutations: () => ({
    createSprint: { mutate: () => undefined, isPending: false },
    closeSprint: { mutate: () => undefined, isPending: false },
    activateSprint: { mutate: () => undefined, isPending: false },
    updateSprint: { mutate: () => undefined, isPending: false },
  }),
}));

vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskDependencies: () => ({
    predecessors: [],
    successors: [],
    isLoading: false,
    error: null,
  }),
  useTaskRisks: () => ({
    risks: [],
    isLoading: false,
    error: null,
  }),
  severityRagBand: (sev: number | null | undefined) => {
    if (sev == null || sev <= 0) return null;
    if (sev <= 5) return 'green';
    if (sev <= 14) return 'amber';
    return 'red';
  },
  severityDotCount: (sev: number | null | undefined) => {
    if (sev == null || sev <= 0) return 0;
    if (sev === 1) return 1;
    if (sev <= 5) return 2;
    if (sev <= 11) return 3;
    if (sev <= 19) return 4;
    return 5;
  },
}));

function resetMocks() {
  boardRoleMock = 300;
  mockTasks = FIXTURE_TASKS;
  mockIsLoading = false;
  mockError = null;
  mockColumns = [
    { status: 'BACKLOG', label: 'BACKLOG', visible: true },
    { status: 'NOT_STARTED', label: 'TO DO', visible: true },
    { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 3 },
    { status: 'REVIEW', label: 'REVIEW', visible: true, wipLimit: 2 },
    { status: 'COMPLETE', label: 'DONE', visible: true },
  ];
  mockFlowMetrics = undefined;
  mockSavedViews = [];
  mockCreateMutate.mockReset();
  updateMutate.mockReset();
  startWorkshopMutate.mockReset();
  endWorkshopMutate.mockReset();
  mockWorkshopSession = null;
  mockEndWorkshopPending = false;
  mockProjectResourcePool = [];
  mockMyTasksFilter = {
    enabled: false,
    isLoading: false,
    setEnabled: vi.fn(),
  };
  localStorage.clear(); // reset persisted board prefs (density, collapsedLanes) between tests
  // Reset matchMedia to desktop default between tests (issue #224)
  (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(makeMq(false));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('renders column headers (BACKLOG lifted to the rail per ADR-0057)', () => {
    renderBoard();
    // BACKLOG is no longer an inline column — it lives in the left-side rail
    // header rendered as the "Inbox · backlog" eyebrow (#361 / ADR-0057).
    expect(screen.queryByText('BACKLOG')).not.toBeInTheDocument();
    expect(screen.getByText(/Inbox · backlog/i)).toBeInTheDocument();
    expect(screen.getByText('TO DO')).toBeInTheDocument();
    expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('REVIEW')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
  });

  it('renders the phase swimlane for the summary task', () => {
    renderBoard();
    // t1 is a summary task "Alpha Platform Upgrade" — it becomes a lane header
    expect(screen.getByText('Alpha Platform Upgrade')).toBeInTheDocument();
  });

  // #2146 — board authoring is Member+. A Viewer keeps read access (columns,
  // cards) but every write affordance on the rail is suppressed rather than
  // rendered and 403'd.
  it('hides the backlog quick-capture affordance for a Viewer', () => {
    boardRoleMock = 0; // ROLE_VIEWER
    renderBoard();
    // The board still renders (read is allowed)…
    expect(screen.getByText('TO DO')).toBeInTheDocument();
    // …but the rail's inline capture field is gone.
    expect(
      screen.queryByRole('textbox', { name: /Capture a backlog idea/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add with details/i })).not.toBeInTheDocument();
  });

  it('shows the backlog quick-capture affordance for an authoring role', () => {
    renderBoard(); // default ADMIN
    expect(screen.getByRole('textbox', { name: /Capture a backlog idea/i })).toBeInTheDocument();
  });

  it('renders an "Project Tasks" lane for ungrouped tasks', () => {
    renderBoard();
    // t7 "Documentation" has no summary parent — appears in "Project Tasks" lane
    expect(screen.getByText('Project Tasks')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
  });

  it('does not render summary tasks as cards', () => {
    renderBoard();
    // "Alpha Platform Upgrade" is a summary task — it should not appear as a draggable card.
    // The collapse/expand buttons and add-task button do reference the phase name, but
    // no card-role button should be present (cards have aria-label "Actions for {name}").
    const allButtons = screen.getAllByRole('button');
    const cardActionButtons = allButtons.filter((btn) =>
      btn.getAttribute('aria-label')?.startsWith('Actions for Alpha Platform Upgrade'),
    );
    expect(cardActionButtons).toHaveLength(0);
  });

  it('renders leaf task cards inside the phase lane', () => {
    renderBoard();
    // "Discovery & Design" (t2, COMPLETE) and "Backend Implementation" (t3, IN_PROGRESS)
    // should appear as cards
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
  });

  it('renders the critical-path worst-offender badge for critical tasks (#1305)', () => {
    renderBoard();
    // t3 "Backend Implementation" is critical. At the default comfortable density
    // the standalone "CP" chip is consolidated into the worst-offender badge,
    // whose label reads "Critical path" when no higher-severity signal wins
    // (#1305). Asserting on "CP" alone was a false positive — it also matched
    // Carol Park's avatar initials on a non-critical card.
    const cpBadges = screen.getAllByText('Critical path');
    expect(cpBadges.length).toBeGreaterThan(0);
  });

  it('collapses a phase lane on header click', async () => {
    const user = userEvent.setup();
    renderBoard();
    // Collapse toggle button for "Alpha Platform Upgrade" phase (aria-label from LaneMeta)
    const toggleBtn = screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ });
    // Initially expanded — task cards visible
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();

    await user.click(toggleBtn);
    // After collapse, task cards in that lane should be hidden
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
  });

  it('renders a dashed hollow "0" (not an em-dash) for empty cells in a collapsed lane (#1943)', async () => {
    const user = userEvent.setup();
    renderBoard();
    // Before collapse the lane renders live BoardCells — no collapsed-cell stub text.
    expect(screen.queryByText('0 cards, empty')).not.toBeInTheDocument();

    const toggleBtn = screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ });
    await user.click(toggleBtn);

    // The Alpha lane's REVIEW column has no cards. Collapsed, that cell must read as
    // "empty", not "n/a": a dashed hollow "0" with an accessible name ending "empty"
    // (rule 201, matching the ColumnStub #1697 treatment), never a bare em-dash.
    const emptyLabels = screen.getAllByText('0 cards, empty');
    expect(emptyLabels.length).toBeGreaterThan(0);
    // The sr-only accessible name follows the visible glyph; the glyph is a hollow
    // dashed "0", not an em-dash.
    const glyph = emptyLabels[0].previousElementSibling;
    expect(glyph).toHaveTextContent('0');
    expect(glyph?.textContent).not.toContain('—');
    expect(glyph?.className).toContain('border-dashed');
  });

  it('shows WIP toggle in toolbar', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    expect(screen.getByLabelText('Show WIP limits')).toBeInTheDocument();
  });

  it('renders the loading state when useScheduleTasks is loading', () => {
    mockIsLoading = true;
    mockTasks = null;
    renderBoard();
    expect(screen.getByRole('status', { name: 'Loading board…' })).toBeInTheDocument();
    // The toolbar / lanes do not render in the loading branch — the More⋯
    // overflow that owns "Show WIP limits" is therefore not present.
    expect(screen.queryByRole('button', { name: 'More board controls' })).not.toBeInTheDocument();
  });

  it('renders the empty state when no leaf tasks exist', () => {
    mockTasks = []; // not null, not loading — but no tasks
    renderBoard();
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  it('renders an error banner (not an empty board) when the tasks fetch fails', () => {
    // A failed fetch previously rendered identically to an empty board (#1764).
    mockError = new Error('boom');
    mockTasks = null;
    renderBoard();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the board\./);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // Not confused with the empty or loading states.
    expect(screen.queryByText(/No tasks yet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading board…')).not.toBeInTheDocument();
  });

  it('renders the empty state when only summary tasks exist (no leaves)', () => {
    mockTasks = [FIXTURE_TASKS[0]]; // t1 is the sole summary task; no children
    renderBoard();
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // No-phases backlog drop target (issue #386)
  // Phase-less projects with at least one BACKLOG card must still render the
  // four status columns + Project Tasks lane so the rail/drawer's promote-by-
  // drag affordance has a target.
  // -------------------------------------------------------------------------
  it('renders the Project Tasks lane on a phase-less project that has BACKLOG cards (issue #386)', () => {
    const backlogTask: Task = {
      ...FIXTURE_TASKS[1],
      id: 'idea-1',
      name: 'Polish onboarding copy',
      isSummary: false,
      isMilestone: false,
      parentId: null,
      status: 'BACKLOG',
      progress: 0,
    };
    mockTasks = [backlogTask];
    renderBoard();
    // Empty-state copy must NOT render — there's a backlog card to promote.
    expect(screen.queryByText(/No tasks yet/)).not.toBeInTheDocument();
    // Project Tasks lane appears with the four status columns.
    expect(screen.getByText('Project Tasks')).toBeInTheDocument();
    expect(screen.getByText('TO DO')).toBeInTheDocument();
    expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('REVIEW')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
  });

  it('does NOT render the Project Tasks lane when there are no tasks at all (issue #386)', () => {
    mockTasks = [];
    renderBoard();
    expect(screen.queryByText('Project Tasks')).not.toBeInTheDocument();
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Synthetic Project Tasks lane intake-default (issue #387, VoC consensus
  // resolution to the BACKLOG-vs-TO-DO question raised by #386).
  // -------------------------------------------------------------------------
  it('renames the + button to "Add to backlog" on the synthetic Project Tasks lane (issue #387)', () => {
    const backlogTask: Task = {
      ...FIXTURE_TASKS[1],
      id: 'idea-1',
      name: 'Polish onboarding copy',
      isSummary: false,
      isMilestone: false,
      parentId: null,
      status: 'BACKLOG',
      progress: 0,
    };
    mockTasks = [backlogTask];
    renderBoard();
    // The lane is intake scaffolding; the "+ Add task" affordance is renamed
    // so the user can see where the new card is going before they click.
    expect(screen.getByRole('button', { name: 'Add to backlog' })).toBeInTheDocument();
    // The default per-phase label must NOT be present on the synthetic lane.
    expect(
      screen.queryByRole('button', { name: /Add task to Project Tasks/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the default "+ Add task" label on real phase lanes (issue #387)', () => {
    // FIXTURE_TASKS contains a real summary task ("Alpha Platform Upgrade")
    // with committed children; that lane is a real phase, not synthetic.
    renderBoard();
    expect(
      screen.getByRole('button', { name: 'Add task to Alpha Platform Upgrade' }),
    ).toBeInTheDocument();
  });

  it('opens TaskFormModal with status pre-set to BACKLOG when added from the synthetic lane (issue #387)', async () => {
    const user = userEvent.setup();
    const backlogTask: Task = {
      ...FIXTURE_TASKS[1],
      id: 'idea-2',
      name: 'Customer-onboarding rough notes',
      isSummary: false,
      isMilestone: false,
      parentId: null,
      status: 'BACKLOG',
      progress: 0,
    };
    mockTasks = [backlogTask];
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Add to backlog' }));
    // Dialog opens with the synthetic-lane title and a status select pre-set
    // to BACKLOG — exercises the `isSynthetic` branch through to the modal.
    const dialog = await screen.findByRole('dialog', { name: /Add to backlog/i });
    expect(dialog).toBeInTheDocument();
    const statusSelect = screen.getByLabelText<HTMLSelectElement>(/Status/i);
    expect(statusSelect.value).toBe('BACKLOG');
  });

  it('replaces the WIP badge with a plain count when "Show WIP limits" is off', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    const toggle = screen.getByLabelText<HTMLInputElement>('Show WIP limits');
    expect(toggle.checked).toBe(true);
    await user.click(toggle);
    expect(toggle.checked).toBe(false);
    // The board still renders (regression check).
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('renders the WIP "over limit" warning chip when a column exceeds its limit', () => {
    // Inject a tight wipLimit on IN_PROGRESS so the fixture (which has multiple
    // IN_PROGRESS tasks under "Alpha Platform Upgrade") trips the over-limit branch.
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    // Per #232 the over-limit chip reads "{count}/{limit} — over WIP limit".
    expect(screen.getByText(/over WIP limit/i)).toBeInTheDocument();
  });

  it('surfaces the at-limit band on the drop zone when a column sits exactly at its WIP limit (issue 1358)', () => {
    // Two IN_PROGRESS leaf cards with wipLimit:2 → count === limit → the 'at'
    // band. Before routing both inline checks through wipState() the drop-zone
    // text only fired on the over branch, so an at-limit column showed nothing.
    const wip = (id: string, name: string): Task => ({
      ...FIXTURE_TASKS[1],
      id,
      name,
      isSummary: false,
      isMilestone: false,
      parentId: null,
      status: 'IN_PROGRESS',
      progress: 30,
    });
    mockTasks = [wip('ip-1', 'Wire the consumer'), wip('ip-2', 'Backfill the cache')];
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 2 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    // The drop-zone now carries the at-limit warning (unique "WIP limit: N — at
    // limit" copy), and the over-limit copy is absent.
    expect(screen.getByText(/WIP limit: 2 — at limit/i)).toBeInTheDocument();
    expect(screen.queryByText(/over WIP limit/i)).not.toBeInTheDocument();
  });

  it('carries the WIP-limit state in the column header accessible name (#1033)', () => {
    // Tight wipLimit trips the over-limit branch on IN_PROGRESS; TO DO has no
    // limit so its header stays the plain form.
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    // The header's accessible name (its aria-label) names the over-limit state,
    // not just the inline WipBadge.
    expect(
      screen.getByRole('heading', { name: /^IN PROGRESS, \d+ tasks?, over limit$/i }),
    ).toBeInTheDocument();
    // A column with no limit keeps the plain "label, N tasks" name.
    expect(screen.getByRole('heading', { name: /^TO DO, \d+ tasks?$/i })).toBeInTheDocument();
  });

  it('renders the at-limit WIP chip when count equals the limit (#232)', () => {
    // Render once with no WIP gate to discover how many leaf IN_PROGRESS
    // cards the BoardView actually paints (summary tasks become phases and
    // are excluded from the per-status totals).
    renderBoard();
    const probe = screen.queryByText(/(\d+)\/3/);
    const inProgressCount = probe ? Number(probe.textContent?.split('/')[0] ?? 0) : 0;
    cleanup();
    expect(inProgressCount).toBeGreaterThan(0);

    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: inProgressCount },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    expect(
      screen.getByLabelText(`${inProgressCount} of ${inProgressCount} WIP limit, at limit`),
    ).toBeInTheDocument();
  });

  it('renders an "N done" chip when every task in the phase is COMPLETE', () => {
    // Only the completed leaf t2 under summary t1 — phase becomes 100% done.
    mockTasks = [FIXTURE_TASKS[0], FIXTURE_TASKS[1]];
    renderBoard();
    expect(screen.getByText('1 done')).toBeInTheDocument();
  });

  it('renders an "N CP" chip when the phase contains critical-path tasks', () => {
    renderBoard();
    // The Alpha phase (FIXTURE_TASKS[0]) has 4 critical leaves: t2, t3, t5, t6.
    expect(screen.getByText('4 CP')).toBeInTheDocument();
  });

  it('shows per-column counts when a phase is collapsed', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ }));
    // The Alpha phase has 1 COMPLETE task (t2) — singular "1 task" branch.
    expect(screen.getAllByText('1 task').length).toBeGreaterThan(0);
    // And NOT_STARTED holds t5, t6 — pluralized "2 tasks" branch.
    expect(screen.getAllByText('2 tasks').length).toBeGreaterThan(0);
  });

  it('routes the keyboard "Move to" menu item through updateMutate', () => {
    renderBoard();
    // Open the overflow menu for the first leaf card and move it to DONE.
    const trigger = screen.getAllByLabelText(/Actions for /)[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'DONE' })[0]);
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', status: 'COMPLETE' }),
    );
  });

  it('cancels a Move-to move when destination is over WIP limit and user declines (#232, #2050)', () => {
    // IN_PROGRESS already has > 0 tasks; tighten its limit to make any new
    // move push it over the threshold, then decline the styled confirm dialog
    // (#2050 replaced the native window.confirm with a role="alertdialog").
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    // Find a card whose status is NOT IN_PROGRESS so the move triggers the guard.
    const trigger = screen.getAllByLabelText(/Actions for /)[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'IN PROGRESS' })[0]);
    // The move is deferred behind the dialog — nothing mutates yet.
    const dialog = screen.getByRole('alertdialog', { name: /Move past the WIP limit/i });
    expect(updateMutate).not.toHaveBeenCalled();
    // Cancel-first: "Keep it here" declines and leaves the card in place.
    fireEvent.click(within(dialog).getByRole('button', { name: /Keep it here/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('proceeds with the move when user confirms over-WIP-limit dialog (#232, #2050)', () => {
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    const trigger = screen.getAllByLabelText(/Actions for /)[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'IN PROGRESS' })[0]);
    const dialog = screen.getByRole('alertdialog', { name: /Move past the WIP limit/i });
    expect(updateMutate).not.toHaveBeenCalled();
    // "Move anyway" confirms and issues the deferred move.
    fireEvent.click(within(dialog).getByRole('button', { name: /Move anyway/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ status: 'IN_PROGRESS' }));
  });

  it('renders LaneMeta for each phase with add-task button (issue #208)', () => {
    renderBoard();
    // Each visible phase gets a per-lane + button (LaneMeta)
    expect(
      screen.getByRole('button', { name: /Add task to Alpha Platform Upgrade/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add task to Project Tasks/ })).toBeInTheDocument();
  });

  it('opens the unified task form modal when phase + button is clicked (issue #208 / #305)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderBoard();
    await user.click(screen.getByRole('button', { name: /Add task to Alpha Platform Upgrade/ }));
    // The redesigned TaskFormModal (#305) titles its header "Add to {phase}".
    expect(
      screen.getByRole('dialog', { name: /Add to Alpha Platform Upgrade/ }),
    ).toBeInTheDocument();
  });

  it('renders "Column tints" toggle in toolbar (issue #211)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    // CalmToolbar (#382) moves the toggle behind the More⋯ overflow; the
    // legacy "Show column tints" aria-label is preserved for compat.
    expect(screen.getByLabelText('Show column tints')).toBeInTheDocument();
  });

  it('"Column tints" toggle is on by default (issue #211)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    const toggle = screen.getByLabelText<HTMLInputElement>('Show column tints');
    expect(toggle.checked).toBe(true);
  });

  it('board still renders when column tints are toggled off (issue #211)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderBoard();
    await openMore(user);
    const toggle = screen.getByLabelText<HTMLInputElement>('Show column tints');
    await user.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #190 — Swimlane collapse/expand persistence
  // -------------------------------------------------------------------------

  it('renders "Collapse all" and "Expand all" buttons in toolbar (issue #190)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    expect(screen.getByRole('button', { name: 'Collapse all lanes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all lanes' })).toBeInTheDocument();
  });

  it('"Collapse all" hides all lane task cards (issue #190)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }));
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
  });

  it('"Expand all" restores cards after collapse-all (issue #190)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }));
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
    // The More⋯ popover stays open after a button click inside it — Expand all
    // is reachable without re-opening.
    await user.click(screen.getByRole('button', { name: 'Expand all lanes' }));
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
  });

  it('persists collapsed state to localStorage (issue #190)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ }));
    const stored = localStorage.getItem('trueppm.board.project-1.collapsedLanes');
    expect(stored).not.toBeNull();
    const ids = JSON.parse(stored!) as string[];
    expect(ids.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Issue #193 — Card density toggle
  // -------------------------------------------------------------------------

  it('renders a "Card density" selector in toolbar (issue #193)', () => {
    renderBoard();
    // CalmToolbar (#382) replaces the legacy <select> with a chip popover —
    // the chip button carries the "Card density" aria-label.
    expect(screen.getByRole('button', { name: 'Card density' })).toBeInTheDocument();
  });

  it('card density defaults to "comfortable" (issue #193)', () => {
    renderBoard();
    expectBoardDensity('comfortable');
  });

  it('switching to compact hides progress rings from cards (issue #193)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await setBoardDensity(user, 'compact');
    // Board still renders — task names still visible
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
  });

  it('density persists to localStorage (issue #193)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await setBoardDensity(user, 'detailed');
    const stored = localStorage.getItem('trueppm.board.density');
    expect(stored).toBe('detailed');
  });

  it('restores density preference from localStorage on mount (issue #193)', () => {
    localStorage.setItem('trueppm.board.density', 'compact');
    renderBoard();
    expectBoardDensity('compact');
  });

  it('restores collapsed lanes from localStorage on mount (issue #190)', () => {
    localStorage.setItem('trueppm.board.project-1.collapsedLanes', JSON.stringify(['t1']));
    renderBoard();
    // Alpha lane (t1) is pre-collapsed — task cards not visible on mount
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Expand Alpha Platform Upgrade/ }),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #225 — keyboard shortcut hints in collapse button tooltip
  // -------------------------------------------------------------------------

  it('collapse toggle shows "Collapse lane  [" title when lane is expanded (issue #225)', () => {
    renderBoard();
    const btn = screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ });
    expect(btn).toHaveAttribute('title', 'Collapse lane  [');
  });

  it('collapse toggle shows "Expand lane  ]" title when lane is collapsed (issue #225)', async () => {
    const user = userEvent.setup();
    renderBoard();
    const btn = screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ });
    await user.click(btn);
    const expandBtn = screen.getByRole('button', { name: /Expand Alpha Platform Upgrade/ });
    expect(expandBtn).toHaveAttribute('title', 'Expand lane  ]');
  });

  // -------------------------------------------------------------------------
  // Issue #224 — responsive density auto-select
  // -------------------------------------------------------------------------

  it('auto-selects compact density below md viewport (issue #224)', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(makeMq(true));
    renderBoard();
    expectBoardDensity('compact');
  });

  it('ignores stored desktop density on mobile — auto-compact wins (issue #224)', () => {
    localStorage.setItem('trueppm.board.density', 'detailed');
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(makeMq(true));
    renderBoard();
    expectBoardDensity('compact');
  });

  it('manual density override on mobile is not persisted to localStorage (issue #224)', async () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(makeMq(true));
    const user = userEvent.setup();
    renderBoard();
    await setBoardDensity(user, 'comfortable');
    expect(localStorage.getItem('trueppm.board.density')).toBeNull();
    expectBoardDensity('comfortable');
  });

  it('desktop density still persists to localStorage when viewport is >= md (issue #224)', async () => {
    // matchMedia already returns matches:false (desktop) from resetMocks
    const user = userEvent.setup();
    renderBoard();
    await setBoardDensity(user, 'detailed');
    expect(localStorage.getItem('trueppm.board.density')).toBe('detailed');
  });

  // -------------------------------------------------------------------------
  // ADR-0046 — Workshop mode (banner, exit dialog, focus trap)
  // -------------------------------------------------------------------------

  it('renders the workshop toggle in non-workshop mode (ADR-0046)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    expect(screen.getByRole('button', { name: 'Start workshop session' })).toBeInTheDocument();
  });

  it('starting workshop mode calls startWorkshop.mutate (ADR-0046)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    expect(startWorkshopMutate).toHaveBeenCalledTimes(1);
  });

  it('shows the workshop banner when a session is active and workshop mode is on (ADR-0046)', async () => {
    // Pre-set the session and have startWorkshop's mutate invoke onSuccess so
    // workshopMode flips to true after the toggle is clicked.
    mockWorkshopSession = {
      id: 'session-uuid',
      project_id: 'project-1',
      started_by_id: 'user-1',
      started_at: '2026-04-29T10:00:00Z',
      ended_at: null,
      participants: [],
    };
    startWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    expect(screen.getByLabelText('Workshop session active')).toBeInTheDocument();
  });

  it('clicking the toggle while in workshop mode opens the exit confirm dialog (ADR-0046)', async () => {
    mockWorkshopSession = {
      id: 'session-uuid',
      project_id: 'project-1',
      started_by_id: 'user-1',
      started_at: '2026-04-29T10:00:00Z',
      ended_at: null,
      participants: [],
    };
    startWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    await user.click(screen.getByRole('button', { name: 'Exit workshop mode' }));
    expect(screen.getByRole('dialog', { name: /End workshop session/ })).toBeInTheDocument();
  });

  it('cancel in the exit dialog dismisses it without ending the session (ADR-0046)', async () => {
    mockWorkshopSession = {
      id: 'session-uuid',
      project_id: 'project-1',
      started_by_id: 'user-1',
      started_at: '2026-04-29T10:00:00Z',
      ended_at: null,
      participants: [],
    };
    startWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    await user.click(screen.getByRole('button', { name: 'Exit workshop mode' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /End workshop session/ })).not.toBeInTheDocument();
    expect(endWorkshopMutate).not.toHaveBeenCalled();
  });

  it('confirming end in the exit dialog calls endWorkshop.mutate (ADR-0046)', async () => {
    mockWorkshopSession = {
      id: 'session-uuid',
      project_id: 'project-1',
      started_by_id: 'user-1',
      started_at: '2026-04-29T10:00:00Z',
      ended_at: null,
      participants: [],
    };
    startWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    endWorkshopMutate.mockImplementation((_input: undefined, opts?: { onSettled?: () => void }) => {
      opts?.onSettled?.();
    });
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    await user.click(screen.getByRole('button', { name: 'Exit workshop mode' }));
    // The dialog renders a primary "End Workshop" button alongside Cancel.
    await user.click(screen.getByRole('button', { name: 'End Workshop' }));
    expect(endWorkshopMutate).toHaveBeenCalledTimes(1);
  });

  it('Escape in the exit dialog dismisses it (ADR-0046)', async () => {
    mockWorkshopSession = {
      id: 'session-uuid',
      project_id: 'project-1',
      started_by_id: 'user-1',
      started_at: '2026-04-29T10:00:00Z',
      ended_at: null,
      participants: [],
    };
    startWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    await user.click(screen.getByRole('button', { name: 'Exit workshop mode' }));
    const dialog = screen.getByRole('dialog', { name: /End workshop session/ });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /End workshop session/ })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #185 — EVM toolbar toggle (evmMode select + show cost checkbox)
  // -------------------------------------------------------------------------

  it('renders EVM indicators select in toolbar (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    expect(screen.getByLabelText('EVM indicators')).toBeInTheDocument();
  });

  it('EVM indicators select defaults to "off" (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    const select = screen.getByLabelText<HTMLSelectElement>('EVM indicators');
    expect(select.value).toBe('off');
  });

  it('switching EVM to "spi" keeps the board rendering (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.selectOptions(screen.getByLabelText('EVM indicators'), 'spi');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('switching EVM to "cpi" keeps the board rendering (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.selectOptions(screen.getByLabelText('EVM indicators'), 'cpi');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('switching EVM to "both" keeps the board rendering (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.selectOptions(screen.getByLabelText('EVM indicators'), 'both');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('renders "Show cost" toggle in toolbar (issue #189)', () => {
    renderBoard();
    // CalmToolbar (#382) renders Show cost as a quiet pill toggle (button with
    // aria-pressed) instead of the legacy <input type="checkbox">.
    expect(screen.getByRole('button', { name: 'Show cost' })).toBeInTheDocument();
  });

  it('"Show cost" toggle defaults to unpressed (issue #189)', () => {
    renderBoard();
    const btn = screen.getByRole('button', { name: 'Show cost' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggling "Show cost" to on keeps the board rendering (issue #189)', async () => {
    const user = userEvent.setup();
    renderBoard();
    const btn = screen.getByRole('button', { name: 'Show cost' });
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  describe('card information popover (issue #304)', () => {
    function getDraggableCardRoot(name: RegExp): HTMLElement {
      // The card root carries `aria-roledescription="draggable"`; child buttons
      // (chain icon, ··· menu) match by role but not by this attribute.
      return screen
        .getAllByRole('button', { name })
        .find((el) => el.getAttribute('aria-roledescription') === 'draggable')!;
    }

    it('clicking a card opens the popover dialog and shows task metadata', () => {
      renderBoard();
      const card = getDraggableCardRoot(/Backend Implementation/);
      fireEvent.click(card);
      const popover = screen.getByRole('dialog', { name: /^Backend Implementation$/ });
      expect(popover).toBeInTheDocument();
      // Esc closes the popover via the shell's keydown listener.
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(
        screen.queryByRole('dialog', { name: /^Backend Implementation$/ }),
      ).not.toBeInTheDocument();
    });

    it('clicking "Open detail" closes the popover and mounts the task detail drawer', () => {
      renderBoard();
      const card = getDraggableCardRoot(/Backend Implementation/);
      fireEvent.click(card);
      fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
      // Stubbed drawer mounts with `Task drawer <name>` accessible label.
      expect(
        screen.getByRole('dialog', { name: /Task drawer Backend Implementation/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('dialog', { name: /^Backend Implementation$/ }),
      ).not.toBeInTheDocument();
    });

    it('clicking "Edit" opens the unified TaskFormModal in edit mode (#305)', () => {
      renderBoard();
      const card = getDraggableCardRoot(/Backend Implementation/);
      fireEvent.click(card);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      // The redesigned modal header surfaces the task name as the dialog's
      // accessible name in edit mode (eyebrow `EDIT TASK` + title = task.name).
      expect(screen.getByRole('dialog', { name: /^Backend Implementation$/ })).toBeInTheDocument();
    });

    it('drawer onClose unmounts the drawer (selectedTaskId reset)', () => {
      renderBoard();
      const card = getDraggableCardRoot(/Backend Implementation/);
      fireEvent.click(card);
      fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
      expect(screen.queryByRole('dialog', { name: /Task drawer/ })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Issue #198 — "My tasks" filter
  // -------------------------------------------------------------------------

  describe('My tasks filter (#198)', () => {
    it('renders the My tasks pill', () => {
      renderBoard();
      expect(screen.getByRole('button', { name: 'My tasks' })).toBeInTheDocument();
    });

    it('toggling the pill calls setEnabled with the inverted value', async () => {
      const user = userEvent.setup();
      renderBoard();
      await user.click(screen.getByRole('button', { name: 'My tasks' }));
      expect(mockMyTasksFilter.setEnabled).toHaveBeenCalledWith(true);
    });

    it('shows the "Filter: My tasks" chip when active', () => {
      // Provide a matching resource so the chip renders on top of a
      // non-empty board (the empty state would also expose a "Show all"
      // button and ambiguate the assertion).
      mockProjectResourcePool = [
        { id: 'pr-1', resourceId: 'r1', resource: { id: 'r1', name: 'Alice', isMe: true } },
      ];
      mockMyTasksFilter = { ...mockMyTasksFilter, enabled: true };
      renderBoard();
      expect(screen.getByText('Filter: My tasks')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show all →' })).toBeInTheDocument();
    });

    it('does NOT show the chip when filter is off', () => {
      renderBoard();
      expect(screen.queryByText('Filter: My tasks')).not.toBeInTheDocument();
    });

    it('hides tasks not assigned to the current user when filter is active', () => {
      // Resource r1 == current user. In FIXTURE_TASKS "Discovery & Design"
      // and "Backend Implementation" include r1; tasks without r1 must
      // disappear with the filter on.
      mockProjectResourcePool = [
        { id: 'pr-1', resourceId: 'r1', resource: { id: 'r1', name: 'Alice Chen', isMe: true } },
      ];
      mockMyTasksFilter = { ...mockMyTasksFilter, enabled: true };
      renderBoard();
      // Alice-assigned tasks remain visible.
      expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
      // A task we know is not assigned to r1 — pick one with empty assignees
      // (Project Plan / Frontend MVP per FIXTURE_TASKS). Both should be gone.
      expect(screen.queryByText('Project Plan')).not.toBeInTheDocument();
    });

    it('renders dedicated empty state when filter is on and no tasks match', () => {
      // Pool is empty → resourceId is null → mineActive drops every task.
      mockMyTasksFilter = { ...mockMyTasksFilter, enabled: true };
      renderBoard();
      expect(screen.getByText('No tasks assigned to you in this project yet.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show all tasks' })).toBeInTheDocument();
    });

    it('"Show all tasks" empty-state button calls setEnabled(false)', async () => {
      const user = userEvent.setup();
      mockMyTasksFilter = { ...mockMyTasksFilter, enabled: true };
      renderBoard();
      await user.click(screen.getByRole('button', { name: 'Show all tasks' }));
      expect(mockMyTasksFilter.setEnabled).toHaveBeenCalledWith(false);
    });

    it('"Show all →" chip button calls setEnabled(false)', async () => {
      const user = userEvent.setup();
      // Need a matching resource so the empty state doesn't render — chip
      // appears on top of a non-empty board.
      mockProjectResourcePool = [
        { id: 'pr-1', resourceId: 'r1', resource: { id: 'r1', name: 'Alice', isMe: true } },
      ];
      mockMyTasksFilter = { ...mockMyTasksFilter, enabled: true };
      renderBoard();
      await user.click(screen.getByRole('button', { name: /Show all/ }));
      expect(mockMyTasksFilter.setEnabled).toHaveBeenCalledWith(false);
    });

    it('pill is disabled while filter state is hydrating', () => {
      mockMyTasksFilter = { ...mockMyTasksFilter, isLoading: true };
      renderBoard();
      const pill = screen.getByRole('button', { name: 'My tasks' });
      expect(pill).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Saved-view filter facets (issue #1918) — save captures the active
  // assignee/priority/due facets; applying a saved view restores them.
  // -------------------------------------------------------------------------
  describe('saved view filter facets (issue #1918)', () => {
    it('saving the current view includes the active facets in config.filters', async () => {
      // `delay: null` guards the CI keystroke-drop flake (#2084).
      const user = userEvent.setup({ delay: null });
      renderBoard();

      // Activate an assignee facet via the filter panel.
      await user.click(screen.getByTestId('board-filter-trigger'));
      await user.click(screen.getByTestId('facet-assignee-r1'));
      expect(screen.getByTestId('board-filter-count')).toHaveTextContent('1');

      // Save the current view.
      await user.click(screen.getByRole('button', { name: /board view/i }));
      await user.click(screen.getByText('+ Save current view…'));
      await user.type(screen.getByLabelText('View name'), 'My filtered view');
      // Let the name field fully commit before Save reads it (#2084).
      await waitFor(() =>
        expect(screen.getByLabelText('View name')).toHaveValue('My filtered view'),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      // Assert on the captured call args directly rather than a nested
      // expect.objectContaining (which loses type information here) — the
      // saved payload's name and its full config.filters must both land.
      expect(mockCreateMutate).toHaveBeenCalledTimes(1);
      const [firstCallArgs] = mockCreateMutate.mock.calls[0] as [{ name: string; config: BoardViewConfig }];
      expect(firstCallArgs.name).toBe('My filtered view');
      expect(firstCallArgs.config.filters).toEqual({
        assignees: ['r1'],
        priority: [],
        due: [],
        labels: [],
      });
    });

    it('saving with no active facets includes an explicit empty filter set', async () => {
      // `delay: null` guards the CI keystroke-drop flake (#2084).
      const user = userEvent.setup({ delay: null });
      renderBoard();

      await user.click(screen.getByRole('button', { name: /board view/i }));
      await user.click(screen.getByText('+ Save current view…'));
      await user.type(screen.getByLabelText('View name'), 'Unfiltered view');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockCreateMutate).toHaveBeenCalledTimes(1);
      const [firstCallArgs] = mockCreateMutate.mock.calls[0] as [{ name: string; config: BoardViewConfig }];
      expect(firstCallArgs.config.filters).toEqual({
        assignees: [],
        priority: [],
        due: [],
        labels: [],
      });
    });

    it('applying a saved view restores its stored facets and dims non-matching cards', async () => {
      const user = userEvent.setup();
      mockSavedViews = [
        {
          id: 'sv-1',
          name: 'Alice only',
          config: {
            sort: 'priority',
            showWip: true,
            showColTints: true,
            evmMode: 'off',
            showCost: false,
            riskLinkedOnly: false,
            filters: { assignees: ['r1'], priority: [], due: [], labels: [] },
          },
          schemaVersion: 2,
          createdBy: null,
          serverVersion: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      renderBoard();

      await user.click(screen.getByRole('button', { name: /board view/i }));
      await user.click(screen.getByText('Alice only'));

      // The restored facet shows up as an active-filter chip and the count badge.
      expect(screen.getByTestId('board-filter-chips')).toBeInTheDocument();
      expect(screen.getByTestId('board-filter-count')).toHaveTextContent('1');
    });

    it('applying a built-in quick filter clears any previously active facets', async () => {
      const user = userEvent.setup();
      renderBoard();

      await user.click(screen.getByTestId('board-filter-trigger'));
      await user.click(screen.getByTestId('facet-assignee-r1'));
      expect(screen.getByTestId('board-filter-count')).toHaveTextContent('1');

      await user.click(screen.getByRole('button', { name: /board view/i }));
      await user.click(screen.getByText('⚠ At risk'));

      expect(screen.queryByTestId('board-filter-chips')).not.toBeInTheDocument();
      expect(screen.queryByTestId('board-filter-count')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase-grid quieting (epic #361 child E, issue #385)
  // -------------------------------------------------------------------------
  describe('phase-grid quieting (issue #385)', () => {
    it('renders empty status cells as a quiet grid cell (column rule + tick), not a full card slot', () => {
      renderBoard();
      // The "Alpha Platform Upgrade" phase has no REVIEW cards in the fixture,
      // so its REVIEW cell stays quiet at rest (no drag active).
      const tickCells = document.querySelectorAll('[data-empty-cell="true"]');
      expect(tickCells.length).toBeGreaterThan(0);
      // Regridded in #1866: the empty cell carries the shared column rule
      // (`border-l border-neutral-border`) and stretches to fill its grid track
      // (grid `align-items: stretch`, floored at `min-h-[2rem]`) so the
      // phase×column grid reads as cells — but it stays quiet: no card outline,
      // no surface fill, no full occupied slot (`min-h-[120px]`), just the
      // `aria-hidden` centered tick.
      const wrapper = tickCells[0] as HTMLElement;
      expect(wrapper.className).toContain('border-l');
      expect(wrapper.className).toContain('border-neutral-border');
      expect(wrapper.className).toContain('min-h-[2rem]');
      expect(wrapper.className).not.toMatch(/min-h-\[120px\]/);
      // The quiet tick line is still present and decorative.
      expect(wrapper.querySelector('[aria-hidden="true"]')?.className).toContain('h-px');
    });

    it('column header renders a status dot prefix per status', () => {
      renderBoard();
      // The dot is `aria-hidden`; query by class on the header row that
      // contains each label so the structural assertion is grounded.
      const todoHeader = screen.getByText('TO DO').closest('div');
      expect(todoHeader?.querySelector('span[aria-hidden="true"]')?.className).toContain(
        'bg-neutral-text-disabled',
      );
      const inProgressHeader = screen.getByText('IN PROGRESS').closest('div');
      expect(inProgressHeader?.querySelector('span[aria-hidden="true"]')?.className).toContain(
        'bg-brand-primary',
      );
      const reviewHeader = screen.getByText('REVIEW').closest('div');
      expect(reviewHeader?.querySelector('span[aria-hidden="true"]')?.className).toContain(
        'bg-brand-accent',
      );
      const doneHeader = screen.getByText('DONE').closest('div');
      expect(doneHeader?.querySelector('span[aria-hidden="true"]')?.className).toContain(
        'bg-semantic-on-track',
      );
    });

    it('column count chip uses tppm-mono', () => {
      renderBoard();
      // Pick the IN PROGRESS column header — its count chip is the second
      // child after the dot+label combo.
      const inProgressHeader = screen.getByText('IN PROGRESS').closest('div');
      const monoCount = inProgressHeader?.querySelector('.tppm-mono');
      expect(monoCount).toBeTruthy();
    });
  });

  describe('phase rollup % (matches CP rollup gate)', () => {
    // The rollup denominator drops uncommitted tasks (no plannedStart, no
    // sprintId) — same isTaskScheduled gate the CP/float chips use. An
    // unscheduled To Do is a 0%-progress task in the data but represents work
    // the PM hasn't committed to; counting it would drag the rollup down by
    // counting backlog ideas against delivery.
    it('excludes unscheduled tasks from the average', () => {
      const base: Omit<Task, 'id' | 'name' | 'plannedStart' | 'progress' | 'status'> = {
        wbs: '',
        isSummary: false,
        isMilestone: false,
        parentId: null,
        isCritical: false,
        isComplete: false,
        assignees: [],
        notes: '',
        start: '2026-10-05',
        finish: '2026-10-05',
        duration: 0,
      };
      mockTasks = [
        // Two committed (plannedStart set) tasks, both 100% — committed avg = 100%.
        {
          ...base,
          id: 'c1',
          name: 'Done one',
          plannedStart: '2026-10-05',
          progress: 100,
          status: 'COMPLETE',
        },
        {
          ...base,
          id: 'c2',
          name: 'Done two',
          plannedStart: '2026-10-05',
          progress: 100,
          status: 'COMPLETE',
        },
        // Two unscheduled (plannedStart=null, no sprint) To Dos at 0% — would
        // pull the naive average to 50% if they were counted.
        {
          ...base,
          id: 'u1',
          name: 'Idea one',
          plannedStart: null,
          progress: 0,
          status: 'NOT_STARTED',
        },
        {
          ...base,
          id: 'u2',
          name: 'Idea two',
          plannedStart: null,
          progress: 0,
          status: 'NOT_STARTED',
        },
      ];
      renderBoard();
      // The synthetic Project Tasks lane renders one progressbar; assert that
      // the rollup reads 100%, not 50%.
      const bar = screen.getByRole('progressbar', { name: /Phase progress 100 percent/i });
      expect(bar).toHaveAttribute('aria-valuenow', '100');
    });

    it('shows the em-dash empty state when every card is uncommitted', () => {
      const base: Omit<Task, 'id' | 'name' | 'plannedStart' | 'progress' | 'status'> = {
        wbs: '',
        isSummary: false,
        isMilestone: false,
        parentId: null,
        isCritical: false,
        isComplete: false,
        assignees: [],
        notes: '',
        start: '2026-10-05',
        finish: '2026-10-05',
        duration: 0,
      };
      mockTasks = [
        {
          ...base,
          id: 'u1',
          name: 'Idea one',
          plannedStart: null,
          progress: 0,
          status: 'NOT_STARTED',
        },
        {
          ...base,
          id: 'u2',
          name: 'Idea two',
          plannedStart: null,
          progress: 0,
          status: 'NOT_STARTED',
        },
      ];
      renderBoard();
      // No committed delivery → progressbar reads "No committed tasks", not
      // a misleading "0%". The em-dash is in the visible label.
      expect(screen.getByRole('progressbar', { name: /No committed tasks/i })).toBeInTheDocument();
    });

    it('reads the phase summary task percent_complete, not the leaf mean (#991/ADR-0115)', () => {
      // A real phase (WBS L1 summary task) carries the server-owned, delivery-mode-
      // weighted rollup (ADR-0108). The lane renders that, not a divergent client mean.
      const base: Omit<Task, 'id' | 'name' | 'plannedStart' | 'progress' | 'status'> = {
        wbs: '',
        isSummary: false,
        isMilestone: false,
        parentId: null,
        isCritical: false,
        isComplete: false,
        assignees: [],
        notes: '',
        start: '2026-10-05',
        finish: '2026-10-05',
        duration: 0,
      };
      mockTasks = [
        // Phase header carries the server rollup (72%).
        {
          ...base,
          id: 's1',
          name: 'Build Phase',
          isSummary: true,
          progress: 72,
          plannedStart: '2026-10-05',
          status: 'IN_PROGRESS',
        },
        // Two committed leaves whose naive mean (100 + 0)/2 = 50% must NOT win.
        {
          ...base,
          id: 'l1',
          name: 'Leaf done',
          parentId: 's1',
          progress: 100,
          plannedStart: '2026-10-05',
          status: 'COMPLETE',
        },
        {
          ...base,
          id: 'l2',
          name: 'Leaf todo',
          parentId: 's1',
          progress: 0,
          plannedStart: '2026-10-05',
          status: 'IN_PROGRESS',
        },
      ];
      renderBoard();
      const bar = screen.getByRole('progressbar', { name: /Phase progress 72 percent/i });
      expect(bar).toHaveAttribute('aria-valuenow', '72');
    });
  });
});

describe('WIP-creep trend arrow (issue #1213)', () => {
  beforeEach(() => {
    resetMocks();
  });

  // Builds a flow-metrics payload whose CFD carries the given per-status series
  // (oldest→newest). Only the fields BoardView reads for the trend matter.
  function flowMetricsWith(
    seriesByStatus: Partial<Record<TaskStatus, number[]>>,
    opts: { suppressed?: boolean } = {},
  ): FlowMetrics {
    const days = Math.max(1, ...Object.values(seriesByStatus).map((s) => s?.length ?? 0));
    const cfd = Array.from({ length: days }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      counts: {
        BACKLOG: seriesByStatus.BACKLOG?.[i] ?? 0,
        NOT_STARTED: seriesByStatus.NOT_STARTED?.[i] ?? 0,
        IN_PROGRESS: seriesByStatus.IN_PROGRESS?.[i] ?? 0,
        REVIEW: seriesByStatus.REVIEW?.[i] ?? 0,
        COMPLETE: seriesByStatus.COMPLETE?.[i] ?? 0,
      },
    }));
    return {
      window_days: days,
      since: '2026-06-01',
      until: `2026-06-${String(days).padStart(2, '0')}`,
      cycle_time: { p50: null, p80: null, p95: null },
      lead_time: { p50: null, p80: null, p95: null },
      cfd,
      throughput: [],
      data_integrity: { bulk_moved_count: 0, backdated_count: 0, missing_transition_count: 0 },
      flow_metrics_suppressed: opts.suppressed ?? false,
    };
  }

  it('renders no arrow when there is no flow-metrics data', () => {
    mockFlowMetrics = undefined;
    renderBoard();
    expect(screen.queryByTestId('wip-trend-arrow')).toBeNull();
  });

  it('renders a rising, at-risk arrow for a column creeping toward its limit', () => {
    // IN_PROGRESS limit is 3; series climbs 0→3 → rising and within one card.
    mockFlowMetrics = flowMetricsWith({ IN_PROGRESS: [0, 1, 2, 3] });
    renderBoard();
    const arrow = screen.getByTestId('wip-trend-arrow');
    expect(arrow).toHaveAttribute('data-trend', 'rising');
    expect(arrow).toHaveAttribute('data-approaching', 'true');
    expect(arrow).toHaveAccessibleName('trending up toward WIP limit');
    expect(arrow).toHaveTextContent('▲');
  });

  it('renders a neutral rising arrow when the column is comfortably under its limit', () => {
    // REVIEW limit is 2; a series that ends at 0 rising from... use IN_PROGRESS
    // with a high headroom scenario: raise the limit implicitly by picking a
    // column whose latest is far below limit. IN_PROGRESS limit 3, series 0→1.
    mockFlowMetrics = flowMetricsWith({ IN_PROGRESS: [0, 0, 0, 1] });
    renderBoard();
    const arrow = screen.getByTestId('wip-trend-arrow');
    expect(arrow).toHaveAttribute('data-trend', 'rising');
    expect(arrow).toHaveAttribute('data-approaching', 'false');
    expect(arrow).toHaveAccessibleName('trending up');
  });

  it('renders a falling arrow for a recovering column', () => {
    // REVIEW limit 2; series falls 3→0.
    mockFlowMetrics = flowMetricsWith({ REVIEW: [3, 3, 1, 0] });
    renderBoard();
    const arrow = screen.getByTestId('wip-trend-arrow');
    expect(arrow).toHaveAttribute('data-trend', 'falling');
    expect(arrow).toHaveAttribute('data-approaching', 'false');
    expect(arrow).toHaveAccessibleName('trending down');
    expect(arrow).toHaveTextContent('▼');
  });

  it('renders NO arrow for a column without a WIP limit even if its series rises', () => {
    // NOT_STARTED has no wipLimit configured → a trend toward "no limit" is
    // meaningless, so no arrow despite a clearly rising series.
    mockFlowMetrics = flowMetricsWith({ NOT_STARTED: [0, 2, 5, 9] });
    renderBoard();
    expect(screen.queryByTestId('wip-trend-arrow')).toBeNull();
  });

  it('renders NO arrow when flow metrics are suppressed (ADR-0104)', () => {
    // Same rising IN_PROGRESS series, but the reader is below the flow_metrics
    // audience — the trend (team-private CFD) must not leak.
    mockFlowMetrics = flowMetricsWith({ IN_PROGRESS: [0, 1, 2, 3] }, { suppressed: true });
    renderBoard();
    expect(screen.queryByTestId('wip-trend-arrow')).toBeNull();
  });

  it('renders one arrow per qualifying column, independent of breach state', () => {
    // IN_PROGRESS (limit 3, rising) and REVIEW (limit 2, falling) both qualify;
    // COMPLETE / NOT_STARTED have no limit → no arrow.
    mockFlowMetrics = flowMetricsWith({
      IN_PROGRESS: [0, 1, 2, 3],
      REVIEW: [2, 2, 1, 0],
      COMPLETE: [0, 1, 2, 8],
    });
    renderBoard();
    const arrows = screen.getAllByTestId('wip-trend-arrow');
    expect(arrows).toHaveLength(2);
    const trends = arrows.map((a) => a.getAttribute('data-trend')).sort();
    expect(trends).toEqual(['falling', 'rising']);
  });
});

// ---------------------------------------------------------------------------
// Collapsed-column stub signals (#1695 WIP breach, #1697 folded≠empty, #1696
// your-cards-inside). A stub is a lens on the column, not a place to hide a
// signal the expanded header would show.
// ---------------------------------------------------------------------------
describe('collapsed column stub signals (#1695/#1696/#1697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  // A single IN_PROGRESS leaf (summary tasks become phases and are excluded
  // from the per-status totals, so leaves keep the count deterministic).
  const ipLeaf = (id: string, name: string, extra: Partial<Task> = {}): Task => ({
    ...FIXTURE_TASKS[1],
    id,
    name,
    isSummary: false,
    isMilestone: false,
    parentId: null,
    status: 'IN_PROGRESS',
    progress: 30,
    assignees: [],
    ...extra,
  });

  const collapse = (user: UE, label: string) =>
    user.click(screen.getByRole('button', { name: `Collapse ${label} column` }));

  it('keeps a WIP breach visible on the stub with "Show WIP limits" off (#1695)', async () => {
    const user = userEvent.setup();
    // 2 IN_PROGRESS cards against a limit of 1 → over.
    mockTasks = [ipLeaf('ip1', 'Wire consumer'), ipLeaf('ip2', 'Backfill cache')];
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    // Turn "Show WIP limits" off — the numeric limit on a *non-breaching* count
    // hides, but a breach must not.
    await openMore(user);
    await user.click(screen.getByLabelText('Show WIP limits'));
    await collapse(user, 'IN PROGRESS');

    const stub = screen.getByTestId('column-stub-IN_PROGRESS');
    expect(stub).toHaveAttribute('data-wip-state', 'over');
    // Breach renders the N/limit ratio in the breach color, toggle notwithstanding.
    expect(stub).toHaveTextContent('2/1');
    expect(stub).toHaveAccessibleName(/over WIP limit of 1/);
  });

  it('renders a plain count (no limit) on a non-breaching stub with the toggle off', async () => {
    const user = userEvent.setup();
    // 2 IN_PROGRESS cards, limit 5 → under. Toggle off → plain count, no "/5".
    mockTasks = [ipLeaf('ip1', 'A'), ipLeaf('ip2', 'B')];
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 5 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    renderBoard();
    await openMore(user);
    await user.click(screen.getByLabelText('Show WIP limits'));
    await collapse(user, 'IN PROGRESS');

    const stub = screen.getByTestId('column-stub-IN_PROGRESS');
    expect(stub).toHaveAttribute('data-wip-state', 'under');
    expect(stub).toHaveTextContent('2');
    expect(stub).not.toHaveTextContent('2/5');
  });

  it('renders a dashed hollow-0 stub for an empty column (folded ≠ empty, #1697)', async () => {
    const user = userEvent.setup();
    renderBoard(); // default fixture: REVIEW column holds 0 cards
    await collapse(user, 'REVIEW');

    const stub = screen.getByTestId('column-stub-REVIEW');
    expect(stub).toHaveAccessibleName(/Expand REVIEW column, empty/);
    // The count badge drops its fill for a dashed hollow ring.
    const badge = within(stub).getByText('0');
    expect(badge.className).toContain('border-dashed');
  });

  it('renders a filled count (not the hollow-0) for a populated stub', async () => {
    const user = userEvent.setup();
    mockTasks = [ipLeaf('ip1', 'A'), ipLeaf('ip2', 'B')];
    renderBoard();
    await collapse(user, 'IN PROGRESS');

    const stub = screen.getByTestId('column-stub-IN_PROGRESS');
    expect(stub).toHaveAccessibleName(/2 tasks/);
    expect(stub.querySelector('.border-dashed')).toBeNull();
  });

  it("marks a stub holding the current user's cards and offers a banner expand (#1696)", async () => {
    const user = userEvent.setup();
    mockProjectResourcePool = [
      { id: 'pr-me', resourceId: 'r-me', resource: { id: 'r-me', name: 'Me', isMe: true } },
    ];
    // One of my cards + one someone else's, both IN_PROGRESS.
    mockTasks = [
      ipLeaf('ip1', 'Mine', { assignees: [{ resourceId: 'r-me', name: 'Me', units: 1 }] }),
      ipLeaf('ip2', 'Theirs', { assignees: [{ resourceId: 'r-other', name: 'Other', units: 1 }] }),
    ];
    renderBoard();
    await collapse(user, 'IN PROGRESS');

    const stub = screen.getByTestId('column-stub-IN_PROGRESS');
    expect(stub).toHaveAttribute('data-has-my-cards', 'true');
    expect(stub).toHaveAccessibleName(/contains 1 of your card/);

    // Banner clause names the count and expands the affected column on click.
    const expandMine = screen.getByTestId('expand-my-hidden-columns');
    expect(expandMine).toHaveTextContent('1 of your card hidden');
    expect(expandMine).toHaveAccessibleName('Expand columns containing your cards');
    await user.click(expandMine);
    expect(screen.queryByTestId('column-stub-IN_PROGRESS')).toBeNull();
  });

  it('shows no your-cards signal when the user has no resource identity', async () => {
    const user = userEvent.setup();
    // Default pool → no isMe resource → myResourceId is null.
    mockTasks = [
      ipLeaf('ip1', 'A', { assignees: [{ resourceId: 'r-other', name: 'Other', units: 1 }] }),
    ];
    renderBoard();
    await collapse(user, 'IN PROGRESS');

    const stub = screen.getByTestId('column-stub-IN_PROGRESS');
    expect(stub).not.toHaveAttribute('data-has-my-cards');
    expect(screen.queryByTestId('expand-my-hidden-columns')).toBeNull();
  });
});

describe('per-cell card cap (issue 1967, ADR-0420)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  // A committed leaf (plannedStart is inherited from FIXTURE_TASKS[1]) in a
  // WIP-limitless column (TO DO) so the cap — not a breach — governs it. Calm by
  // default: not critical/blocked/late, unassigned (the resource pool is empty
  // so my-own never fires).
  const leaf = (id: string, name: string, extra: Partial<Task> = {}): Task => ({
    ...FIXTURE_TASKS[1],
    id,
    name,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    isComplete: false,
    isBlocked: false,
    blockedAgeSeconds: null,
    totalFloat: 5,
    readiness: 'ready',
    parentId: null,
    status: 'NOT_STARTED',
    progress: 10,
    assignees: [],
    ...extra,
  });

  function enableCap(cap = 6) {
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ cellCap: cap }));
  }

  const cardCount = () => screen.getAllByRole('button', { name: /% complete/i }).length;

  it('does not cap when the pref is off (default) — the full stack renders', () => {
    mockTasks = Array.from({ length: 8 }, (_, i) => leaf(`c${i}`, `Card ${i + 1}`));
    renderBoard();
    expect(cardCount()).toBe(8);
    expect(screen.queryByTestId('cell-overflow-toggle')).toBeNull();
  });

  it('collapses the calm overflow behind a "+N more" disclosure when the cap is on', () => {
    enableCap(6);
    mockTasks = Array.from({ length: 8 }, (_, i) => leaf(`c${i}`, `Card ${i + 1}`));
    renderBoard();
    // 8 calm cards, cap 6 → 6 visible, 2 hidden.
    expect(cardCount()).toBe(6);
    const toggle = screen.getByTestId('cell-overflow-toggle');
    expect(toggle).toHaveAttribute('aria-label', 'Show 2 more cards');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not collapse a single overflow card (min-overflow threshold)', () => {
    enableCap(6);
    // cap 6, 7 cards → hiding 1 is friction; show all, no toggle.
    mockTasks = Array.from({ length: 7 }, (_, i) => leaf(`c${i}`, `Card ${i + 1}`));
    renderBoard();
    expect(cardCount()).toBe(7);
    expect(screen.queryByTestId('cell-overflow-toggle')).toBeNull();
  });

  it('expands to show every card when the disclosure is clicked, then collapses again', async () => {
    const user = userEvent.setup();
    enableCap(6);
    mockTasks = Array.from({ length: 8 }, (_, i) => leaf(`c${i}`, `Card ${i + 1}`));
    renderBoard();
    await user.click(screen.getByTestId('cell-overflow-toggle'));
    expect(cardCount()).toBe(8);
    expect(screen.getByTestId('cell-overflow-toggle')).toHaveAttribute(
      'aria-label',
      'Show fewer cards',
    );
    expect(screen.getByTestId('cell-overflow-toggle')).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByTestId('cell-overflow-toggle'));
    expect(cardCount()).toBe(6);
  });

  it('never caps a WIP-breached cell — the overload pile stays fully visible', () => {
    enableCap(6);
    // 8 cards in IN_PROGRESS (wipLimit 3, showWip on) → over-limit → exempt.
    mockTasks = Array.from({ length: 8 }, (_, i) =>
      leaf(`c${i}`, `Card ${i + 1}`, { status: 'IN_PROGRESS' }),
    );
    renderBoard();
    expect(cardCount()).toBe(8);
    expect(screen.queryByTestId('cell-overflow-toggle')).toBeNull();
  });

  it('keeps exception cards (critical path) visible even past the cap', () => {
    enableCap(6);
    // 6 calm + 2 critical = 8 in TO DO. Both critical (exceptions) stay visible +
    // 4 calm fill the cap → 6 visible, 2 calm overflow.
    const calm = Array.from({ length: 6 }, (_, i) => leaf(`calm${i}`, `Calm ${i + 1}`));
    const crit = [1, 2].map((n) => leaf(`crit${n}`, `Critical ${n}`, { isCritical: true }));
    mockTasks = [...calm, ...crit];
    renderBoard();
    expect(
      screen.getByRole('button', { name: /Critical 1,.*% complete/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Critical 2,.*% complete/i }),
    ).toBeInTheDocument();
    expect(cardCount()).toBe(6);
    expect(screen.getByTestId('cell-overflow-toggle')).toHaveAttribute(
      'aria-label',
      'Show 2 more cards',
    );
  });

  it('exposes the "Cap tall cells" toggle in the More menu', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    expect(screen.getByRole('checkbox', { name: /Cap tall cells/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Card sort order (sortTasksBy) — the Sort chip reorders every column's stack.
// Each sort key produces a distinct order for the fixture below so the three
// branches (priority / start_date / percent_complete) are exercised, not just
// selected.
// ---------------------------------------------------------------------------
describe('card sort order (Sort chip)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  // Three leaf cards in a single TO DO (NOT_STARTED) root cell whose priority,
  // start date, and progress each impose a *different* order.
  const sortLeaf = (
    id: string,
    name: string,
    o: { priorityRank: number; start: string; progress: number },
  ): Task => ({
    ...FIXTURE_TASKS[4], // t5: NOT_STARTED, unassigned, committed
    id,
    name,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    parentId: null,
    status: 'NOT_STARTED',
    priorityRank: o.priorityRank,
    start: o.start,
    plannedStart: o.start,
    progress: o.progress,
  });

  function setSortCards() {
    mockTasks = [
      sortLeaf('a', 'Apple', { priorityRank: 2, start: '2026-03-01', progress: 10 }),
      sortLeaf('b', 'Banana', { priorityRank: 3, start: '2026-01-01', progress: 50 }),
      sortLeaf('c', 'Cherry', { priorityRank: 1, start: '2026-02-01', progress: 90 }),
    ];
  }

  const cardOrder = () =>
    screen
      .getAllByRole('button', { name: /% complete/i })
      .map((b) => b.getAttribute('aria-label')!.split(',')[0]);

  async function chooseSort(user: UE, optionLabel: string) {
    await user.click(screen.getByRole('button', { name: 'Sort tasks by' }));
    await user.click(screen.getByRole('radio', { name: optionLabel }));
  }

  it('sorts by priority rank ascending (lowest rank first)', async () => {
    const user = userEvent.setup();
    setSortCards();
    renderBoard();
    await chooseSort(user, 'Priority');
    // rank 1 (Cherry) → 2 (Apple) → 3 (Banana)
    expect(cardOrder()).toEqual(['Cherry', 'Apple', 'Banana']);
  });

  it('sorts by start date ascending (earliest first)', async () => {
    const user = userEvent.setup();
    setSortCards();
    renderBoard();
    await chooseSort(user, 'Start date');
    // Jan (Banana) → Feb (Cherry) → Mar (Apple)
    expect(cardOrder()).toEqual(['Banana', 'Cherry', 'Apple']);
  });

  it('sorts by percent complete descending (most complete first)', async () => {
    const user = userEvent.setup();
    setSortCards();
    renderBoard();
    await chooseSort(user, '% complete');
    // 90 (Cherry) → 50 (Banana) → 10 (Apple)
    expect(cardOrder()).toEqual(['Cherry', 'Banana', 'Apple']);
  });
});

// ---------------------------------------------------------------------------
// Swimlane grouping (Group chip) — assignee and epic lenses build lanes from a
// different axis than the default WBS phase grouping.
// ---------------------------------------------------------------------------
describe('swimlane grouping (Group chip)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  async function chooseGroup(user: UE, optionLabel: string) {
    await user.click(screen.getByRole('button', { name: 'Group lanes by' }));
    await user.click(screen.getByRole('radio', { name: optionLabel }));
  }

  it('groups lanes by primary assignee with an Unassigned lane pinned last', async () => {
    const user = userEvent.setup();
    renderBoard(); // default fixture has Alice/Bob/Carol assignees + unassigned t5/t6
    await chooseGroup(user, 'By assignee');

    // A lane per primary assignee (t2/t3 → Alice, t7 → Bob, t4 → Carol) …
    expect(screen.getByRole('group', { name: 'Alice Chen swimlane' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Bob Martinez swimlane' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Carol Park swimlane' })).toBeInTheDocument();
    // … plus the catch-all for the unassigned leaves (t5 QA, t6 Go-Live).
    expect(screen.getByRole('group', { name: 'Unassigned swimlane' })).toBeInTheDocument();
    // The WBS phase lane header is gone in assignee mode.
    expect(
      screen.queryByRole('group', { name: 'Alpha Platform Upgrade swimlane' }),
    ).toBeNull();
  });

  it('collapses every card into a single "(No epic)" lane when no task has a parent epic', async () => {
    const user = userEvent.setup();
    renderBoard(); // fixture tasks carry no parentEpic
    await chooseGroup(user, 'By epic');

    expect(screen.getByRole('group', { name: '(No epic) swimlane' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Unassigned swimlane' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mobile snap-scroll board (v3 case 8). Rendered only when the viewport reports
// the mobile tier — the phase × status grid collapses to per-status pages.
// ---------------------------------------------------------------------------
describe('mobile snap-scroll board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(makeMq(true));
    // Without an *explicit* layout choice the board auto-selects the queue layout
    // on mobile (resolveBoardLayout), which suppresses MobileBoard. Pin an explicit
    // 'rail' layout so the snap-scroll board renders on the mobile tier.
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ layout: 'rail' }));
    // jsdom has no layout — stub the scroll used by tap-to-jump.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders the snap-scroll scroller with one page per visible status column', () => {
    renderBoard();
    expect(screen.getByTestId('mobile-board-scroller')).toBeInTheDocument();
    // BACKLOG is lifted to the band (ADR-0057); the four grid statuses page.
    const pages = screen
      .getByTestId('mobile-board-scroller')
      .querySelectorAll('[data-mobile-column="true"]');
    expect(pages).toHaveLength(4);
  });

  it('renders the per-column empty prompt for a status with no cards', () => {
    renderBoard(); // REVIEW holds 0 fixture cards
    expect(screen.getByText('Nothing here yet — drag a card in.')).toBeInTheDocument();
  });

  it('surfaces each column as a labeled region with its task count', () => {
    renderBoard();
    // IN_PROGRESS holds t3/t4/t7 → 3 cards.
    expect(screen.getByRole('region', { name: 'IN PROGRESS, 3 tasks' })).toBeInTheDocument();
    // NOT_STARTED holds t5/t6 → 2 cards.
    expect(screen.getByRole('region', { name: 'TO DO, 2 tasks' })).toBeInTheDocument();
  });

  it('tapping a strip segment jumps to and marks that column active', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderBoard();
    // The strip's first segment (TO DO) starts active.
    const todoSeg = screen.getByRole('button', { name: 'TO DO, 2 tasks' });
    expect(todoSeg).toHaveAttribute('aria-current', 'true');

    // Jump to DONE — scrollIntoView is invoked and the active marker moves.
    const doneSeg = screen.getByRole('button', { name: 'DONE, 1 task' });
    await user.click(doneSeg);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(doneSeg).toHaveAttribute('aria-current', 'true');
    expect(todoSeg).not.toHaveAttribute('aria-current');
  });

  it('does not render the desktop phase swimlane grid on mobile', () => {
    renderBoard();
    expect(screen.queryByRole('group', { name: 'Alpha Platform Upgrade swimlane' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Board zoom stepper (issue 379) — an independent spacing axis from Density.
// ---------------------------------------------------------------------------
describe('board zoom stepper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('steps zoom up and down and persists the choice, board still renders', async () => {
    const user = userEvent.setup();
    renderBoard();
    // BoardZoomControl exposes two stepper buttons.
    const zoomIn = screen.getByRole('button', { name: /zoom in/i });
    const zoomOut = screen.getByRole('button', { name: /zoom out/i });
    await user.click(zoomIn);
    // Board is unaffected structurally — phase lane still present.
    expect(screen.getByRole('group', { name: 'Alpha Platform Upgrade swimlane' })).toBeInTheDocument();
    await user.click(zoomOut);
    expect(screen.getByRole('group', { name: 'Alpha Platform Upgrade swimlane' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Queue layout (effectiveLayout === 'queue') — the flat, priority-ordered list
// alternative to the phase × status grid.
// ---------------------------------------------------------------------------
describe('queue layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
    // Explicit queue layout — on desktop resolveBoardLayout returns the stored
    // value verbatim, so the queue list renders in place of the phase grid.
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ layout: 'queue' }));
  });

  it('renders the flat queue list (rows) instead of the phase swimlane grid', () => {
    renderBoard();
    // Leaf fixture tasks become queue rows …
    expect(screen.getByTestId('queue-row-t3')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-t7')).toBeInTheDocument();
    // … and the phase-grid swimlane is not rendered in queue mode.
    expect(screen.queryByRole('group', { name: 'Alpha Platform Upgrade swimlane' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lens filters (At-risk / Tech debt) in the queue layout — the quiet pill
// toggles remove non-matching rows from the flat queue (queueTasks filter).
// ---------------------------------------------------------------------------
describe('lens filters (At-risk / Tech debt)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ layout: 'queue' }));
  });

  const leaf = (id: string, name: string, extra: Partial<Task> = {}): Task => ({
    ...FIXTURE_TASKS[4], // NOT_STARTED, unassigned, committed
    id,
    name,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    parentId: null,
    status: 'NOT_STARTED',
    assignees: [],
    ...extra,
  });

  it('At-risk toggle removes cards with no linked risk from the queue', async () => {
    const user = userEvent.setup();
    mockTasks = [
      leaf('risky', 'Has Risk', { linkedRisksCount: 2 }),
      leaf('clean', 'No Risk', { linkedRisksCount: 0 }),
    ];
    renderBoard();
    // Both rows present before the lens is applied.
    expect(screen.getByTestId('queue-row-risky')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-clean')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Risk-linked only' }));
    expect(screen.getByTestId('queue-row-risky')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-row-clean')).toBeNull();
  });

  it('Tech debt toggle removes non-tech-debt cards from the queue', async () => {
    const user = userEvent.setup();
    mockTasks = [
      leaf('debt', 'Refactor', { taskType: 'tech_debt' }),
      leaf('feature', 'New Feature', { taskType: 'task' }),
    ];
    renderBoard();
    expect(screen.getByTestId('queue-row-debt')).toBeInTheDocument();
    expect(screen.getByTestId('queue-row-feature')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tech-debt only' }));
    expect(screen.getByTestId('queue-row-debt')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-row-feature')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workshop exit-confirm dialog focus trap (Tab cycling). The Escape path is
// covered above; this exercises the Tab / Shift+Tab wrap.
// ---------------------------------------------------------------------------
describe('workshop exit dialog focus trap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  async function openExitDialog(user: UE) {
    mockWorkshopSession = {
      id: 'session-uuid',
      project_id: 'project-1',
      started_by_id: 'user-1',
      started_at: '2026-04-29T10:00:00Z',
      ended_at: null,
      participants: [],
    };
    startWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    await user.click(screen.getByRole('button', { name: 'Exit workshop mode' }));
    return screen.getByRole('dialog', { name: /End workshop session/ });
  }

  it('Tab from the last control wraps focus to the first', async () => {
    const user = userEvent.setup();
    const dialog = await openExitDialog(user);
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first control wraps focus to the last', async () => {
    const user = userEvent.setup();
    const dialog = await openExitDialog(user);
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

// ---------------------------------------------------------------------------
// Collapsed-column WIP-breach popover (issue 1459, VoC Alex). Folding a column
// that sits at/over its WIP limit keeps the breach visible as a tappable chip
// in the collapsed-columns banner; the popover lists every breaching column and
// each row re-expands its column. Default fixture: IN_PROGRESS holds t3/t4/t7 =
// 3 cards against its limit of 3 → an at-limit breach the instant it folds.
// ---------------------------------------------------------------------------
describe('collapsed-column WIP breach popover (#1459)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  const collapse = (user: UE, label: string) =>
    user.click(screen.getByRole('button', { name: `Collapse ${label} column` }));

  it('surfaces an "at WIP limit" breach chip when a full column is collapsed', async () => {
    const user = userEvent.setup();
    renderBoard();
    await collapse(user, 'IN PROGRESS');

    expect(screen.getByTestId('collapsed-columns-banner')).toHaveTextContent('1 column collapsed');
    const trigger = screen.getByTestId('collapsed-wip-trigger');
    expect(trigger).toHaveTextContent('1 at WIP limit');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The folded column renders as a header stub, not a full column.
    expect(screen.getByTestId('column-stub-IN_PROGRESS')).toBeInTheDocument();
  });

  it('opens the breach popover and re-expands the column from a row click', async () => {
    const user = userEvent.setup();
    renderBoard();
    await collapse(user, 'IN PROGRESS');

    await user.click(screen.getByTestId('collapsed-wip-trigger'));
    const popover = screen.getByTestId('collapsed-wip-popover');
    expect(popover).toBeInTheDocument();
    // The row carries the column label, its N/limit, and the at/over verdict.
    const row = within(popover).getByRole('button', {
      name: 'Expand IN PROGRESS column, 3 of 3, at limit',
    });
    await user.click(row);
    // Column restored (stub gone) and popover dismissed.
    expect(screen.queryByTestId('column-stub-IN_PROGRESS')).toBeNull();
    expect(screen.queryByTestId('collapsed-wip-popover')).toBeNull();
  });

  it('closes the breach popover on Escape', async () => {
    const user = userEvent.setup();
    renderBoard();
    await collapse(user, 'IN PROGRESS');
    await user.click(screen.getByTestId('collapsed-wip-trigger'));
    expect(screen.getByTestId('collapsed-wip-popover')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('collapsed-wip-popover')).toBeNull();
  });

  it('closes the breach popover on an outside pointerdown', async () => {
    const user = userEvent.setup();
    renderBoard();
    await collapse(user, 'IN PROGRESS');
    await user.click(screen.getByTestId('collapsed-wip-trigger'));
    expect(screen.getByTestId('collapsed-wip-popover')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('collapsed-wip-popover')).toBeNull();
  });

  it('"Expand all →" restores every collapsed column and clears the banner', async () => {
    const user = userEvent.setup();
    renderBoard();
    await collapse(user, 'IN PROGRESS');
    await collapse(user, 'DONE');
    expect(screen.getByTestId('collapsed-columns-banner')).toHaveTextContent(
      '2 columns collapsed',
    );

    await user.click(screen.getByTestId('expand-all-columns'));
    expect(screen.queryByTestId('collapsed-columns-banner')).toBeNull();
    expect(screen.queryByTestId('column-stub-IN_PROGRESS')).toBeNull();
  });

  it('shows no breach chip when only an under-limit column is collapsed', async () => {
    const user = userEvent.setup();
    renderBoard();
    // DONE holds one card and carries no WIP limit → banner, but no breach chip.
    await collapse(user, 'DONE');
    expect(screen.getByTestId('collapsed-columns-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('collapsed-wip-trigger')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase-lane focus mode (issue 1460, ADR-0192 Part 3). Focusing a lane zooms
// the board to that single lane (?focus=<id>) and renders an inescapable exit
// banner so a board narrowed to one lane never reads as "lost lanes".
// ---------------------------------------------------------------------------
describe('phase-lane focus mode (#1460)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('focusing a lane hides the other lanes and shows an escape banner', async () => {
    const user = userEvent.setup();
    renderBoard();
    // Both the Alpha phase lane and the Project Tasks (root) lane render by default.
    expect(
      screen.getByRole('group', { name: 'Alpha Platform Upgrade swimlane' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Project Tasks swimlane' })).toBeInTheDocument();

    // Focus the Alpha lane via its focus toggle (keyed by summary-task id t1).
    await user.click(screen.getByTestId('focus-lane-t1'));

    const banner = screen.getByTestId('focus-banner');
    expect(banner).toHaveTextContent('Alpha Platform Upgrade');
    // Only the focused lane survives; the root lane is hidden.
    expect(
      screen.getByRole('group', { name: 'Alpha Platform Upgrade swimlane' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Project Tasks swimlane' })).toBeNull();
  });

  it('exits focus mode from the banner, restoring all lanes', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByTestId('focus-lane-t1'));
    expect(screen.getByTestId('focus-banner')).toBeInTheDocument();

    await user.click(screen.getByTestId('exit-focus'));
    expect(screen.queryByTestId('focus-banner')).toBeNull();
    expect(screen.getByRole('group', { name: 'Project Tasks swimlane' })).toBeInTheDocument();
  });

  it('re-clicking the focused lane toggle clears focus', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByTestId('focus-lane-t1'));
    expect(screen.getByTestId('focus-banner')).toBeInTheDocument();
    // The toggle is now pressed; clicking it again exits focus.
    expect(screen.getByTestId('focus-lane-t1')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('focus-lane-t1'));
    expect(screen.queryByTestId('focus-banner')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyboard card navigation (issue #195). J/K move focus within a status column
// across phases; L/H move across columns within a phase, skipping empty cells.
// Focus is set by a pointer-down on a card (no popover) and the keyboard-focus
// ring class (unique `ring-offset-neutral-surface-sunken`) marks the target.
// ---------------------------------------------------------------------------
describe('keyboard card navigation (#195)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  const FOCUS_RING = 'ring-offset-neutral-surface-sunken';
  // A card's child controls (chain icon, ··· menu) also match by accessible
  // name; the draggable root is the one carrying aria-roledescription.
  const card = (name: RegExp): HTMLElement =>
    screen
      .getAllByRole('button', { name })
      .find((el) => el.getAttribute('aria-roledescription') === 'draggable')!;

  it('j/k move focus down and up within a column across phases', () => {
    renderBoard();
    // IN_PROGRESS flat order across phases: t3, t4 (Alpha) then t7 (root).
    const t3 = card(/Backend Implementation/);
    fireEvent.pointerDown(t3);
    expect(t3.className).toContain(FOCUS_RING);

    fireEvent.keyDown(window, { key: 'j' });
    expect(card(/Frontend Build/).className).toContain(FOCUS_RING);
    expect(card(/Backend Implementation/).className).not.toContain(FOCUS_RING);

    fireEvent.keyDown(window, { key: 'j' });
    expect(card(/Documentation/).className).toContain(FOCUS_RING);

    fireEvent.keyDown(window, { key: 'k' });
    expect(card(/Frontend Build/).className).toContain(FOCUS_RING);
    expect(card(/Documentation/).className).not.toContain(FOCUS_RING);
  });

  it('l/h move focus across columns within a phase, skipping the empty REVIEW cell', () => {
    renderBoard();
    // Focus t3 in the Alpha lane's IN_PROGRESS column.
    fireEvent.pointerDown(card(/Backend Implementation/));

    // Right → next non-empty column is COMPLETE (t2); REVIEW between is empty.
    fireEvent.keyDown(window, { key: 'l' });
    expect(card(/Discovery & Design/).className).toContain(FOCUS_RING);

    // Left from COMPLETE → wraps back through empty REVIEW to IN_PROGRESS (t3).
    fireEvent.keyDown(window, { key: 'h' });
    expect(card(/Backend Implementation/).className).toContain(FOCUS_RING);
    expect(card(/Discovery & Design/).className).not.toContain(FOCUS_RING);
  });

  // #2194 — navigation must move *real* DOM focus, not paint a ring only, so
  // screen readers announce the card and Enter/E reach it.
  it('j/k moves real DOM focus onto the target card (not just a visual ring)', () => {
    renderBoard();
    fireEvent.pointerDown(card(/Backend Implementation/));
    expect(card(/Backend Implementation/)).toHaveFocus();

    fireEvent.keyDown(window, { key: 'j' });
    expect(card(/Frontend Build/)).toHaveFocus();
    expect(card(/Backend Implementation/)).not.toHaveFocus();
  });

  // #2194 — the cheatsheet advertised "E — Edit card" but the handler was never
  // wired into useBoardKeyboard. Pressing E on a focused card now opens the
  // unified TaskFormModal in edit mode.
  it('E opens the focused card in the edit modal', () => {
    renderBoard();
    fireEvent.pointerDown(card(/Backend Implementation/));
    fireEvent.keyDown(window, { key: 'e' });
    expect(screen.getByRole('dialog', { name: /^Backend Implementation$/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lens filter chips in the phase grid (My tasks / Tech debt / At-risk). The
// quiet toolbar toggles narrow the grid AND surface an inescapable chip so a
// filtered board never reads as data loss.
// ---------------------------------------------------------------------------
describe('lens filter chips in the phase grid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  // A card's child controls share its accessible name; count only draggable roots.
  const cardRootCount = (name: RegExp) =>
    screen
      .queryAllByRole('button', { name })
      .filter((el) => el.getAttribute('aria-roledescription') === 'draggable').length;

  it('Tech-debt lens hides non-debt cards, shows a chip, and "Show all →" restores', async () => {
    const user = userEvent.setup();
    mockTasks = [
      { ...FIXTURE_TASKS[2], id: 'debt', name: 'Debt Card', parentId: null, taskType: 'tech_debt' },
      { ...FIXTURE_TASKS[2], id: 'feat', name: 'Feature Card', parentId: null, taskType: 'task' },
    ];
    renderBoard();
    expect(cardRootCount(/Debt Card/)).toBe(1);
    expect(cardRootCount(/Feature Card/)).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Tech-debt only' }));
    expect(screen.getByText('Filter: Tech debt')).toBeInTheDocument();
    expect(cardRootCount(/Debt Card/)).toBe(1);
    expect(cardRootCount(/Feature Card/)).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Show all →' }));
    expect(screen.queryByText('Filter: Tech debt')).toBeNull();
    expect(cardRootCount(/Feature Card/)).toBe(1);
  });

  it('At-risk lens hides phases whose tasks carry no linked risk', async () => {
    const user = userEvent.setup();
    // Alpha lane tasks have no linked risks; give the root Documentation task one.
    mockTasks = [
      ...FIXTURE_TASKS.slice(0, 6),
      { ...FIXTURE_TASKS[6], linkedRisksCount: 1 },
    ];
    renderBoard();
    expect(
      screen.getByRole('group', { name: 'Alpha Platform Upgrade swimlane' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Risk-linked only' }));
    // The Alpha lane (no risk-linked tasks) drops out; the root lane survives.
    expect(screen.queryByRole('group', { name: 'Alpha Platform Upgrade swimlane' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Project Tasks swimlane' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Empty-state create affordance. With no leaf cards the board shows the "No
// tasks yet" empty state whose "+ Add task" button opens the create modal.
// ---------------------------------------------------------------------------
describe('empty-state create affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('opens the create modal from the "No tasks yet" empty state', async () => {
    const user = userEvent.setup();
    mockTasks = [FIXTURE_TASKS[0]]; // summary only — no leaf cards, no backlog
    renderBoard();
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ Add task' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Activity feed panel toggle (ADR-0160, issue 1261). A first-class board
// surface toggled from the toolbar; the open state persists per project.
// ---------------------------------------------------------------------------
describe('activity feed panel toggle (ADR-0160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('toggles the activity feed open/closed and persists the choice per project', async () => {
    const user = userEvent.setup();
    renderBoard();
    const toggle = screen.getByRole('button', { name: 'Board activity feed' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('trueppm.board.project-1.activityPanel.open')).toBe('true');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('trueppm.board.project-1.activityPanel.open')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Public board share (#1486). Admin+ actors get a "Share this board" item in
// the More overflow that opens the ShareViewDialog. The mocked role is 300
// (ADMIN) so the affordance is present.
// ---------------------------------------------------------------------------
describe('public board share (#1486)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('opens the share dialog from the More menu for an admin', async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMore(user);
    await user.click(screen.getByRole('button', { name: 'Share this board with a public link' }));
    // ShareViewDialog mounts — its create-mode "Link expiry" control is unique to it.
    expect(await screen.findByLabelText('Link expiry')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mobile create FAB (issue 605). On a phone the floating "+" opens the create
// modal targeting the group in view (the snapped-to status column).
// ---------------------------------------------------------------------------
describe('mobile create FAB (#605)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(makeMq(true));
    // Pin an explicit 'rail' layout so the mobile snap board (not the queue) renders.
    localStorage.setItem('trueppm.board.toolbarPrefs.v1', JSON.stringify({ layout: 'rail' }));
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('opens the create modal targeting the visible status column', async () => {
    const user = userEvent.setup();
    renderBoard();
    // The FAB is the only "Add task" affordance on the mobile snap board.
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
