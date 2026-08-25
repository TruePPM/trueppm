/**
 * The cadence rail's ONE geometry, asserted at both heights (#3012, web rule
 * 315d).
 *
 * `HEADER_HEIGHT` used to mean two things at 19+ sites — "the date ruler band"
 * and "the y where row 0 starts" — and the two were the same number, so they
 * agreed by luck. The rail makes them differ, and the failure mode of getting
 * the split wrong is the reason this file exists: the outline's rows sit a
 * rail-height above the canvas's, **nothing looks broken**, and taps open the
 * neighbouring task.
 *
 * So these specs pin the three independent readers of the row origin — the DOM
 * outline header, the canvas hit test, and the renderer's row bands — to each
 * other at rail height **0 and 16**. Checking one height proves nothing: at 0
 * the split is invisible, because that is precisely the state where both
 * meanings coincide again.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TaskListHeader } from './TaskListHeader';
import { MIN_COL_WIDTHS, type ColumnWidths } from '@/hooks/useColumnWidths';
import {
  CADENCE_RAIL_HEIGHT,
  CHART_HEADER_HEIGHT,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  syncCadenceRail,
} from './scheduleConstants';
import { timelineRowIndexAt } from './timelineRowHitTest';
import { drawHoverRowBand } from './engine/GanttRenderer';
import { ROW_VOCABULARY } from './rowVocabulary';

const WIDTHS: ColumnWidths['widths'] = {
  wbs: 48,
  task: 220,
  links: 76,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 56,
  owner: 60,
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
};

/** The outline header's own rendered height, in px. */
function outlineHeaderHeight(): number {
  render(
    <TaskListHeader
      widths={WIDTHS}
      visible={VISIBLE}
      setWidth={() => {}}
      gripReserve={0}
      nudgeReserve={0}
      maxTaskWidth={MIN_COL_WIDTHS.task * 4}
    />,
  );
  const row = screen.getByRole('row', { name: ROW_VOCABULARY.header.columnsRow });
  return Number.parseInt(row.style.height, 10);
}

/**
 * The y the canvas hit test places row 0 at: the lowest y that resolves to row
 * 0, proved by the pixel above it resolving to nothing.
 */
function hitTestRowOrigin(): number {
  for (let y = 0; y < 200; y++) {
    if (timelineRowIndexAt(y, 0, 5) === 0) return y;
  }
  throw new Error('row 0 is unreachable by the hit test at any y');
}

/**
 * The y the renderer paints row 0's band at.
 *
 * `drawHoverRowBand` rather than `drawRowBands`, because the striping in the
 * latter skips alternate rows — its first `fillRect` is row *1*, which would
 * make this oracle read one row too low and agree with a broken origin by
 * coincidence.
 */
function rendererRowOrigin(): number {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, prop: string) => {
      if (prop === 'canvas') return { width: 800, height: 600 };
      return (...args: unknown[]) => calls.push({ name: prop, args });
    },
    set: () => true,
  });
  drawHoverRowBand(ctx, 0, 0, 800, 600);
  const first = calls.find((c) => c.name === 'fillRect');
  if (!first) throw new Error('drawHoverRowBand painted nothing');
  return first.args[1] as number;
}

afterEach(() => {
  cleanup();
  syncCadenceRail(false);
});

describe('the chart header height has exactly one meaning (#3012)', () => {
  it('is the ruler alone when no cadence rail is drawn', () => {
    syncCadenceRail(false);
    expect(CHART_HEADER_HEIGHT).toBe(HEADER_HEIGHT);
    expect(outlineHeaderHeight()).toBe(HEADER_HEIGHT);
    expect(hitTestRowOrigin()).toBe(HEADER_HEIGHT);
    expect(rendererRowOrigin()).toBe(HEADER_HEIGHT);
  });

  it('grows by exactly the rail when one is drawn, and all three readers follow', () => {
    syncCadenceRail(true);
    const expected = HEADER_HEIGHT + CADENCE_RAIL_HEIGHT;
    expect(CHART_HEADER_HEIGHT).toBe(expected);
    // The three independent readers. Any ONE of these left on the old constant
    // is the silent mis-hit — which is why the assertion is three-way and not
    // "the binding changed".
    expect(outlineHeaderHeight()).toBe(expected);
    expect(hitTestRowOrigin()).toBe(expected);
    expect(rendererRowOrigin()).toBe(expected);
  });

  it('moves every row by the rail, not just the first', () => {
    // A reader that added the rail to row 0 and not to the row pitch would pass
    // the two specs above and still drift by a whole rail on every later row.
    syncCadenceRail(true);
    const origin = HEADER_HEIGHT + CADENCE_RAIL_HEIGHT;
    expect(timelineRowIndexAt(origin + 3 * ROW_HEIGHT, 0, 5)).toBe(3);
    expect(timelineRowIndexAt(origin - 1, 0, 5)).toBeNull();
  });

  it('is byte-identical to a waterfall project once the rail is retracted', () => {
    // The property that lets this ship without a visual diff on every non-agile
    // plan: turning the rail off must return the exact previous geometry, not
    // merely something close to it.
    syncCadenceRail(true);
    syncCadenceRail(false);
    expect(CHART_HEADER_HEIGHT).toBe(HEADER_HEIGHT);
    expect(outlineHeaderHeight()).toBe(HEADER_HEIGHT);
    expect(hitTestRowOrigin()).toBe(HEADER_HEIGHT);
    expect(rendererRowOrigin()).toBe(HEADER_HEIGHT);
  });
});
