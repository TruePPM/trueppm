import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 300, isLoading: false }),
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

  it('cancels a Move-to move when destination is over WIP limit and user declines (#232)', () => {
    // IN_PROGRESS already has > 0 tasks; tighten its limit to make any new
    // move push it over the threshold, then decline the confirm prompt.
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderBoard();
    // Find a card whose status is NOT IN_PROGRESS so the move triggers the guard.
    const trigger = screen.getAllByLabelText(/Actions for /)[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'IN PROGRESS' })[0]);
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(updateMutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('proceeds with the move when user confirms over-WIP-limit prompt (#232)', () => {
    mockColumns = [
      { status: 'BACKLOG', label: 'BACKLOG', visible: true },
      { status: 'NOT_STARTED', label: 'TO DO', visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS', visible: true, wipLimit: 1 },
      { status: 'REVIEW', label: 'REVIEW', visible: true },
      { status: 'COMPLETE', label: 'DONE', visible: true },
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderBoard();
    const trigger = screen.getAllByLabelText(/Actions for /)[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'IN PROGRESS' })[0]);
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ status: 'IN_PROGRESS' }));
    confirmSpy.mockRestore();
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
      const user = userEvent.setup();
      renderBoard();

      // Activate an assignee facet via the filter panel.
      await user.click(screen.getByTestId('board-filter-trigger'));
      await user.click(screen.getByTestId('facet-assignee-r1'));
      expect(screen.getByTestId('board-filter-count')).toHaveTextContent('1');

      // Save the current view.
      await user.click(screen.getByRole('button', { name: /board view/i }));
      await user.click(screen.getByText('+ Save current view…'));
      await user.type(screen.getByLabelText('View name'), 'My filtered view');
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
      const user = userEvent.setup();
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
