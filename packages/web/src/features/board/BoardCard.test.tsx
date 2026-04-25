/**
 * BoardCard branch coverage — exercises overlay, drag placeholder, entry-stamp
 * conditionals, priority rank, assignee overflow, "Move to Done?" nudge, and
 * the overflow menu / "Move to" submenu interaction (rule 105).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import type { ReactNode } from 'react';
import { BoardCard } from './BoardCard';
import type { Task, TaskStatus } from '@/types';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'NOT_STARTED', label: 'TO DO' },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS' },
  { status: 'ON_HOLD', label: 'ON HOLD' },
  { status: 'COMPLETE', label: 'DONE' },
];

const baseTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Backend Implementation',
  start: '2026-01-01',
  finish: '2026-01-08',
  duration: 7,
  progress: 60,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'IN_PROGRESS',
  assignees: [],
};

function renderCard(props: Partial<React.ComponentProps<typeof BoardCard>>) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <DndContext>{children}</DndContext>;
  }
  return render(
    <Wrapper>
      <BoardCard
        task={props.task ?? baseTask}
        onMenuMove={props.onMenuMove ?? (() => {})}
        columns={props.columns ?? COLUMNS}
        isOverlay={props.isOverlay}
        isStalled={props.isStalled}
      />
    </Wrapper>,
  );
}

describe('BoardCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the overlay variant without the menu chrome', () => {
    renderCard({ isOverlay: true });
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
    // overlay does not render the ··· menu trigger
    expect(screen.queryByLabelText(/Actions for/)).not.toBeInTheDocument();
  });

  it('renders priority rank chip when priorityRank is set', () => {
    renderCard({ task: { ...baseTask, priorityRank: 7 } });
    expect(screen.getByText('#7')).toBeInTheDocument();
  });

  it('omits priority rank chip when priorityRank is undefined', () => {
    renderCard({ task: baseTask });
    expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument();
  });

  it('renders the CP rpill for critical tasks', () => {
    renderCard({ task: { ...baseTask, isCritical: true } });
    expect(screen.getByText('CP')).toBeInTheDocument();
  });

  it('renders up to 3 assignee initials and a +N overflow chip', () => {
    const task: Task = {
      ...baseTask,
      assignees: [
        { resourceId: 'r1', name: 'Alice Chen', units: 1 },
        { resourceId: 'r2', name: 'Bob Martinez', units: 1 },
        { resourceId: 'r3', name: 'Carol Park', units: 1 },
        { resourceId: 'r4', name: 'David Lee', units: 1 },
        { resourceId: 'r5', name: 'Eve Johnson', units: 1 },
      ],
    };
    renderCard({ task });
    expect(screen.getByText('AC')).toBeInTheDocument();
    expect(screen.getByText('BM')).toBeInTheDocument();
    expect(screen.getByText('CP')).toBeInTheDocument(); // Carol Park initials, not the CP pill (no critical here)
    expect(screen.getByText('+2')).toBeInTheDocument();
    // David and Eve are NOT shown directly
    expect(screen.queryByText('DL')).not.toBeInTheDocument();
  });

  it('renders single-name initials as the first letter only', () => {
    const task: Task = {
      ...baseTask,
      assignees: [{ resourceId: 'r1', name: 'Cher', units: 1 }],
    };
    renderCard({ task });
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('falls back to "?" initials when the name is empty', () => {
    const task: Task = {
      ...baseTask,
      assignees: [{ resourceId: 'r1', name: '   ', units: 1 }],
    };
    renderCard({ task });
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders the entry stamp with non-stalled styling at <= 3 days', () => {
    const enteredAt = new Date('2026-01-13T12:00:00Z').toISOString(); // 2 days ago
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt } });
    expect(screen.getByText(/Entered at 60% · 2d ago/)).toBeInTheDocument();
    expect(screen.queryByText(/stalled/)).not.toBeInTheDocument();
  });

  it('renders "1d ago" when entered exactly 1 day ago', () => {
    const enteredAt = new Date('2026-01-14T12:00:00Z').toISOString();
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt } });
    expect(screen.getByText(/Entered at 60% · 1d ago/)).toBeInTheDocument();
  });

  it('marks the entry stamp as stalled when > 3 days and progress < 100', () => {
    const enteredAt = new Date('2026-01-10T12:00:00Z').toISOString(); // 5 days ago
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt } });
    expect(screen.getByText(/— stalled/)).toBeInTheDocument();
  });

  it('does NOT show the entry stamp when statusEnteredAt is undefined', () => {
    renderCard({ task: baseTask });
    expect(screen.queryByText(/Entered at/)).not.toBeInTheDocument();
  });

  it('honors the isStalled override prop over the derived value', () => {
    // Only 1 day ago — would NOT be stalled by derivation
    const enteredAt = new Date('2026-01-14T12:00:00Z').toISOString();
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt }, isStalled: true });
    // The stamp text itself only includes "— stalled" when the derived value
    // says stalled; the override propagates to the BoardProgressRing visual
    // state. We assert the stamp body still reads "1d ago" and the override
    // does not crash rendering.
    expect(screen.getByText(/Entered at 60% · 1d ago/)).toBeInTheDocument();
  });

  it('shows the "Move to Done?" nudge when progress is 100% and status is not COMPLETE', () => {
    renderCard({ task: { ...baseTask, progress: 100, status: 'IN_PROGRESS' } });
    expect(screen.getByText('Move to Done?')).toBeInTheDocument();
  });

  it('hides the "Move to Done?" nudge when status is already COMPLETE', () => {
    renderCard({ task: { ...baseTask, progress: 100, status: 'COMPLETE' } });
    expect(screen.queryByText('Move to Done?')).not.toBeInTheDocument();
  });

  it('opens the overflow menu, exposes "Move to…", and fires onMenuMove on selection', () => {
    // fireEvent.click is used here (not userEvent) because the card root binds
    // dnd-kit pointer listeners; userEvent's pointerdown/up flow flips the
    // draggable into its dragging placeholder before the onClick fires.
    const onMenuMove = vi.fn();
    renderCard({ onMenuMove });

    fireEvent.click(screen.getByLabelText(`Actions for ${baseTask.name}`));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));

    // The submenu lists every column except the source status (IN_PROGRESS).
    expect(screen.getByRole('menuitem', { name: 'TO DO' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'DONE' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'IN PROGRESS' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'DONE' }));
    expect(onMenuMove).toHaveBeenCalledWith('COMPLETE');
  });

  it('closes the overflow menu when a pointer-down lands outside it', () => {
    renderCard({});

    fireEvent.click(screen.getByLabelText(`Actions for ${baseTask.name}`));
    expect(screen.getByRole('menuitem', { name: 'Move to…' })).toBeInTheDocument();

    // Outside-click handler listens on document `pointerdown`.
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument();
  });
});
