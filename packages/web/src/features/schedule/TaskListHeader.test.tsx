/**
 * Keyboard operability for the task-list column resize handles (#2205,
 * WCAG 2.1.1). Each header ResizeHandle is a focusable `separator` exposing
 * aria-value*; arrows nudge width by 16px and Home/End jump to the min/max —
 * mirroring the panel splitter, so column widths are reachable without a mouse.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TaskListHeader } from './TaskListHeader';
import { MIN_COL_WIDTHS, type ColumnWidths } from '@/hooks/useColumnWidths';

const WIDTHS: ColumnWidths['widths'] = {
  wbs: 48,
  task: 220,
  links: 76,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 56,
  owner: 60,
  totalFloat: 64,
  freeFloat: 64,
};

const VISIBLE: ColumnWidths['visible'] = {
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

function renderHeader(setWidth = vi.fn(), gripReserve = 0, nudgeReserve = 0) {
  render(
    <TaskListHeader
      widths={WIDTHS}
      visible={VISIBLE}
      setWidth={setWidth}
      gripReserve={gripReserve}
      nudgeReserve={nudgeReserve}
    />,
  );
  return setWidth;
}

afterEach(cleanup);

describe('TaskListHeader column resize keyboard operability (#2205)', () => {
  it('exposes each handle as a focusable separator with aria-value*', () => {
    renderHeader();
    const handle = screen.getByRole('separator', { name: 'Resize Item column' });
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-valuenow', '220');
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_COL_WIDTHS.task));
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuetext', 'Item column 220 pixels');
  });

  it('gives the Links column a header and a working resize handle (#3023)', () => {
    // A typo'd `colKey` renders a handle that resizes nothing, and nothing else
    // in the suite would notice.
    const setWidth = renderHeader();
    expect(screen.getByRole('columnheader', { name: 'Dependency links' })).toBeInTheDocument();
    const handle = screen.getByRole('separator', { name: 'Resize Dependency links column' });
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_COL_WIDTHS.links));
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(setWidth).toHaveBeenCalledWith('links', MIN_COL_WIDTHS.links);
  });

  it('ArrowRight / ArrowLeft nudge the width by 16px', () => {
    const setWidth = renderHeader();
    const handle = screen.getByRole('separator', { name: 'Resize Item column' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(setWidth).toHaveBeenLastCalledWith('task', 236);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(setWidth).toHaveBeenLastCalledWith('task', 204);
  });

  it('Home clamps to the column min; End jumps to the keyboard max', () => {
    const setWidth = renderHeader();
    const handle = screen.getByRole('separator', { name: 'Resize Duration column' });
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(setWidth).toHaveBeenLastCalledWith('dur', MIN_COL_WIDTHS.dur);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(setWidth).toHaveBeenLastCalledWith('dur', 400);
  });

  it('never nudges below the column min (clamped)', () => {
    const setWidth = vi.fn();
    render(
      <TaskListHeader
        widths={{ ...WIDTHS, dur: MIN_COL_WIDTHS.dur }}
        visible={VISIBLE}
        setWidth={setWidth}
        gripReserve={0}
        nudgeReserve={0}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize Duration column' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    // Already at the floor — the clamp keeps it at the min, not below.
    expect(setWidth).toHaveBeenLastCalledWith('dur', MIN_COL_WIDTHS.dur);
  });
});


/**
 * #2997 — the ⋮⋮ grip's lane.
 *
 * The header and every row render this spacer independently. Drop it from
 * either side and the columns sit 44px apart, which reads as a broken table;
 * the value has to come from one place (`TaskListPanel`) and be rendered the
 * same way by both. This pins the header's half — `TaskListPanel.test.tsx`
 * pins that the panel hands the same number to both, and
 * `e2e/schedule-coarse-row-height.spec.ts` measures the resulting alignment.
 */
describe('TaskListHeader — the grip lane (#2997)', () => {
  function laneWidth(): string | undefined {
    const row = screen.getByRole('row', { name: 'Item list columns' });
    const first = row.firstElementChild as HTMLElement | null;
    return first?.getAttribute('aria-hidden') === 'true' ? first.style.width : undefined;
  }

  it('reserves nothing when the panel says there is no grip', () => {
    renderHeader(vi.fn(), 0);
    expect(laneWidth()).toBeUndefined();
  });

  it('reserves exactly what the panel asked for, ahead of every column', () => {
    renderHeader(vi.fn(), 44);
    expect(laneWidth()).toBe('44px');
  });
});

describe('TaskListHeader — the row\u2019s left-edge lanes (#2997, #3026)', () => {
  /** The header's leading `aria-hidden` spacers, in DOM order. */
  function spacers(): HTMLElement[] {
    const header = screen.getByRole('row', { name: 'Item list columns' });
    return Array.from(header.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"]'));
  }

  it('reserves the grip lane and the nudge lane, in that order', () => {
    // The header, every row, the pending rows and the draft row each render
    // these themselves. Drop one, or swap the order, and that element's columns
    // sit a lane off — which reads as a broken table, not as a constant that
    // drifted, and no unit test on the rows alone can see it.
    renderHeader(vi.fn(), 44, 90);
    const [grip, nudge] = spacers();
    expect(grip.style.width).toBe('44px');
    expect(nudge.style.width).toBe('90px');
  });

  it('renders neither spacer when neither lane is reserved', () => {
    renderHeader(vi.fn(), 0, 0);
    expect(spacers()).toHaveLength(0);
  });

  it('renders only the nudge spacer on a fine pointer, where the grip overlays', () => {
    // `resolveGripReserve(false)` is 0 — a 14px grip overlays the row's edge and
    // no column pays for it — while the nudges are in flow and always drawn.
    renderHeader(vi.fn(), 0, 34);
    const [only] = spacers();
    expect(spacers()).toHaveLength(1);
    expect(only.style.width).toBe('34px');
  });
});

/**
 * The vocabulary lock, on the surface the design names first (#3027).
 *
 * > **Item** is the generic word for a row of any type — headers, create
 * > affordances and placeholders use it. The specific types keep their own
 * > words where the type is known: phase, milestone, task.
 *
 * The header is a *header*, so it takes the generic word — and since #2950 made
 * `structure_role` a declared identity, "Task" over a column that also carries
 * phases and milestones is a type claim those rows do not hold. Pinned here
 * rather than left to the incidental locators in the specs above, because those
 * would all still pass if the label regressed to "Task" together with them.
 */
describe('TaskListHeader — the vocabulary lock (#3027)', () => {
  it('heads the name column "Item", never "Task"', () => {
    // An EXACT name, where #3027 could only match a prefix. Two defects it
    // recorded and deferred are gone: the resize handle no longer builds its
    // label from the raw column KEY (`Resize task column`), and this column no
    // longer composes its name from its own subtree — it was the only one of
    // the eight without an `aria-label`, so it announced "Item Resize Item
    // column" while its seven siblings suppressed their handles. Both were
    // re-found by #3031's rendered-DOM guard without being told to look.
    renderHeader();
    expect(screen.getByRole('columnheader', { name: 'Item' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Task/i })).toBeNull();
  });

  it('names the header row itself with the generic word too', () => {
    renderHeader();
    expect(screen.getByRole('row', { name: 'Item list columns' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'Task list columns' })).toBeNull();
  });

  it('leaves the typed columns alone — the lock is about the GENERIC word', () => {
    // The counterweight. A sweep that renamed every "task" in the tree would
    // pass the two assertions above and cost the outline the words it is
    // allowed to use where the type IS known.
    renderHeader();
    expect(screen.getByRole('columnheader', { name: 'Work breakdown structure' })).toBeInTheDocument();
  });
});
