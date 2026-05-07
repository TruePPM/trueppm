/**
 * DepPopover — covers loading state, empty state, predecessor/successor lists,
 * blocking dot vs link icon, statusPillClass branches, and close interactions.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DepPopover } from './DepPopover';
import type { Task, TaskStatus } from '@/types';
import type { TaskDependenciesResult } from '@/hooks/useTaskDependencies';

// ---------------------------------------------------------------------------
// Module mock — controls what useTaskDependencies returns per test
// ---------------------------------------------------------------------------

const mockDepsResult: TaskDependenciesResult = {
  predecessors: [],
  successors: [],
  isLoading: false,
  isFetching: false,
  hasResolved: true,
  error: null,
};

vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskDependencies: () => mockDepsResult,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Alpha Task',
    start: '2026-01-01',
    finish: '2026-01-08',
    duration: 7,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

function makeTaskIndex(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}

describe('DepPopover', () => {
  const baseTask = makeTask();
  const onClose = vi.fn();
  const onJumpTo = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default empty state
    mockDepsResult.predecessors = [];
    mockDepsResult.successors = [];
    mockDepsResult.isLoading = false;
    mockDepsResult.error = null;
  });

  it('renders the dialog with accessible role', () => {
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the task name in the header', () => {
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    expect(screen.getByText('Alpha Task')).toBeInTheDocument();
  });

  it('renders "Dependencies" heading', () => {
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    expect(screen.getByText('Dependencies')).toBeInTheDocument();
  });

  it('shows loading state when isLoading is true', () => {
    mockDepsResult.isLoading = true;
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows empty state when no predecessors or successors', () => {
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    expect(screen.getByText('No active dependencies.')).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close dependency list' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is pointer-downed', () => {
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders predecessors section with count', () => {
    mockDepsResult.predecessors = [
      { id: 'e1', predecessorId: 'tp1', successorId: 't1', depType: 'FS', lag: 0 },
    ];
    const pred = makeTask({ id: 'tp1', name: 'Pred Task', status: 'IN_PROGRESS' });
    render(
      <DepPopover
        task={baseTask}
        taskIndex={makeTaskIndex([pred])}
        onClose={onClose}
        onJumpTo={onJumpTo}
      />,
    );
    expect(screen.getByText('Predecessors (1)')).toBeInTheDocument();
    expect(screen.getByText('Pred Task')).toBeInTheDocument();
  });

  it('renders successors section with count', () => {
    mockDepsResult.successors = [
      { id: 'e2', predecessorId: 't1', successorId: 'ts1', depType: 'FS', lag: 0 },
    ];
    const succ = makeTask({ id: 'ts1', name: 'Succ Task', status: 'NOT_STARTED' });
    render(
      <DepPopover
        task={baseTask}
        taskIndex={makeTaskIndex([succ])}
        onClose={onClose}
        onJumpTo={onJumpTo}
      />,
    );
    expect(screen.getByText('Successors (1)')).toBeInTheDocument();
    expect(screen.getByText('Succ Task')).toBeInTheDocument();
  });

  it('calls onJumpTo when a known predecessor row is clicked', () => {
    mockDepsResult.predecessors = [
      { id: 'e1', predecessorId: 'tp1', successorId: 't1', depType: 'FS', lag: 0 },
    ];
    const pred = makeTask({ id: 'tp1', name: 'Pred Task', status: 'COMPLETE' });
    render(
      <DepPopover
        task={baseTask}
        taskIndex={makeTaskIndex([pred])}
        onClose={onClose}
        onJumpTo={onJumpTo}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Pred Task/ }));
    expect(onJumpTo).toHaveBeenCalledWith('tp1');
  });

  it('renders blocking dot for incomplete predecessor', () => {
    mockDepsResult.predecessors = [
      { id: 'e1', predecessorId: 'tp1', successorId: 't1', depType: 'FS', lag: 0 },
    ];
    const pred = makeTask({ id: 'tp1', name: 'Blocking Task', status: 'IN_PROGRESS' });
    const { container } = render(
      <DepPopover
        task={baseTask}
        taskIndex={makeTaskIndex([pred])}
        onClose={onClose}
      />,
    );
    // Blocking dot is a red rounded-full span
    const redDot = container.querySelector('.bg-semantic-critical');
    expect(redDot).toBeTruthy();
  });

  it('does not render blocking dot for complete predecessor', () => {
    mockDepsResult.predecessors = [
      { id: 'e1', predecessorId: 'tp1', successorId: 't1', depType: 'FS', lag: 0 },
    ];
    const pred = makeTask({ id: 'tp1', name: 'Done Task', status: 'COMPLETE' });
    const { container } = render(
      <DepPopover
        task={baseTask}
        taskIndex={makeTaskIndex([pred])}
        onClose={onClose}
      />,
    );
    const redDot = container.querySelector('.bg-semantic-critical');
    expect(redDot).toBeNull();
  });

  it('falls back to truncated id when task is unknown', () => {
    mockDepsResult.predecessors = [
      { id: 'e1', predecessorId: 'unknown-task-id', successorId: 't1', depType: 'FS', lag: 0 },
    ];
    render(
      <DepPopover task={baseTask} taskIndex={makeTaskIndex([])} onClose={onClose} />,
    );
    // Falls back to "Task " + first 6 chars of the unknown id
    expect(screen.getByText('Task unknow')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // statusPillClass branches — verify each status produces the right pill text
  // ---------------------------------------------------------------------------

  const statusCases: { status: TaskStatus; label: string }[] = [
    { status: 'COMPLETE', label: 'Done' },
    { status: 'IN_PROGRESS', label: 'In Progress' },
    { status: 'REVIEW', label: 'Review' },
    { status: 'BACKLOG', label: 'Backlog' },
    { status: 'ON_HOLD', label: 'On Hold' },
    { status: 'NOT_STARTED', label: 'To Do' },
  ];

  statusCases.forEach(({ status, label }) => {
    it(`shows status pill "${label}" for ${status} predecessor`, () => {
      mockDepsResult.predecessors = [
        { id: 'e1', predecessorId: 'tp1', successorId: 't1', depType: 'FS', lag: 0 },
      ];
      const pred = makeTask({ id: 'tp1', name: 'Task X', status });
      render(
        <DepPopover
          task={baseTask}
          taskIndex={makeTaskIndex([pred])}
          onClose={onClose}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('renders both predecessors and successors simultaneously', () => {
    mockDepsResult.predecessors = [
      { id: 'e1', predecessorId: 'tp1', successorId: 't1', depType: 'FS', lag: 0 },
    ];
    mockDepsResult.successors = [
      { id: 'e2', predecessorId: 't1', successorId: 'ts1', depType: 'FS', lag: 0 },
    ];
    const pred = makeTask({ id: 'tp1', name: 'Pred Task', status: 'COMPLETE' });
    const succ = makeTask({ id: 'ts1', name: 'Succ Task', status: 'NOT_STARTED' });
    render(
      <DepPopover
        task={baseTask}
        taskIndex={makeTaskIndex([pred, succ])}
        onClose={onClose}
      />,
    );
    expect(screen.getByText('Predecessors (1)')).toBeInTheDocument();
    expect(screen.getByText('Successors (1)')).toBeInTheDocument();
  });
});
