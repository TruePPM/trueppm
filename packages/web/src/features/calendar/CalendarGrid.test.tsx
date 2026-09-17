import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Task } from '@/types';
import { CalendarGrid } from './CalendarGrid';

// useBreakpoint drives the desktop-grid vs mobile-list branch (#2161). Default
// to the reference desktop tier; the mobile test overrides it per-case.
const { breakpointMock } = vi.hoisted(() => ({ breakpointMock: vi.fn(() => 'lg') }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => breakpointMock() }));

afterEach(() => {
  breakpointMock.mockReturnValue('lg');
});

// Anchor to a fixed month so tests are deterministic
const ANCHOR = '2026-05-01'; // May 2026 — starts on Friday

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  wbs: '1',
  name: 'Integration Test',
  start: '2026-05-05',
  finish: '2026-05-08',
  duration: 4,
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
});

const milestoneTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'm1',
  wbs: '2',
  name: 'Launch Milestone',
  start: '2026-05-07',
  finish: '2026-05-07',
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
});

describe('CalendarGrid', () => {
  it('renders day-of-week headers', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Fri')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
  });

  it('renders the CalendarLegend with all entries incl. Due + Sprint boundary (issue 1230)', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    expect(screen.getByText('At risk')).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('Milestone')).toBeInTheDocument();
    expect(screen.getByText('Due')).toBeInTheDocument();
    expect(screen.getByText('Sprint boundary')).toBeInTheDocument();
  });

  it('marks sprint start/finish days with a boundary dot (issue 1230)', () => {
    const boundaries = new Set(['2026-05-04', '2026-05-15']);
    render(
      <CalendarGrid
        anchorIso={ANCHOR}
        tasks={[]}
        onTaskClick={vi.fn()}
        sprintBoundaries={boundaries}
      />,
    );
    // One dot per boundary day that falls inside the rendered month grid.
    const dots = screen.getAllByLabelText('Sprint boundary');
    // Both boundary dates are in May 2026; the legend swatch is aria-hidden, so
    // only the day-cell dots carry the accessible label.
    expect(dots.length).toBe(2);
  });

  it('renders no boundary dots when no sprint boundaries are supplied', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.queryByLabelText('Sprint boundary')).not.toBeInTheDocument();
  });

  it('renders milestone as a ◆ diamond button, not a chip', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[milestoneTask()]} onTaskClick={vi.fn()} />);
    // The diamond SVG has a polygon element, and there is an aria-label for the milestone button
    const milestoneBtn = screen.getByRole('button', { name: /Milestone: Launch Milestone/i });
    expect(milestoneBtn).toBeInTheDocument();
    // The button contains a polygon (diamond SVG)
    const polygon = milestoneBtn.querySelector('polygon');
    expect(polygon).toBeInTheDocument();
    expect(polygon?.getAttribute('points')).toBe('5,0 10,5 5,10 0,5');
  });

  it('fires onTaskClick when milestone diamond is clicked', async () => {
    const onTaskClick = vi.fn();
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[milestoneTask()]} onTaskClick={onTaskClick} />);
    await userEvent.click(screen.getByRole('button', { name: /Milestone: Launch Milestone/i }));
    expect(onTaskClick).toHaveBeenCalledWith('m1');
  });

  it('duration tasks are not rendered as milestone diamonds', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    // No milestone button for a regular task
    expect(screen.queryByRole('button', { name: /Milestone:/i })).not.toBeInTheDocument();
  });

  it('renders chip for duration task (chip overlay present)', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    // CalendarChip renders a button with the task name
    const chipBtn = screen.getByRole('button', { name: /Integration Test/i });
    expect(chipBtn).toBeInTheDocument();
  });

  it('appends ", due" to the finish fragment of a task chip (issue 1230)', () => {
    // A single-week task's fragment contains its finish date → the due marker.
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Integration Test, due' })).toBeInTheDocument();
  });

  it('shows +N more overflow badge when too many chips in a week', () => {
    // Create 5 overlapping tasks in the same week to exceed MAX_LANES (4)
    const tasks = Array.from({ length: 5 }, (_, i) =>
      baseTask({
        id: `t${i}`,
        wbs: `1.${i}`,
        name: `Task ${i}`,
        start: '2026-05-04',
        finish: '2026-05-08',
      }),
    );
    render(<CalendarGrid anchorIso={ANCHOR} tasks={tasks} onTaskClick={vi.fn()} />);
    expect(screen.getByText(/\+1 more/i)).toBeInTheDocument();
  });

  it('does not show overflow badge with 4 or fewer overlapping tasks', () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      baseTask({
        id: `t${i}`,
        wbs: `1.${i}`,
        name: `Task ${i}`,
        start: '2026-05-04',
        finish: '2026-05-08',
      }),
    );
    render(<CalendarGrid anchorIso={ANCHOR} tasks={tasks} onTaskClick={vi.fn()} />);
    expect(screen.queryByText(/more/i)).not.toBeInTheDocument();
  });

  it('renders day numbers for the month', () => {
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
    // May has 31 days — spot-check a few
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Week view (#3167)
  // -------------------------------------------------------------------------

  it('the calView default is month — omitting the prop takes the month path', () => {
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. Comparing "omitted" against
    // an explicit "month" would be a tautology: both resolve to the same
    // default and take the same branch, so such a test cannot fail. What is
    // worth pinning is that the default is *month and not week* — that IS
    // falsifiable, and it is the property every pre-existing caller relies on.
    // Month-mode rendering itself is pinned by the behavioral assertions below
    // and by the suite that predates this change.
    const { container } = render(
      <CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />,
    );
    const rows = container.querySelectorAll('.divide-y > div');
    expect(rows.length).toBeGreaterThan(1); // a week render would be exactly 1
  });

  it('month mode keeps its grid shape: multiple rows, dimmed out-of-month days, 4-lane cap', () => {
    // The month-mode contract, asserted directly rather than by self-comparison.
    // Each clause fails if month rendering regresses.
    const tasks = Array.from({ length: 6 }, (_, i) =>
      baseTask({
        id: `t${i}`,
        wbs: `1.${i}`,
        name: `Task ${i}`,
        start: '2026-05-04',
        finish: '2026-05-08',
      }),
    );
    const { container } = render(
      <CalendarGrid anchorIso={ANCHOR} calView="month" tasks={tasks} onTaskClick={vi.fn()} />,
    );
    const rows = container.querySelector('.divide-y') as HTMLElement;

    // 4-6 week rows for the anchored month.
    expect(rows.querySelectorAll(':scope > div').length).toBeGreaterThanOrEqual(4);
    // Neighbouring-month days are dimmed.
    expect(rows.querySelectorAll('.bg-neutral-surface-sunken').length).toBeGreaterThan(0);
    // The cap still applies: 6 overlapping tasks, 4 lanes, 2 hidden.
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    // Fixed 4-lane row height, independent of task count.
    expect((rows.querySelector(':scope > div') as HTMLElement).style.minHeight).toBe('120px');
  });

  it('week mode renders a single week row, month mode renders several', () => {
    const weekRows = (mode: 'week' | 'month') => {
      const { container, unmount } = render(
        <CalendarGrid anchorIso={ANCHOR} calView={mode} tasks={[]} onTaskClick={vi.fn()} />,
      );
      // Week rows are the children of the scrolling wrapper, which is the
      // sibling after the day-of-week header.
      const n = container.querySelectorAll('.divide-y > div').length;
      unmount();
      return n;
    };
    expect(weekRows('week')).toBe(1);
    expect(weekRows('month')).toBeGreaterThan(3);
  });

  it('week mode shows only tasks in the anchored week', () => {
    // ANCHOR is 2026-05-01 (a Friday) → the Apr 27 – May 3 week.
    const inWeek = baseTask({
      id: 'in',
      name: 'In Week',
      start: '2026-04-29',
      finish: '2026-04-30',
    });
    const laterInMonth = baseTask({
      id: 'out',
      name: 'Later Month',
      start: '2026-05-18',
      finish: '2026-05-20',
    });
    render(
      <CalendarGrid
        anchorIso={ANCHOR}
        calView="week"
        tasks={[inWeek, laterInMonth]}
        onTaskClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /In Week/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Later Month/ })).not.toBeInTheDocument();
  });

  it('week mode renders ALL 20 overlapping tasks with no +N more (#3167)', () => {
    // The defect's real cost: month mode caps at 4 lanes and hides the rest
    // behind inert text. A week row has the vertical budget to show them all,
    // and 20-in-one-week is the observed peak on a real-shaped project.
    const tasks = Array.from({ length: 20 }, (_, i) =>
      baseTask({
        id: `t${i}`,
        wbs: `1.${i}`,
        name: `Task ${i}`,
        start: '2026-04-27',
        finish: '2026-05-01',
      }),
    );
    const { rerender } = render(
      <CalendarGrid anchorIso={ANCHOR} calView="week" tasks={tasks} onTaskClick={vi.fn()} />,
    );
    for (let i = 0; i < 20; i++) {
      expect(screen.getByRole('button', { name: new RegExp(`^Task ${i},`) })).toBeInTheDocument();
    }
    expect(screen.queryByText(/more/i)).not.toBeInTheDocument();

    // ...and month mode still caps, so this is a week-mode property, not a
    // silent removal of the cap everywhere.
    rerender(
      <CalendarGrid anchorIso={ANCHOR} calView="month" tasks={tasks} onTaskClick={vi.fn()} />,
    );
    expect(screen.getByText(/\+16 more/)).toBeInTheDocument();
  });

  it('week mode grows the row to fit its lanes, month mode stays at the 4-lane height', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      baseTask({
        id: `t${i}`,
        wbs: `1.${i}`,
        name: `Task ${i}`,
        start: '2026-04-27',
        finish: '2026-05-01',
      }),
    );
    const rowHeight = (mode: 'week' | 'month') => {
      const { container, unmount } = render(
        <CalendarGrid anchorIso={ANCHOR} calView={mode} tasks={tasks} onTaskClick={vi.fn()} />,
      );
      const row = container.querySelector('.divide-y > div') as HTMLElement;
      const h = row.style.minHeight;
      unmount();
      return h;
    };
    // 24 + 10*22 + 8 = 252
    expect(rowHeight('week')).toBe('252px');
    // month is pinned to the 4-lane cell height regardless of task count
    expect(rowHeight('month')).toBe('120px');
  });

  it('week mode floors an empty week at the month row height and names it', () => {
    const { container } = render(
      <CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />,
    );
    const row = container.querySelector('.divide-y > div') as HTMLElement;
    expect(row.style.minHeight).toBe('120px');
    expect(screen.getByText(/No tasks in the week of/)).toBeInTheDocument();
  });

  it('week mode does not gray any day as out-of-month', () => {
    // Anchor 2026-05-01 is a Friday, so its week spans Apr 27 – May 3: six of
    // seven days are outside the anchored month. Month mode grays them; week
    // mode must not, because every rendered day is inside the window.
    const { container } = render(
      <CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />,
    );
    // Scope to the week rows — the Mon..Sun header cells legitimately carry
    // this class in both modes and are not day cells.
    const rows = container.querySelector('.divide-y') as HTMLElement;
    expect(rows.querySelectorAll('.bg-neutral-surface-sunken').length).toBe(0);

    // ...and month mode, on the same anchor, does gray them — so the assertion
    // above is testing week mode's behavior, not an absent class name.
    const month = render(
      <CalendarGrid anchorIso={ANCHOR} calView="month" tasks={[]} onTaskClick={vi.fn()} />,
    );
    const monthRows = month.container.querySelector('.divide-y') as HTMLElement;
    expect(monthRows.querySelectorAll('.bg-neutral-surface-sunken').length).toBeGreaterThan(0);
  });

  it('exposes the grid as a landmark whose name is stable across navigation', () => {
    // A landmark name is an identity a screen-reader user navigates by, not a
    // state readout — renaming it on every Prev/Next would churn the rotor
    // entry. The volatile window lives in the toolbar heading and in
    // CalendarView's live region instead.
    const { rerender } = render(
      <CalendarGrid anchorIso={ANCHOR} calView="month" tasks={[]} onTaskClick={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'Calendar' })).toBeInTheDocument();
    rerender(<CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Calendar' })).toBeInTheDocument();
    rerender(
      <CalendarGrid anchorIso="2026-09-14" calView="week" tasks={[]} onTaskClick={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('paints capped-row chips at their own lanes, not at a filtered index (#3167)', () => {
    // Pre-existing bug found while fixing #3167: the chip overlay re-derived a
    // chip's lane as `laneMap.get(i)` where `i` indexed the *filtered* visible
    // array, while laneMap is keyed by index into the unfiltered week array.
    // When the cap drops a chip that is not last, every later chip shifts onto
    // another chip's lane — and one lands past the row's own height.
    //
    // Task 0 starts last (Sunday only) so it sorts last and takes the highest
    // lane, but sits first in the array — so the dropped element is not at the
    // end. Anchor 2026-05-06 → the May 4-10 week.
    const tasks: Task[] = [
      baseTask({ id: 't0', name: 'Task 0', start: '2026-05-10', finish: '2026-05-10' }),
      ...Array.from({ length: 5 }, (_, i) =>
        baseTask({
          id: `t${i + 1}`,
          wbs: `1.${i + 1}`,
          name: `Task ${i + 1}`,
          start: '2026-05-04',
          finish: '2026-05-10',
        }),
      ),
    ];
    const { container } = render(
      <CalendarGrid anchorIso="2026-05-06" calView="month" tasks={tasks} onTaskClick={vi.fn()} />,
    );

    // Chips now live inside the day cell they start in rather than in a
    // row-wide overlay (#3241), so their `top` is measured from the cell's own
    // box — which begins at the row's top, hence the fixed 24px date-number
    // offset that the overlay used to carry as its own inset.
    const painted = [...container.querySelectorAll('[data-cal-chip]')]
      .map((d) => ({
        name: d.querySelector('button')?.getAttribute('aria-label') ?? '',
        top: Number.parseInt((d as HTMLElement).style.top, 10),
      }))
      .filter((p) => p.name.startsWith('Task '));

    // Four chips survive the 4-lane cap...
    expect(painted).toHaveLength(4);
    // ...and they occupy lanes 0-3 exactly once each — no duplicate lane, and
    // nothing pushed past the 4-lane band (lane 3 tops out at 24+3*22+2 = 92).
    const tops = painted.map((p) => p.top).sort((a, b) => a - b);
    expect(tops).toEqual([26, 48, 70, 92]);
  });

  // -------------------------------------------------------------------------
  // ARIA grid pattern + keyboard traversal (#3241)
  // -------------------------------------------------------------------------

  describe('ARIA grid + keyboard (#3241)', () => {
    /** Every day cell's tabIndex, in DOM (visual) order. */
    const cellTabIndexes = () =>
      screen.getAllByRole('gridcell').map((c) => (c).tabIndex);

    it('exposes grid / row / gridcell, and the day-cell count states the mode', () => {
      // This is the assertion the #3167 class was not mechanically checkable
      // without: "how many days did this render" rather than "is some fixture
      // task's chip on screen". Week is exactly 7; a month is 4-6 rows of 7.
      const { unmount } = render(
        <CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />,
      );
      expect(screen.getByRole('grid', { name: 'Calendar dates' })).toBeInTheDocument();
      expect(screen.getAllByRole('gridcell')).toHaveLength(7);
      // One header row + one week row.
      expect(screen.getAllByRole('row')).toHaveLength(2);
      expect(screen.getAllByRole('columnheader')).toHaveLength(7);
      unmount();

      render(<CalendarGrid anchorIso={ANCHOR} calView="month" tasks={[]} onTaskClick={vi.fn()} />);
      const monthCells = screen.getAllByRole('gridcell').length;
      expect(monthCells % 7).toBe(0);
      expect(monthCells).toBeGreaterThanOrEqual(28);
      expect(monthCells).toBeLessThanOrEqual(42);
    });

    it('names each day cell with its weekday, day and month', () => {
      // The visible content of a cell is a bare number in a subtree the Mon-Sun
      // header cannot be composed with, so the date has to be on the cell.
      render(<CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />);
      // ANCHOR 2026-05-01 is a Friday → the Apr 27 – May 3 week.
      expect(screen.getByRole('gridcell', { name: 'Monday, April 27, 2026' })).toBeInTheDocument();
      expect(screen.getByRole('gridcell', { name: 'Friday, May 1, 2026' })).toBeInTheDocument();
      expect(screen.getByRole('gridcell', { name: 'Sunday, May 3, 2026' })).toBeInTheDocument();
    });

    it('names the column headers in full, not as abbreviations', () => {
      render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
      expect(screen.getByRole('columnheader', { name: 'Wednesday' })).toBeInTheDocument();
      // ...and still prints the abbreviation.
      expect(screen.getByText('Wed')).toBeInTheDocument();
    });

    it('carries exactly one tab stop, on the anchored day', () => {
      render(<CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />);
      const tabbable = cellTabIndexes().filter((t) => t === 0);
      expect(tabbable).toHaveLength(1);
      // ANCHOR is the Friday of the rendered week — index 4 of Mon..Sun.
      expect(cellTabIndexes()).toEqual([-1, -1, -1, -1, 0, -1, -1]);
    });

    it('moves focus between cells on Arrow / Home / End', async () => {
      render(<CalendarGrid anchorIso={ANCHOR} calView="month" tasks={[]} onTaskClick={vi.fn()} />);
      const cell = (name: string) => screen.getByRole('gridcell', { name });

      await userEvent.click(cell('Friday, May 1, 2026'));
      expect(document.activeElement).toBe(cell('Friday, May 1, 2026'));

      await userEvent.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(cell('Saturday, May 2, 2026'));

      // Down is a week, not a day.
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(cell('Saturday, May 9, 2026'));

      await userEvent.keyboard('{ArrowLeft}');
      expect(document.activeElement).toBe(cell('Friday, May 8, 2026'));

      await userEvent.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(cell('Friday, May 1, 2026'));

      // Home / End are the ends of this week row (Apr 27 – May 3).
      await userEvent.keyboard('{Home}');
      expect(document.activeElement).toBe(cell('Monday, April 27, 2026'));
      await userEvent.keyboard('{End}');
      expect(document.activeElement).toBe(cell('Sunday, May 3, 2026'));

      // Ctrl+Home / Ctrl+End are the ends of the whole window.
      await userEvent.keyboard('{Control>}{End}{/Control}');
      expect(document.activeElement).toBe(cell('Sunday, May 31, 2026'));
      await userEvent.keyboard('{Control>}{Home}{/Control}');
      expect(document.activeElement).toBe(cell('Monday, April 27, 2026'));

      // ...and the roving tab stop followed focus rather than staying behind.
      expect(cellTabIndexes().filter((t) => t === 0)).toHaveLength(1);
      expect((cell('Monday, April 27, 2026')).tabIndex).toBe(0);
    });

    it('clamps at the window edges instead of wrapping or stepping the window', async () => {
      render(<CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[]} onTaskClick={vi.fn()} />);
      const cell = (name: string) => screen.getByRole('gridcell', { name });

      await userEvent.click(cell('Monday, April 27, 2026'));
      await userEvent.keyboard('{ArrowLeft}');
      expect(document.activeElement).toBe(cell('Monday, April 27, 2026'));
      await userEvent.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(cell('Monday, April 27, 2026'));

      await userEvent.click(cell('Sunday, May 3, 2026'));
      await userEvent.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(cell('Sunday, May 3, 2026'));
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(cell('Sunday, May 3, 2026'));
    });

    it('does not steal focus when the rendered day set changes', async () => {
      // The trap this component is most exposed to: the whole day set is
      // replaced on every Prev/Next and on every Month|Week switch. A roving
      // index keyed on an array position (or re-applied from an effect keyed on
      // the collection's length) both points at a different day afterwards and
      // yanks focus away from whatever the user moved to next — here, the
      // toolbar button that did the stepping.
      const outside = document.createElement('button');
      outside.textContent = 'Next month';
      document.body.append(outside);

      const { rerender } = render(
        <CalendarGrid anchorIso={ANCHOR} calView="month" tasks={[]} onTaskClick={vi.fn()} />,
      );
      await userEvent.click(screen.getByRole('gridcell', { name: 'Friday, May 1, 2026' }));

      outside.focus();
      expect(document.activeElement).toBe(outside);

      rerender(
        <CalendarGrid anchorIso="2026-06-01" calView="month" tasks={[]} onTaskClick={vi.fn()} />,
      );
      // Focus stayed where the user put it...
      expect(document.activeElement).toBe(outside);
      // ...and the new window still has exactly one tab stop, on a day it
      // actually renders rather than on a stale position.
      expect(cellTabIndexes().filter((t) => t === 0)).toHaveLength(1);
      expect(
        (screen.getByRole('gridcell', { name: 'Monday, June 1, 2026' })).tabIndex,
      ).toBe(0);

      outside.remove();
    });

    it('does not hijack arrow keys pressed on a widget inside a cell', async () => {
      // React's onKeyDown is delegated, so a chip's or milestone's arrow key
      // bubbles to the cell. Moving the grid then would yank focus out from
      // under a user who is on the widget, not on the day.
      render(
        <CalendarGrid
          anchorIso={ANCHOR}
          calView="month"
          tasks={[milestoneTask()]}
          onTaskClick={vi.fn()}
        />,
      );
      const btn = screen.getByRole('button', { name: /Milestone: Launch Milestone/i });
      btn.focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(btn);
    });

    it('orders chip tab stops by the day they start on, not by API list order', () => {
      // The chip overlay used to be a sibling rendered after all seven cells,
      // so a week row tabbed as "every milestone button, then every chip in
      // buildChips' task-iteration order" — i.e. the order the API returned.
      const late = baseTask({
        id: 'late',
        name: 'Late Task',
        start: '2026-05-01',
        finish: '2026-05-01',
      }); // Friday
      const early = baseTask({
        id: 'early',
        name: 'Early Task',
        start: '2026-04-27',
        finish: '2026-04-27',
      }); // Monday
      const { container } = render(
        <CalendarGrid
          anchorIso={ANCHOR}
          calView="week"
          tasks={[late, early]}
          onTaskClick={vi.fn()}
        />,
      );
      const order = [...container.querySelectorAll('button')].map((b) =>
        b.getAttribute('aria-label'),
      );
      expect(order).toEqual(['Early Task, due', 'Late Task, due']);
    });

    it('mutes a weekend cell’s own marks without muting a chip that starts there', () => {
      // Chips live in the day cell they start in now, so a weekend mute left on
      // the cell BOX would dim a Saturday-starting bar and leave an identical
      // Monday-starting one at full strength — the same bar rendered two ways
      // depending on which day it happens to begin.
      const sat = baseTask({
        id: 'sat',
        name: 'Weekend Task',
        start: '2026-05-02',
        finish: '2026-05-02',
      });
      const { container } = render(
        <CalendarGrid anchorIso={ANCHOR} calView="week" tasks={[sat]} onTaskClick={vi.fn()} />,
      );
      const chip = container.querySelector('[data-cal-chip]');
      expect(chip).not.toBeNull();
      expect(chip?.closest('.opacity-60')).toBeNull();
      // ...while the Saturday cell's own date number and marks still are muted.
      const satCell = screen.getByRole('gridcell', { name: 'Saturday, May 2, 2026' });
      expect(satCell.querySelector('.opacity-60')).not.toBeNull();
      // ...and a weekday cell is not.
      const friCell = screen.getByRole('gridcell', { name: 'Friday, May 1, 2026' });
      expect(friCell.querySelector('.opacity-60')).toBeNull();
    });

    it('exposes the legend label by giving it a role that can carry one', () => {
      // aria-label on a role-less <div> names nothing at all.
      render(<CalendarGrid anchorIso={ANCHOR} tasks={[]} onTaskClick={vi.fn()} />);
      expect(screen.getByRole('group', { name: 'Calendar legend' })).toBeInTheDocument();
    });
  });

  it('renders the mobile date-grouped list (not the 7-col grid) under the sm breakpoint (#2161)', () => {
    breakpointMock.mockReturnValue('sm');
    render(<CalendarGrid anchorIso={ANCHOR} tasks={[baseTask()]} onTaskClick={vi.fn()} />);
    // Day-of-week header columns are grid-only — absent on mobile.
    expect(screen.queryByText('Wed')).not.toBeInTheDocument();
    // The task surfaces as a full-width row button instead.
    expect(screen.getByRole('button', { name: /Integration Test/ })).toBeInTheDocument();
    // The legend is retained on mobile.
    expect(screen.getByText('Critical path')).toBeInTheDocument();
  });
});
