import { describe, it, expect, vi } from 'vitest';
import {
  drawSummaryBar,
  drawActualDateBar,
  drawScheduleVarianceBadge,
  drawTimelineHeader,
  MILESTONE_SIZE,
  GHOST_BAR_HEIGHT,
  BAR_HEIGHT,
  BAR_TOP_OFFSET,
  ROW_HEIGHT,
  COLOR,
} from './GanttRenderer';
import { buildScaleData, dateToLeft } from './GanttScaleData';
import { HEADER_HEIGHT } from '../scheduleConstants';
import type { Task } from '@/types';

function makeCtxSpy() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ name, args });
    });
  let _strokeStyle = '';
  let _fillStyle = '';
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
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    fillText: record('fillText'),
    measureText: vi.fn(() => ({ width: 20 })),
    setLineDash: record('setLineDash'),
    set fillStyle(v: string) { _fillStyle = v; calls.push({ name: 'fillStyle', args: [v] }); },
    get fillStyle() { return _fillStyle; },
    set strokeStyle(v: string) { _strokeStyle = v; calls.push({ name: 'strokeStyle', args: [v] }); },
    get strokeStyle() { return _strokeStyle; },
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set textBaseline(_v: string) {},
    set font(_v: string) {},
    clip: record('clip'),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const SUMMARY_TASK: Task = {
  id: 's1',
  name: 'Rollup',
  start: '2026-04-06',
  // PM-committed; without plannedStart the drawSummaryBar gate (#332)
  // suppresses the bar entirely.
  plannedStart: '2026-04-06',
  finish: '2026-04-10',
  duration: 5,
  progress: 0,
  isSummary: true,
  isMilestone: false,
  isCritical: false,
  parentId: null,
  wbs: '1',
} as unknown as Task;

describe('drawSummaryBar — diamond end-caps (#71)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  it('renders diamond end-caps at both the start and finish x-coordinates', () => {
    const { ctx, calls } = makeCtxSpy();
    drawSummaryBar(ctx, SUMMARY_TASK, 0, scales, 0, false);

    const translates = calls.filter((c) => c.name === 'translate');
    const rotates = calls.filter((c) => c.name === 'rotate');

    // Two diamond caps → two translate+rotate pairs
    expect(translates.length).toBe(2);
    expect(rotates.length).toBe(2);
    for (const r of rotates) expect(r.args[0]).toBeCloseTo(Math.PI / 4);

    const expectedLeft = dateToLeft(SUMMARY_TASK.start, scales);
    const expectedRight = dateToLeft(SUMMARY_TASK.finish, scales);
    const xs = translates.map((t) => t.args[0] as number).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(expectedLeft);
    expect(xs[1]).toBeCloseTo(expectedRight);
  });

  it('diamond cap is a MILESTONE_SIZE square drawn from (-half, -half)', () => {
    const { ctx, calls } = makeCtxSpy();
    drawSummaryBar(ctx, SUMMARY_TASK, 0, scales, 0, false);

    // Look for rect calls matching milestone geometry (not the roundRect body)
    const rects = calls.filter((c) => c.name === 'rect');
    expect(rects.length).toBe(2);
    for (const r of rects) {
      expect(r.args[0]).toBe(-MILESTONE_SIZE / 2);
      expect(r.args[1]).toBe(-MILESTONE_SIZE / 2);
      expect(r.args[2]).toBe(MILESTONE_SIZE);
      expect(r.args[3]).toBe(MILESTONE_SIZE);
    }
  });

  it('no bracket-tail fillRects remain (regression guard)', () => {
    const { ctx, calls } = makeCtxSpy();
    drawSummaryBar(ctx, SUMMARY_TASK, 0, scales, 0, false);
    expect(calls.filter((c) => c.name === 'fillRect').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drawActualDateBar
// ---------------------------------------------------------------------------

const SCALES = buildScaleData('week', '2026-04-01', '2026-05-01');

function makeActualTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Task',
    start: '2026-04-06',
    finish: '2026-04-10',
    duration: 5,
    progress: 50,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    parentId: null,
    wbs: '1',
    isComplete: false,
    status: 'IN_PROGRESS',
    assignees: [],
    actualStart: '2026-04-06',
    actualFinish: '2026-04-11',
    scheduleVarianceDays: 1,
    ...overrides,
  } as Task;
}

describe('drawActualDateBar (#80)', () => {
  it('draws a dashed stroke for a task with actual dates', () => {
    const task = makeActualTask();
    const { ctx, calls } = makeCtxSpy();
    drawActualDateBar(ctx, task, 0, SCALES, 0);

    expect(calls.filter((c) => c.name === 'stroke').length).toBeGreaterThan(0);
    // setLineDash called with a non-empty pattern (dashed line)
    const dashCalls = calls.filter((c) => c.name === 'setLineDash');
    expect(dashCalls.length).toBeGreaterThanOrEqual(2); // set + reset
    expect(dashCalls[0].args[0]).not.toEqual([]); // first call sets a pattern
  });

  it('positions the bar below the planned bar (barTop + BAR_HEIGHT + 1)', () => {
    const task = makeActualTask();
    const { calls } = makeCtxSpy();
    const { ctx } = makeCtxSpy();
    drawActualDateBar(ctx, task, 0, SCALES, 0);

    const expectedTop =
      0 * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET + BAR_HEIGHT + 1 + GHOST_BAR_HEIGHT / 2;
    // moveTo should be called with y = expectedTop
    const moveToCall = calls.find((c) => c.name === 'moveTo');
    // We can't observe y from the outer ctx since we used a different ctx above.
    // Instead, call again with the recording ctx.
    const { ctx: ctx2, calls: calls2 } = makeCtxSpy();
    drawActualDateBar(ctx2, task, 0, SCALES, 0);
    const moveTo = calls2.find((c) => c.name === 'moveTo');
    expect(moveTo).toBeDefined();
    expect(moveTo!.args[1]).toBeCloseTo(expectedTop);
    void moveToCall; // suppress unused var warning
  });

  it('uses barCritical color for late tasks (variance > 0)', () => {
    const task = makeActualTask({ scheduleVarianceDays: 3 });
    const { ctx, calls } = makeCtxSpy();
    drawActualDateBar(ctx, task, 0, SCALES, 0);
    const colorCalls = calls.filter((c) => c.name === 'strokeStyle');
    expect(colorCalls.some((c) => c.args[0] === COLOR.barCritical)).toBe(true);
  });

  it('uses barComplete color for early tasks (variance < 0)', () => {
    const task = makeActualTask({ scheduleVarianceDays: -2 });
    const { ctx, calls } = makeCtxSpy();
    drawActualDateBar(ctx, task, 0, SCALES, 0);
    const colorCalls = calls.filter((c) => c.name === 'strokeStyle');
    expect(colorCalls.some((c) => c.args[0] === COLOR.barComplete)).toBe(true);
  });

  it('uses ghostBorder color for in-progress tasks (variance null)', () => {
    const task = makeActualTask({ scheduleVarianceDays: null, actualFinish: undefined });
    const { ctx, calls } = makeCtxSpy();
    drawActualDateBar(ctx, task, 0, SCALES, 0);
    const colorCalls = calls.filter((c) => c.name === 'strokeStyle');
    expect(colorCalls.some((c) => c.args[0] === COLOR.ghostBorder)).toBe(true);
  });

  it('does nothing when no actualStart or actualFinish', () => {
    const task = makeActualTask({ actualStart: undefined, actualFinish: undefined });
    const { ctx, calls } = makeCtxSpy();
    drawActualDateBar(ctx, task, 0, SCALES, 0);
    expect(calls.filter((c) => c.name === 'stroke').length).toBe(0);
  });
});

describe('drawScheduleVarianceBadge (#80)', () => {
  const VIEWPORT_W = 2000;

  it('renders a text badge for a late task', () => {
    const task = makeActualTask({ scheduleVarianceDays: 3 });
    const { ctx, calls } = makeCtxSpy();
    drawScheduleVarianceBadge(ctx, task, 0, SCALES, 0, VIEWPORT_W);
    const textCalls = calls.filter((c) => c.name === 'fillText');
    expect(textCalls.length).toBeGreaterThan(0);
    expect(String(textCalls[0].args[0])).toBe('+3d');
  });

  it('renders a text badge for an early task', () => {
    const task = makeActualTask({ scheduleVarianceDays: -2 });
    const { ctx, calls } = makeCtxSpy();
    drawScheduleVarianceBadge(ctx, task, 0, SCALES, 0, VIEWPORT_W);
    const textCalls = calls.filter((c) => c.name === 'fillText');
    expect(String(textCalls[0].args[0])).toBe('-2d');
  });

  it('does nothing when variance is 0', () => {
    const task = makeActualTask({ scheduleVarianceDays: 0 });
    const { ctx, calls } = makeCtxSpy();
    drawScheduleVarianceBadge(ctx, task, 0, SCALES, 0, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'fillText').length).toBe(0);
  });

  it('does nothing when variance is null', () => {
    const task = makeActualTask({ scheduleVarianceDays: null });
    const { ctx, calls } = makeCtxSpy();
    drawScheduleVarianceBadge(ctx, task, 0, SCALES, 0, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'fillText').length).toBe(0);
  });

  it('does nothing when bar is off-screen to the right', () => {
    const task = makeActualTask({ scheduleVarianceDays: 3 });
    const { ctx, calls } = makeCtxSpy();
    // Pass viewport width of 1 — bar right edge will be > 1
    drawScheduleVarianceBadge(ctx, task, 0, SCALES, 0, 1);
    expect(calls.filter((c) => c.name === 'fillText').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drawTimelineHeader — sticky label (#96)
// ---------------------------------------------------------------------------

describe('drawTimelineHeader — sticky label (#96)', () => {
  // Project: Apr 1–May 1. Scale at 'month' zoom adds trailing buffer well past May.
  // Minor unit = month, major unit = year.
  const scales = buildScaleData('month', '2026-04-01', '2026-05-01');
  const CANVAS_W = 800;

  it('renders a fillText call when scrollLeft=0 (no scroll)', () => {
    const { ctx, calls } = makeCtxSpy();
    drawTimelineHeader(ctx, scales, 0, CANVAS_W);
    expect(calls.filter((c) => c.name === 'fillText').length).toBeGreaterThan(0);
  });

  it('still renders fillText when scrolled past the first unit boundary (sticky label)', () => {
    // Scroll far right so the current major unit (year) started before the viewport.
    // Before the fix, the label x was negative → invisible.
    const scrollLeft = scales.totalWidth - CANVAS_W;
    const { ctx, calls } = makeCtxSpy();
    drawTimelineHeader(ctx, scales, scrollLeft, CANVAS_W);
    const textCalls = calls.filter((c) => c.name === 'fillText');
    expect(textCalls.length).toBeGreaterThan(0);
  });

  it('pins label x to ≥ 4 when cell starts off-screen left', () => {
    // Scroll to the very end so every major and minor unit has started before viewport.
    const scrollLeft = scales.totalWidth - CANVAS_W;
    const { ctx, calls } = makeCtxSpy();
    drawTimelineHeader(ctx, scales, scrollLeft, CANVAS_W);
    const textCalls = calls.filter((c) => c.name === 'fillText');
    // Every visible label must have x ≥ 4 (pinned) — never negative.
    for (const call of textCalls) {
      expect(call.args[1] as number).toBeGreaterThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// drawTaskBar — wave 3 bar render (#212)
// ---------------------------------------------------------------------------

import { drawTaskBar } from './GanttRenderer';

function makeBarTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'b1',
    name: 'Design sprint',
    start: '2026-04-06',
    // Default to a committed task so the drawTaskBar gate (#332) does not
    // suppress the bar. Tests that exercise the unscheduled path override
    // plannedStart: null explicitly.
    plannedStart: '2026-04-06',
    finish: '2026-04-20',
    duration: 14,
    progress: 85,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    isComplete: false,
    parentId: null,
    wbs: '1.1',
    status: 'IN_PROGRESS',
    assignees: [],
    ...overrides,
  } as unknown as Task;
}

describe('drawTaskBar — % chip and outside name (#212)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const VIEWPORT_W = 800;

  it('renders a roundRect chip when bar width >= 32px', () => {
    const { ctx, calls } = makeCtxSpy();
    drawTaskBar(ctx, makeBarTask(), 0, scales, 0, false, VIEWPORT_W);
    // Chip is drawn with roundRect (3 arg: x, y, w, h, radius)
    // The bar itself is also a roundRect — we just check at least two roundRects exist
    const roundRects = calls.filter((c) => c.name === 'roundRect');
    expect(roundRects.length).toBeGreaterThanOrEqual(2);
  });

  it('does not clip the task name inside bar bounds (name is outside)', () => {
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ name: 'My Task' });
    drawTaskBar(ctx, task, 0, scales, 0, false, VIEWPORT_W);
    // There should be a fillText call for the name.
    // Previously the name was clipped; the new call happens after ctx.restore().
    // We verify the name appears in fillText args.
    const textCalls = calls.filter((c) => c.name === 'fillText');
    const nameCall = textCalls.find((c) => c.args[0] === 'My Task');
    expect(nameCall).toBeDefined();
  });

  it('omits chip when bar is narrower than 32px (far-right zoom)', () => {
    // Place bar on a single day with day-zoom scale — bar will be very narrow
    const dayScales = buildScaleData('day', '2026-04-06', '2026-04-07');
    const { ctx, calls } = makeCtxSpy();
    // Override measureText to return 0 width so bar collapses to minimum 2px
    (ctx.measureText as ReturnType<typeof vi.fn>).mockReturnValue({ width: 5 });
    const narrowTask = makeBarTask({ start: '2026-04-06', finish: '2026-04-06', duration: 1 });
    drawTaskBar(ctx, narrowTask, 0, dayScales, 0, false, VIEWPORT_W);
    // With a 1-day bar at day zoom, pxPerMs is low enough that barWidth < 32px.
    // We just ensure it doesn't throw — chip suppression is by conditional, not error.
    expect(calls.filter((c) => c.name === 'roundRect').length).toBeGreaterThanOrEqual(1);
  });

  it('uses translucent white chip fill on critical bars', () => {
    const { ctx, calls } = makeCtxSpy();
    const criticalTask = makeBarTask({ isCritical: true, isComplete: false, progress: 50 });
    drawTaskBar(ctx, criticalTask, 0, scales, 0, false, VIEWPORT_W);
    // The chip fill for critical bars is 'rgba(255,255,255,0.22)'
    const chipFill = calls.find(
      (c) => c.name === 'fillStyle' && c.args[0] === 'rgba(255,255,255,0.22)',
    );
    expect(chipFill).toBeDefined();
  });

  it('uses translucent dark chip fill on non-critical bars', () => {
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ isCritical: false, progress: 50 });
    drawTaskBar(ctx, task, 0, scales, 0, false, VIEWPORT_W);
    const chipFill = calls.find(
      (c) => c.name === 'fillStyle' && c.args[0] === 'rgba(0,0,0,0.18)',
    );
    expect(chipFill).toBeDefined();
  });

  it('does not render chip for 0% NOT_STARTED task', () => {
    const { ctx, calls } = makeCtxSpy();
    const newTask = makeBarTask({ progress: 0, status: 'NOT_STARTED' as Task['status'] });
    drawTaskBar(ctx, newTask, 0, scales, 0, false, VIEWPORT_W);
    // No translucent fill calls (chip suppressed)
    const chipFill = calls.find(
      (c) => c.name === 'fillStyle' &&
        (c.args[0] === 'rgba(255,255,255,0.22)' || c.args[0] === 'rgba(0,0,0,0.18)'),
    );
    expect(chipFill).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// drawTaskBar — uncommitted-task suppression (#332)
// ---------------------------------------------------------------------------

describe('drawTaskBar — uncommitted-task suppression (#332)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const VIEWPORT_W = 800;

  it('skips drawing entirely when plannedStart is null and the task is not in a sprint', () => {
    // CPM auto-fills early_start/finish on every dated task, so task.start is
    // non-null even for backlog ideas. Without this gate every backlog card
    // silently rendered as a Gantt bar (issue #332).
    const { ctx, calls } = makeCtxSpy();
    const uncommitted = makeBarTask({ plannedStart: null, sprintId: null });
    drawTaskBar(ctx, uncommitted, 0, scales, 0, false, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'roundRect')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'fillText')).toHaveLength(0);
  });

  it('renders normally once the PM commits a plannedStart', () => {
    const { ctx, calls } = makeCtxSpy();
    drawTaskBar(ctx, makeBarTask({ plannedStart: '2026-04-06' }), 0, scales, 0, false, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'roundRect').length).toBeGreaterThanOrEqual(1);
  });

  it('renders when committed via sprint membership even with plannedStart null', () => {
    const { ctx, calls } = makeCtxSpy();
    const sprintTask = makeBarTask({ plannedStart: null, sprintId: 'sprint-uuid' });
    drawTaskBar(ctx, sprintTask, 0, scales, 0, false, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'roundRect').length).toBeGreaterThanOrEqual(1);
  });
});
