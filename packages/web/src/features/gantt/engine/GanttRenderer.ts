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
 * - Bar label text uses neutral-text-primary (#1A1917) on light surface
 * - Critical path bars use semantic-critical (#B91C1C) on light surface
 * - Rule 74: weekend shading = rgba(255,255,255,0.03)
 * - Rule 75: dependency arrows are cubic Bézier, 40px control offsets, 1.5px
 */

import type { Task, TaskLink } from '@/types';
import type { GanttScaleData } from './GanttScaleData';
import { ZOOM_CONFIGS, dateToLeft, parseUTCDate } from './GanttScaleData';
import { HEADER_HEIGHT } from '../ganttConstants';

// ---------------------------------------------------------------------------
// Constants (exported — used by GanttEngineImpl and GanttHitIndex)
// ---------------------------------------------------------------------------

export const ROW_HEIGHT = 28;
export const BAR_TOP_OFFSET = 5;
export const BAR_HEIGHT = 18;
export const SUMMARY_BAR_HEIGHT = 8;
export const MILESTONE_SIZE = 12;
/** Baseline ghost bar and actual-date overlay height (rule 14). */
export const GHOST_BAR_HEIGHT = 6;
export const CANVAS_FONT = '12px Inter, system-ui, sans-serif';

/** Extract initials from a full name (e.g. "Jane Smith" → "JS"). */
function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Height of the major label row inside the HEADER_HEIGHT band. */
const HEADER_MAJOR_HEIGHT = 14;
/** Height of the minor label row inside the HEADER_HEIGHT band. */
const HEADER_MINOR_HEIGHT = 14;

// ---------------------------------------------------------------------------
// Color palette — light surface (neutral-surface #FFFFFF / neutral-surface-raised #F5F5F0)
// ---------------------------------------------------------------------------

export const COLOR = {
  surface:        '#FFFFFF',
  rowBandAlt:     'rgba(0,0,0,0.02)',
  weekend:        'rgba(0,0,0,0.03)',
  gridLine:       'rgba(0,0,0,0.08)',
  todayLine:      '#1C6B3A',
  text:           '#1A1917',   // neutral-text-primary — dark text on light surface
  textSecondary:  '#6B6965',   // neutral-text-secondary
  barNormal:      '#3B82F6',   // blue-500 — non-CP task
  barCritical:    '#B91C1C',   // semantic-critical — dark red, WCAG on light surface
  barComplete:    '#166534',   // semantic-on-track — dark green
  barSummary:     '#374151',   // gray-700 — visible on white
  milestone:      '#E8A020',   // brand-accent
  arrowNormal:    'rgba(107,105,101,0.6)',   // neutral-text-secondary based
  arrowCritical:  '#B91C1C',
  selectionRing:  '#1C6B3A',   // brand-primary
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
 * All y-coordinates are viewport-relative: subtract scrollTop from content y.
 */
export function drawRowBands(
  ctx: CanvasRenderingContext2D,
  firstRow: number,
  lastRow: number,
  scrollLeft: number,
  scrollTop: number,
  canvasWidth: number,
): void {
  for (let i = firstRow; i <= lastRow; i++) {
    if (i % 2 !== 0) {
      ctx.fillStyle = COLOR.rowBandAlt;
      ctx.fillRect(0, i * ROW_HEIGHT + HEADER_HEIGHT - scrollTop, canvasWidth + scrollLeft, ROW_HEIGHT);
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
      // Weekend shading (rule 74) — draw on bg canvas, below the header
      if (isWeekend(date)) {
        const dayWidth = dayMs * scales.pxPerMs;
        ctx.fillStyle = COLOR.weekend;
        ctx.fillRect(x, HEADER_HEIGHT, dayWidth, canvasHeight + scrollTop - HEADER_HEIGHT);
      }
      ctx.moveTo(x + 0.5, HEADER_HEIGHT);
      ctx.lineTo(x + 0.5, canvasHeight + scrollTop);
    }
    ms += dayMs;
  }
  ctx.stroke();

  // Horizontal row separators
  ctx.beginPath();
  ctx.strokeStyle = COLOR.gridLine;
  for (let i = firstRow; i <= lastRow + 1; i++) {
    const y = i * ROW_HEIGHT + HEADER_HEIGHT - scrollTop + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(ctx.canvas.width / (window.devicePixelRatio || 1), y);
  }
  ctx.stroke();
}

/**
 * Draw the "today" vertical line on canvas-bg.
 * Uses brand-primary green (#1C6B3A) at full height.
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
  ctx.moveTo(x + 0.5, HEADER_HEIGHT);
  ctx.lineTo(x + 0.5, canvasHeight);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw: timeline date header
// ---------------------------------------------------------------------------

/**
 * Return a stable string key for the major or minor unit that contains `date`.
 * Used to detect unit-boundary transitions when walking the date range.
 */
function getUnitKey(
  date: Date,
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year',
): string {
  switch (unit) {
    case 'day':
      return date.toISOString().slice(0, 10);
    case 'week': {
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      return `${d.getUTCFullYear()}-W${weekNo}`;
    }
    case 'month':
      return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    case 'quarter':
      return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3)}`;
    case 'year':
      return `${date.getUTCFullYear()}`;
  }
}

/** Draw a single header cell (label + left border) clipped to its bounds. */
function drawHeaderCell(
  ctx: CanvasRenderingContext2D,
  label: string,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
): void {
  if (cellWidth < 4) return;

  // Left separator
  ctx.strokeStyle = COLOR.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.floor(cellX) + 0.5, cellY);
  ctx.lineTo(Math.floor(cellX) + 0.5, cellY + cellHeight);
  ctx.stroke();

  // Label text, clipped to the cell.
  // Pin the text x to Math.max(cellX + 6, 4) so the label remains visible when
  // the cell's left boundary has scrolled off-screen (e.g. viewing mid-April
  // when the April header cell started at canvas-origin position to the left of
  // the current viewport). This is the standard "sticky label" Gantt pattern.
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX + 4, cellY, Math.max(0, cellWidth - 4), cellHeight);
  ctx.clip();
  ctx.fillStyle = COLOR.textSecondary;
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, Math.max(cellX + 6, 4), cellY + cellHeight / 2);
  ctx.restore();
}

/**
 * Draw the two-row timeline header at y = 0..HEADER_HEIGHT on canvas-bg.
 * Top row: major unit (month, quarter, or year).
 * Bottom row: minor unit (day, week, month, quarter, or year).
 *
 * Called on every full repaint of canvas-bg, after row bands and grid lines
 * so it paints over any content that overflowed into the header area.
 */
export function drawTimelineHeader(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  canvasWidth: number,
): void {
  const cfg = ZOOM_CONFIGS[scales.zoomLevel];
  const dayMs = 86_400_000;
  const startMs = scales.start.getTime();
  const endMs = scales.end.getTime();

  // Opaque background covers any row bands that reached the header area
  ctx.fillStyle = COLOR.surface;
  ctx.fillRect(0, 0, canvasWidth, HEADER_HEIGHT);

  // Bottom border separating header from task area
  ctx.strokeStyle = COLOR.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT - 0.5);
  ctx.lineTo(canvasWidth, HEADER_HEIGHT - 0.5);
  ctx.stroke();

  // --- Major row (top half) ---
  {
    let prevKey = '';
    let cellStartCanvasX = 0;
    let cellStartDate: Date | null = null;

    let ms = startMs;
    while (ms <= endMs + dayMs) {
      const date = new Date(ms);
      const key = getUnitKey(date, cfg.majorUnit);

      if (key !== prevKey) {
        if (cellStartDate !== null) {
          const canvasX = (ms - startMs) * scales.pxPerMs;
          const cellX = cellStartCanvasX - scrollLeft;
          const cellWidth = canvasX - scrollLeft - cellX;
          drawHeaderCell(ctx, cfg.majorFormat(cellStartDate), cellX, 0, cellWidth, HEADER_MAJOR_HEIGHT);
        }
        cellStartCanvasX = (ms - startMs) * scales.pxPerMs;
        cellStartDate = date;
        prevKey = key;
      }
      ms += dayMs;
    }
    // Flush last cell
    if (cellStartDate !== null) {
      const cellX = cellStartCanvasX - scrollLeft;
      const cellWidth = canvasWidth - cellX;
      drawHeaderCell(ctx, cfg.majorFormat(cellStartDate), cellX, 0, cellWidth, HEADER_MAJOR_HEIGHT);
    }
  }

  // --- Minor row (bottom half) ---
  {
    let prevKey = '';
    let cellStartCanvasX = 0;
    let cellStartDate: Date | null = null;

    let ms = startMs;
    while (ms <= endMs + dayMs) {
      const date = new Date(ms);
      const key = getUnitKey(date, cfg.minorUnit);

      if (key !== prevKey) {
        if (cellStartDate !== null) {
          const canvasX = (ms - startMs) * scales.pxPerMs;
          const cellX = cellStartCanvasX - scrollLeft;
          const cellWidth = canvasX - scrollLeft - cellX;
          drawHeaderCell(ctx, cfg.minorFormat(cellStartDate), cellX, HEADER_MAJOR_HEIGHT, cellWidth, HEADER_MINOR_HEIGHT);
        }
        cellStartCanvasX = (ms - startMs) * scales.pxPerMs;
        cellStartDate = date;
        prevKey = key;
      }
      ms += dayMs;
    }
    // Flush last cell
    if (cellStartDate !== null) {
      const cellX = cellStartCanvasX - scrollLeft;
      const cellWidth = canvasWidth - cellX;
      drawHeaderCell(ctx, cfg.minorFormat(cellStartDate), cellX, HEADER_MAJOR_HEIGHT, cellWidth, HEADER_MINOR_HEIGHT);
    }
  }
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
  // Defense-in-depth: _paintTaskAt already guards, but protect against direct callers too
  if (!task.start || !task.finish) return;
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

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

  // Assignee initials — right-aligned, only when bar is wide enough (>= 48px)
  if (barWidth >= 48 && task.assignees.length > 0) {
    const initials = getInitials(task.assignees[0].name);
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLOR.text;
    const textWidth = ctx.measureText(initials).width;
    ctx.fillText(initials, barLeft + barWidth - 4 - textWidth, barTop + BAR_HEIGHT / 2);
    ctx.font = CANVAS_FONT; // Reset to engine default (rule 71)
  }

  ctx.restore();
}

/**
 * Draw the actual-date overlay for a task that has been at least partially
 * executed (actualStart or actualFinish is set).
 *
 * Renders a 6px dashed bar at the bottom of the row (GHOST_BAR_HEIGHT, rule 14)
 * positioned below the planned bar.  Color:
 *   - Finished late (scheduleVarianceDays > 0) → semantic-critical (#B91C1C)
 *   - Finished early (scheduleVarianceDays < 0) → semantic-on-track (#166534)
 *   - In progress or no variance info        → ghostBorder (slate-500 @55%)
 *
 * Drawn on canvas-bars (rule 59) after the main bar so it appears on top.
 * Callers must translate(0, -scrollTop) before invoking.
 */
export function drawActualDateBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
): void {
  // Only render when execution has actually started (explicit actual dates required).
  if (!task.actualStart && !task.actualFinish) return;
  const drawStart = task.actualStart ?? task.start;
  const drawEnd = task.actualFinish ?? task.finish;

  const left = dateToLeft(drawStart, scales) - scrollLeft;
  const right = dateToLeft(drawEnd, scales) - scrollLeft;
  const width = Math.max(2, right - left);

  // Position: bottom of the planned bar (barTop + BAR_HEIGHT + 1px gap)
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
  const actualTop = barTop + BAR_HEIGHT + 1;

  const variance = task.scheduleVarianceDays ?? null;
  let color: string;
  if (variance !== null && variance > 0) {
    color = COLOR.barCritical;   // late — semantic-critical
  } else if (variance !== null && variance < 0) {
    color = COLOR.barComplete;   // early — semantic-on-track
  } else {
    color = COLOR.ghostBorder;   // in-progress or no variance info
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = GHOST_BAR_HEIGHT;
  ctx.lineCap = 'butt';
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(left, actualTop + GHOST_BAR_HEIGHT / 2);
  ctx.lineTo(left + width, actualTop + GHOST_BAR_HEIGHT / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw a schedule-variance badge to the right of the task bar when the task
 * has a non-zero scheduleVarianceDays value.
 *
 * Format: "+3d" (late) or "-2d" (early).  Positive = late (critical color),
 * negative = early (on-track color).  Badge only renders when the bar right
 * edge is within viewport (no off-screen labels).
 *
 * Drawn on canvas-bars after drawActualDateBar so the badge sits above the
 * overlay.  Callers must translate(0, -scrollTop) before invoking.
 */
export function drawScheduleVarianceBadge(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  viewportWidth: number,
): void {
  const variance = task.scheduleVarianceDays;
  if (variance === null || variance === undefined || variance === 0) return;

  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  if (barRight < 0 || barRight > viewportWidth) return;

  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
  const badgeY = barTop + BAR_HEIGHT / 2;
  const label = variance > 0 ? `+${variance}d` : `${variance}d`;
  const color = variance > 0 ? COLOR.barCritical : COLOR.barComplete;

  ctx.save();
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, barRight + 4, badgeY);
  ctx.font = CANVAS_FONT; // restore engine default (rule 71)
  ctx.restore();
}

/**
 * Draw a summary (parent) task bar — thinner, centered vertically, no label.
 * End-caps are filled diamonds matching the milestone diamond geometry
 * (rule 14: milestone = 12px), signalling the start/finish of a rollup span.
 */
export function drawSummaryBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
): void {
  if (!task.start || !task.finish) return;
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const rowCenterY = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;
  const barTop = rowCenterY - SUMMARY_BAR_HEIGHT / 2;

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

  // Diamond end-caps — same 45°-rotated square as drawMilestone, centered on
  // the bar midline at each end so the summary endpoints visually match
  // milestones on adjacent rows.
  const capHalf = MILESTONE_SIZE / 2;
  ctx.fillStyle = COLOR.barSummary;
  for (const centerX of [barLeft, barRight]) {
    ctx.save();
    ctx.translate(centerX, rowCenterY);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-capHalf, -capHalf, MILESTONE_SIZE, MILESTONE_SIZE);
    ctx.fill();
    ctx.restore();
  }

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
  if (!task.start) return;
  const centerX = dateToLeft(task.start, scales) - scrollLeft;
  const centerY = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;
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
 * Draw dependency arrows for all four link types (FS, SS, FF, SF).
 *
 * Anchor points and Bézier control-point offsets per type (rule 75 — 40px):
 *   FS  Finish → Start  : exits right from src finish, enters left  at tgt start
 *   SS  Start  → Start  : exits left  from src start,  enters left  at tgt start
 *   FF  Finish → Finish : exits right from src finish, enters right at tgt finish
 *   SF  Start  → Finish : exits left  from src start,  enters right at tgt finish
 *
 * Control points share the y-coordinate of their anchor so the curve exits and
 * enters horizontally (tangent is purely horizontal at both endpoints). This
 * means the arrowhead angle is always 0 (→) for FS/SS and π (←) for FF/SF.
 *
 * Critical-path arrows (both tasks isCritical) use arrowCritical stroke.
 */
export function drawDependencyArrows(
  ctx: CanvasRenderingContext2D,
  tasks: Task[],
  links: TaskLink[],
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
): void {
  if (links.length === 0) return;

  // Build a quick lookup: taskId → { rowIndex, barLeft, barRight }
  // Skip unscheduled tasks (empty start/finish) — NaN coordinates in the map
  // can cause degenerate Bézier paths or unexpected arrow rendering (#92).
  const taskMap = new Map<string, { rowIndex: number; barLeft: number; barRight: number; isCritical: boolean }>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;
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
    const src = taskMap.get(link.sourceId);
    const tgt = taskMap.get(link.targetId);
    if (!src || !tgt) continue;

    const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;

    // Compute anchor x-coords and Bézier control x-coords per dependency type.
    let x1: number, x2: number, cx1: number, cx2: number;
    switch (link.type) {
      case 'SS':
        // Start → Start: both anchors on left bar edge, loop out to the left
        x1 = src.barLeft;  x2 = tgt.barLeft;
        cx1 = x1 - 40;    cx2 = x2 - 40;
        break;
      case 'FF':
        // Finish → Finish: both anchors on right bar edge, loop out to the right
        x1 = src.barRight; x2 = tgt.barRight;
        cx1 = x1 + 40;    cx2 = x2 + 40;
        break;
      case 'SF':
        // Start → Finish: source exits left, target enters right
        x1 = src.barLeft;  x2 = tgt.barRight;
        cx1 = x1 - 40;    cx2 = x2 + 40;
        break;
      default: // 'FS'
        // Finish → Start: source exits right, target enters left (most common)
        x1 = src.barRight; x2 = tgt.barLeft;
        cx1 = x1 + 40;    cx2 = x2 - 40;
    }

    // Skip if entirely off-screen
    if (
      (x1 < -10 && x2 < -10) ||
      (x1 > cpWidth + 10 && x2 > cpWidth + 10) ||
      (srcY < -10 && tgtY < -10) ||
      (srcY > cpHeight + 10 && tgtY > cpHeight + 10)
    ) {
      continue;
    }

    const isCriticalArrow = src.isCritical && tgt.isCritical;
    const stroke = isCriticalArrow ? COLOR.arrowCritical : COLOR.arrowNormal;

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    // Cubic Bézier: control y-coords match anchor y-coords → horizontal entry/exit tangent (rule 75)
    ctx.moveTo(x1, srcY);
    ctx.bezierCurveTo(cx1, srcY, cx2, tgtY, x2, tgtY);
    ctx.stroke();

    // Arrowhead: tangent at t=1 is horizontal, so angle is atan2(0, x2 - cx2).
    // FS/SS: cx2 < x2  → angle = 0  → arrowhead points right (entering left edge)
    // FF/SF: cx2 > x2  → angle = π  → arrowhead points left  (entering right edge)
    const arrowSize = 6;
    const angle = Math.atan2(0, x2 - cx2);
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(x2, tgtY);
    ctx.lineTo(x2 - arrowSize * Math.cos(angle - 0.4), tgtY - arrowSize * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - arrowSize * Math.cos(angle + 0.4), tgtY - arrowSize * Math.sin(angle + 0.4));
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
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

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
