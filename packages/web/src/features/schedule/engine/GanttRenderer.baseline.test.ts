import { describe, it, expect, vi } from 'vitest';
import {
  BASELINE_GHOST_BLEED,
  baselineGhostRect,
  drawBaselineGhostBar,
} from './GanttRenderer';
import { buildScaleData, dateToLeft, dateToRight } from './GanttScaleData';
import { BAR_HEIGHT, BAR_TOP_OFFSET, ROW_HEIGHT } from '../scheduleConstants';
import { buildBaselineDateMap } from '@/hooks/useBaselines';

const scales = buildScaleData('week', '2026-04-01', '2026-06-01');

describe('baselineGhostRect (#3821)', () => {
  it('spans the inclusive baseline start..finish and bleeds around the live bar', () => {
    const r = baselineGhostRect({ start: '2026-04-06', finish: '2026-04-10' }, 3, scales);
    expect(r.left).toBeCloseTo(dateToLeft('2026-04-06', scales));
    expect(r.left + r.width).toBeCloseTo(dateToRight('2026-04-10', scales));
    expect(r.height).toBe(BAR_HEIGHT + 2 * BASELINE_GHOST_BLEED);
    // Same row slot as the live bar, shifted up by the bleed.
    const barTop = 3 * ROW_HEIGHT + r.top - 3 * ROW_HEIGHT + BASELINE_GHOST_BLEED;
    expect(r.top + BASELINE_GHOST_BLEED).toBeCloseTo(barTop);
    expect(r.top + BASELINE_GHOST_BLEED - 3 * ROW_HEIGHT).toBeGreaterThanOrEqual(BAR_TOP_OFFSET);
  });

  it('keeps a one-day-or-less baseline visible (min width 2px)', () => {
    const tiny = buildScaleData('year', '2026-01-01', '2030-01-01');
    const r = baselineGhostRect({ start: '2026-04-06', finish: '2026-04-06' }, 0, tiny);
    expect(r.width).toBeGreaterThanOrEqual(2);
  });

  it('moves with zoom but follows the same date', () => {
    const wide = buildScaleData('day', '2026-04-01', '2026-06-01');
    const a = baselineGhostRect({ start: '2026-04-10', finish: '2026-04-12' }, 0, scales);
    const b = baselineGhostRect({ start: '2026-04-10', finish: '2026-04-12' }, 0, wide);
    expect(b.width).toBeGreaterThan(a.width);
  });
});

describe('drawBaselineGhostBar (#3821)', () => {
  it('fills and strokes one outlined round rect, offset by scrollLeft', () => {
    const roundRect = vi.fn();
    const fill = vi.fn();
    const stroke = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      roundRect,
      fill,
      stroke,
    } as unknown as CanvasRenderingContext2D;
    const b = { start: '2026-04-06', finish: '2026-04-10' };
    drawBaselineGhostBar(ctx, b, 0, scales, 40);
    const r = baselineGhostRect(b, 0, scales);
    expect(roundRect).toHaveBeenCalledTimes(1);
    expect(roundRect.mock.calls[0][0]).toBeCloseTo(r.left - 40 + 0.5);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(stroke).toHaveBeenCalledTimes(1);
  });
});

describe('buildBaselineDateMap (#3821)', () => {
  it('joins by task_id and skips rows with no dates', () => {
    const map = buildBaselineDateMap([
      { task_id: 'a', task_name: 'A', start: '2026-04-06', finish: '2026-04-10', duration: 5 },
      { task_id: 'b', task_name: 'B', start: '', finish: '', duration: 0 },
    ]);
    expect(map?.get('a')).toEqual({ start: '2026-04-06', finish: '2026-04-10' });
    expect(map?.has('b')).toBe(false);
  });

  it('is null until the detail has loaded, so nothing is drawn', () => {
    expect(buildBaselineDateMap(undefined)).toBeNull();
  });
});
