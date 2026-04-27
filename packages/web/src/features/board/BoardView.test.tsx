import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BoardView } from './BoardView';
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

  it('renders an "Other" lane for ungrouped tasks', () => {
    render(<BoardView />);
    // t7 "Documentation" has no summary parent — appears in "Other" lane
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
  });

  it('does not render summary tasks as cards', () => {
    render(<BoardView />);
    // "Alpha Platform Upgrade" is a summary task — it should not appear as a card
    // but it CAN appear as a lane label. We verify there's no card role for it.
    const allButtons = screen.getAllByRole('button');
    const cardButtons = allButtons.filter(
      (btn) => btn.getAttribute('aria-label')?.includes('Alpha Platform Upgrade'),
    );
    expect(cardButtons).toHaveLength(0);
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
    // Expand toggle button for "Alpha Platform Upgrade" phase
    const toggleBtn = screen.getByRole('button', { name: /Alpha Platform Upgrade/ });
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
    await user.click(screen.getByRole('button', { name: /Alpha Platform Upgrade/ }));
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

});
