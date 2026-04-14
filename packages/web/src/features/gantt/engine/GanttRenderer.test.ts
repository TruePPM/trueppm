import { describe, it, expect, vi } from 'vitest';
import {
  drawSummaryBar,
  drawActualDateBar,
  drawScheduleVarianceBadge,
  MILESTONE_SIZE,
  GHOST_BAR_HEIGHT,
  BAR_HEIGHT,
  BAR_TOP_OFFSET,
  ROW_HEIGHT,
  COLOR,
} from './GanttRenderer';
import { buildScaleData, dateToLeft } from './GanttScaleData';
import { HEADER_HEIGHT } from '../ganttConstants';
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
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const SUMMARY_TASK: Task = {
  id: 's1',
  name: 'Rollup',
  start: '2026-04-06',
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
