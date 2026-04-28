/**
 * BoardCard branch coverage — exercises overlay, drag placeholder, entry-stamp
 * conditionals, priority rank, assignee overflow, "Move to Done?" nudge, and
 * the overflow menu / "Move to" submenu interaction (rule 105).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import type { ComponentProps, ReactNode } from 'react';
import { BoardCard } from './BoardCard';
import type { Task, TaskStatus } from '@/types';

// 5-column model (issue #178). SLA defaults match useBoardConfig (issue #192).
const COLUMNS: { status: TaskStatus; label: string; slaDays?: number }[] = [
  { status: 'BACKLOG',     label: 'BACKLOG',     slaDays: 14 },
  { status: 'NOT_STARTED', label: 'TO DO',       slaDays: 7  },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS', slaDays: 10 },
  { status: 'REVIEW',      label: 'REVIEW',      slaDays: 4  },
  { status: 'COMPLETE',    label: 'DONE' },
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

function renderCard(props: Partial<ComponentProps<typeof BoardCard>>) {
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
        density={props.density}
        isKeyboardFocused={props.isKeyboardFocused}
        isDimmed={props.isDimmed}
        overallocByResource={props.overallocByResource}
        onShowDeps={props.onShowDeps}
        onShowRisks={props.onShowRisks}
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
    expect(screen.getByRole('menuitem', { name: 'BACKLOG' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'TO DO' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'REVIEW' })).toBeInTheDocument();
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

  // ---------------------------------------------------------------------------
  // Readiness chip (issue #179)
  // ---------------------------------------------------------------------------

  it('renders the idea chip with dashed border for readiness=idea', () => {
    renderCard({ task: { ...baseTask, readiness: 'idea' } });
    expect(screen.getByText('idea')).toBeInTheDocument();
  });

  it('renders the estimated chip for readiness=estimated', () => {
    renderCard({ task: { ...baseTask, readiness: 'estimated' } });
    expect(screen.getByText('estimated')).toBeInTheDocument();
  });

  it('renders the ready chip with chain icon for readiness=ready', () => {
    renderCard({ task: { ...baseTask, readiness: 'ready' } });
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('renders the baselined chip with lock icon for readiness=baselined', () => {
    renderCard({ task: { ...baseTask, readiness: 'baselined' } });
    expect(screen.getByText('baselined')).toBeInTheDocument();
  });

  it('shows ? avatar instead of progress ring for idea cards', () => {
    renderCard({ task: { ...baseTask, readiness: 'idea', assignees: [] } });
    expect(screen.getByLabelText('Unassigned')).toBeInTheDocument();
  });

  it('omits readiness chip when readiness is undefined', () => {
    renderCard({ task: baseTask }); // no readiness field
    expect(screen.queryByText('idea')).not.toBeInTheDocument();
    expect(screen.queryByText('estimated')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Card density (issue #193)
  // ---------------------------------------------------------------------------

  it('compact: renders task name and CP chip for critical task', () => {
    renderCard({ task: { ...baseTask, isCritical: true }, density: 'compact' });
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
    expect(screen.getByText('CP')).toBeInTheDocument();
  });

  it('compact: progress strip uses semantic-on-track for 100%-complete non-critical task', () => {
    const { container } = renderCard({ task: { ...baseTask, progress: 100 }, density: 'compact' });
    // The progress fill div gets bg-semantic-on-track when done
    expect(container.querySelector('.bg-semantic-on-track')).toBeInTheDocument();
  });

  it('compact: progress strip uses brand-primary for in-progress non-critical task', () => {
    const { container } = renderCard({ task: { ...baseTask, progress: 50 }, density: 'compact' });
    expect(container.querySelector('.bg-brand-primary')).toBeInTheDocument();
  });

  it('compact: progress strip uses semantic-critical for critical task', () => {
    const { container } = renderCard({ task: { ...baseTask, isCritical: true, progress: 40 }, density: 'compact' });
    // The progress fill div should be semantic-critical (not brand-primary)
    const criticalEl = container.querySelector('.bg-semantic-critical');
    expect(criticalEl).toBeInTheDocument();
  });

  it('detailed: renders float chip for non-critical task with totalFloat', () => {
    renderCard({ task: { ...baseTask, totalFloat: 5 }, density: 'detailed' });
    expect(screen.getByText('5d float')).toBeInTheDocument();
  });

  it('detailed: float chip is red when totalFloat is 0', () => {
    const { container } = renderCard({ task: { ...baseTask, totalFloat: 0 }, density: 'detailed' });
    expect(screen.getByText('0d float')).toBeInTheDocument();
    expect(container.querySelector('.text-semantic-critical')).toBeInTheDocument();
  });

  it('detailed: float chip is amber when totalFloat is < 3', () => {
    const { container } = renderCard({ task: { ...baseTask, totalFloat: 2 }, density: 'detailed' });
    expect(screen.getByText('2d float')).toBeInTheDocument();
    expect(container.querySelector('.text-brand-accent-dark')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #183 — float chip in comfortable mode + CP "0d float" + negative float
  // -------------------------------------------------------------------------

  it('comfortable: shows float chip for non-critical task with totalFloat (issue #183)', () => {
    renderCard({ task: { ...baseTask, totalFloat: 7 }, density: 'comfortable' });
    expect(screen.getByText('7d float')).toBeInTheDocument();
  });

  it('comfortable: CP task shows "0d float" chip in red (issue #183)', () => {
    const { container } = renderCard({ task: { ...baseTask, isCritical: true }, density: 'comfortable' });
    expect(screen.getByText('0d float')).toBeInTheDocument();
    expect(container.querySelector('.text-semantic-critical')).toBeInTheDocument();
  });

  it('comfortable: negative float shows warning icon (issue #183)', () => {
    renderCard({ task: { ...baseTask, totalFloat: -2 }, density: 'comfortable' });
    expect(screen.getByText('-2d float')).toBeInTheDocument();
    expect(screen.getByText('⚠')).toBeInTheDocument();
  });

  it('compact: does not show float chip (issue #183)', () => {
    renderCard({ task: { ...baseTask, totalFloat: 5 }, density: 'compact' });
    expect(screen.queryByText(/d float/)).not.toBeInTheDocument();
  });

  it('omits float chip when totalFloat is undefined and task is not critical (issue #183)', () => {
    renderCard({ task: baseTask, density: 'comfortable' }); // no totalFloat
    expect(screen.queryByText(/d float/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #186 — baseline vs. forecast date variance hover panel
  // -------------------------------------------------------------------------

  it('baseline variance panel is in DOM for tasks with baselineFinish (issue #186)', () => {
    // finish: Jan 8, baselineFinish: Jan 5 → +3d late (amber, not >5 so not critical)
    renderCard({
      task: { ...baseTask, finish: '2026-01-08', baselineFinish: '2026-01-05' },
      density: 'comfortable',
    });
    // The panel is hidden via CSS (group-hover:block) but exists in the DOM
    expect(screen.getByLabelText('Baseline variance: +3d')).toBeInTheDocument();
    expect(screen.getByText('+3d')).toBeInTheDocument();
  });

  it('baseline variance +Nd uses amber class when 0 < variance ≤ 5 (issue #186)', () => {
    const { container } = renderCard({
      task: { ...baseTask, finish: '2026-01-08', baselineFinish: '2026-01-05' },
      density: 'comfortable',
    });
    expect(container.querySelector('.text-semantic-at-risk')).toBeInTheDocument();
  });

  it('baseline variance +Nd uses red class when variance > 5d (issue #186)', () => {
    const { container } = renderCard({
      task: { ...baseTask, finish: '2026-01-15', baselineFinish: '2026-01-05' },
      density: 'comfortable',
    });
    // 10 days late → semantic-critical
    expect(container.querySelector('.text-semantic-critical')).toBeInTheDocument();
  });

  it('baseline variance is green when forecast is on time (issue #186)', () => {
    const { container } = renderCard({
      task: { ...baseTask, finish: '2026-01-05', baselineFinish: '2026-01-08' },
      density: 'comfortable',
    });
    // 3 days early → semantic-on-track
    expect(container.querySelector('.text-semantic-on-track')).toBeInTheDocument();
  });

  it('omits baseline variance panel when baselineFinish is undefined (issue #186)', () => {
    renderCard({ task: baseTask, density: 'comfortable' }); // no baselineFinish
    expect(screen.queryByLabelText(/Baseline variance/)).not.toBeInTheDocument();
  });

  it('compact: omits baseline variance panel (issue #186)', () => {
    renderCard({
      task: { ...baseTask, finish: '2026-01-08', baselineFinish: '2026-01-05' },
      density: 'compact',
    });
    expect(screen.queryByLabelText(/Baseline variance/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Issue #192 — card aging / dwell-time indicator
  // -------------------------------------------------------------------------

  it('shows aging chip when dwell exceeds column SLA (issue #192)', () => {
    // System time: Jan 15. statusEnteredAt: Jan 1 = 14 days ago.
    // IN_PROGRESS SLA is 10d — 14d > 10d → aging chip appears.
    const enteredAt = new Date('2026-01-01T12:00:00Z').toISOString();
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt, status: 'IN_PROGRESS' } });
    expect(screen.getByLabelText(/14 days in this column/)).toBeInTheDocument();
    expect(screen.getByText('14d')).toBeInTheDocument();
  });

  it('does not show aging chip when dwell is within SLA (issue #192)', () => {
    // 2 days ago, IN_PROGRESS SLA is 10d — no chip.
    const enteredAt = new Date('2026-01-13T12:00:00Z').toISOString();
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt, status: 'IN_PROGRESS' } });
    expect(screen.queryByLabelText(/days in this column/)).not.toBeInTheDocument();
  });

  it('aging chip is red when dwell exceeds 2× SLA (issue #192)', () => {
    // 25 days ago, SLA 10d — 25 > 20 (2×SLA) → red/critical
    const enteredAt = new Date('2025-12-21T12:00:00Z').toISOString();
    const { container } = renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt, status: 'IN_PROGRESS' } });
    expect(container.querySelector('.text-semantic-critical')).toBeInTheDocument();
  });

  it('aging chip is amber when dwell is between 1× and 2× SLA (issue #192)', () => {
    // 14 days ago, SLA 10d — 14 is between 10 and 20 → amber
    const enteredAt = new Date('2026-01-01T12:00:00Z').toISOString();
    const { container } = renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt, status: 'IN_PROGRESS' } });
    expect(container.querySelector('.text-brand-accent-dark')).toBeInTheDocument();
  });

  it('does not show aging chip when statusEnteredAt is absent (issue #192)', () => {
    renderCard({ task: baseTask }); // no statusEnteredAt
    expect(screen.queryByLabelText(/days in this column/)).not.toBeInTheDocument();
  });

  it('does not show aging chip when column has no SLA configured (issue #192)', () => {
    // COMPLETE column has no slaDays in COLUMNS
    const enteredAt = new Date('2026-01-01T12:00:00Z').toISOString();
    renderCard({ task: { ...baseTask, statusEnteredAt: enteredAt, status: 'COMPLETE' } });
    expect(screen.queryByLabelText(/days in this column/)).not.toBeInTheDocument();
  });

  it('detailed: shows all assignees without +N overflow', () => {
    const task: Task = {
      ...baseTask,
      assignees: [
        { resourceId: 'r1', name: 'Alice Chen', units: 1 },
        { resourceId: 'r2', name: 'Bob Martinez', units: 1 },
        { resourceId: 'r3', name: 'Carol Park', units: 1 },
        { resourceId: 'r4', name: 'David Lee', units: 1 },
      ],
    };
    renderCard({ task, density: 'detailed' });
    expect(screen.getByText('AC')).toBeInTheDocument();
    expect(screen.getByText('DL')).toBeInTheDocument();
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Board batch 3 PPM signals (#182 deps, #184 overalloc, #188 risks).
  // ---------------------------------------------------------------------------

  it('shows the chain icon when predecessor_count > 0', () => {
    const onShowDeps = vi.fn();
    renderCard({
      task: { ...baseTask, predecessorCount: 2, isBlocked: false },
      onShowDeps,
    });
    const btn = screen.getByLabelText(/2 dependencies\. Press D to view\./);
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onShowDeps).toHaveBeenCalled();
  });

  it('omits the chain icon when predecessor_count is 0', () => {
    renderCard({ task: { ...baseTask, predecessorCount: 0 } });
    expect(screen.queryByLabelText(/Press D to view/)).not.toBeInTheDocument();
  });

  it('renders the chain icon as red and labels it Blocked when is_blocked', () => {
    renderCard({
      task: { ...baseTask, predecessorCount: 1, isBlocked: true },
    });
    const btn = screen.getByLabelText(/Blocked by 1 dependency\. Press D to view\./);
    expect(btn.className).toContain('text-semantic-critical');
  });

  it('shows the risk icon with severity-aware label when linked_risks_count > 0', () => {
    const onShowRisks = vi.fn();
    renderCard({
      task: { ...baseTask, linkedRisksCount: 3, linkedRisksMaxSeverity: 18 },
      onShowRisks,
    });
    const btn = screen.getByLabelText(/3 linked risks, severity red\. Click to view\./);
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onShowRisks).toHaveBeenCalled();
  });

  it('omits the risk icon when linked_risks_max_severity is null even if count > 0', () => {
    // Defensive: count > 0 with null max severity (e.g. all risks have null
    // probability/impact) should hide the icon — see ADR-0035 §Durable Execution.
    renderCard({
      task: { ...baseTask, linkedRisksCount: 1, linkedRisksMaxSeverity: null },
    });
    expect(screen.queryByLabelText(/linked risk/)).not.toBeInTheDocument();
  });

  it('renders the overallocation red dot on assignees with peak factor > 1', () => {
    const overallocByResource = new Map([['r1', 1.4]]);
    renderCard({
      task: {
        ...baseTask,
        assignees: [{ resourceId: 'r1', name: 'Pat Chen', units: 1 }],
      },
      overallocByResource,
    });
    expect(screen.getByLabelText('Pat Chen, overallocated')).toBeInTheDocument();
  });

  it('does not render the overallocation dot when factor is absent', () => {
    renderCard({
      task: {
        ...baseTask,
        assignees: [{ resourceId: 'r1', name: 'Pat Chen', units: 1 }],
      },
      overallocByResource: new Map(),
    });
    expect(screen.queryByLabelText('Pat Chen, overallocated')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Pat Chen')).toBeInTheDocument();
  });

  it('shows the 1.4× factor inline in detailed density only', () => {
    const overallocByResource = new Map([['r1', 1.4]]);
    const task = {
      ...baseTask,
      assignees: [{ resourceId: 'r1', name: 'Pat Chen', units: 1 }],
    };
    const { rerender } = renderCard({ task, overallocByResource, density: 'comfortable' });
    expect(screen.queryByText('1.4×')).not.toBeInTheDocument();
    rerender(
      <DndContext>
        <BoardCard
          task={task}
          onMenuMove={() => {}}
          columns={COLUMNS}
          density="detailed"
          overallocByResource={overallocByResource}
        />
      </DndContext>,
    );
    expect(screen.getByText('1.4×')).toBeInTheDocument();
  });

  it('applies the keyboard-focused ring when isKeyboardFocused', () => {
    const { container } = renderCard({ isKeyboardFocused: true });
    const card = container.querySelector('[role="button"]')!;
    expect(card.className).toContain('ring-2');
  });

  it('dims the card when isDimmed is true', () => {
    const { container } = renderCard({ isDimmed: true });
    const card = container.querySelector('[role="button"]')!;
    expect(card.className).toContain('opacity-40');
  });
});
