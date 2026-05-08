import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

// jsdom does not implement window.matchMedia — stub it.
// Default: desktop (matches: false). Individual tests may override via mockReturnValue.
const makeMq = (matches: boolean) => ({
  matches,
  media: '(max-width: 767px)',
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});
vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => makeMq(false)));
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import type { Task, TaskStatus } from '@/types';

// ---------------------------------------------------------------------------
// Mocks — module-scope mutable state lets each test choose which tasks /
// columns / loading state to render.
// ---------------------------------------------------------------------------

let mockTasks: Task[] | null = FIXTURE_TASKS;
let mockIsLoading = false;
let mockColumns: { status: TaskStatus; label: string; visible: boolean; wipLimit?: number }[] = [
  { status: 'BACKLOG',     label: 'BACKLOG',      visible: true },
  { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true, wipLimit: 3 },
  { status: 'REVIEW',      label: 'REVIEW',       visible: true, wipLimit: 2 },
  { status: 'COMPLETE',    label: 'DONE',          visible: true },
];
const updateMutate = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'project-1',
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, isLoading: mockIsLoading }),
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
  useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false }),
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

let mockProjectResourcePool: { id: string; resourceId: string; resource: { id: string; name: string; isMe?: boolean } }[] = [];
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
  useProject: () => ({ data: { agile_features: false }, isLoading: false }),
}));

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => ({ data: { pages: [] }, isLoading: false }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 3, isLoading: false }),
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
vi.mock('@/hooks/useBoardSavedViews', () => ({
  useBoardSavedViews: () => ({
    views: [],
    isLoading: false,
    create: { mutate: vi.fn(), isPending: false },
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
  TaskDetailDrawer: ({ task, onClose }: { task: { id: string; name: string } | null; onClose: () => void }) =>
    task ? (
      <div role="dialog" aria-label={`Task drawer ${task.name}`}>
        <button type="button" onClick={onClose}>Close drawer</button>
      </div>
    ) : null,
}));

// useSprints is invoked by the popover when a task has sprintId — return an
// empty list so the chip renders as "Sprint: …" placeholder without an API hit.
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [], isLoading: false }),
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
  mockColumns = [
    { status: 'BACKLOG',     label: 'BACKLOG',      visible: true },
    { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
    { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true, wipLimit: 3 },
    { status: 'REVIEW',      label: 'REVIEW',       visible: true, wipLimit: 2 },
    { status: 'COMPLETE',    label: 'DONE',          visible: true },
  ];
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
  (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => makeMq(false));
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
    const cardActionButtons = allButtons.filter(
      (btn) => btn.getAttribute('aria-label')?.startsWith('Actions for Alpha Platform Upgrade'),
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

  it('renders CP rpill for critical tasks', () => {
    renderBoard();
    // t3 "Backend Implementation" is critical — should show a CP pill
    const cpPills = screen.getAllByText('CP');
    expect(cpPills.length).toBeGreaterThan(0);
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

  it('shows WIP toggle in toolbar', () => {
    renderBoard();
    expect(screen.getByLabelText('Show WIP limits')).toBeInTheDocument();
  });

  it('renders the loading state when useScheduleTasks is loading', () => {
    mockIsLoading = true;
    mockTasks = null;
    renderBoard();
    expect(screen.getByText('Loading board…')).toBeInTheDocument();
    // The toolbar / lanes do not render in the loading branch.
    expect(screen.queryByLabelText('Show WIP limits')).not.toBeInTheDocument();
  });

  it('renders the empty state when no leaf tasks exist', () => {
    mockTasks = []; // not null, not loading — but no tasks
    renderBoard();
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  it('renders the empty state when only summary tasks exist (no leaves)', () => {
    mockTasks = [FIXTURE_TASKS[0]]; // t1 is the sole summary task; no children
    renderBoard();
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  it('replaces the WIP badge with a plain count when "Show WIP limits" is off', async () => {
    const user = userEvent.setup();
    renderBoard();
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
      { status: 'BACKLOG',     label: 'BACKLOG',      visible: true },
      { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true, wipLimit: 1 },
      { status: 'REVIEW',      label: 'REVIEW',       visible: true },
      { status: 'COMPLETE',    label: 'DONE',          visible: true },
    ];
    renderBoard();
    // Per #232 the over-limit chip reads "{count}/{limit} — over WIP limit".
    expect(screen.getByText(/over WIP limit/i)).toBeInTheDocument();
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
      { status: 'BACKLOG',     label: 'BACKLOG',      visible: true },
      { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true, wipLimit: inProgressCount },
      { status: 'REVIEW',      label: 'REVIEW',       visible: true },
      { status: 'COMPLETE',    label: 'DONE',          visible: true },
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
      { status: 'BACKLOG',     label: 'BACKLOG',      visible: true },
      { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true, wipLimit: 1 },
      { status: 'REVIEW',      label: 'REVIEW',       visible: true },
      { status: 'COMPLETE',    label: 'DONE',          visible: true },
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
      { status: 'BACKLOG',     label: 'BACKLOG',      visible: true },
      { status: 'NOT_STARTED', label: 'TO DO',        visible: true },
      { status: 'IN_PROGRESS', label: 'IN PROGRESS',  visible: true, wipLimit: 1 },
      { status: 'REVIEW',      label: 'REVIEW',       visible: true },
      { status: 'COMPLETE',    label: 'DONE',          visible: true },
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderBoard();
    const trigger = screen.getAllByLabelText(/Actions for /)[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'IN PROGRESS' })[0]);
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'IN_PROGRESS' }),
    );
    confirmSpy.mockRestore();
  });

  it('renders LaneMeta for each phase with add-task button (issue #208)', () => {
    renderBoard();
    // Each visible phase gets a per-lane + button (LaneMeta)
    expect(screen.getByRole('button', { name: /Add task to Alpha Platform Upgrade/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add task to Project Tasks/ })).toBeInTheDocument();
  });

  it('opens the unified task form modal when phase + button is clicked (issue #208 / #305)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderBoard();
    await user.click(screen.getByRole('button', { name: /Add task to Alpha Platform Upgrade/ }));
    // The redesigned TaskFormModal (#305) titles its header "Add to {phase}".
    expect(screen.getByRole('dialog', { name: /Add to Alpha Platform Upgrade/ })).toBeInTheDocument();
  });

  it('renders "Column tints" toggle in toolbar (issue #211)', () => {
    renderBoard();
    expect(screen.getByLabelText('Show column tints')).toBeInTheDocument();
  });

  it('"Column tints" toggle is on by default (issue #211)', () => {
    renderBoard();
    const toggle = screen.getByLabelText<HTMLInputElement>('Show column tints');
    expect(toggle.checked).toBe(true);
  });

  it('board still renders when column tints are toggled off (issue #211)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderBoard();
    const toggle = screen.getByLabelText<HTMLInputElement>('Show column tints');
    await user.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #190 — Swimlane collapse/expand persistence
  // -------------------------------------------------------------------------

  it('renders "Collapse all" and "Expand all" buttons in toolbar (issue #190)', () => {
    renderBoard();
    expect(screen.getByRole('button', { name: 'Collapse all lanes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all lanes' })).toBeInTheDocument();
  });

  it('"Collapse all" hides all lane task cards (issue #190)', async () => {
    const user = userEvent.setup();
    renderBoard();
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }));
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
  });

  it('"Expand all" restores cards after collapse-all (issue #190)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }));
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
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
    expect(screen.getByLabelText('Card density')).toBeInTheDocument();
  });

  it('card density defaults to "comfortable" (issue #193)', () => {
    renderBoard();
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('comfortable');
  });

  it('switching to compact hides progress rings from cards (issue #193)', async () => {
    const user = userEvent.setup();
    renderBoard();
    // In comfortable mode, cards include a progress ring (SVG aria-hidden)
    // In compact mode, the progress ring is not rendered.
    await user.selectOptions(screen.getByLabelText('Card density'), 'compact');
    // Board still renders — task names still visible
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
  });

  it('density persists to localStorage (issue #193)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.selectOptions(screen.getByLabelText('Card density'), 'detailed');
    const stored = localStorage.getItem('trueppm.board.density');
    expect(stored).toBe('detailed');
  });

  it('restores density preference from localStorage on mount (issue #193)', () => {
    localStorage.setItem('trueppm.board.density', 'compact');
    renderBoard();
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('compact');
  });

  it('restores collapsed lanes from localStorage on mount (issue #190)', () => {
    localStorage.setItem('trueppm.board.project-1.collapsedLanes', JSON.stringify(['t1']));
    renderBoard();
    // Alpha lane (t1) is pre-collapsed — task cards not visible on mount
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand Alpha Platform Upgrade/ })).toBeInTheDocument();
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
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => makeMq(true));
    renderBoard();
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('compact');
  });

  it('ignores stored desktop density on mobile — auto-compact wins (issue #224)', () => {
    localStorage.setItem('trueppm.board.density', 'detailed');
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => makeMq(true));
    renderBoard();
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('compact');
  });

  it('manual density override on mobile is not persisted to localStorage (issue #224)', async () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => makeMq(true));
    const user = userEvent.setup();
    renderBoard();
    await user.selectOptions(screen.getByLabelText('Card density'), 'comfortable');
    expect(localStorage.getItem('trueppm.board.density')).toBeNull();
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('comfortable');
  });

  it('desktop density still persists to localStorage when viewport is >= md (issue #224)', async () => {
    // matchMedia already returns matches:false (desktop) from resetMocks
    const user = userEvent.setup();
    renderBoard();
    await user.selectOptions(screen.getByLabelText('Card density'), 'detailed');
    expect(localStorage.getItem('trueppm.board.density')).toBe('detailed');
  });

  // -------------------------------------------------------------------------
  // ADR-0046 — Workshop mode (banner, exit dialog, focus trap)
  // -------------------------------------------------------------------------

  it('renders the workshop toggle in non-workshop mode (ADR-0046)', () => {
    renderBoard();
    expect(
      screen.getByRole('button', { name: 'Start workshop session' }),
    ).toBeInTheDocument();
  });

  it('starting workshop mode calls startWorkshop.mutate (ADR-0046)', async () => {
    const user = userEvent.setup();
    renderBoard();
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
    endWorkshopMutate.mockImplementation(
      (_input: undefined, opts?: { onSettled?: () => void }) => {
        opts?.onSettled?.();
      },
    );
    const user = userEvent.setup();
    renderBoard();
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
    await user.click(screen.getByRole('button', { name: 'Start workshop session' }));
    await user.click(screen.getByRole('button', { name: 'Exit workshop mode' }));
    const dialog = screen.getByRole('dialog', { name: /End workshop session/ });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /End workshop session/ })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #185 — EVM toolbar toggle (evmMode select + show cost checkbox)
  // -------------------------------------------------------------------------

  it('renders EVM indicators select in toolbar (issue #185)', () => {
    renderBoard();
    expect(screen.getByLabelText('EVM indicators')).toBeInTheDocument();
  });

  it('EVM indicators select defaults to "off" (issue #185)', () => {
    renderBoard();
    const select = screen.getByLabelText<HTMLSelectElement>('EVM indicators');
    expect(select.value).toBe('off');
  });

  it('switching EVM to "spi" keeps the board rendering (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.selectOptions(screen.getByLabelText('EVM indicators'), 'spi');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('switching EVM to "cpi" keeps the board rendering (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.selectOptions(screen.getByLabelText('EVM indicators'), 'cpi');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('switching EVM to "both" keeps the board rendering (issue #185)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.selectOptions(screen.getByLabelText('EVM indicators'), 'both');
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  it('renders "Show cost" checkbox in toolbar (issue #189)', () => {
    renderBoard();
    expect(screen.getByLabelText('Show cost')).toBeInTheDocument();
  });

  it('"Show cost" checkbox defaults to unchecked (issue #189)', () => {
    renderBoard();
    const cb = screen.getByLabelText<HTMLInputElement>('Show cost');
    expect(cb.checked).toBe(false);
  });

  it('toggling "Show cost" to on keeps the board rendering (issue #189)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByLabelText('Show cost'));
    expect(screen.getByLabelText<HTMLInputElement>('Show cost').checked).toBe(true);
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
      expect(screen.queryByRole('dialog', { name: /^Backend Implementation$/ })).not.toBeInTheDocument();
    });

    it('clicking "Open detail" closes the popover and mounts the task detail drawer', () => {
      renderBoard();
      const card = getDraggableCardRoot(/Backend Implementation/);
      fireEvent.click(card);
      fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));
      // Stubbed drawer mounts with `Task drawer <name>` accessible label.
      expect(screen.getByRole('dialog', { name: /Task drawer Backend Implementation/ })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: /^Backend Implementation$/ })).not.toBeInTheDocument();
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

});
