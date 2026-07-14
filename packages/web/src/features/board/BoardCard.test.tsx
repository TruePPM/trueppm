/**
 * BoardCard branch coverage — exercises overlay, drag placeholder, entry-stamp
 * conditionals, priority rank, assignee overflow, "Move to Done?" nudge, and
 * the overflow menu / "Move to" submenu interaction (rule 105).
 */
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DndContext } from '@dnd-kit/core';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { BoardCard } from './BoardCard';
import type { Task, TaskStatus } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';

// Wrap the real hook in a spy so a test can count how many times BoardCard's
// render body actually runs (useIterationLabel is called unconditionally at the
// top of the component). The spy delegates to the real implementation, so every
// other test in this file sees unchanged behavior.
vi.mock('@/hooks/useIterationLabel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useIterationLabel')>();
  return { ...actual, useIterationLabel: vi.fn(actual.useIterationLabel) };
});

// Control title overflow directly (#1947): JSDOM reports scrollWidth/clientWidth
// as 0, so the real ResizeObserver-backed hook can never observe an overflow.
// The mock lets a test assert the title-peek button appears only when the title
// is actually clipped, independent of unmeasurable JSDOM layout.
const overflowState = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsOverflowing', () => ({
  useIsOverflowing: () => overflowState.value,
}));

// 5-column model (issue #178). SLA defaults match useBoardConfig (issue #192).
const COLUMNS: { status: TaskStatus; label: string; slaDays?: number }[] = [
  { status: 'BACKLOG', label: 'BACKLOG', slaDays: 14 },
  { status: 'NOT_STARTED', label: 'TO DO', slaDays: 7 },
  { status: 'IN_PROGRESS', label: 'IN PROGRESS', slaDays: 10 },
  { status: 'REVIEW', label: 'REVIEW', slaDays: 4 },
  { status: 'COMPLETE', label: 'DONE' },
];

const baseTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Backend Implementation',
  start: '2026-01-01',
  // plannedStart matches start so the task counts as scheduled — most tests
  // exercise display behavior on a committed task. Unscheduled cases override
  // plannedStart: null explicitly (issue #332).
  plannedStart: '2026-01-01',
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
  notes: '',
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
        showEvm={props.showEvm}
        showCost={props.showCost}
        onCardClick={props.onCardClick}
        scopeActions={props.scopeActions}
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

  it('renders the worst-offender Critical path badge for critical tasks (#1305)', () => {
    // At comfortable density the standalone CP chip is consolidated into the
    // worst-offender badge; critical path is its label when no higher signal wins.
    renderCard({ task: { ...baseTask, isCritical: true } });
    expect(screen.getByText('Critical path')).toBeInTheDocument();
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

  it('renders stalled from the server is_stalled verdict even when clock dwell is short (#992)', () => {
    // Clock says 1 day in-column, but the server reports the task as stalled — the
    // card renders the server verdict, not a re-derivation of the policy.
    const enteredAt = new Date('2026-01-14T12:00:00Z').toISOString();
    renderCard({
      task: { ...baseTask, statusEnteredAt: enteredAt, isStalled: true, dwellDays: 1 },
    });
    expect(screen.getByText(/— stalled/)).toBeInTheDocument();
  });

  it('uses the server dwell_days for the entry-stamp age label (#992)', () => {
    // Clock delta is 1 day, but the server dwell fact is 9 days — the label reads 9d.
    const enteredAt = new Date('2026-01-14T12:00:00Z').toISOString();
    renderCard({
      task: { ...baseTask, statusEnteredAt: enteredAt, isStalled: false, dwellDays: 9 },
    });
    expect(screen.getByText(/· 9d ago/)).toBeInTheDocument();
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
    // onMenuMove is now task-aware (issue 1520): the card passes its own task so
    // the parent can share one stable callback across the grid.
    expect(onMenuMove).toHaveBeenCalledWith(baseTask, 'COMPLETE');
  });

  it('supports keyboard navigation in the overflow menu (#838)', () => {
    renderCard({});
    const trigger = screen.getByLabelText(`Actions for ${baseTask.name}`);
    fireEvent.click(trigger);

    // Menu opens with focus on the first menuitem.
    const moveTo = screen.getByRole('menuitem', { name: 'Move to…' });
    expect(document.activeElement).toBe(moveTo);

    // Expand the submenu so there are multiple menuitems to navigate.
    fireEvent.click(moveTo);
    // ArrowDown advances to the first submenu item; focus is NOT stolen back.
    fireEvent.keyDown(moveTo, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'BACKLOG' }));

    // Home jumps to the first menuitem (Move to…), End to the last.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(moveTo);
    fireEvent.keyDown(moveTo, { key: 'End' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[items.length - 1]);

    // Escape closes the menu and restores focus to the trigger.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
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

  it('comfortable: title wraps to a second row (line-clamp-2, not single-line truncate) so long names stay readable (#1924)', () => {
    renderCard({ task: baseTask, density: 'comfortable' });
    const title = screen.getByText('Backend Implementation');
    expect(title.className).toContain('line-clamp-2');
    expect(title.className).not.toContain('truncate');
  });

  it('detailed: title also wraps to a second row (#1924)', () => {
    renderCard({ task: baseTask, density: 'detailed' });
    const title = screen.getByText('Backend Implementation');
    expect(title.className).toContain('line-clamp-2');
  });

  it('comfortable: full task name is exposed via the title attribute when clamped (#1924)', () => {
    renderCard({ task: baseTask, density: 'comfortable' });
    expect(screen.getByText('Backend Implementation')).toHaveAttribute(
      'title',
      'Backend Implementation',
    );
  });

  it('compact: title stays a single-line bar (truncate, not line-clamp-2) (#1924)', () => {
    renderCard({ task: baseTask, density: 'compact' });
    const title = screen.getByText('Backend Implementation');
    expect(title.className).toContain('truncate');
    expect(title.className).not.toContain('line-clamp-2');
  });

  it('compact: renders task name and a glyph-only worst-offender badge for critical task (#1305, #1925)', () => {
    renderCard({ task: { ...baseTask, isCritical: true }, density: 'compact' });
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
    // On the compact bar the badge is glyph-only (#1925): the glyph renders, the
    // word does not compete with the title, and the accessible name is preserved.
    expect(screen.getByText('⚑')).toBeInTheDocument();
    expect(screen.getByLabelText('On the critical path')).toBeInTheDocument();
    expect(screen.queryByText('Critical path')).not.toBeInTheDocument();
  });

  it('comfortable: worst-offender badge keeps its visible word (glyph-only is compact-only) (#1925)', () => {
    renderCard({ task: { ...baseTask, isCritical: true }, density: 'comfortable' });
    expect(screen.getByText('Critical path')).toBeInTheDocument();
  });

  it('compact: full task name is exposed via the title attribute (#1925)', () => {
    renderCard({ task: baseTask, density: 'compact' });
    expect(screen.getByText('Backend Implementation')).toHaveAttribute(
      'title',
      'Backend Implementation',
    );
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
    const { container } = renderCard({
      task: { ...baseTask, isCritical: true, progress: 40 },
      density: 'compact',
    });
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
    const { container } = renderCard({
      task: { ...baseTask, isCritical: true },
      density: 'comfortable',
    });
    expect(screen.getByText('0d float')).toBeInTheDocument();
    expect(container.querySelector('.text-semantic-critical')).toBeInTheDocument();
  });

  it('comfortable: negative float shows warning icon (issue #183)', () => {
    renderCard({ task: { ...baseTask, totalFloat: -2 }, density: 'comfortable' });
    expect(screen.getByText('-2d float')).toBeInTheDocument();
    // The warning glyph is now the WarningIcon SVG (aria-hidden) in the critical
    // float chip, not the old ⚠ emoji text.
    const chip = screen.getByText('-2d float').closest('.inline-flex');
    expect(chip?.querySelector('svg')).not.toBeNull();
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
    const { container } = renderCard({
      task: { ...baseTask, statusEnteredAt: enteredAt, status: 'IN_PROGRESS' },
    });
    expect(container.querySelector('.text-semantic-critical')).toBeInTheDocument();
  });

  it('aging chip is amber when dwell is between 1× and 2× SLA (issue #192)', () => {
    // 14 days ago, SLA 10d — 14 is between 10 and 20 → amber
    const enteredAt = new Date('2026-01-01T12:00:00Z').toISOString();
    const { container } = renderCard({
      task: { ...baseTask, statusEnteredAt: enteredAt, status: 'IN_PROGRESS' },
    });
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

  it('renders the dependency count beside an SVG icon as one in-flow chip, not an emoji (#1735)', () => {
    renderCard({ task: { ...baseTask, predecessorCount: 3, isBlocked: false } });
    const btn = screen.getByLabelText(/3 dependencies\. Press D to view\./);
    // Count renders beside the icon in the chip…
    expect(btn).toHaveTextContent('3');
    // …the glyph is the SVG LinkIcon, not the 🔗 emoji…
    expect(btn.querySelector('svg')).toBeInTheDocument();
    expect(btn.textContent).not.toContain('🔗');
    // …and the chip sits in the flex flow (shrink-0), no longer an absolute
    // top-right cluster overwriting the title. (`before:absolute` is only the
    // invisible touch-target pad on the in-flow, `relative` button.)
    expect(btn.className).toContain('shrink-0');
    expect(btn.className).not.toContain('top-2');
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

  // ---------------------------------------------------------------------------
  // EVM indicators — issue #185
  // ---------------------------------------------------------------------------

  describe('SPI chip (issue #185)', () => {
    // SPI + band are server-owned now (#990): the card renders task.spi/spiBand
    // rather than deriving from baseline dates. progress=60 → server SPI 0.60 (behind).
    const taskWithBaseline: Task = {
      ...baseTask,
      progress: 60,
      baselineStart: '2026-01-01',
      baselineFinish: '2026-01-08',
      spi: 0.6,
      spiBand: 'behind',
    };

    it('shows SPI chip in comfortable density when showEvm=spi and baseline is set', () => {
      renderCard({ task: taskWithBaseline, showEvm: 'spi', density: 'comfortable' });
      expect(screen.getByText(/^SPI 0\.\d\d$/)).toBeInTheDocument();
    });

    it('shows SPI chip in detailed density when showEvm=both', () => {
      renderCard({ task: taskWithBaseline, showEvm: 'both', density: 'detailed' });
      expect(screen.getByText(/^SPI 0\.\d\d$/)).toBeInTheDocument();
    });

    it('behind-schedule SPI chip has behind-schedule aria-label', () => {
      // Server reports SPI 0.10 / band 'behind'.
      const behindTask = {
        ...taskWithBaseline,
        progress: 10,
        spi: 0.1,
        spiBand: 'behind' as const,
      };
      renderCard({ task: behindTask, showEvm: 'spi', density: 'comfortable' });
      // Scope to the SPI chip's own label — the worst-offender badge (#1305) also
      // carries a "Behind schedule…" label for this task, so an unscoped
      // /behind schedule/ match would now be ambiguous.
      expect(screen.getByLabelText(/SPI .*behind schedule/i)).toBeInTheDocument();
    });

    it('hides SPI chip in compact density', () => {
      renderCard({ task: taskWithBaseline, showEvm: 'spi', density: 'compact' });
      expect(screen.queryByText(/SPI/)).not.toBeInTheDocument();
    });

    it('hides SPI chip when showEvm=off (default)', () => {
      renderCard({ task: taskWithBaseline, density: 'comfortable' });
      expect(screen.queryByText(/SPI/)).not.toBeInTheDocument();
    });

    it('hides SPI chip when task has no baseline data', () => {
      const noBaseline = { ...baseTask, baselineStart: undefined, baselineFinish: undefined };
      renderCard({ task: noBaseline, showEvm: 'spi', density: 'comfortable' });
      expect(screen.queryByText(/SPI/)).not.toBeInTheDocument();
    });

    it('hides SPI chip when showEvm=cpi only', () => {
      renderCard({ task: taskWithBaseline, showEvm: 'cpi', density: 'comfortable' });
      expect(screen.queryByText(/SPI/)).not.toBeInTheDocument();
    });

    it('shows SPI chip when the server provides a value for a 1-day baseline (#400)', () => {
      // The server floors a same-day baseline at 1 day so SPI is defined (#990); the
      // card just renders whatever spi/spiBand the server returns.
      const oneDay: Task = {
        ...baseTask,
        progress: 50,
        baselineStart: '2026-01-08',
        baselineFinish: '2026-01-08', // same day — 1-day baseline
        spi: 0.5,
        spiBand: 'behind',
      };
      renderCard({ task: oneDay, showEvm: 'spi', density: 'comfortable' });
      expect(screen.getByText(/^SPI 0\.\d\d$/)).toBeInTheDocument();
    });
  });

  describe('CPI chip (issue #185)', () => {
    const taskWithCpi: Task = { ...baseTask, cpi: 0.87 };

    it('shows amber CPI chip when showEvm=cpi and 0.85 ≤ CPI < 0.95', () => {
      renderCard({ task: taskWithCpi, showEvm: 'cpi', density: 'comfortable' });
      expect(screen.getByText(/CPI 0\.87/)).toBeInTheDocument();
      expect(screen.getByLabelText(/CPI 0\.87 — over budget/)).toBeInTheDocument();
    });

    it('shows red CPI chip when CPI < 0.85', () => {
      const task = { ...baseTask, cpi: 0.72 };
      renderCard({ task, showEvm: 'cpi', density: 'comfortable' });
      expect(screen.getByText(/CPI 0\.72/)).toBeInTheDocument();
      expect(screen.getByLabelText(/significantly over budget/)).toBeInTheDocument();
    });

    it('hides CPI chip when showEvm=off', () => {
      renderCard({ task: taskWithCpi, density: 'comfortable' });
      expect(screen.queryByText(/CPI/)).not.toBeInTheDocument();
    });

    it('hides CPI chip when task.cpi is null', () => {
      const task = { ...baseTask, cpi: null };
      renderCard({ task, showEvm: 'cpi', density: 'comfortable' });
      expect(screen.queryByText(/CPI/)).not.toBeInTheDocument();
    });

    it('hides CPI chip in compact density', () => {
      renderCard({ task: taskWithCpi, showEvm: 'cpi', density: 'compact' });
      expect(screen.queryByText(/CPI/)).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Cost chip — issue #189
  // ---------------------------------------------------------------------------

  describe('cost chip (issue #189)', () => {
    const taskWithCost: Task = {
      ...baseTask,
      budgetAtCompletion: 50_000,
      actualCost: 30_000,
    };

    it('shows cost chip in comfortable density when showCost=true and BAC is set', () => {
      renderCard({ task: taskWithCost, showCost: true, density: 'comfortable' });
      expect(screen.getByText(/\$30K.*\/.*\$50K/)).toBeInTheDocument();
    });

    it('shows cost chip with over-budget aria-label when actualCost > budgetAtCompletion', () => {
      const task = { ...taskWithCost, actualCost: 60_000 };
      renderCard({ task, showCost: true, density: 'comfortable' });
      // aria-label: "Cost: $60K of $50K budget"
      expect(screen.getByLabelText(/Cost:.*\$60K.*\$50K/i)).toBeInTheDocument();
    });

    it('shows — for actual cost when actualCost is null', () => {
      const task = { ...taskWithCost, actualCost: undefined };
      renderCard({ task, showCost: true, density: 'comfortable' });
      expect(screen.getByText(/—.*\/.*\$50K/)).toBeInTheDocument();
    });

    it('hides cost chip when showCost=false (default)', () => {
      renderCard({ task: taskWithCost, density: 'comfortable' });
      expect(screen.queryByText(/\$50K/)).not.toBeInTheDocument();
    });

    it('hides cost chip when budgetAtCompletion is null', () => {
      const task = { ...baseTask, budgetAtCompletion: undefined };
      renderCard({ task, showCost: true, density: 'comfortable' });
      expect(screen.queryByText(/\$50K/)).not.toBeInTheDocument();
    });

    it('hides cost chip in compact density', () => {
      renderCard({ task: taskWithCost, showCost: true, density: 'compact' });
      expect(screen.queryByText(/\$50K/)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Issue #332 — uncommitted (backlog) cards must not display scheduled-state
  // signals. CPM marks every dated task as critical and computes totalFloat;
  // without a plannedStart/sprint gate, backlog ideas falsely render with CP
  // pills, 0d-float chips, and red borders.
  // -------------------------------------------------------------------------

  describe('uncommitted-task suppression (issue #332)', () => {
    it('hides the CP pill on a backlog card with no plannedStart', () => {
      const task: Task = {
        ...baseTask,
        status: 'BACKLOG',
        isCritical: true,
        plannedStart: null,
      };
      renderCard({ task });
      // No scheduled-state signal at all: neither the legacy CP chip nor the
      // worst-offender Critical path badge (#1305) should appear.
      expect(screen.queryByText('CP')).not.toBeInTheDocument();
      expect(screen.queryByText('Critical path')).not.toBeInTheDocument();
    });

    it('renders the Critical path badge on a backlog card once plannedStart is set', () => {
      // A PM committing a backlog idea (without yet promoting it) should
      // unlock the scheduled-state styling — the gate is plannedStart, not
      // status.
      const task: Task = {
        ...baseTask,
        status: 'BACKLOG',
        isCritical: true,
        plannedStart: '2026-01-01',
      };
      renderCard({ task });
      expect(screen.getByText('Critical path')).toBeInTheDocument();
    });

    it('renders the Critical path badge on a backlog card committed via sprint membership', () => {
      const task: Task = {
        ...baseTask,
        status: 'BACKLOG',
        isCritical: true,
        plannedStart: null,
        sprintId: 'sprint-uuid',
      };
      renderCard({ task });
      expect(screen.getByText('Critical path')).toBeInTheDocument();
    });

    it('hides the float chip on an uncommitted task even when CPM has computed totalFloat', () => {
      const task: Task = {
        ...baseTask,
        status: 'BACKLOG',
        plannedStart: null,
        totalFloat: 0,
        isCritical: true,
      };
      renderCard({ task, density: 'comfortable' });
      expect(screen.queryByText(/d float/)).not.toBeInTheDocument();
    });

    it('renders the float chip on an uncommitted task once plannedStart is set', () => {
      const task: Task = {
        ...baseTask,
        status: 'BACKLOG',
        plannedStart: '2026-01-01',
        totalFloat: 5,
      };
      renderCard({ task, density: 'comfortable' });
      expect(screen.getByText('5d float')).toBeInTheDocument();
    });
  });

  describe('onCardClick (issue #304)', () => {
    function getCardRoot(): HTMLElement {
      // The card root carries `aria-roledescription="draggable"` from dnd-kit;
      // the menu trigger and chain icon are also `role="button"` but on
      // smaller elements.
      return screen
        .getAllByRole('button')
        .find((el) => el.getAttribute('aria-roledescription') === 'draggable')!;
    }

    it('fires onCardClick on root click with the task and the card root as anchor', () => {
      const onCardClick = vi.fn();
      renderCard({ onCardClick });
      const card = getCardRoot();
      fireEvent.click(card);
      expect(onCardClick).toHaveBeenCalledTimes(1);
      expect(onCardClick).toHaveBeenCalledWith(baseTask, card);
    });

    it('fires onCardClick on Enter and Space when focus is on the card root', () => {
      const onCardClick = vi.fn();
      renderCard({ onCardClick });
      const card = getCardRoot();
      fireEvent.keyDown(card, { key: 'Enter' });
      expect(onCardClick).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(card, { key: ' ' });
      expect(onCardClick).toHaveBeenCalledTimes(2);
    });

    it('fires onCardClick on the comfortable density variant as well', () => {
      const onCardClick = vi.fn();
      renderCard({ onCardClick, density: 'comfortable' });
      const card = getCardRoot();
      fireEvent.click(card);
      expect(onCardClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('sprint scope-injection pending state (ADR-0102)', () => {
    const pendingTask: Task = {
      ...baseTask,
      sprintPending: true,
      isCritical: true,
      sprintScopeChanges: [
        {
          id: 'sc-1',
          subtaskName: 'Backend Implementation',
          itemName: 'Backend Implementation',
          addedByName: 'PM',
          addedAt: '2026-01-10',
          goalImpact: false,
          status: 'pending',
        },
      ],
    };

    const scopeActions = {
      canManage: true,
      offline: false,
      onAccept: vi.fn(),
      onReject: vi.fn(),
    };

    beforeEach(() => {
      scopeActions.onAccept.mockClear();
      scopeActions.onReject.mockClear();
    });

    it('renders the pending chip and suppresses the CP badge while pending', () => {
      renderCard({ task: pendingTask, scopeActions });
      // #1472: the board chip is now a tap-to-explain disclosure trigger — its
      // accessible name gained the "What does this mean?" affordance hint.
      expect(
        screen.getByRole('button', { name: /Pending acceptance\. What does this mean\?/ }),
      ).toBeInTheDocument();
      // CP is suppressed for pending injections (not yet committed).
      expect(screen.queryByText('CP')).not.toBeInTheDocument();
    });

    it('single-tap ✓ accept fires onAccept (additive, no confirm)', () => {
      renderCard({ task: pendingTask, scopeActions });
      fireEvent.click(
        screen.getByRole('button', { name: /Accept Backend Implementation into the sprint/ }),
      );
      expect(scopeActions.onAccept).toHaveBeenCalledTimes(1);
    });

    it('hides the accept ✓ and reject menu item when the user cannot manage scope', () => {
      renderCard({ task: pendingTask, scopeActions: { ...scopeActions, canManage: false } });
      expect(
        screen.queryByRole('button', { name: /Accept Backend Implementation into the sprint/ }),
      ).not.toBeInTheDocument();
      // Open the overflow menu — no "Reject from sprint" item for a non-manager.
      fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
      expect(
        screen.queryByRole('menuitem', { name: /Reject from sprint/ }),
      ).not.toBeInTheDocument();
    });

    it('offline hides the accept ✓ and reject item (never queue a stale decision)', () => {
      renderCard({ task: pendingTask, scopeActions: { ...scopeActions, offline: true } });
      expect(
        screen.queryByRole('button', { name: /Accept Backend Implementation into the sprint/ }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
      expect(
        screen.queryByRole('menuitem', { name: /Reject from sprint/ }),
      ).not.toBeInTheDocument();
    });

    it('reject is in the overflow menu and fires onReject', () => {
      renderCard({ task: pendingTask, scopeActions });
      fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Reject from sprint/ }));
      expect(scopeActions.onReject).toHaveBeenCalledTimes(1);
    });
  });

  describe('hover-lift (rule 181)', () => {
    it('lifts via a motion-safe transform and never uses a drop shadow (rule 1)', () => {
      const { container } = renderCard({});
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).toContain('motion-safe:hover:-translate-y-px');
      expect(root.className).toContain('ease-brand');
      // the dim/opacity states and the lift share one multi-prop transition
      expect(root.className).toContain('transition-[opacity,transform]');
      // no shadow — the card's own border carries the edge (rule 1)
      expect(root.className).not.toMatch(/(^|\s)shadow-/);
    });
  });

  // -------------------------------------------------------------------------
  // Worst-offender badge + health-chip peek (#1305, ADR-0191 §4)
  // -------------------------------------------------------------------------
  describe('worst-offender badge (#1305)', () => {
    it('shows a blocked badge with a non-lossy dependency count', () => {
      renderCard({ task: { ...baseTask, isBlocked: true, predecessorCount: 2 } });
      expect(screen.getByText('Blocked · 2 deps')).toBeInTheDocument();
    });

    it('surfaces the highest-severity signal: blocked outranks critical path', () => {
      renderCard({ task: { ...baseTask, isBlocked: true, predecessorCount: 1, isCritical: true } });
      expect(screen.getByText('Blocked · 1 dep')).toBeInTheDocument();
      expect(screen.queryByText('Critical path')).not.toBeInTheDocument();
    });

    it('on-track card shows no badge (calm card)', () => {
      renderCard({ task: baseTask });
      expect(
        screen.queryByRole('button', { name: /show health details/i }),
      ).not.toBeInTheDocument();
    });

    it('the badge toggles the health-chip peek and reflects aria-expanded', () => {
      renderCard({ task: { ...baseTask, isCritical: true } });
      const badge = screen.getByRole('button', { name: /show health details/i });
      expect(badge).toHaveAttribute('aria-expanded', 'false');
      const peek = document.getElementById(badge.getAttribute('aria-controls')!)!;
      expect(peek.className).toContain('hidden');

      fireEvent.click(badge);
      expect(badge).toHaveAttribute('aria-expanded', 'true');
      expect(peek.className).toContain('block');
      expect(peek.className).not.toContain('hidden');
    });

    it('Escape collapses an opened peek and returns focus to the badge', () => {
      renderCard({ task: { ...baseTask, isCritical: true } });
      const badge = screen.getByRole('button', { name: /show health details/i });
      fireEvent.click(badge);
      expect(badge).toHaveAttribute('aria-expanded', 'true');

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(badge).toHaveAttribute('aria-expanded', 'false');
      expect(badge).toHaveFocus();
    });

    it('detailed density renders no badge and keeps the CP chip inline', () => {
      renderCard({ task: { ...baseTask, isCritical: true }, density: 'detailed' });
      expect(
        screen.queryByRole('button', { name: /show health details/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('CP')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // React.memo — the whole point of issue 1520: an unrelated board re-render
  // (drag-over, another card's focus, a search keystroke) must not re-render a
  // card whose own props are unchanged.
  // ---------------------------------------------------------------------------
  describe('memoization (issue 1520)', () => {
    const renderSpy = vi.mocked(useIterationLabel);

    // Stable references live outside the harness so every parent render passes
    // BoardCard the *same* task, callback, and columns — the condition under
    // which React.memo is allowed to bail out.
    const stableProps: ComponentProps<typeof BoardCard> = {
      task: baseTask,
      onMenuMove: () => {},
      columns: COLUMNS,
    };

    it('skips re-render when unrelated parent state changes but its props are stable', () => {
      function Harness() {
        const [n, setN] = useState(0);
        return (
          <DndContext>
            <button type="button" onClick={() => setN((v) => v + 1)}>
              bump {n}
            </button>
            <BoardCard {...stableProps} />
          </DndContext>
        );
      }
      render(<Harness />);
      // Clear the mount call(s); count only renders triggered by the bump below.
      renderSpy.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /bump/ }));
      expect(screen.getByRole('button', { name: 'bump 1' })).toBeInTheDocument();
      // The memoized card bailed out — its render body (and thus the hook) never ran.
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('does re-render when a primitive prop it reads actually changes', () => {
      function Harness() {
        const [dimmed, setDimmed] = useState(false);
        return (
          <DndContext>
            <button type="button" onClick={() => setDimmed(true)}>
              dim
            </button>
            <BoardCard {...stableProps} isDimmed={dimmed} />
          </DndContext>
        );
      }
      render(<Harness />);
      renderSpy.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'dim' }));
      // isDimmed flipped false → true, so the card must re-render (guards against
      // an over-eager comparator swallowing a real change).
      expect(renderSpy).toHaveBeenCalled();
    });
  });
});

describe('BoardCard v2 identity meta (issue 1230)', () => {
  it('renders the visible short id on the card face', () => {
    renderCard({ task: { ...baseTask, shortId: 'a1b2c3d4' } });
    expect(screen.getByText('a1b2c3d4')).toBeInTheDocument();
  });

  it('renders a story-points pill with an accessible label', () => {
    renderCard({ task: { ...baseTask, storyPoints: 8 } });
    expect(screen.getByText('8 pts')).toBeInTheDocument();
    expect(screen.getByLabelText('8 story points')).toBeInTheDocument();
  });

  it('singularizes the points pill label at one point', () => {
    renderCard({ task: { ...baseTask, storyPoints: 1 } });
    expect(screen.getByLabelText('1 story point')).toBeInTheDocument();
  });

  it('renders a stream color tag keyed to the epic when present', () => {
    const { container } = renderCard({
      task: { ...baseTask, parentEpic: 'epic-1', shortId: 'aa11bb22' },
    });
    // The stream dot is a decorative colored node with a "Stream" title.
    const dot = container.querySelector('span[title="Stream"]');
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.backgroundColor).not.toBe('');
  });

  it('omits the identity meta row when the card has none of the data', () => {
    const { container } = renderCard({ task: baseTask });
    expect(container.querySelector('span[title="Stream"]')).toBeNull();
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
  });
});

// Coarse-pointer tap-to-peek promotion on the compact bar (#1947, web-rule 256).
// The mobile board forces compact density (rule 193); on touch the hover-only
// health badge and the truncated title strand meaning the user cannot recover,
// so each promotes to a CardPeekButton. Fine pointer must stay byte-identical.
describe('BoardCard compact bar touch affordances (#1947)', () => {
  // Stub matchMedia so `(pointer: coarse)` reports touch while `min-width`
  // queries keep reporting the reference `lg` layout the other specs assume.
  function stubPointer(coarse: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /^\(min-width:/.test(query) || (coarse && /pointer:\s*coarse/.test(query)),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    overflowState.value = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    overflowState.value = false;
  });

  it('(a) coarse + overflowing title → title-peek button opens/closes the full name', () => {
    stubPointer(true);
    overflowState.value = true;
    renderCard({ task: baseTask, density: 'compact' });

    const trigger = screen.getByRole('button', { name: /show full title: backend implementation/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Backend Implementation');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('(b) coarse + title that fits → no title-peek button (rule 122)', () => {
    stubPointer(true);
    overflowState.value = false; // scrollWidth === clientWidth (title fits)
    renderCard({ task: baseTask, density: 'compact' });
    expect(screen.queryByRole('button', { name: /show full title/i })).not.toBeInTheDocument();
  });

  it('(c) coarse + signal → health badge is a tap-to-peek button showing srText', () => {
    stubPointer(true);
    renderCard({ task: { ...baseTask, isCritical: true }, density: 'compact' });

    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('note')).toHaveTextContent('On the critical path');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('(d) fine pointer → no peek buttons; health badge stays a display-only span', () => {
    // No stub → default matchMedia reports a fine pointer (coarse=false).
    overflowState.value = true; // even if it would overflow, fine pointer adds nothing
    renderCard({ task: { ...baseTask, isCritical: true }, density: 'compact' });

    expect(
      screen.queryByRole('button', { name: /what does this mean/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show full title/i })).not.toBeInTheDocument();

    // The badge is a plain span carrying its meaning in title + aria-label.
    const badge = screen.getByLabelText('On the critical path');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveAttribute('title', 'On the critical path');
  });

  it('(e) coarse + closed → no popover in the document until opened', () => {
    stubPointer(true);
    renderCard({ task: { ...baseTask, isCritical: true }, density: 'compact' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
