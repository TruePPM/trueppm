import { describe, expect, it, afterEach } from 'vitest';
import { timelineRowIndexAt } from './timelineRowHitTest';
import { HEADER_HEIGHT, ROW_HEIGHT, syncRowMetrics } from './scheduleConstants';

describe('timelineRowIndexAt', () => {
  it('resolves the first row just below the ruler', () => {
    expect(timelineRowIndexAt(HEADER_HEIGHT, 0, 5)).toBe(0);
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT - 1, 0, 5)).toBe(0);
  });

  it('advances a row per ROW_HEIGHT', () => {
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT, 0, 5)).toBe(1);
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT * 3, 0, 5)).toBe(3);
  });

  it('returns null over the ruler — a month header is not a task', () => {
    expect(timelineRowIndexAt(0, 0, 5)).toBeNull();
    expect(timelineRowIndexAt(HEADER_HEIGHT - 1, 0, 5)).toBeNull();
  });

  it('returns null past the last row rather than clamping to it', () => {
    // Clamping would open the last task's menu from empty space below the plan,
    // which is worse than doing nothing.
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT * 5, 0, 5)).toBeNull();
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT * 40, 0, 5)).toBeNull();
  });

  it('accounts for scroll', () => {
    // Scrolled down two rows, the top visible row is index 2.
    expect(timelineRowIndexAt(HEADER_HEIGHT, ROW_HEIGHT * 2, 10)).toBe(2);
  });

  it('handles an empty plan without resolving anything', () => {
    expect(timelineRowIndexAt(HEADER_HEIGHT, 0, 0)).toBeNull();
  });
});


/**
 * #2997 — Timeline mode is the one surface with NO DOM row.
 *
 * `ScheduleView` hides the task-list panel entirely in Timeline mode (#1221,
 * #2978), so a right-click's row is resolved purely by arithmetic against
 * `ROW_HEIGHT`. That also means `e2e/schedule-coarse-row-height.spec.ts` cannot
 * reach it — it locates rows with `getByRole('row')`, which this mode does not
 * render. This is the only coverage the coarse path has here.
 */
describe('timelineRowIndexAt at both row pitches (#2997)', () => {
  afterEach(() => syncRowMetrics(false));

  it.each([
    ['fine', false, 28],
    ['coarse', true, 44],
  ])('resolves every pixel of row n to row n (%s pointer)', (_label, coarse, h) => {
    syncRowMetrics(coarse);
    for (let row = 0; row < 5; row++) {
      const top = HEADER_HEIGHT + row * h;
      for (const y of [top, top + h / 2, top + h - 1]) {
        expect(timelineRowIndexAt(y, 0, 5), `row=${row} y=${y}`).toBe(row);
      }
    }
  });

  it('still refuses the header band and past the last row at the coarse pitch', () => {
    syncRowMetrics(true);
    expect(timelineRowIndexAt(HEADER_HEIGHT - 1, 0, 5)).toBeNull();
    expect(timelineRowIndexAt(HEADER_HEIGHT + 5 * 44, 0, 5)).toBeNull();
  });

  it('subtracts scroll at the coarse pitch, not the fine one', () => {
    syncRowMetrics(true);
    // Two rows scrolled away: the top of the viewport is row 2, not row 3 (which
    // is what a stale 28px divisor would answer).
    expect(timelineRowIndexAt(HEADER_HEIGHT, 2 * 44, 10)).toBe(2);
  });
});
