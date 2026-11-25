import { describe, it, expect, vi } from 'vitest';
import {
  BASELINE_MARK_MIN_DAYS,
  baselineSlipDays,
  drawBaselineMilestoneGhost,
  drawBaselineSummarySlip,
  formatSlipLabel,
  hasBaselineSlipMarks,
} from './GanttRenderer';
import { buildScaleData, dateToRight, isoDayDelta, milestoneX } from './GanttScaleData';
import type { Task } from '@/types';

const scales = buildScaleData('week', '2026-04-01', '2026-06-01');

const summary = (finish: string) =>
  ({ id: 's', start: '2026-04-06', finish, isSummary: true, isMilestone: false }) as Task;
const milestone = (start: string) =>
  ({
    id: 'm',
    start,
    finish: start,
    isSummary: false,
    isMilestone: true,
    plannedStart: start,
  }) as Task;

function fakeCtx() {
  const calls: string[] = [];
  const rec = (n: string) => vi.fn(() => void calls.push(n));
  const ctx = {
    calls,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    rect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    stroke: rec('stroke'),
    fill: rec('fill'),
    strokeText: rec('strokeText'),
    fillText: vi.fn(),
    measureText: () => ({ width: 10 }),
  };
  return ctx as unknown as CanvasRenderingContext2D & typeof ctx;
}

describe('isoDayDelta / formatSlipLabel (#5065)', () => {
  it('is signed whole calendar days', () => {
    expect(isoDayDelta('2026-04-06', '2026-04-11')).toBe(5);
    expect(isoDayDelta('2026-04-11', '2026-04-06')).toBe(-5);
    expect(formatSlipLabel(5)).toBe('+5d');
    expect(formatSlipLabel(-3)).toBe('−3d');
  });
});

describe('baselineSlipDays (#5065)', () => {
  it('is null when nothing moved by the threshold, for tasks and without a baseline', () => {
    const b = { start: '2026-04-06', finish: '2026-04-10' };
    expect(baselineSlipDays(summary('2026-04-10'), b)).toBeNull();
    expect(baselineSlipDays(summary('2026-04-15'), undefined)).toBeNull();
    expect(baselineSlipDays({ ...summary('2026-04-15'), isSummary: false } as Task, b)).toBeNull();
    expect(BASELINE_MARK_MIN_DAYS).toBe(1);
  });

  it('reads summary slip off the finish and milestone slip off the date', () => {
    const b = { start: '2026-04-06', finish: '2026-04-10' };
    expect(baselineSlipDays(summary('2026-04-15'), b)).toBe(5);
    expect(baselineSlipDays(summary('2026-04-08'), b)).toBe(-2);
    expect(
      baselineSlipDays(milestone('2026-04-13'), { start: '2026-04-10', finish: '2026-04-10' }),
    ).toBe(3);
  });

  it('honors a larger threshold', () => {
    const b = { start: '2026-04-06', finish: '2026-04-10' };
    expect(baselineSlipDays(summary('2026-04-12'), b, 3)).toBeNull();
    expect(baselineSlipDays(summary('2026-04-13'), b, 3)).toBe(3);
  });
});

describe('drawBaselineSummarySlip (#5065)', () => {
  it('draws a whisker from baseline finish to live finish and a signed label, no outline', () => {
    const ctx = fakeCtx();
    const b = { start: '2026-04-06', finish: '2026-04-10' };
    drawBaselineSummarySlip(ctx, summary('2026-04-15'), b, 0, scales, 20);
    const baseX = dateToRight('2026-04-10', scales) - 20;
    expect(ctx.lineTo).toHaveBeenCalledWith(baseX, expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('+5d', expect.any(Number), expect.any(Number));
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('draws nothing for an on-plan summary', () => {
    const ctx = fakeCtx();
    drawBaselineSummarySlip(
      ctx,
      summary('2026-04-10'),
      { start: '2026-04-06', finish: '2026-04-10' },
      0,
      scales,
      0,
    );
    expect(ctx.save).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});

describe('drawBaselineMilestoneGhost (#5065)', () => {
  const b = { start: '2026-04-10', finish: '2026-04-10' };

  it('draws a hollow diamond at the baseline date joined by a whisker to the live diamond', () => {
    const ctx = fakeCtx();
    drawBaselineMilestoneGhost(ctx, milestone('2026-04-15'), b, 2, scales, 0);
    expect(ctx.translate).toHaveBeenCalledWith(
      milestoneX('2026-04-10', undefined, scales),
      expect.any(Number),
    );
    expect(ctx.rect).toHaveBeenCalledTimes(1);
    expect(ctx.stroke).toHaveBeenCalledTimes(2); // whisker + hollow diamond
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('draws nothing when the milestone did not move', () => {
    const ctx = fakeCtx();
    drawBaselineMilestoneGhost(ctx, milestone('2026-04-10'), b, 2, scales, 0);
    expect(ctx.save).not.toHaveBeenCalled();
  });
});

describe('hasBaselineSlipMarks (#5065)', () => {
  const dates = new Map([
    ['s', { start: '2026-04-06', finish: '2026-04-10' }],
    ['m', { start: '2026-04-10', finish: '2026-04-10' }],
  ]);
  it('is true only while some summary/milestone moved', () => {
    expect(hasBaselineSlipMarks([summary('2026-04-15')], dates)).toBe(true);
    expect(hasBaselineSlipMarks([summary('2026-04-10'), milestone('2026-04-10')], dates)).toBe(
      false,
    );
    expect(hasBaselineSlipMarks([summary('2026-04-15')], null)).toBe(false);
  });
});
