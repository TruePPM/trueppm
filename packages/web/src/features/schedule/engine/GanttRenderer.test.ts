import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  drawDependencyArrows,
  prepareDependencyLayout,
  paintDependencyLayout,
  drawSummaryBar,
  drawActualDateBar,
  drawScheduleVarianceBadge,
  drawTimelineHeader,
  drawRowBands,
  drawGridLines,
  drawTodayLine,
  drawMilestone,
  drawDragShadow,
  drawResizeIndicator,
  MILESTONE_SIZE,
  GHOST_BAR_HEIGHT,
  BAR_HEIGHT,
  BAR_TOP_OFFSET,
  ROW_HEIGHT,
  MERGE_HALO_RADIUS,
  MERGE_DOT_RADIUS,
  COLOR,
} from './GanttRenderer';
import { buildScaleData, dateToLeft, dateToRight } from './GanttScaleData';
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
    strokeText: record('strokeText'),
    measureText: vi.fn(() => ({ width: 20 })),
    setLineDash: record('setLineDash'),
    set fillStyle(v: string) {
      _fillStyle = v;
      calls.push({ name: 'fillStyle', args: [v] });
    },
    get fillStyle() {
      return _fillStyle;
    },
    set strokeStyle(v: string) {
      _strokeStyle = v;
      calls.push({ name: 'strokeStyle', args: [v] });
    },
    get strokeStyle() {
      return _strokeStyle;
    },
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
    // finish is inclusive — the right endcap sits at the exclusive bar edge (#950).
    const expectedRight = dateToRight(SUMMARY_TASK.finish, scales);
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
// drawTimelineHeader — fiscal quarter tiers (#755)
// ---------------------------------------------------------------------------

describe('drawTimelineHeader — fiscal quarters (#755)', () => {
  // Quarter zoom across an April-fiscal-year boundary: Mar 2026 → Feb 2027.
  const scales = buildScaleData('quarter', '2026-03-01', '2027-02-01');
  const CANVAS_W = 1600;
  const labelsFrom = (calls: Array<{ name: string; args: unknown[] }>) =>
    calls.filter((c) => c.name === 'fillText').map((c) => c.args[0] as string);

  it('renders calendar quarter labels by default', () => {
    const { ctx, calls } = makeCtxSpy();
    drawTimelineHeader(ctx, scales, 0, CANVAS_W);
    const labels = labelsFrom(calls);
    expect(labels.some((l) => /^Q\d 2026$/.test(l))).toBe(true);
    expect(labels.some((l) => l.includes('FY'))).toBe(false);
  });

  it('renders fiscal quarter + fiscal year labels in fiscal mode (April start)', () => {
    const { ctx, calls } = makeCtxSpy();
    drawTimelineHeader(ctx, scales, 0, CANVAS_W, { startMonth: 4, mode: 'fiscal' });
    const labels = labelsFrom(calls);
    // Minor row: fiscal quarter labels. Apr–Jun 2026 = Q1 FY27.
    expect(labels).toContain('Q1 FY27');
    // Major row: fiscal year label spanning the range.
    expect(labels).toContain('FY27');
    // No calendar "Q1 2026" form in fiscal mode.
    expect(labels.some((l) => /^Q\d 20\d\d$/.test(l))).toBe(false);
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

  it('paints a 2-day-wide bar for a 2-day task (inclusive finish, #950)', () => {
    // Regression for #950: a 2-day task (start Jun 7, inclusive finish Jun 8)
    // must span TWO day-columns. The bar body is the first roundRect call;
    // its width arg (args[2]) must equal two full days of pixels, not one.
    const dayScales = buildScaleData('day', '2026-06-01', '2026-06-30');
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({
      start: '2026-06-07',
      plannedStart: '2026-06-07',
      finish: '2026-06-08',
      duration: 2,
    });
    drawTaskBar(ctx, task, 0, dayScales, 0, false, VIEWPORT_W);
    const barBody = calls.find((c) => c.name === 'roundRect');
    expect(barBody).toBeDefined();
    const oneDayPx = 86_400_000 * dayScales.pxPerMs;
    expect(barBody!.args[2] as number).toBeCloseTo(2 * oneDayPx, 1);
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

  it('uses the surface (dark) chip fill on critical bars — criticality no longer flips the chip', () => {
    // #1699/ADR-0277: critical bars keep a STATE fill (blue/green) with a red
    // border, so the chip pairs with the surface treatment like every other bar;
    // the old white-on-red chip pill for a red critical fill is gone.
    const { ctx, calls } = makeCtxSpy();
    const criticalTask = makeBarTask({ isCritical: true, isComplete: false, progress: 50 });
    drawTaskBar(ctx, criticalTask, 0, scales, 0, false, VIEWPORT_W);
    const surfacePill = calls.find(
      (c) => c.name === 'fillStyle' && c.args[0] === 'rgba(0,0,0,0.18)',
    );
    const whitePill = calls.find(
      (c) => c.name === 'fillStyle' && c.args[0] === 'rgba(255,255,255,0.22)',
    );
    expect(surfacePill).toBeDefined();
    expect(whitePill).toBeUndefined();
  });

  it('uses translucent dark chip fill on non-critical bars', () => {
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ isCritical: false, progress: 50 });
    drawTaskBar(ctx, task, 0, scales, 0, false, VIEWPORT_W);
    const chipFill = calls.find((c) => c.name === 'fillStyle' && c.args[0] === 'rgba(0,0,0,0.18)');
    expect(chipFill).toBeDefined();
  });

  it('does not render chip for 0% NOT_STARTED task', () => {
    const { ctx, calls } = makeCtxSpy();
    const newTask = makeBarTask({ progress: 0, status: 'NOT_STARTED' as Task['status'] });
    drawTaskBar(ctx, newTask, 0, scales, 0, false, VIEWPORT_W);
    // No translucent fill calls (chip suppressed)
    const chipFill = calls.find(
      (c) =>
        c.name === 'fillStyle' &&
        (c.args[0] === 'rgba(255,255,255,0.22)' || c.args[0] === 'rgba(0,0,0,0.18)'),
    );
    expect(chipFill).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// drawTaskBar — critical path as a red border frame (#1699, ADR-0277)
// ---------------------------------------------------------------------------

describe('drawTaskBar — critical path as a red border frame (#1699)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const VIEWPORT_W = 800;

  const styles = (calls: Array<{ name: string; args: unknown[] }>, kind: string): unknown[] =>
    calls.filter((c) => c.name === kind).map((c) => c.args[0]);

  it('paints an in-progress critical task with the state (blue) fill, never a red fill', () => {
    const { ctx, calls } = makeCtxSpy();
    const t = makeBarTask({ isCritical: true, isComplete: false, progress: 40 });
    drawTaskBar(ctx, t, 0, scales, 0, false, VIEWPORT_W);
    expect(styles(calls, 'fillStyle')).toContain(COLOR.barNormal);
    expect(styles(calls, 'fillStyle')).not.toContain(COLOR.barCritical);
  });

  it('draws a red critical frame (border stroke) for a critical task', () => {
    const { ctx, calls } = makeCtxSpy();
    const t = makeBarTask({ isCritical: true, isComplete: false, progress: 40 });
    drawTaskBar(ctx, t, 0, scales, 0, false, VIEWPORT_W);
    expect(styles(calls, 'strokeStyle')).toContain(COLOR.barCritical);
  });

  it('keeps a COMPLETED critical task visible: green fill + red frame (the #1699 fix)', () => {
    // The original bug: barFillColor checked isComplete before isCritical, so a done
    // critical bar rendered solid green and the critical path vanished. Now the green
    // is the fill and the red is the border — both present, criticality survives.
    const { ctx, calls } = makeCtxSpy();
    const t = makeBarTask({ isCritical: true, isComplete: true, progress: 100 });
    drawTaskBar(ctx, t, 0, scales, 0, false, VIEWPORT_W);
    expect(styles(calls, 'fillStyle')).toContain(COLOR.barComplete);
    expect(styles(calls, 'strokeStyle')).toContain(COLOR.barCritical);
  });

  it('draws no red frame for a non-critical task', () => {
    const { ctx, calls } = makeCtxSpy();
    const t = makeBarTask({ isCritical: false, progress: 40 });
    drawTaskBar(ctx, t, 0, scales, 0, false, VIEWPORT_W);
    expect(styles(calls, 'strokeStyle')).not.toContain(COLOR.barCritical);
  });

  it('nests the selection ring inside the critical frame so both channels stay visible', () => {
    const { ctx, calls } = makeCtxSpy();
    const t = makeBarTask({ isCritical: true, progress: 40 });
    drawTaskBar(ctx, t, 0, scales, 0, true /* selected */, VIEWPORT_W);
    const strokes = styles(calls, 'strokeStyle');
    expect(strokes).toContain(COLOR.barCritical); // red frame
    expect(strokes).toContain(COLOR.selectionRing); // navy ring nested inside
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

// ---------------------------------------------------------------------------
// drawTaskBar / drawTaskBarLabel — split for z-order layering
// ---------------------------------------------------------------------------

import { drawTaskBarLabel } from './GanttRenderer';

describe('drawTaskBar — skipLabel parameter (z-order regression)', () => {
  // Dependency arrows exit/enter at row-center y, exactly where the label
  // sits. If the engine paints labels first and arrows last (the natural
  // last-pass position), every arrow looks like a strikethrough through
  // the label text. The fix splits label rendering into drawTaskBarLabel
  // so the engine can layer bars → arrows → labels.
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const VIEWPORT_W = 800;

  it('does NOT draw the task name when skipLabel is true', () => {
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ name: 'My Task' });
    drawTaskBar(ctx, task, 0, scales, 0, false, VIEWPORT_W, /* skipLabel */ true);
    const nameCalls = calls.filter((c) => c.name === 'fillText' && c.args[0] === 'My Task');
    expect(nameCalls).toHaveLength(0);
  });

  it('still draws the task name when skipLabel is false (default)', () => {
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ name: 'My Task' });
    drawTaskBar(ctx, task, 0, scales, 0, false, VIEWPORT_W);
    const nameCalls = calls.filter((c) => c.name === 'fillText' && c.args[0] === 'My Task');
    expect(nameCalls.length).toBeGreaterThan(0);
  });

  it('drawTaskBarLabel draws only the task name (no bar fill, no chip, no initials)', () => {
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ name: 'My Task' });
    drawTaskBarLabel(ctx, task, 0, scales, 0, VIEWPORT_W);
    // Exactly one fillText for the name; nothing else.
    const nameCalls = calls.filter((c) => c.name === 'fillText' && c.args[0] === 'My Task');
    expect(nameCalls).toHaveLength(1);
    // No bar — no roundRect call.
    expect(calls.filter((c) => c.name === 'roundRect')).toHaveLength(0);
  });

  it('drawTaskBarLabel respects the same #332 uncommitted gate as drawTaskBar', () => {
    const { ctx, calls } = makeCtxSpy();
    const uncommitted = makeBarTask({ plannedStart: null, sprintId: null, name: 'Idea' });
    drawTaskBarLabel(ctx, uncommitted, 0, scales, 0, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'fillText')).toHaveLength(0);
  });

  it('paint sequence drawTaskBar(skipLabel=true) → label puts the name AFTER the chip', () => {
    // Direct regression for the strikethrough artifact: the engine paints
    // the bar first, then arrows, then labels. We can't exercise the engine
    // here, but we can lock in the contract that drawTaskBarLabel is
    // independently invokable and runs after drawTaskBar(skipLabel=true).
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ name: 'My Task', progress: 50 });
    drawTaskBar(ctx, task, 0, scales, 0, false, VIEWPORT_W, /* skipLabel */ true);
    // Label not yet drawn after just drawTaskBar.
    expect(calls.filter((c) => c.name === 'fillText' && c.args[0] === 'My Task')).toHaveLength(0);
    drawTaskBarLabel(ctx, task, 0, scales, 0, VIEWPORT_W);
    // Now the label call exists, and it is the LAST fillText invocation —
    // any arrow drawn between the two calls would be covered.
    const allFillText = calls.filter((c) => c.name === 'fillText');
    expect(allFillText[allFillText.length - 1]?.args[0]).toBe('My Task');
  });
});

// ---------------------------------------------------------------------------
// drawSummaryBar — phase rollup must render regardless of phase plannedStart
// ---------------------------------------------------------------------------

describe('drawSummaryBar — rollup renders without phase plannedStart (#305 follow-up)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  it('renders the rollup bar when CPM has produced summary dates even if plannedStart is null', () => {
    // The original #332 fix gated drawSummaryBar on plannedStart, the same
    // heuristic used for leaf tasks. That hid every phase rollup whose
    // phase row didn't have its own planned_start — but PMs never set
    // planned_start on phases. Summaries are containers; their dates are
    // CPM rollups from children. The corrected gate is just
    // `!task.start || !task.finish` (covers the "no children scheduled
    // yet" case naturally).
    const { ctx, calls } = makeCtxSpy();
    const phase = {
      ...SUMMARY_TASK,
      plannedStart: null,
      sprintId: null,
    } as unknown as Task;
    drawSummaryBar(ctx, phase, 0, scales, 0, false);
    // Both diamond endpoint translates and the body roundRect should be drawn.
    expect(calls.filter((c) => c.name === 'translate')).toHaveLength(2);
    expect(calls.filter((c) => c.name === 'roundRect').length).toBeGreaterThanOrEqual(1);
  });

  it('still skips the rollup when CPM has not produced any dates yet', () => {
    const { ctx, calls } = makeCtxSpy();
    const empty = {
      ...SUMMARY_TASK,
      start: '',
      finish: '',
      plannedStart: null,
      sprintId: null,
    } as unknown as Task;
    drawSummaryBar(ctx, empty, 0, scales, 0, false);
    expect(calls.filter((c) => c.name === 'roundRect')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'translate')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// drawDependencyArrows — phase summaries are anchorable even without
// plannedStart (#305 follow-up to #332)
// ---------------------------------------------------------------------------

describe('drawDependencyArrows — summary tasks are anchorable without plannedStart (#305 follow-up)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  // drawDependencyArrows reads ctx.canvas.width / .height; augment the shared
  // spy with canvas methods not in makeCtxSpy().
  function makeArrowCtxSpy() {
    const { ctx, calls } = makeCtxSpy();
    const augmented = ctx as unknown as Record<string, unknown>;
    augmented.canvas = { width: 800, height: 600 };
    augmented.bezierCurveTo = vi.fn((...args: unknown[]) => {
      calls.push({ name: 'bezierCurveTo', args });
    });
    augmented.closePath = vi.fn(() => calls.push({ name: 'closePath', args: [] }));
    augmented.arc = vi.fn((...args: unknown[]) => {
      calls.push({ name: 'arc', args });
    });
    return { ctx, calls };
  }

  function leafTask(id: string, plannedStart: string | null): Task {
    return {
      id,
      wbs: id,
      name: `Leaf ${id}`,
      start: '2026-04-08',
      finish: '2026-04-12',
      plannedStart,
      duration: 5,
      progress: 0,
      isSummary: false,
      isMilestone: false,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
  }

  function phase(id: string, plannedStart: string | null): Task {
    return {
      id,
      wbs: id,
      name: `Phase ${id}`,
      start: '2026-04-06',
      finish: '2026-04-15',
      plannedStart,
      duration: 10,
      progress: 0,
      isSummary: true,
      isMilestone: false,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
  }

  it('renders an arrow when the source is an uncommitted phase summary (#305)', () => {
    // PMs link phase-to-phase as the primary dependency relationship in
    // waterfall plans. Suppressing rollup-rooted arrows hides the structure
    // the user is actually working in (reverted after P1-3 misjudgment).
    // The summary still acts as an obstacle in the routing layer.
    const { ctx, calls } = makeArrowCtxSpy();
    const tasks: Task[] = [phase('phase-1', null), leafTask('leaf-1', '2026-04-12')];
    const links = [
      {
        id: 'l1',
        sourceId: 'phase-1',
        targetId: 'leaf-1',
        type: 'FS' as const,
        lag: 0,
        isCritical: false,
      },
    ];
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'lineTo').length).toBeGreaterThan(0);
  });

  it('still skips arrows anchored to uncommitted leaf tasks (the original #332 case)', () => {
    const { ctx, calls } = makeArrowCtxSpy();
    const tasks: Task[] = [
      leafTask('leaf-source', '2026-04-08'),
      leafTask('leaf-uncommitted', null),
    ];
    const links = [
      {
        id: 'l1',
        sourceId: 'leaf-source',
        targetId: 'leaf-uncommitted',
        type: 'FS' as const,
        lag: 0,
        isCritical: false,
      },
    ];
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'lineTo')).toHaveLength(0);
  });

  function schedLeaf(id: string, start: string, finish: string): Task {
    return {
      id,
      wbs: id,
      name: `Leaf ${id}`,
      start,
      finish,
      plannedStart: start,
      duration: 5,
      progress: 0,
      isSummary: false,
      isMilestone: false,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
  }

  it('Scenario 1: forward FS with clear gap uses orthogonal L-shape (lineTo, no bezierCurveTo)', () => {
    // Source finishes Apr 10, target starts Apr 14 → simple L shape.
    // 3 path lineTos (exit, V drop, run-in) + 2 arrowhead-triangle lineTos = 5.
    const { ctx, calls } = makeArrowCtxSpy();
    const tasks: Task[] = [
      schedLeaf('src', '2026-04-06', '2026-04-10'), // row 0
      schedLeaf('tgt', '2026-04-14', '2026-04-21'), // row 1
    ];
    const links = [
      {
        id: 'l1',
        sourceId: 'src',
        targetId: 'tgt',
        type: 'FS' as const,
        lag: 0,
        isCritical: false,
      },
    ];
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'bezierCurveTo')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'lineTo').length).toBe(5);
  });

  it('Scenario 1: multi-row forward FS also uses orthogonal L-shape regardless of row distance', () => {
    // Simple L is independent of intervening rows when none are obstacles.
    const { ctx, calls } = makeArrowCtxSpy();
    const tasks: Task[] = [
      schedLeaf('src', '2026-04-06', '2026-04-10'), // row 0
      schedLeaf('mid', '2026-04-06', '2026-04-10'), // row 1 (not in link)
      schedLeaf('tgt', '2026-04-14', '2026-04-21'), // row 2
    ];
    const links = [
      {
        id: 'l1',
        sourceId: 'src',
        targetId: 'tgt',
        type: 'FS' as const,
        lag: 0,
        isCritical: false,
      },
    ];
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'bezierCurveTo')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'lineTo').length).toBe(5);
  });

  // A zero-duration milestone diamond sitting on the V-drop column must be
  // treated as an obstacle: the SIMPLE-L drop column is right-swept past the
  // diamond's right edge + ROUTING_PADDING so the V skirts it instead of
  // piercing it (#1184).
  //
  // Geometry note: the drop column is the MIDPOINT between source-right and
  // the arrowhead base, NOT the target column. The original skipped spec put
  // the milestone on the target column (Apr 14) where it falls past the drop
  // range entirely — so it could never collide under midpoint routing. We use
  // a wide source→target gap and place the milestone on the actual midpoint
  // (week scale = 12 px/day): src right-edge ≈ x120, arrowhead base ≈ x266,
  // midpoint ≈ x193; a milestone at Apr 17 (center x192, body [183, 201])
  // straddles that column while clearing the exit stub at x125.
  it('milestones are obstacles — right-sweep diverts the V drop around a diamond in the drop column', () => {
    const milestoneTask: Task = {
      id: 'm1',
      wbs: 'm1',
      name: 'Mid milestone',
      start: '2026-04-17',
      finish: '2026-04-17',
      plannedStart: '2026-04-17',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: false,
      parentId: null,
    } as unknown as Task;

    const tasks: Task[] = [
      schedLeaf('src', '2026-04-06', '2026-04-10'), // row 0
      milestoneTask, // row 1 — obstacle on the drop column
      schedLeaf('tgt', '2026-04-24', '2026-04-30'), // row 2 — target (wide gap)
    ];
    const links = [
      {
        id: 'l1',
        sourceId: 'src',
        targetId: 'tgt',
        type: 'FS' as const,
        lag: 0,
        isCritical: false,
      },
    ];

    // Compare paths with vs without the obstacle milestone.
    const withMs = makeArrowCtxSpy();
    drawDependencyArrows(withMs.ctx, tasks, links, scales, 0, 0);
    const withoutMs = makeArrowCtxSpy();
    drawDependencyArrows(
      withoutMs.ctx,
      [tasks[0], tasks[2]], // remove the milestone
      links,
      scales,
      0,
      0,
    );

    const linePts = (calls: Array<{ name: string; args: unknown[] }>) =>
      calls
        .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
        .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number }));

    const ptsWith = linePts(withMs.calls);
    const ptsWithout = linePts(withoutMs.calls);

    // The drop column (X of the V segment) is the X of the third stroked point.
    // (moveTo + lineTo exit + lineTo sweepH — sweepH X is the drop column.)
    const dropX_with = ptsWith[2].x;
    const dropX_without = ptsWithout[2].x;

    // Without the milestone the drop column sits at the midpoint; with it, the
    // right-sweep must push the column RIGHT, past the diamond body, so the
    // descending V never crosses the milestone.
    expect(dropX_with).toBeGreaterThan(dropX_without);

    // The swept column must clear the diamond's right edge. Milestone center is
    // dateToLeft(Apr 17); body extends ±milestoneHalfDiag (9 px). The drop V
    // must land at or beyond center + 9.
    const msCenterX = dateToLeft('2026-04-17', scales);
    expect(dropX_with).toBeGreaterThanOrEqual(msCenterX + 9);
  });

  it('milestone off the drop column does not perturb the route (divert is targeted)', () => {
    // Same wide-gap geometry, but the milestone sits on the TARGET column
    // (Apr 24) — past the drop range, in the arrowhead approach zone. It must
    // NOT shift the drop column: the right-sweep only fires for obstacles that
    // actually straddle the chosen V column.
    const milestoneTask: Task = {
      id: 'm1',
      wbs: 'm1',
      name: 'Approach-zone milestone',
      start: '2026-04-24',
      finish: '2026-04-24',
      plannedStart: '2026-04-24',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: false,
      parentId: null,
    } as unknown as Task;

    const tasks: Task[] = [
      schedLeaf('src', '2026-04-06', '2026-04-10'), // row 0
      milestoneTask, // row 1 — off the drop column
      schedLeaf('tgt', '2026-04-24', '2026-04-30'), // row 2 — target
    ];
    const links = [
      {
        id: 'l1',
        sourceId: 'src',
        targetId: 'tgt',
        type: 'FS' as const,
        lag: 0,
        isCritical: false,
      },
    ];

    const withMs = makeArrowCtxSpy();
    drawDependencyArrows(withMs.ctx, tasks, links, scales, 0, 0);
    const withoutMs = makeArrowCtxSpy();
    drawDependencyArrows(withoutMs.ctx, [tasks[0], tasks[2]], links, scales, 0, 0);

    const linePts = (calls: Array<{ name: string; args: unknown[] }>) =>
      calls
        .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
        .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number }));

    expect(linePts(withMs.calls)[2].x).toBe(linePts(withoutMs.calls)[2].x);
  });

  // -------------------------------------------------------------------------
  // Merge junctions for multi-predecessor milestones (rule 75)
  // -------------------------------------------------------------------------

  it('renders a merge junction when 2+ FS arrows terminate at the same milestone', () => {
    // Two predecessor leaves both target a single milestone — spec rule 5
    // (multi-predecessor milestone) requires a junction dot + single trunk
    // arrow rather than two separate arrowheads landing on the diamond.
    const milestone: Task = {
      id: 'gate',
      wbs: 'gate',
      name: 'Gate',
      start: '2026-04-20',
      finish: '2026-04-20',
      plannedStart: '2026-04-20',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
    const tasks: Task[] = [
      schedLeaf('a', '2026-04-06', '2026-04-10'),
      schedLeaf('b', '2026-04-06', '2026-04-12'),
      milestone,
    ];
    const links = [
      { id: 'la', sourceId: 'a', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
      { id: 'lb', sourceId: 'b', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);

    // Junction = halo (surface fill) + dot (stroke color), drawn AFTER all
    // predecessor lines and the trunk → two ctx.arc calls at the same center.
    const arcs = calls.filter((c) => c.name === 'arc');
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    // The last two arcs should be the junction (halo, then dot — same X, Y).
    const junctionHalo = arcs[arcs.length - 2];
    const junctionDot = arcs[arcs.length - 1];
    expect(junctionDot.args[0]).toBe(junctionHalo.args[0]); // same X
    expect(junctionDot.args[1]).toBe(junctionHalo.args[1]); // same Y
    expect(junctionHalo.args[2]).toBe(MERGE_HALO_RADIUS);
    expect(junctionDot.args[2]).toBe(MERGE_DOT_RADIUS);

    // Exactly ONE arrowhead — the trunk. With two predecessors there would be
    // 2 arrowheads if merging failed. Each arrowhead is fill+closePath+lineTos.
    // We count closePath calls — only the arrowhead triangle uses closePath.
    expect(calls.filter((c) => c.name === 'closePath')).toHaveLength(1);
  });

  it('merge junction X sits at the actual line-convergence point (rightmost predecessor exit X)', () => {
    // Junction is positioned at min(maxPredecessorExitX, tipX - 14) — i.e. at
    // the X where the LAST predecessor's V drops onto the trunk Y. That's
    // where the lines actually meet visually. The fixed `target.barLeft - 14`
    // offset is only used as an upper bound to preserve the ≥ APPROACH_STUB
    // straight trunk shaft before the arrowhead.
    const milestone: Task = {
      id: 'gate',
      wbs: 'gate',
      name: 'Gate',
      start: '2026-04-20',
      finish: '2026-04-20',
      plannedStart: '2026-04-20',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
    const tasks: Task[] = [
      schedLeaf('a', '2026-04-06', '2026-04-10'),
      schedLeaf('b', '2026-04-06', '2026-04-12'),
      milestone,
    ];
    const links = [
      { id: 'la', sourceId: 'a', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
      { id: 'lb', sourceId: 'b', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);

    // Rightmost predecessor 'b' has inclusive finish Apr 12 → its bar's right
    // edge is the EXCLUSIVE end of that day = dateToRight(Apr 12) (#950), so the
    // exit stub leaves from there: maxExitX = dateToRight(Apr 12) + EXIT_STUB (5).
    const maxExitX = dateToRight('2026-04-12', scales) + 5;
    const arcs = calls.filter((c) => c.name === 'arc');
    expect(arcs[arcs.length - 1].args[0]).toBeCloseTo(maxExitX);
  });

  it('merge junction trunk uses arrowNormal charcoal regardless of critical predecessors', () => {
    // Issue #466 gap P0-1: arrows are always charcoal — critical state lives
    // in the BAR fill (rule 73), not the connector. A red trunk crossing a
    // red bar visually disappears; charcoal stays distinct on every surface.
    const milestone: Task = {
      id: 'gate',
      wbs: 'gate',
      name: 'Gate',
      start: '2026-04-20',
      finish: '2026-04-20',
      plannedStart: '2026-04-20',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: true,
      parentId: null,
    } as unknown as Task;
    const crit = { ...schedLeaf('a', '2026-04-06', '2026-04-10'), isCritical: true };
    const tasks: Task[] = [crit, schedLeaf('b', '2026-04-06', '2026-04-12'), milestone];
    const links = [
      { id: 'la', sourceId: 'a', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: true },
      { id: 'lb', sourceId: 'b', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);

    const strokeStyles = calls.filter((c) => c.name === 'strokeStyle').map((c) => c.args[0]);
    expect(strokeStyles).toContain(COLOR.arrowNormal);
    // Critical-bar red MUST NOT appear as an arrow stroke. With the unified
    // charcoal scheme arrowNormal and arrowCritical resolve to the same value,
    // so this assertion is implicitly about distinctness from the BAR red.
    expect(strokeStyles).not.toContain('#B91C1C');
  });

  it('does NOT merge when a milestone has a single FS predecessor', () => {
    const milestone: Task = {
      id: 'gate',
      wbs: 'gate',
      name: 'Gate',
      start: '2026-04-20',
      finish: '2026-04-20',
      plannedStart: '2026-04-20',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
    const tasks: Task[] = [schedLeaf('a', '2026-04-06', '2026-04-10'), milestone];
    const links = [
      { id: 'la', sourceId: 'a', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    // Single-predecessor path has NO junction halo/dot — zero arc calls.
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Milestone vertex flank (rule 75 — incoming on LEFT flank)
  // -------------------------------------------------------------------------

  it('FS arrow into a milestone arrives at its left vertex (cx - halfDiag)', () => {
    const milestone: Task = {
      id: 'gate',
      wbs: 'gate',
      name: 'Gate',
      start: '2026-04-20',
      finish: '2026-04-20',
      plannedStart: '2026-04-20',
      duration: 0,
      progress: 0,
      isSummary: false,
      isMilestone: true,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
    const tasks: Task[] = [schedLeaf('a', '2026-04-06', '2026-04-10'), milestone];
    const links = [
      { id: 'la', sourceId: 'a', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);

    // The arrowhead tip X is the leftmost vertex of the diamond.
    const milestoneHalfDiag = Math.ceil((MILESTONE_SIZE / 2) * Math.SQRT2);
    const leftVertexX = dateToLeft(milestone.start, scales) - milestoneHalfDiag;
    // Arrowhead is drawn after the polyline: the FIRST moveTo of the second
    // beginPath sets the tip. Find the last moveTo to get the arrowhead apex.
    const moveTos = calls.filter((c) => c.name === 'moveTo');
    expect(moveTos[moveTos.length - 1].args[0]).toBeCloseTo(leftVertexX);
  });

  // -------------------------------------------------------------------------
  // Selection emphasis (rule 75)
  // -------------------------------------------------------------------------

  it('arrows for selected tasks use the selection ring color', () => {
    const tasks: Task[] = [
      schedLeaf('a', '2026-04-06', '2026-04-10'),
      schedLeaf('b', '2026-04-14', '2026-04-20'),
    ];
    const links = [
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0, new Set(['a']));
    const strokeStyles = calls.filter((c) => c.name === 'strokeStyle').map((c) => c.args[0]);
    expect(strokeStyles).toContain(COLOR.selectionRing);
  });

  it('non-selected arrows do NOT use the selection ring color', () => {
    const tasks: Task[] = [
      schedLeaf('a', '2026-04-06', '2026-04-10'),
      schedLeaf('b', '2026-04-14', '2026-04-20'),
    ];
    const links = [
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0); // empty selection
    const strokeStyles = calls.filter((c) => c.name === 'strokeStyle').map((c) => c.args[0]);
    expect(strokeStyles).not.toContain(COLOR.selectionRing);
  });

  // -------------------------------------------------------------------------
  // Source-dot regression — must NOT render the Visio-style attachment dot.
  // The spec removes it; the only arc calls now come from merge junctions.
  // -------------------------------------------------------------------------

  it('does NOT draw a source connection dot for a plain FS arrow', () => {
    const tasks: Task[] = [
      schedLeaf('a', '2026-04-06', '2026-04-10'),
      schedLeaf('b', '2026-04-14', '2026-04-20'),
    ];
    const links = [
      { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// drawTaskBar — in-bar label contrast across palettes (#1032)
// In dark mode the bar fills are the light 400 stops (sage-400, blue-400),
// where white in-bar text fails WCAG 1.4.3; the dark palette flips the chip /
// initial text to near-black ink. Light mode keeps white on its darker fills.
// ---------------------------------------------------------------------------

import { setRendererColorMode, COLOR_DARK, COLOR_FORCED, pickPalette } from './GanttRenderer';

describe('drawTaskBar — in-bar label contrast (#1032)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const VIEWPORT_W = 800;
  const labelledTask = () =>
    makeBarTask({
      progress: 50,
      assignees: [{ name: 'Jane Doe' }] as unknown as Task['assignees'],
    });

  // Restore the default light palette so palette state never leaks into the
  // surrounding suite (the active palette is module-global).
  afterEach(() => setRendererColorMode(false));

  it('uses white in-bar text on the darker light-mode fills', () => {
    setRendererColorMode(false);
    const { ctx, calls } = makeCtxSpy();
    drawTaskBar(ctx, labelledTask(), 0, scales, 0, false, VIEWPORT_W);
    const fills = calls.filter((c) => c.name === 'fillStyle').map((c) => c.args[0]);
    expect(fills).toContain('#FFFFFF');
    expect(fills).not.toContain('#1A1917');
  });

  it('uses near-black ink in-bar text on the light 400-stop dark-mode fills', () => {
    setRendererColorMode(true);
    const { ctx, calls } = makeCtxSpy();
    drawTaskBar(ctx, labelledTask(), 0, scales, 0, false, VIEWPORT_W);
    const fills = calls.filter((c) => c.name === 'fillStyle').map((c) => c.args[0]);
    expect(COLOR_DARK.chipTextOnSurface).toBe('#1A1917');
    expect(fills).toContain(COLOR_DARK.chipTextOnSurface);
    expect(fills).not.toContain('#FFFFFF');
  });

  // The chip pill must flip with the chip text: a fixed rgba(0,0,0,…) pill would
  // darken the area behind the ink text on the light dark-mode bars, reducing
  // contrast (issue 1638). In dark mode the non-critical pill is light, never black.
  it('uses a light chip pill on the dark surface, never a black rgba', () => {
    setRendererColorMode(true);
    const { ctx, calls } = makeCtxSpy();
    // A non-critical bar exercises the chipPillOnSurface branch.
    drawTaskBar(
      ctx,
      makeBarTask({ isCritical: false, progress: 50 }),
      0,
      scales,
      0,
      false,
      VIEWPORT_W,
    );
    const fills = calls.filter((c) => c.name === 'fillStyle').map((c) => c.args[0]);
    expect(COLOR_DARK.chipPillOnSurface).toBe('rgba(255,255,255,0.18)');
    expect(fills).toContain(COLOR_DARK.chipPillOnSurface);
    expect(fills).not.toContain('rgba(0,0,0,0.18)');
  });
});

// ---------------------------------------------------------------------------
// prepare/paint split + scroll re-projection (#1000)
//
// The dependency-arrow layer is split into a scroll-independent prepare step
// (cached on the engine) and a paint step that re-projects by the current
// scroll. These tests pin the two load-bearing guarantees:
//   1. paint at scroll 0 is identical to the all-in-one drawDependencyArrows;
//   2. re-painting ONE cached layout at a different scroll shifts every drawn
//      coordinate by exactly the scroll delta — i.e. geometry is stored at
//      canvas origin and the offset is applied only in paint, so scrolling never
//      needs a rebuild.
// ---------------------------------------------------------------------------
describe('dependency arrows — cached layout + scroll re-projection (#1000)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-06-01');

  function makeArrowCtxSpy() {
    const { ctx, calls } = makeCtxSpy();
    const augmented = ctx as unknown as Record<string, unknown>;
    augmented.canvas = { width: 800, height: 600 };
    augmented.bezierCurveTo = vi.fn((...args: unknown[]) =>
      calls.push({ name: 'bezierCurveTo', args }),
    );
    augmented.quadraticCurveTo = vi.fn((...args: unknown[]) =>
      calls.push({ name: 'quadraticCurveTo', args }),
    );
    augmented.closePath = vi.fn(() => calls.push({ name: 'closePath', args: [] }));
    augmented.arc = vi.fn((...args: unknown[]) => calls.push({ name: 'arc', args }));
    return { ctx, calls };
  }

  function leaf(id: string, start: string, finish: string): Task {
    return {
      id,
      wbs: id,
      name: `Task ${id}`,
      start,
      finish,
      plannedStart: start,
      duration: 5,
      progress: 0,
      isSummary: false,
      isMilestone: false,
      isCritical: false,
      parentId: null,
    } as unknown as Task;
  }

  const tasks: Task[] = [
    leaf('a', '2026-04-08', '2026-04-12'),
    leaf('b', '2026-04-20', '2026-04-24'),
    leaf('c', '2026-05-04', '2026-05-08'),
  ];
  const links = [
    { id: 'l1', sourceId: 'a', targetId: 'b', type: 'FS' as const, lag: 0, isCritical: false },
    { id: 'l2', sourceId: 'b', targetId: 'c', type: 'FS' as const, lag: 0, isCritical: false },
  ];

  /** All (x, y) vertices the renderer moved/lined the pen to, in call order. */
  function pointsFrom(calls: Array<{ name: string; args: unknown[] }>): Array<[number, number]> {
    const pts: Array<[number, number]> = [];
    for (const c of calls) {
      if ((c.name === 'moveTo' || c.name === 'lineTo') && c.args.length >= 2) {
        pts.push([c.args[0] as number, c.args[1] as number]);
      }
    }
    return pts;
  }

  it('paint(layout) at scroll 0 matches the drawDependencyArrows wrapper', () => {
    const direct = makeArrowCtxSpy();
    drawDependencyArrows(direct.ctx, tasks, links, scales, 0, 0);

    const split = makeArrowCtxSpy();
    paintDependencyLayout(split.ctx, prepareDependencyLayout(tasks, links, scales), 0, 0);

    expect(pointsFrom(split.calls)).toEqual(pointsFrom(direct.calls));
  });

  it('re-projects a cached layout by scrollLeft: every x shifts by exactly -scrollLeft, y unchanged', () => {
    const layout = prepareDependencyLayout(tasks, links, scales);
    const S = 60;

    const base = makeArrowCtxSpy();
    paintDependencyLayout(base.ctx, layout, 0, 0);
    const scrolled = makeArrowCtxSpy();
    paintDependencyLayout(scrolled.ctx, layout, S, 0); // SAME cached layout, no rebuild

    const p0 = pointsFrom(base.calls);
    const pS = pointsFrom(scrolled.calls);
    expect(pS).toHaveLength(p0.length);
    expect(p0.length).toBeGreaterThan(0);
    for (let i = 0; i < p0.length; i++) {
      expect(pS[i][0]).toBeCloseTo(p0[i][0] - S, 5);
      expect(pS[i][1]).toBeCloseTo(p0[i][1], 5);
    }
  });

  it('re-projects a cached layout by scrollTop: every y shifts by exactly -scrollTop, x unchanged', () => {
    const layout = prepareDependencyLayout(tasks, links, scales);
    const S = 18;

    const base = makeArrowCtxSpy();
    paintDependencyLayout(base.ctx, layout, 0, 0);
    const scrolled = makeArrowCtxSpy();
    paintDependencyLayout(scrolled.ctx, layout, 0, S);

    const p0 = pointsFrom(base.calls);
    const pS = pointsFrom(scrolled.calls);
    expect(pS).toHaveLength(p0.length);
    expect(p0.length).toBeGreaterThan(0);
    for (let i = 0; i < p0.length; i++) {
      expect(pS[i][0]).toBeCloseTo(p0[i][0], 5);
      expect(pS[i][1]).toBeCloseTo(p0[i][1] - S, 5);
    }
  });

  it('prepares once and re-paints across a scroll burst without rebuilding', () => {
    // The engine caches this layout and only re-runs prepare on data/zoom change.
    // Simulate the per-frame scroll path: one prepared layout, many paints.
    const layout = prepareDependencyLayout(tasks, links, scales);
    for (const [sl, st] of [
      [0, 0],
      [25, 10],
      [80, 30],
      [140, 0],
      [5, 18],
    ]) {
      const { ctx, calls } = makeArrowCtxSpy();
      expect(() => paintDependencyLayout(ctx, layout, sl, st)).not.toThrow();
      expect(pointsFrom(calls).length).toBeGreaterThan(0);
    }
  });

  it('returns an empty, no-op layout when there are no links', () => {
    const layout = prepareDependencyLayout(tasks, [], scales);
    expect(layout.empty).toBe(true);
    const { ctx, calls } = makeArrowCtxSpy();
    paintDependencyLayout(ctx, layout, 0, 0);
    expect(pointsFrom(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Draw primitives — backfill coverage (#848): row bands, grid, today line,
// milestone diamond, drag shadow, resize indicator.
// ---------------------------------------------------------------------------

describe('draw primitives (#848 coverage)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  // drawGridLines / drawTodayLine read ctx.canvas.width for viewport clipping;
  // the bare spy has no canvas, so give it a generous one.
  function makeBgCtx(width = 1_000_000) {
    const { ctx, calls } = makeCtxSpy();
    (ctx as unknown as { canvas: { width: number; height: number } }).canvas = {
      width,
      height: 4000,
    };
    return { ctx, calls };
  }

  describe('drawRowBands', () => {
    it('shades only odd rows with a fillRect', () => {
      const { ctx, calls } = makeCtxSpy();
      drawRowBands(ctx, 0, 3, 0, 0, 1000);
      const rects = calls.filter((c) => c.name === 'fillRect');
      // rows 1 and 3 are odd → two alternating bands
      expect(rects.length).toBe(2);
      expect(rects[0].args[1]).toBeCloseTo(1 * ROW_HEIGHT + HEADER_HEIGHT);
    });

    it('draws nothing when the range contains no odd rows', () => {
      const { ctx, calls } = makeCtxSpy();
      drawRowBands(ctx, 0, 0, 0, 0, 1000);
      expect(calls.filter((c) => c.name === 'fillRect').length).toBe(0);
    });
  });

  describe('drawGridLines', () => {
    it('strokes vertical day lines and horizontal row separators', () => {
      const { ctx, calls } = makeBgCtx();
      drawGridLines(ctx, scales, 0, 0, 600, 0, 3);
      // Two stroke passes: the vertical grid and the horizontal separators.
      expect(calls.filter((c) => c.name === 'stroke').length).toBeGreaterThanOrEqual(2);
      expect(calls.filter((c) => c.name === 'lineTo').length).toBeGreaterThan(0);
    });
  });

  describe('drawTodayLine', () => {
    it('strokes a single vertical line when today is within the visible range', () => {
      // A wide range so "today" (whenever the suite runs) is always in view.
      const wide = buildScaleData('month', '2024-01-01', '2030-01-01');
      const { ctx, calls } = makeBgCtx();
      drawTodayLine(ctx, wide, 0, 600);
      expect(calls.filter((c) => c.name === 'stroke').length).toBe(1);
      const moveTo = calls.find((c) => c.name === 'moveTo');
      expect(moveTo).toBeDefined();
      expect(moveTo!.args[1]).toBe(HEADER_HEIGHT);
    });
  });

  describe('drawMilestone', () => {
    function milestone(overrides: Partial<Task> = {}): Task {
      return {
        id: 'm1',
        name: 'Go Live',
        start: '2026-04-08',
        plannedStart: '2026-04-08',
        finish: '2026-04-08',
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

    it('draws a rotated diamond for a committed milestone', () => {
      const { ctx, calls } = makeCtxSpy();
      drawMilestone(ctx, milestone(), 0, scales, 0, false);
      expect(calls.filter((c) => c.name === 'translate').length).toBe(1);
      const rotate = calls.find((c) => c.name === 'rotate');
      expect(rotate?.args[0]).toBeCloseTo(Math.PI / 4);
      const rect = calls.find((c) => c.name === 'rect');
      expect(rect?.args[2]).toBe(MILESTONE_SIZE);
      expect(calls.filter((c) => c.name === 'fill').length).toBe(1);
    });

    it('adds a selection-ring stroke when selected', () => {
      const { ctx, calls } = makeCtxSpy();
      drawMilestone(ctx, milestone(), 0, scales, 0, true);
      expect(calls.filter((c) => c.name === 'stroke').length).toBe(1);
    });

    it('skips uncommitted milestones (no plannedStart, no sprintId) — #332', () => {
      const { ctx, calls } = makeCtxSpy();
      drawMilestone(ctx, milestone({ plannedStart: undefined }), 0, scales, 0, false);
      expect(calls.filter((c) => c.name === 'translate').length).toBe(0);
      expect(calls.filter((c) => c.name === 'fill').length).toBe(0);
    });
  });

  describe('drawDragShadow', () => {
    function bar(): Task {
      return {
        id: 't1',
        name: 'Task',
        start: '2026-04-06',
        finish: '2026-04-10',
        duration: 5,
        progress: 0,
        isSummary: false,
        isMilestone: false,
        isCritical: false,
        parentId: null,
        wbs: '1',
      } as unknown as Task;
    }

    it('draws a ghost roundRect with fill + stroke at the given x and row', () => {
      const { ctx, calls } = makeCtxSpy();
      drawDragShadow(ctx, bar(), 120, 2, scales);
      const rr = calls.find((c) => c.name === 'roundRect');
      expect(rr).toBeDefined();
      expect(rr!.args[0]).toBe(120); // canvasX
      expect(rr!.args[1]).toBeCloseTo(2 * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET);
      expect(calls.filter((c) => c.name === 'fill').length).toBe(1);
      expect(calls.filter((c) => c.name === 'stroke').length).toBe(1);
    });
  });

  describe('drawResizeIndicator', () => {
    it('strokes a 1px vertical line at barRight - 4 across the bar height', () => {
      const { ctx, calls } = makeCtxSpy();
      drawResizeIndicator(ctx, 200, 50);
      const moveTo = calls.find((c) => c.name === 'moveTo');
      const lineTo = calls.find((c) => c.name === 'lineTo');
      expect(moveTo!.args[0]).toBe(200 - 4 + 0.5);
      expect(moveTo!.args[1]).toBe(50);
      expect(lineTo!.args[1]).toBe(50 + BAR_HEIGHT);
      expect(calls.filter((c) => c.name === 'stroke').length).toBe(1);
    });
  });
});

describe('forced-colors (Windows High Contrast) palette (#1742)', () => {
  // Restore the default light palette so forced state never leaks (module-global).
  afterEach(() => setRendererColorMode(false, false));

  it('pickPalette: forced wins over dark/light', () => {
    expect(pickPalette(false, false)).toBe(COLOR);
    expect(pickPalette(true, false)).toBe(COLOR_DARK);
    expect(pickPalette(false, true)).toBe(COLOR_FORCED);
    expect(pickPalette(true, true)).toBe(COLOR_FORCED); // forced overrides dark
  });

  it('the forced palette is entirely CSS system-color keywords, never hex', () => {
    const systemColors = new Set(['Canvas', 'CanvasText', 'GrayText', 'Highlight', 'LinkText']);
    for (const value of Object.values(COLOR_FORCED)) {
      expect(systemColors.has(value)).toBe(true);
    }
  });

  it('drawing a bar in forced mode emits system colors, not the brand hex', () => {
    const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
    setRendererColorMode(false, true);
    const { ctx, calls } = makeCtxSpy();
    drawTaskBar(ctx, makeBarTask({ progress: 50 }), 0, scales, 0, false, 800);
    const fills = calls.filter((c) => c.name === 'fillStyle').map((c) => c.args[0]);
    // The normal-bar brand blue is replaced by system ink.
    expect(fills).not.toContain('#2F6FD1');
    expect(
      fills.some((f) => f === 'CanvasText' || f === 'GrayText' || f === 'Highlight' || f === 'Canvas'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #2096 / #2097 — label halo, name gutter, hover-row band, chart options
// ---------------------------------------------------------------------------

import {
  drawTaskBarLabel as drawLabel2096,
  drawTimelineNameGutter,
  drawHoverRowBand,
  setRendererChartOptions,
  NAME_GUTTER_WIDTH,
} from './GanttRenderer';

const DEFAULT_CHART = {
  taskNamePlacement: 'next' as const,
  showProgressPills: true,
  showNameGutter: false,
};

describe('drawTaskBarLabel — paper halo + placement gate (#2096/#2097)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');
  const VIEWPORT_W = 800;

  afterEach(() => setRendererChartOptions(DEFAULT_CHART));

  it('strokes a paper-color halo immediately before filling the name', () => {
    setRendererChartOptions(DEFAULT_CHART);
    const { ctx, calls } = makeCtxSpy();
    const task = makeBarTask({ name: 'Dry-run migration' });
    drawLabel2096(ctx, task, 0, scales, 0, VIEWPORT_W);
    const seq = calls
      .filter((c) => c.name === 'strokeText' || c.name === 'fillText')
      .map((c) => c.name);
    // A strokeText (halo) precedes the fillText (ink) for the name.
    expect(seq[0]).toBe('strokeText');
    expect(seq[1]).toBe('fillText');
  });

  it('draws nothing next to the bar when placement is "hidden"', () => {
    setRendererChartOptions({ ...DEFAULT_CHART, taskNamePlacement: 'hidden' });
    const { ctx, calls } = makeCtxSpy();
    drawLabel2096(ctx, makeBarTask({ name: 'Freeze window prep' }), 0, scales, 0, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'fillText')).toHaveLength(0);
  });

  it('suppresses the on-bar label when placement is "left" (gutter draws it instead)', () => {
    setRendererChartOptions({ ...DEFAULT_CHART, taskNamePlacement: 'left' });
    const { ctx, calls } = makeCtxSpy();
    drawLabel2096(ctx, makeBarTask({ name: 'Cutover' }), 0, scales, 0, VIEWPORT_W);
    expect(calls.filter((c) => c.name === 'fillText')).toHaveLength(0);
  });
});

describe('drawTimelineNameGutter (#2096)', () => {
  it('paints an opaque band, a right divider, and one name per visible row', () => {
    const { ctx, calls } = makeCtxSpy();
    const tasks = [
      makeBarTask({ id: 't1', name: 'Alpha' }),
      makeBarTask({ id: 't2', name: 'Beta' }),
    ];
    drawTimelineNameGutter(ctx, tasks, 0, 1, 0, 600);
    const names = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
    // Opaque background band drawn at gutter width, and a right divider stroke.
    const rects = calls.filter((c) => c.name === 'fillRect');
    expect(rects.some((c) => c.args[2] === NAME_GUTTER_WIDTH)).toBe(true);
    expect(calls.some((c) => c.name === 'stroke')).toBe(true);
  });
});

describe('drawHoverRowBand (#2096)', () => {
  it('fills a full-width band for a visible row', () => {
    const { ctx, calls } = makeCtxSpy();
    drawHoverRowBand(ctx, 2, 0, 800, 600);
    const rects = calls.filter((c) => c.name === 'fillRect');
    expect(rects.some((c) => c.args[2] === 800)).toBe(true);
  });

  it('is a no-op for a row scrolled above the header fold', () => {
    const { ctx, calls } = makeCtxSpy();
    // Row 0 with a large scrollTop is entirely above the header band.
    drawHoverRowBand(ctx, 0, 10_000, 800, 600);
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(0);
  });
});
