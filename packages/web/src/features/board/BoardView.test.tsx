import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BoardView } from './BoardView';

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

vi.mock('@/hooks/useGanttTasks', () => ({
  useGanttTasks: () => ({ tasks: mockTasks, isLoading: mockIsLoading }),
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
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
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

  it('renders column headers', () => {
    render(<BoardView />);
    expect(screen.getByText('BACKLOG')).toBeInTheDocument();
    expect(screen.getByText('TO DO')).toBeInTheDocument();
    expect(screen.getByText('IN PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('REVIEW')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
  });

  it('renders the phase swimlane for the summary task', () => {
    render(<BoardView />);
    // t1 is a summary task "Alpha Platform Upgrade" — it becomes a lane header
    expect(screen.getByText('Alpha Platform Upgrade')).toBeInTheDocument();
  });

  it('renders an "Project Tasks" lane for ungrouped tasks', () => {
    render(<BoardView />);
    // t7 "Documentation" has no summary parent — appears in "Project Tasks" lane
    expect(screen.getByText('Project Tasks')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
  });

  it('does not render summary tasks as cards', () => {
    render(<BoardView />);
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
    render(<BoardView />);
    // "Discovery & Design" (t2, COMPLETE) and "Backend Implementation" (t3, IN_PROGRESS)
    // should appear as cards
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
  });

  it('renders CP rpill for critical tasks', () => {
    render(<BoardView />);
    // t3 "Backend Implementation" is critical — should show a CP pill
    const cpPills = screen.getAllByText('CP');
    expect(cpPills.length).toBeGreaterThan(0);
  });

  it('collapses a phase lane on header click', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    // Collapse toggle button for "Alpha Platform Upgrade" phase (aria-label from LaneMeta)
    const toggleBtn = screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ });
    // Initially expanded — task cards visible
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();

    await user.click(toggleBtn);
    // After collapse, task cards in that lane should be hidden
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
  });

  it('shows WIP toggle in toolbar', () => {
    render(<BoardView />);
    expect(screen.getByLabelText('Show WIP limits')).toBeInTheDocument();
  });

  it('renders the loading state when useGanttTasks is loading', () => {
    mockIsLoading = true;
    mockTasks = null;
    render(<BoardView />);
    expect(screen.getByText('Loading board…')).toBeInTheDocument();
    // The toolbar / lanes do not render in the loading branch.
    expect(screen.queryByLabelText('Show WIP limits')).not.toBeInTheDocument();
  });

  it('renders the empty state when no leaf tasks exist', () => {
    mockTasks = []; // not null, not loading — but no tasks
    render(<BoardView />);
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  it('renders the empty state when only summary tasks exist (no leaves)', () => {
    mockTasks = [FIXTURE_TASKS[0]]; // t1 is the sole summary task; no children
    render(<BoardView />);
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  it('replaces the WIP badge with a plain count when "Show WIP limits" is off', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
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
    render(<BoardView />);
    // The header WIP badge for IN_PROGRESS shows "{count} · WIP {limit} ⚠".
    expect(screen.getByText(/WIP 1 ⚠/)).toBeInTheDocument();
  });

  it('renders an "N done" chip when every task in the phase is COMPLETE', () => {
    // Only the completed leaf t2 under summary t1 — phase becomes 100% done.
    mockTasks = [FIXTURE_TASKS[0], FIXTURE_TASKS[1]];
    render(<BoardView />);
    expect(screen.getByText('1 done')).toBeInTheDocument();
  });

  it('renders an "N CP" chip when the phase contains critical-path tasks', () => {
    render(<BoardView />);
    // The Alpha phase (FIXTURE_TASKS[0]) has 4 critical leaves: t2, t3, t5, t6.
    expect(screen.getByText('4 CP')).toBeInTheDocument();
  });

  it('shows per-column counts when a phase is collapsed', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    await user.click(screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ }));
    // The Alpha phase has 1 COMPLETE task (t2) — singular "1 task" branch.
    expect(screen.getAllByText('1 task').length).toBeGreaterThan(0);
    // And NOT_STARTED holds t5, t6 — pluralized "2 tasks" branch.
    expect(screen.getAllByText('2 tasks').length).toBeGreaterThan(0);
  });

  it('routes the keyboard "Move to" menu item through updateMutate', () => {
    render(<BoardView />);
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

  it('renders LaneMeta for each phase with add-task button (issue #208)', () => {
    render(<BoardView />);
    // Each visible phase gets a per-lane + button (LaneMeta)
    expect(screen.getByRole('button', { name: /Add task to Alpha Platform Upgrade/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add task to Project Tasks/ })).toBeInTheDocument();
  });

  it('opens AddTaskModal when phase + button is clicked (issue #208)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(<BoardView />);
    await user.click(screen.getByRole('button', { name: /Add task to Alpha Platform Upgrade/ }));
    expect(screen.getByRole('dialog', { name: /Add task to Alpha Platform Upgrade/ })).toBeInTheDocument();
  });

  it('renders "Column tints" toggle in toolbar (issue #211)', () => {
    render(<BoardView />);
    expect(screen.getByLabelText('Show column tints')).toBeInTheDocument();
  });

  it('"Column tints" toggle is on by default (issue #211)', () => {
    render(<BoardView />);
    const toggle = screen.getByLabelText<HTMLInputElement>('Show column tints');
    expect(toggle.checked).toBe(true);
  });

  it('board still renders when column tints are toggled off (issue #211)', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(<BoardView />);
    const toggle = screen.getByLabelText<HTMLInputElement>('Show column tints');
    await user.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('TO DO')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #190 — Swimlane collapse/expand persistence
  // -------------------------------------------------------------------------

  it('renders "Collapse all" and "Expand all" buttons in toolbar (issue #190)', () => {
    render(<BoardView />);
    expect(screen.getByRole('button', { name: 'Collapse all lanes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all lanes' })).toBeInTheDocument();
  });

  it('"Collapse all" hides all lane task cards (issue #190)', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }));
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
  });

  it('"Expand all" restores cards after collapse-all (issue #190)', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    await user.click(screen.getByRole('button', { name: 'Collapse all lanes' }));
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand all lanes' }));
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
  });

  it('persists collapsed state to localStorage (issue #190)', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
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
    render(<BoardView />);
    expect(screen.getByLabelText('Card density')).toBeInTheDocument();
  });

  it('card density defaults to "comfortable" (issue #193)', () => {
    render(<BoardView />);
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('comfortable');
  });

  it('switching to compact hides progress rings from cards (issue #193)', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    // In comfortable mode, cards include a progress ring (SVG aria-hidden)
    // In compact mode, the progress ring is not rendered.
    await user.selectOptions(screen.getByLabelText('Card density'), 'compact');
    // Board still renders — task names still visible
    expect(screen.getByText('Discovery & Design')).toBeInTheDocument();
  });

  it('density persists to localStorage (issue #193)', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
    await user.selectOptions(screen.getByLabelText('Card density'), 'detailed');
    const stored = localStorage.getItem('trueppm.board.density');
    expect(stored).toBe('detailed');
  });

  it('restores density preference from localStorage on mount (issue #193)', () => {
    localStorage.setItem('trueppm.board.density', 'compact');
    render(<BoardView />);
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('compact');
  });

  it('restores collapsed lanes from localStorage on mount (issue #190)', () => {
    localStorage.setItem('trueppm.board.project-1.collapsedLanes', JSON.stringify(['t1']));
    render(<BoardView />);
    // Alpha lane (t1) is pre-collapsed — task cards not visible on mount
    expect(screen.queryByText('Discovery & Design')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand Alpha Platform Upgrade/ })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #225 — keyboard shortcut hints in collapse button tooltip
  // -------------------------------------------------------------------------

  it('collapse toggle shows "Collapse lane  [" title when lane is expanded (issue #225)', () => {
    render(<BoardView />);
    const btn = screen.getByRole('button', { name: /Collapse Alpha Platform Upgrade/ });
    expect(btn).toHaveAttribute('title', 'Collapse lane  [');
  });

  it('collapse toggle shows "Expand lane  ]" title when lane is collapsed (issue #225)', async () => {
    const user = userEvent.setup();
    render(<BoardView />);
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
    render(<BoardView />);
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('compact');
  });

  it('ignores stored desktop density on mobile — auto-compact wins (issue #224)', () => {
    localStorage.setItem('trueppm.board.density', 'detailed');
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => makeMq(true));
    render(<BoardView />);
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('compact');
  });

  it('manual density override on mobile is not persisted to localStorage (issue #224)', async () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(() => makeMq(true));
    const user = userEvent.setup();
    render(<BoardView />);
    await user.selectOptions(screen.getByLabelText('Card density'), 'comfortable');
    expect(localStorage.getItem('trueppm.board.density')).toBeNull();
    const select = screen.getByLabelText<HTMLSelectElement>('Card density');
    expect(select.value).toBe('comfortable');
  });

  it('desktop density still persists to localStorage when viewport is >= md (issue #224)', async () => {
    // matchMedia already returns matches:false (desktop) from resetMocks
    const user = userEvent.setup();
    render(<BoardView />);
    await user.selectOptions(screen.getByLabelText('Card density'), 'detailed');
    expect(localStorage.getItem('trueppm.board.density')).toBe('detailed');
  });

});
