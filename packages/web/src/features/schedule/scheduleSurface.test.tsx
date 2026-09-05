import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import {
  surfaceRendersColumn,
  surfaceColumnVisibility,
  surfaceOutlineWidth,
  surfaceToggleableColumns,
} from './scheduleSurface';
import { resolveOutlineGripReserve, resolveOutlineLeftReserve } from './scheduleConstants';
import {
  maxTaskWidthFor,
  clampTaskWidth,
  outlinePaneWidthFor,
  MIN_BAR_TRACK,
  SPLITTER_WIDTH,
} from './ScheduleView';
import { TaskListPanel } from './TaskListPanel';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';

const WIDTHS: ColumnWidths['widths'] = {
  wbs: 48,
  task: 220,
  links: 76,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 60,
  owner: 72,
  totalFloat: 64,
  freeFloat: 64,
};

const ALL_VISIBLE: ColumnWidths['visible'] = {
  wbs: true,
  task: true,
  links: true,
  dur: true,
  start: true,
  finish: true,
  progress: true,
  owner: true,
  totalFloat: true,
  freeFloat: true,
};

// ---------------------------------------------------------------------------
// The column profile — pure.
// ---------------------------------------------------------------------------

describe('scheduleSurface — column profile (#2960)', () => {
  it('renders every column on the Grid and the identity pair on the Timeline', () => {
    for (const col of Object.keys(WIDTHS) as (keyof typeof WIDTHS)[]) {
      expect(surfaceRendersColumn('grid', col)).toBe(true);
    }
    expect(surfaceRendersColumn('timeline', 'wbs')).toBe(true);
    expect(surfaceRendersColumn('timeline', 'task')).toBe(true);
    for (const col of [
      'links',
      'dur',
      'start',
      'finish',
      'progress',
      'owner',
      'totalFloat',
      'freeFloat',
    ] as const) {
      expect(surfaceRendersColumn('timeline', col)).toBe(false);
    }
  });

  it('narrows the user profile on the Timeline and leaves the Grid untouched', () => {
    expect(surfaceColumnVisibility('grid', ALL_VISIBLE)).toBe(ALL_VISIBLE);
    expect(surfaceColumnVisibility('timeline', ALL_VISIBLE)).toEqual({
      wbs: true,
      task: true,
      links: false,
      dur: false,
      start: false,
      finish: false,
      progress: false,
      owner: false,
      totalFloat: false,
      freeFloat: false,
    });
  });

  it('NARROWS, never widens — a column hidden in Grid stays hidden on the Timeline', () => {
    // Switching layout must not resurrect a column the user turned off. The
    // surface profile removes columns and the user's own choice removes more;
    // neither may put back what the other took away.
    const wbsOff = { ...ALL_VISIBLE, wbs: false };
    expect(surfaceColumnVisibility('timeline', wbsOff).wbs).toBe(false);
    expect(surfaceOutlineWidth('timeline', WIDTHS, wbsOff)).toBe(WIDTHS.task);
  });

  it('sums the outline width over the surface profile', () => {
    const gridTotal = Object.values(WIDTHS).reduce((a, b) => a + b, 0);
    expect(surfaceOutlineWidth('grid', WIDTHS, ALL_VISIBLE)).toBe(gridTotal);
    expect(surfaceOutlineWidth('timeline', WIDTHS, ALL_VISIBLE)).toBe(WIDTHS.wbs + WIDTHS.task);
  });

  it('offers only the toggles the surface can honour, and never the locked Task column', () => {
    expect(surfaceToggleableColumns('grid')).toEqual([
      'wbs',
      'links',
      'dur',
      'start',
      'finish',
      'progress',
      'owner',
      'totalFloat',
      'freeFloat',
    ]);
    // A one-item section, on purpose: three checkboxes that change nothing would
    // be worse, and hiding the section takes away the one that works.
    expect(surfaceToggleableColumns('timeline')).toEqual(['wbs']);
    expect(surfaceToggleableColumns('timeline')).not.toContain('task');
  });
});

// ---------------------------------------------------------------------------
// Geometry derived from the RUNTIME row height — at both pointer classes.
// ---------------------------------------------------------------------------

describe('scheduleSurface — geometry at both pointer classes (#2960/#2997)', () => {
  it('gives an authorable outline a grip lane on a coarse pointer and none on a fine one', () => {
    expect(resolveOutlineGripReserve(false, true)).toBe(0);
    expect(resolveOutlineGripReserve(true, true)).toBe(44);
  });

  it('gives a VIEWER no lane at either pointer class — absence, not a 44px hole', () => {
    // Web rule 302: the grip is not rendered for a reader with no rights, so the
    // name column must not give up a fifth of its width to reserve room for it.
    expect(resolveOutlineGripReserve(false, false)).toBe(0);
    expect(resolveOutlineGripReserve(true, false)).toBe(0);
  });

  it('the Timeline outline box is the columns PLUS every lane, at both classes', () => {
    // The lanes are rendered inside the panel's fixed-width box and subtracted
    // from no column, so a box that omits one overruns by exactly that lane.
    // Stated against the shared resolver rather than as literals: #3026's nudge
    // lane moved both numbers (268 → 302 fine, 312 → 402 coarse), and a test
    // carrying the old constants would have gone on describing a geometry
    // nothing renders.
    const columns = surfaceOutlineWidth('timeline', WIDTHS, ALL_VISIBLE);
    expect(columns).toBe(268);
    expect(columns + resolveOutlineLeftReserve(false, true)).toBe(
      268 + resolveOutlineLeftReserve(false, true),
    );
    // The fine pointer now reserves something for the first time: the grip
    // overlays at 14px and costs nothing, but the nudges are in flow.
    expect(resolveOutlineGripReserve(false, true)).toBe(0);
    expect(resolveOutlineLeftReserve(false, true)).toBeGreaterThan(0);
    expect(resolveOutlineLeftReserve(true, true)).toBeGreaterThan(
      resolveOutlineLeftReserve(false, true),
    );
  });
});

describe('The shared task-column bound (#2960)', () => {
  it('keeps the bar track at or above its floor on a narrow window', () => {
    // 800 wide, 48px of non-task outline: the name column may claim only what
    // is left once the track keeps MIN_BAR_TRACK, which binds before the
    // absolute 600px cap does.
    expect(maxTaskWidthFor(800, 48, 120)).toBe(800 - MIN_BAR_TRACK - 48);
  });

  it('still honours the absolute cap when there is room to spare', () => {
    // On a wide window the track floor is not the binding constraint — a name
    // column past 600px stops being a name column and starts being the plan.
    expect(maxTaskWidthFor(1920, 48, 220)).toBe(600);
  });

  it('never reaches BACKWARDS past the width the user already holds', () => {
    // The Grid's default outline is 600px, so in a ~780px pane the computed room
    // is negative. Answering 120 against a current 220 would announce
    // `valuemax < valuenow` — a WCAG 4.1.2 failure nothing visual catches — and
    // collapse the column 220 → 120 on the very first ArrowLeft. An upper bound
    // is permission to grow, never an instruction to shrink.
    expect(maxTaskWidthFor(780, 380, 220)).toBe(220);
    expect(maxTaskWidthFor(320, 48, 220)).toBe(220);
  });

  it('floors at the name column minimum when nothing is held either', () => {
    expect(maxTaskWidthFor(320, 48, 120)).toBe(120);
  });

  it('falls back to the absolute bound before the container has been measured', () => {
    // jsdom and first paint both report 0; collapsing the column to its minimum
    // there would make the outline jump on every mount.
    expect(maxTaskWidthFor(0, 48, 220)).toBe(600);
    expect(maxTaskWidthFor(0, 48, 900)).toBe(900);
  });

  it('clamps a pointer drag exactly as it clamps a keyboard nudge', () => {
    const max = maxTaskWidthFor(1280, 48, 220);
    expect(clampTaskWidth(10_000, max)).toBe(max);
    expect(clampTaskWidth(-500, max)).toBe(120);
    expect(clampTaskWidth(300, max)).toBe(300);
  });
});

describe('The bar track keeps its floor when the pane shrinks (#3279)', () => {
  it('leaves the outline alone whenever both fit', () => {
    // The common case, and the one that must stay untouched: a wide pane holds
    // the outline the user sized and the track's floor with room to spare.
    expect(outlinePaneWidthFor(1920, 738)).toBe(738);
    // Exactly enough is still enough — the floor is a floor, not a margin.
    expect(outlinePaneWidthFor(738 + MIN_BAR_TRACK, 738)).toBe(738);
  });

  it('counts the splitter, which is shrink-0 too', () => {
    // The 4px `PanelSplitter` sits between the two and yields nothing either, so
    // a reserve that forgets it hands the track 4px less than its floor — small
    // enough to pass every visual check and still fail the assertion that means
    // anything. At exactly-enough-plus-the-splitter nothing yields yet.
    expect(outlinePaneWidthFor(738 + MIN_BAR_TRACK + SPLITTER_WIDTH, 738, SPLITTER_WIDTH)).toBe(738);
    // One pixel tighter and the outline starts paying for it.
    expect(outlinePaneWidthFor(738 + MIN_BAR_TRACK, 738, SPLITTER_WIDTH)).toBe(738 - SPLITTER_WIDTH);
  });

  it('makes the OUTLINE yield, not the track, once they no longer both fit', () => {
    // The regression this exists for. At 768px with a 64px rail the pane is
    // 704px against a 738px outline: the outline is `flex-shrink-0` and the
    // canvas `flex-1 min-w-0`, so every missing pixel came out of the track
    // until it reached zero and disappeared.
    expect(outlinePaneWidthFor(704, 738)).toBe(704 - MIN_BAR_TRACK);
    // And it was ALREADY broken before the rail took its 64px — 768px against
    // the same outline left the track 30px, which no test could tell from
    // healthy because `toBeVisible()` accepts any non-empty box.
    expect(outlinePaneWidthFor(768, 738)).toBe(768 - MIN_BAR_TRACK);
  });

  it('never trades a useless track for a useless outline', () => {
    // Below roughly 480px of pane there is no split worth making, so the
    // outline stops yielding rather than shrinking to a column of ellipses.
    // (The desktop surface does not render this narrow — below md the Schedule
    // swaps to MobileSchedule — but the floor must not depend on that.)
    expect(outlinePaneWidthFor(400, 738)).toBe(240);
    expect(outlinePaneWidthFor(0 + 1, 738)).toBe(240);
  });

  it('renders what the columns ask for before the pane has been measured', () => {
    // 0 means "not laid out yet" (first paint, jsdom), never "no room". Clamping
    // against it would park the outline at its floor in every environment that
    // never lays out — the same trap rule 343 records for the toolbar.
    expect(outlinePaneWidthFor(0, 738)).toBe(738);
  });
});

// ---------------------------------------------------------------------------
// THE invariant: one row model, two surfaces.
//
// `TaskListPanel` is rendered from the same `tasks` array and the same
// `expandedIds` set on both surfaces; the ONLY thing a surface chooses is its
// column profile. This suite renders the real panel twice — once per profile —
// and asserts that rows, order, depth and fold state come out identical while
// the columns differ. If a future change re-introduces a Timeline-specific row
// list, this is what fails.
//
// The virtualizer is stubbed (jsdom has no ResizeObserver, so the real one
// renders zero rows) and `TaskListRow` is stubbed down to the row facts under
// test. `TaskListHeader` is REAL, because the column count is half the claim.
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_unused, index) => ({ key: index, index, start: index * 28 })),
    scrollToIndex: vi.fn(),
    measure: vi.fn(),
  }),
}));

vi.mock('./TaskListRow', () => ({
  TaskListRow: (props: {
    task: Task;
    level: number;
    hasChildren?: boolean;
    isExpanded?: boolean;
    ariaRowIndex?: number;
  }) => (
    <div
      data-testid="row"
      data-row-id={props.task.id}
      data-level={props.level}
      data-has-children={String(props.hasChildren ?? false)}
      data-expanded={String(props.isExpanded ?? false)}
      data-aria-rowindex={String(props.ariaRowIndex ?? '')}
    />
  ),
}));

function task(id: string, wbs: string, name: string): Task {
  return { id, wbs, name, isMilestone: false } as Task;
}

/** A three-level outline with one collapsed phase, so fold state is observable. */
const TASKS = [
  task('t1', '1', 'Design'),
  task('t1-1', '1.1', 'Wireframes'),
  task('t1-2', '1.2', 'Review'),
  task('t2', '2', 'Build'),
];
const SUMMARY_IDS = new Set(['t1']);
const EXPANDED_IDS = new Set(['t1']);

function renderSurface(surface: 'grid' | 'timeline', opts: { authorable?: boolean } = {}) {
  const onMoveRow = opts.authorable ? vi.fn() : undefined;
  const view = render(
    <TaskListPanel
      tasks={TASKS}
      scrollRef={{ current: null }}
      widths={WIDTHS}
      visible={surfaceColumnVisibility(surface, ALL_VISIBLE)}
      setWidth={vi.fn()}
      // The SAME expression `ScheduleView` uses (`outlineWidth`). Computing it
      // from `resolveOutlineGripReserve` here — as this did until #3026 added a
      // second lane — makes the suite assert its own stale formula and green
      // while production overruns its box by the lane the test does not know
      // about. Read the shared resolver, never restate the arithmetic.
      totalWidth={
        surfaceOutlineWidth(surface, WIDTHS, ALL_VISIBLE) +
        resolveOutlineLeftReserve(isCoarse(), onMoveRow !== undefined)
      }
      summaryIds={SUMMARY_IDS}
      expandedIds={EXPANDED_IDS}
      onToggle={vi.fn()}
      onMoveRow={onMoveRow}
    />,
  );
  const rows = screen.getAllByTestId('row').map((el) => ({
    id: el.getAttribute('data-row-id'),
    level: el.getAttribute('data-level'),
    hasChildren: el.getAttribute('data-has-children'),
    expanded: el.getAttribute('data-expanded'),
    rowIndex: el.getAttribute('data-aria-rowindex'),
  }));
  const headers = screen.getAllByRole('columnheader').map((el) => el.textContent);
  const panelWidth = screen.getByRole('treegrid', { name: 'Item list' }).style.width;
  const headerGripReserve = screen
    .getAllByRole('row')[0]
    .querySelector('span[aria-hidden="true"]')
    ?.getAttribute('style');
  view.unmount();
  return { rows, headers, panelWidth, headerGripReserve };
}

/** Does the row model currently resolve to the coarse-pointer height? */
function isCoarse(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

describe('one row model, two surfaces (#2960)', () => {
  afterEach(cleanup);

  it('renders the SAME rows, in the same order, at the same depth, folded the same', () => {
    const grid = renderSurface('grid');
    const timeline = renderSurface('timeline');
    expect(timeline.rows).toEqual(grid.rows);
    // And they are the rows we handed in — not an empty set agreeing vacuously.
    expect(grid.rows.map((r) => r.id)).toEqual(['t1', 't1-1', 't1-2', 't2']);
  });

  it('states containment identically — a phase is a phase on both surfaces', () => {
    const grid = renderSurface('grid');
    const timeline = renderSurface('timeline');
    const phaseOf = (s: typeof grid) => s.rows.find((r) => r.id === 't1');
    expect(phaseOf(grid)?.hasChildren).toBe('true');
    expect(phaseOf(timeline)?.hasChildren).toBe('true');
    expect(phaseOf(timeline)?.expanded).toBe(phaseOf(grid)?.expanded);
  });

  it('differs ONLY in the columns: ten on the Grid, two on the Timeline', () => {
    const grid = renderSurface('grid');
    const timeline = renderSurface('timeline');
    expect(grid.headers).toEqual([
      'WBS',
      'Item',
      'Links',
      'Dur',
      'Start',
      'Finish',
      '%',
      'Owner',
      'Float',
      'Free',
    ]);
    expect(timeline.headers).toEqual(['WBS', 'Item']);
    // The name column is byte-identical, which is what makes a gate's name "two
    // cells to the left" true on the Timeline as well as the Grid.
    expect(timeline.headers).toContain('Item');
  });

  it('draws Links on the Grid ONLY, and the Display menu says the same (#3023)', () => {
    // Rule 316 applied to a new column: the menu that offers it and the panel
    // that draws it resolve through one predicate, so they cannot disagree.
    // Header labels are what the panel actually drew; the menu list is what
    // ScheduleView maps over.
    expect(renderSurface('grid').headers).toContain('Links');
    expect(renderSurface('timeline').headers).not.toContain('Links');
    expect(surfaceToggleableColumns('grid')).toContain('links');
    expect(surfaceToggleableColumns('timeline')).not.toContain('links');
  });

  it('draws Float on the Grid ONLY, and the Display menu says the same (#3344)', () => {
    // Same rule-316 pairing the Links column is pinned by: the surface predicate
    // that decides whether the panel draws a column is the one the Display menu
    // maps over, so a column can never be offered on a surface that hides it.
    expect(renderSurface('grid').headers).toEqual(
      expect.arrayContaining(['Float', 'Free']),
    );
    expect(renderSurface('timeline').headers).not.toContain('Float');
    expect(renderSurface('timeline').headers).not.toContain('Free');
    expect(surfaceToggleableColumns('grid')).toEqual(
      expect.arrayContaining(['totalFloat', 'freeFloat']),
    );
    expect(surfaceToggleableColumns('timeline')).not.toContain('totalFloat');
    expect(surfaceToggleableColumns('timeline')).not.toContain('freeFloat');
  });

  it('shrinks the panel box to the columns it actually draws', () => {
    // 676 + the two 64px float columns (#3344).
    expect(renderSurface('grid').panelWidth).toBe('804px');
    expect(renderSurface('timeline').panelWidth).toBe('268px');
  });

  it('carries EVERY left-edge lane in the BOX, not only in the rows', () => {
    // The lanes are leading flex spacers inside the panel's fixed-width box and
    // are subtracted from no column, so a box that omits one lets the row
    // content overrun by exactly that lane — a large fraction of the Timeline's
    // 268px outline, where on the Grid's 600px it was merely untidy. This is the
    // assertion that the panel's box and the panel's rows resolve ONE rule
    // (#2960), and since #3026 that rule covers both lanes.
    const mq = stubCoarsePointer(true);
    try {
      const timeline = renderSurface('timeline', { authorable: true });
      expect(timeline.panelWidth).toBe(`${268 + resolveOutlineLeftReserve(true, true)}px`);
      expect(timeline.headerGripReserve).toContain('44px');

      // A viewer has neither lane, so gives up nothing — absence, not a hole.
      expect(renderSurface('timeline').panelWidth).toBe('268px');

      // …and on a fine pointer the box still carries the nudge lane, which is
      // the change #3026 made to the desktop geometry.
      mq.flip(false);
      expect(renderSurface('timeline', { authorable: true }).panelWidth).toBe(
        `${268 + resolveOutlineLeftReserve(false, true)}px`,
      );
      expect(renderSurface('timeline').panelWidth).toBe('268px');
    } finally {
      restoreCoarsePointer();
    }
  });
});
