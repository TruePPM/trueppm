/**
 * Pure canvas draw functions for the TruePPM Gantt renderer.
 *
 * All functions are stateless: they accept a CanvasRenderingContext2D plus
 * data and return void. No React, no DOM queries, no side effects.
 *
 * Design rules enforced:
 * - Rule 59: draw functions target the correct canvas layer (bg / bars / ix)
 * - Rule 61: virtualisation — callers must pass firstRow/lastRow
 * - Rule 62: devicePixelRatio scaling applied once at canvas init; logical px here
 * - Rule 71: canvas font set once at engine init, not per draw call
 * - Rule 72: bar label text uses gantt-text-primary (#E8E8E8)
 * - Rule 73: critical path bars use gantt-semantic-critical (#F87171)
 * - Rule 74: weekend shading = rgba(255,255,255,0.03)
 * - Rule 75: dependency arrows are cubic Bézier, 40px control offsets, 1.5px
 */

import type { Task, TaskLink } from '@/types';
import type { GanttScaleData } from './GanttScaleData';
import { dateToLeft, parseUTCDate } from './GanttScaleData';

// ---------------------------------------------------------------------------
// Constants (exported — used by GanttEngineImpl and GanttHitIndex)
// ---------------------------------------------------------------------------

export const ROW_HEIGHT = 28;
export const BAR_TOP_OFFSET = 5;
export const BAR_HEIGHT = 18;
export const SUMMARY_BAR_HEIGHT = 8;
export const MILESTONE_SIZE = 12;
export const CANVAS_FONT = '12px Inter, system-ui, sans-serif';

// ---------------------------------------------------------------------------
// Color palette (rule 72/73: dark-surface tokens only — no Tailwind classes)
// ---------------------------------------------------------------------------

export const COLOR = {
  surface:        '#0F1117',
  rowBandAlt:     'rgba(255,255,255,0.02)',
  weekend:        'rgba(255,255,255,0.03)',
  gridLine:       'rgba(255,255,255,0.06)',
  todayLine:      '#1C6B3A',
  text:           '#E8E8E8',
  textSecondary:  'rgba(148,163,184,1.0)',
  barNormal:      '#3B82F6',   // blue-500 — non-CP task
  barCritical:    '#F87171',   // red-400 — gantt-semantic-critical (rule 73)
  barComplete:    '#4ADE80',   // green-400 — gantt-semantic-on-track
  barSummary:     '#6B7280',   // gray-500
  milestone:      '#E8A020',   // brand-accent
  arrowNormal:    'rgba(148,163,184,0.6)',
  arrowCritical:  '#F87171',
  selectionRing:  '#FFFFFF',
  ghostFill:      'rgba(100,116,139,0.12)',
  ghostBorder:    'rgba(100,116,139,0.55)',
} as const;

// ---------------------------------------------------------------------------
// Helper: is a UTC date a weekend?
// ---------------------------------------------------------------------------

function isWeekend(date: Date): boolean {
  const dow = date.getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// Draw: background layer
// ---------------------------------------------------------------------------

/**
 * Draw alternating row bands for the given visible row range.
 * Called on canvas-bg; only odd rows get the alt shade.
 */
export function drawRowBands(
  ctx: CanvasRenderingContext2D,
  firstRow: number,
  lastRow: number,
  scrollLeft: number,
  canvasWidth: number,
): void {
  for (let i = firstRow; i <= lastRow; i++) {
    if (i % 2 !== 0) {
      ctx.fillStyle = COLOR.rowBandAlt;
      ctx.fillRect(0, i * ROW_HEIGHT - 0, canvasWidth + scrollLeft, ROW_HEIGHT);
    }
  }
}

/**
 * Draw vertical grid lines aligned to scale minor ticks, plus horizontal row
 * separators for the visible range.
 *
 * Called on canvas-bg.
 */
export function drawGridLines(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  canvasHeight: number,
  firstRow: number,
  lastRow: number,
): void {
  ctx.strokeStyle = COLOR.gridLine;
  ctx.lineWidth = 1;

  // Vertical lines: walk from scales.start to scales.end in 1-day steps.
  // For large zoom levels this is O(days in range) which is fine for phase 1.
  const startMs = scales.start.getTime();
  const endMs = scales.end.getTime();
  const dayMs = 86_400_000;

  ctx.beginPath();
  let ms = startMs;
  while (ms <= endMs) {
    const x = (ms - startMs) * scales.pxPerMs - scrollLeft;
    if (x >= -1 && x <= ctx.canvas.width / (window.devicePixelRatio || 1) + 1) {
      const date = new Date(ms);
      // Weekend shading (rule 74) — draw on bg canvas
      if (isWeekend(date)) {
        const dayWidth = dayMs * scales.pxPerMs;
        ctx.fillStyle = COLOR.weekend;
        ctx.fillRect(x, 0, dayWidth, canvasHeight + scrollTop);
      }
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, canvasHeight + scrollTop);
    }
    ms += dayMs;
  }
  ctx.stroke();

  // Horizontal row separators
  ctx.beginPath();
  ctx.strokeStyle = COLOR.gridLine;
  for (let i = firstRow; i <= lastRow + 1; i++) {
    const y = i * ROW_HEIGHT - scrollTop + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(ctx.canvas.width / (window.devicePixelRatio || 1), y);
  }
  ctx.stroke();
}

/**
 * Draw the "today" vertical line on canvas-bg.
 * Uses the gantt-semantic-on-track green (#1C6B3A) at full height.
 */
export function drawTodayLine(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  canvasHeight: number,
): void {
  const today = new Date().toISOString().slice(0, 10);
  const x = dateToLeft(today, scales) - scrollLeft;

  if (x < -2 || x > ctx.canvas.width / (window.devicePixelRatio || 1) + 2) return;

  ctx.save();
  ctx.strokeStyle = COLOR.todayLine;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, canvasHeight);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw: task bars layer
// ---------------------------------------------------------------------------

/** Choose bar fill color based on task state. */
function barFillColor(task: Task): string {
  if (task.isSummary) return COLOR.barSummary;
  if (task.isComplete || task.progress >= 100) return COLOR.barComplete;
  if (task.isCritical) return COLOR.barCritical;
  return COLOR.barNormal;
}

/**
 * Draw a normal (non-summary, non-milestone) task bar on canvas-bars.
 * Clips the label text to the bar width.
 */
export function drawTaskBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
): void {
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const barTop = rowIndex * ROW_HEIGHT + BAR_TOP_OFFSET;

  const fill = barFillColor(task);

  // Bar fill
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.fill();

  // Selection: 2px white inset stroke
  if (isSelected) {
    ctx.strokeStyle = COLOR.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barLeft + 1, barTop + 1, barWidth - 2, BAR_HEIGHT - 2, 2);
    ctx.stroke();
  }

  // Progress fill overlay (darker tint at 30% opacity for progress indication)
  if (task.progress > 0 && task.progress < 100) {
    const progressWidth = barWidth * (task.progress / 100);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(barLeft + progressWidth, barTop, barWidth - progressWidth, BAR_HEIGHT, [0, 3, 3, 0]);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Label — clipped to bar bounds (rule 72: #E8E8E8 on dark surface)
  ctx.font = CANVAS_FONT;
  ctx.fillStyle = COLOR.text;
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  ctx.rect(barLeft, barTop, barWidth, BAR_HEIGHT);
  ctx.clip();
  ctx.fillText(task.name, barLeft + 11, barTop + BAR_HEIGHT / 2);

  ctx.restore();
}

/**
 * Draw a summary (parent) task bar — thinner, centered vertically, no label.
 * Uses a simpler bracket shape at reduced height.
 */
export function drawSummaryBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
): void {
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  // Center the 8px summary bar vertically in the 28px row
  const barTop = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - SUMMARY_BAR_HEIGHT) / 2;

  ctx.save();
  ctx.fillStyle = COLOR.barSummary;
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, SUMMARY_BAR_HEIGHT, 2);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = COLOR.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barLeft + 1, barTop + 1, barWidth - 2, SUMMARY_BAR_HEIGHT - 2, 1);
    ctx.stroke();
  }

  // Hanging end-caps (bracket tails)
  const capHeight = 5;
  ctx.fillStyle = COLOR.barSummary;
  ctx.fillRect(barLeft, barTop, 3, capHeight + SUMMARY_BAR_HEIGHT);
  ctx.fillRect(barRight - 3, barTop, 3, capHeight + SUMMARY_BAR_HEIGHT);

  ctx.restore();
}

/**
 * Draw a milestone diamond on canvas-bars.
 * A diamond is a 45°-rotated square of size MILESTONE_SIZE.
 */
export function drawMilestone(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
): void {
  const centerX = dateToLeft(task.start, scales) - scrollLeft;
  const centerY = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const half = MILESTONE_SIZE / 2;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(Math.PI / 4);

  ctx.fillStyle = COLOR.milestone;
  ctx.beginPath();
  ctx.rect(-half, -half, MILESTONE_SIZE, MILESTONE_SIZE);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = COLOR.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-half + 1, -half + 1, MILESTONE_SIZE - 2, MILESTONE_SIZE - 2);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draw all FS dependency arrows for the visible task set.
 * Critical-path arrows (both tasks isCritical) use arrowCritical stroke.
 */
export function drawDependencyArrows(
  ctx: CanvasRenderingContext2D,
  tasks: Task[],
  links: TaskLink[],
  scales: GanttScaleData,
  scrollLeft: number,
): void {
  if (links.length === 0) return;

  // Build a quick lookup: taskId → { rowIndex, barLeft, barRight }
  const taskMap = new Map<string, { rowIndex: number; barLeft: number; barRight: number; isCritical: boolean }>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    taskMap.set(t.id, {
      rowIndex: i,
      barLeft: dateToLeft(t.start, scales) - scrollLeft,
      barRight: dateToLeft(t.finish, scales) - scrollLeft,
      isCritical: t.isCritical,
    });
  }

  const cpWidth = ctx.canvas.width / (window.devicePixelRatio || 1);
  const cpHeight = ctx.canvas.height / (window.devicePixelRatio || 1);

  for (const link of links) {
    // Only FS links in phase 1
    if (link.type !== 'FS') continue;

    const src = taskMap.get(link.sourceId);
    const tgt = taskMap.get(link.targetId);
    if (!src || !tgt) continue;

    const x1 = src.barRight;
    const y1 = src.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = tgt.barLeft;
    const y2 = tgt.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;

    // Skip if entirely off-screen
    if (
      (x1 < -10 && x2 < -10) ||
      (x1 > cpWidth + 10 && x2 > cpWidth + 10) ||
      (y1 < -10 && y2 < -10) ||
      (y1 > cpHeight + 10 && y2 > cpHeight + 10)
    ) {
      continue;
    }

    const isCriticalArrow = src.isCritical && tgt.isCritical;
    const stroke = isCriticalArrow ? COLOR.arrowCritical : COLOR.arrowNormal;

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    // Cubic Bézier: 40px horizontal control point offset (rule 75)
    const cx1 = x1 + 40;
    const cx2 = x2 - 40;
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cx1, y1, cx2, y2, x2, y2);
    ctx.stroke();

    // Arrowhead at target (x2, y2) pointing left
    const arrowSize = 6;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - arrowSize * Math.cos(angle - 0.4), y2 - arrowSize * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - arrowSize * Math.cos(angle + 0.4), y2 - arrowSize * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Draw: interaction layer
// ---------------------------------------------------------------------------

/**
 * Draw a translucent drag shadow bar at the given canvas x position.
 * Rendered on canvas-interaction; cleared between frames (rule 59).
 */
export function drawDragShadow(
  ctx: CanvasRenderingContext2D,
  task: Task,
  canvasX: number,
  rowIndex: number,
  scales: GanttScaleData,
): void {
  const duration = parseUTCDate(task.finish).getTime() - parseUTCDate(task.start).getTime();
  const barWidth = Math.max(2, duration * scales.pxPerMs);
  const barTop = rowIndex * ROW_HEIGHT + BAR_TOP_OFFSET;

  ctx.save();
  ctx.fillStyle = COLOR.ghostFill;
  ctx.strokeStyle = COLOR.ghostBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(canvasX, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the resize handle indicator: a 1px vertical line at barRight - 4,
 * full bar height, using textSecondary color.
 *
 * Rendered on canvas-interaction; WCAG 1.4.11 compliant (rule 85).
 */
export function drawResizeIndicator(
  ctx: CanvasRenderingContext2D,
  barRight: number,
  barTop: number,
): void {
  const x = barRight - 4;
  ctx.save();
  ctx.strokeStyle = COLOR.textSecondary;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, barTop);
  ctx.lineTo(x + 0.5, barTop + BAR_HEIGHT);
  ctx.stroke();
  ctx.restore();
}
