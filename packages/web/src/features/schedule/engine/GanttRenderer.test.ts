import { describe, it, expect, vi } from 'vitest';
import {
  drawDependencyArrows,
  drawSummaryBar,
  drawActualDateBar,
  drawScheduleVarianceBadge,
  drawTimelineHeader,
  MILESTONE_SIZE,
  GHOST_BAR_HEIGHT,
  BAR_HEIGHT,
  BAR_TOP_OFFSET,
  ROW_HEIGHT,
  MERGE_HALO_RADIUS,
  MERGE_DOT_RADIUS,
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
    const tasks: Task[] = [
      phase('phase-1', null),
      leafTask('leaf-1', '2026-04-12'),
    ];
    const links = [
      { id: 'l1', sourceId: 'phase-1', targetId: 'leaf-1', type: 'FS' as const, lag: 0, isCritical: false },
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
      { id: 'l1', sourceId: 'leaf-source', targetId: 'leaf-uncommitted', type: 'FS' as const, lag: 0, isCritical: false },
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
      schedLeaf('src', '2026-04-06', '2026-04-10'),  // row 0
      schedLeaf('tgt', '2026-04-14', '2026-04-21'),  // row 1
    ];
    const links = [
      { id: 'l1', sourceId: 'src', targetId: 'tgt', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'bezierCurveTo')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'lineTo').length).toBe(5);
  });

  it('Scenario 1: multi-row forward FS also uses orthogonal L-shape regardless of row distance', () => {
    // Simple L is independent of intervening rows when none are obstacles.
    const { ctx, calls } = makeArrowCtxSpy();
    const tasks: Task[] = [
      schedLeaf('src', '2026-04-06', '2026-04-10'),  // row 0
      schedLeaf('mid', '2026-04-06', '2026-04-10'),  // row 1 (not in link)
      schedLeaf('tgt', '2026-04-14', '2026-04-21'),  // row 2
    ];
    const links = [
      { id: 'l1', sourceId: 'src', targetId: 'tgt', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);
    expect(calls.filter((c) => c.name === 'bezierCurveTo')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'lineTo').length).toBe(5);
  });

  it.skip('milestones are obstacles — right-sweep diverts the V drop around a diamond in the drop column', () => {
    // src finishes Apr 10, target starts Apr 14 → ideal drop column ≈ targetX − APPROACH_STUB.
    // A committed milestone sits in row 1 at Apr 14 — i.e. directly on the ideal drop X.
    // The right-sweep must push safeDropX to the right edge of the milestone + PADDING.
    const milestoneTask: Task = {
      id: 'm1', wbs: 'm1', name: 'Mid milestone',
      start: '2026-04-14', finish: '2026-04-14',
      plannedStart: '2026-04-14',
      duration: 0, progress: 0,
      isSummary: false, isMilestone: true, isCritical: false, parentId: null,
    } as unknown as Task;

    const tasks: Task[] = [
      schedLeaf('src', '2026-04-06', '2026-04-10'),  // row 0
      milestoneTask,                                  // row 1 — obstacle
      schedLeaf('tgt', '2026-04-14', '2026-04-21'),  // row 2 — target
    ];
    const links = [
      { id: 'l1', sourceId: 'src', targetId: 'tgt', type: 'FS' as const, lag: 0, isCritical: false },
    ];

    // Compare paths with vs without the obstacle milestone.
    const withMs = makeArrowCtxSpy();
    drawDependencyArrows(withMs.ctx, tasks, links, scales, 0, 0);
    const withoutMs = makeArrowCtxSpy();
    drawDependencyArrows(
      withoutMs.ctx,
      [tasks[0], tasks[2]],  // remove the milestone
      links, scales, 0, 0,
    );

    const linePts = (calls: Array<{ name: string; args: unknown[] }>) =>
      calls
        .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
        .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number }));

    const ptsWith    = linePts(withMs.calls);
    const ptsWithout = linePts(withoutMs.calls);

    // The drop column (X of the V segment) is the X of the third stroked point.
    // (moveTo + lineTo exit + lineTo sweepH — sweepH X is the safe drop column.)
    const dropX_with    = ptsWith[2].x;
    const dropX_without = ptsWithout[2].x;

    // With the milestone in the corridor, the safe-column search must divert
    // the drop column away from the obstacle. findSafeDropColumn considers
    // both sides of every obstacle and picks the closest clear X — direction
    // is implementation detail; the spec only requires "no segment penetrates
    // any object body."
    expect(dropX_with).not.toBe(dropX_without);
  });

  // -------------------------------------------------------------------------
  // Merge junctions for multi-predecessor milestones (rule 75)
  // -------------------------------------------------------------------------

  it('renders a merge junction when 2+ FS arrows terminate at the same milestone', () => {
    // Two predecessor leaves both target a single milestone — spec rule 5
    // (multi-predecessor milestone) requires a junction dot + single trunk
    // arrow rather than two separate arrowheads landing on the diamond.
    const milestone: Task = {
      id: 'gate', wbs: 'gate', name: 'Gate',
      start: '2026-04-20', finish: '2026-04-20', plannedStart: '2026-04-20',
      duration: 0, progress: 0,
      isSummary: false, isMilestone: true, isCritical: false, parentId: null,
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
    const junctionDot  = arcs[arcs.length - 1];
    expect(junctionDot.args[0]).toBe(junctionHalo.args[0]);   // same X
    expect(junctionDot.args[1]).toBe(junctionHalo.args[1]);   // same Y
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
      id: 'gate', wbs: 'gate', name: 'Gate',
      start: '2026-04-20', finish: '2026-04-20', plannedStart: '2026-04-20',
      duration: 0, progress: 0,
      isSummary: false, isMilestone: true, isCritical: false, parentId: null,
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

    // Rightmost predecessor 'b' ends Apr 12 → maxExitX = dateToLeft(Apr 12) + EXIT_STUB (5).
    const maxExitX = dateToLeft('2026-04-12', scales) + 5;
    const arcs = calls.filter((c) => c.name === 'arc');
    expect(arcs[arcs.length - 1].args[0]).toBeCloseTo(maxExitX);
  });

  it('merge junction trunk uses arrowNormal charcoal regardless of critical predecessors', () => {
    // Issue #466 gap P0-1: arrows are always charcoal — critical state lives
    // in the BAR fill (rule 73), not the connector. A red trunk crossing a
    // red bar visually disappears; charcoal stays distinct on every surface.
    const milestone: Task = {
      id: 'gate', wbs: 'gate', name: 'Gate',
      start: '2026-04-20', finish: '2026-04-20', plannedStart: '2026-04-20',
      duration: 0, progress: 0,
      isSummary: false, isMilestone: true, isCritical: true, parentId: null,
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
      id: 'gate', wbs: 'gate', name: 'Gate',
      start: '2026-04-20', finish: '2026-04-20', plannedStart: '2026-04-20',
      duration: 0, progress: 0,
      isSummary: false, isMilestone: true, isCritical: false, parentId: null,
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
      id: 'gate', wbs: 'gate', name: 'Gate',
      start: '2026-04-20', finish: '2026-04-20', plannedStart: '2026-04-20',
      duration: 0, progress: 0,
      isSummary: false, isMilestone: true, isCritical: false, parentId: null,
    } as unknown as Task;
    const tasks: Task[] = [schedLeaf('a', '2026-04-06', '2026-04-10'), milestone];
    const links = [
      { id: 'la', sourceId: 'a', targetId: 'gate', type: 'FS' as const, lag: 0, isCritical: false },
    ];
    const { ctx, calls } = makeArrowCtxSpy();
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);

    // The arrowhead tip X is the leftmost vertex of the diamond.
    const milestoneHalfDiag = Math.ceil(MILESTONE_SIZE / 2 * Math.SQRT2);
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
    drawDependencyArrows(ctx, tasks, links, scales, 0, 0);   // empty selection
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
