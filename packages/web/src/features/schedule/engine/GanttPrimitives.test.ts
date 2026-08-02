/**
 * Canvas draw-primitive coverage for the Gantt renderer (#848).
 *
 * GanttRenderer.test.ts covers the bar/header/arrow paths; these six low-level
 * primitives (row bands, grid lines, today line, milestone diamond, drag ghost,
 * resize handle) had no direct coverage. Each is exercised against a spy
 * 2D-context that records the canvas calls it issues.
 */
import { describe, it, expect, vi } from 'vitest';

// todayISO drives drawTodayLine; pin it inside the test scale range so the
// line deterministically renders. Partial-mock to keep every other export real.
vi.mock('@/features/resource/resourceUtils', async (orig) => ({
  ...(await orig<typeof import('@/features/resource/resourceUtils')>()),
  todayISO: () => '2026-04-15',
}));

import {
  drawRowBands,
  drawGridLines,
  drawTodayLine,
  drawMilestone,
  drawDragShadow,
  drawResizeIndicator,
  drawLinkHandle,
  BAR_HEIGHT,
} from './GanttRenderer';
import { LINK_DOT_CENTER_OFFSET } from './GanttHitIndex';
import { buildScaleData } from './GanttScaleData';
import type { Task } from '@/types';

function makeCtxSpy(canvasWidth = 800) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ name, args });
    });
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    rect: record('rect'),
    roundRect: record('roundRect'),
    arc: record('arc'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    set fillStyle(v: string) {
      calls.push({ name: 'fillStyle', args: [v] });
    },
    set strokeStyle(v: string) {
      calls.push({ name: 'strokeStyle', args: [v] });
    },
    set lineWidth(_v: number) {},
    set globalAlpha(_v: number) {},
    set lineCap(_v: string) {},
    canvas: { width: canvasWidth },
  } as unknown as CanvasRenderingContext2D;
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  const argsOf = (name: string) => calls.filter((c) => c.name === name).map((c) => c.args);
  return { ctx, calls, count, argsOf };
}

const SCALES = buildScaleData('week', '2026-04-01', '2026-05-01');

function milestone(overrides: Partial<Task> = {}): Task {
  return {
    id: 'm',
    name: 'M',
    start: '2026-04-10',
    finish: '2026-04-10',
    plannedStart: '2026-04-10',
    duration: 0,
    progress: 0,
    isSummary: false,
    isMilestone: true,
    isCritical: false,
    parentId: null,
    wbs: '1',
    ...overrides,
  } as unknown as Task;
}

describe('drawRowBands', () => {
  it('shades only the odd rows in the range', () => {
    const { ctx, count } = makeCtxSpy();
    drawRowBands(ctx, 0, 3, 0, 0, 800);
    // rows 1 and 3 are odd → two filled bands; even rows are left bare.
    expect(count('fillRect')).toBe(2);
  });

  it('shades nothing for an all-even single-row range', () => {
    const { ctx, count } = makeCtxSpy();
    drawRowBands(ctx, 0, 0, 0, 0, 800);
    expect(count('fillRect')).toBe(0);
  });
});

describe('drawResizeIndicator', () => {
  it('draws a 1px vertical line inset 4px from the bar right edge', () => {
    const { ctx, count, argsOf } = makeCtxSpy();
    drawResizeIndicator(ctx, 200, 50);
    expect(count('stroke')).toBe(1);
    // x = barRight - 4 + 0.5 = 196.5, spanning the bar height.
    expect(argsOf('moveTo')[0]).toEqual([196.5, 50]);
    expect(argsOf('lineTo')[0]).toEqual([196.5, 50 + BAR_HEIGHT]);
  });
});

describe('drawMilestone', () => {
  it('draws a rotated diamond and no ring when unselected', () => {
    const { ctx, count } = makeCtxSpy();
    drawMilestone(ctx, milestone(), 0, SCALES, 0, false);
    expect(count('rotate')).toBe(1); // 45° rotation makes the square a diamond
    expect(count('rect')).toBe(1);
    expect(count('fill')).toBe(1);
    expect(count('stroke')).toBe(0);
  });

  it('adds a stroked selection ring when selected', () => {
    const { ctx, count } = makeCtxSpy();
    drawMilestone(ctx, milestone(), 0, SCALES, 0, true);
    expect(count('rect')).toBe(2); // body + ring
    expect(count('stroke')).toBe(1);
  });

  it('skips an uncommitted milestone (no plannedStart, no sprint) — #332 gate', () => {
    const { ctx, count } = makeCtxSpy();
    drawMilestone(ctx, milestone({ plannedStart: undefined, sprintId: undefined }), 0, SCALES, 0, false);
    expect(count('rect')).toBe(0);
    expect(count('fill')).toBe(0);
  });
});

describe('drawLinkHandle (#2702)', () => {
  it('draws a filled-then-stroked circle so an arrow beneath cannot read through it', () => {
    const { ctx, count } = makeCtxSpy();
    drawLinkHandle(ctx, 200, 14);
    expect(count('arc')).toBe(1);
    // Fill first (chart surface) then stroke (link color) — a hollow circle over a
    // dependency arrow otherwise reads as a smudge rather than a grab point.
    expect(count('fill')).toBe(1);
    expect(count('stroke')).toBe(1);
  });

  it('centers on the link-dot hit zone, so the mark and the hotspot cannot diverge', () => {
    // The whole point of the affordance: a handle drawn off its own hotspot is worse
    // than none, because the user aims at what they see, misses, and starts a *move*
    // drag instead — silently rescheduling the task. LINK_DOT_CENTER_OFFSET is the
    // single shared constant that keeps GanttHitIndex and the renderer in step.
    const { ctx, calls } = makeCtxSpy();
    const barRight = 300;
    drawLinkHandle(ctx, barRight + LINK_DOT_CENTER_OFFSET, 14);
    const arc = calls.find((c) => c.name === 'arc');
    expect(arc?.args[0]).toBe(312); // barRight + (8 + 16) / 2, the zone's midpoint
  });

  it('restores the context so its stroke style does not leak into later draws', () => {
    const { ctx, count } = makeCtxSpy();
    drawLinkHandle(ctx, 200, 14);
    expect(count('save')).toBe(1);
    expect(count('restore')).toBe(1);
  });
});

describe('drawDragShadow', () => {
  it('draws a filled, stroked rounded ghost bar', () => {
    const { ctx, count } = makeCtxSpy();
    const t = milestone({ start: '2026-04-06', finish: '2026-04-10', isMilestone: false });
    drawDragShadow(ctx, t, 100, 0, SCALES);
    expect(count('roundRect')).toBe(1);
    expect(count('fill')).toBe(1);
    expect(count('stroke')).toBe(1);
  });
});

describe('drawGridLines', () => {
  it('strokes vertical + horizontal passes and shades weekends', () => {
    const { ctx, count } = makeCtxSpy();
    drawGridLines(ctx, SCALES, 0, 0, 600, 0, 5);
    // Two separate stroked passes: vertical day lines, then row separators.
    expect(count('beginPath')).toBeGreaterThanOrEqual(2);
    expect(count('stroke')).toBeGreaterThanOrEqual(2);
    expect(count('lineTo')).toBeGreaterThan(0);
    // The April range contains weekends → at least one weekend fill.
    expect(count('fillRect')).toBeGreaterThan(0);
  });
});

describe('drawTodayLine', () => {
  it('draws the today marker when today is within the visible range', () => {
    const { ctx, count } = makeCtxSpy();
    drawTodayLine(ctx, SCALES, 0, 600);
    expect(count('moveTo')).toBe(1);
    expect(count('lineTo')).toBe(1);
    expect(count('stroke')).toBe(1);
    // Wrapped in save/restore so globalAlpha/strokeStyle don't leak.
    expect(count('save')).toBe(1);
    expect(count('restore')).toBe(1);
  });

  it('skips drawing when today is off-screen', () => {
    const { ctx, count } = makeCtxSpy();
    const farPast = buildScaleData('week', '2025-01-01', '2025-03-01');
    drawTodayLine(ctx, farPast, 0, 600);
    expect(count('stroke')).toBe(0);
  });
});
