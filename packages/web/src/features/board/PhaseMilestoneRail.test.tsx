import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhaseMilestoneRail } from './PhaseMilestoneRail';
import type { Task, TaskStatus } from '@/types';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'NOT_STARTED', label: 'To Do' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'COMPLETE', label: 'Done' },
];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'm1',
    wbs: '1.1',
    name: 'Launch milestone',
    start: '2026-06-01',
    finish: '2026-06-01',
    duration: 0,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: true,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Date setup — control "today" for tone classification
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Today = 2026-04-27
  vi.useFakeTimers({ now: new Date('2026-04-27T12:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PhaseMilestoneRail', () => {
  it('renders nothing when milestones list is empty', () => {
    const { container } = render(
      <PhaseMilestoneRail milestones={[]} columns={COLUMNS} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the milestone rail with role="list"', () => {
    const milestones = [makeTask()];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    expect(screen.getByRole('list', { name: /Phase milestones/i })).toBeInTheDocument();
  });

  it('renders a diamond button with correct aria-label for upcoming milestone', () => {
    const milestones = [makeTask({ start: '2026-06-01', status: 'NOT_STARTED' })];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    // start = 2026-06-01, future date → 'Upcoming'
    expect(
      screen.getByRole('button', { name: /Upcoming milestone Launch milestone/ }),
    ).toBeInTheDocument();
  });

  it('classifies a past incomplete milestone as "Missed"', () => {
    // start = 2026-01-01, today = 2026-04-27 → missed
    const milestones = [makeTask({ start: '2026-01-01', status: 'NOT_STARTED' })];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    expect(
      screen.getByRole('button', { name: /Missed milestone/ }),
    ).toBeInTheDocument();
  });

  it('classifies a COMPLETE milestone with on-time actual finish as "Hit"', () => {
    // planned = 2026-03-15, actualFinish = 2026-03-10 (before planned) → Hit
    const milestones = [
      makeTask({
        start: '2026-03-15',
        status: 'COMPLETE',
        isComplete: true,
        actualFinish: '2026-03-10',
      }),
    ];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    expect(
      screen.getByRole('button', { name: /Hit milestone/ }),
    ).toBeInTheDocument();
  });

  it('classifies a COMPLETE milestone with late actual finish as "Late hit"', () => {
    // planned = 2026-03-10, actualFinish = 2026-03-15 (after planned) → Late hit
    const milestones = [
      makeTask({
        start: '2026-03-10',
        status: 'COMPLETE',
        isComplete: true,
        actualFinish: '2026-03-15',
      }),
    ];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    expect(
      screen.getByRole('button', { name: /Late hit milestone/ }),
    ).toBeInTheDocument();
  });

  it('classifies a COMPLETE milestone with no actualFinish as "Hit"', () => {
    const milestones = [
      makeTask({ start: '2026-03-10', status: 'COMPLETE', isComplete: true }),
    ];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    expect(
      screen.getByRole('button', { name: /Hit milestone/ }),
    ).toBeInTheDocument();
  });

  it('shows "Date TBD" when task has no start date', () => {
    const milestones = [makeTask({ start: undefined })];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    const btn = screen.getByRole('button', { name: /milestone Launch milestone/ });
    expect(btn).toHaveAttribute('aria-label', expect.stringContaining('Date TBD'));
  });

  it('shows tooltip on pointer enter and hides on pointer leave', () => {
    const milestones = [makeTask({ start: '2026-06-01', status: 'NOT_STARTED' })];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    const btn = screen.getByRole('button', { name: /Upcoming milestone/ });

    // No tooltip initially
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.pointerEnter(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Launch milestone');

    fireEvent.pointerLeave(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows tooltip on focus and hides on blur', () => {
    const milestones = [makeTask({ start: '2026-06-01', status: 'NOT_STARTED' })];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    const btn = screen.getByRole('button', { name: /Upcoming milestone/ });

    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.blur(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('calls onOpenTask when a diamond button is clicked', () => {
    const onOpenTask = vi.fn();
    const task = makeTask({ start: '2026-06-01', status: 'NOT_STARTED' });
    render(
      <PhaseMilestoneRail
        milestones={[task]}
        columns={COLUMNS}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Upcoming milestone/ }));
    expect(onOpenTask).toHaveBeenCalledWith(task);
  });

  it('renders +N overflow chip when more than 5 milestones are in one column', () => {
    const milestones = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `m${i}`, name: `MS ${i}`, start: '2026-06-01', status: 'NOT_STARTED' }),
    );
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    // 7 - 5 = 2 overflow
    expect(screen.getByLabelText(/2 more milestones in To Do/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/2 more milestones in To Do/i)).toHaveTextContent('+2');
  });

  it('places milestones in the correct column based on task status', () => {
    const milestones = [
      makeTask({ id: 'm1', name: 'MS A', status: 'IN_PROGRESS', start: '2026-06-01' }),
      makeTask({ id: 'm2', name: 'MS B', status: 'NOT_STARTED', start: '2026-06-01' }),
    ];
    render(<PhaseMilestoneRail milestones={milestones} columns={COLUMNS} />);
    expect(
      screen.getByRole('button', { name: /Upcoming milestone MS A/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Upcoming milestone MS B/ }),
    ).toBeInTheDocument();
  });
});
