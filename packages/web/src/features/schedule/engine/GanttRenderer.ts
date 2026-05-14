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
 * - Rule 75: FS arrows use orthogonal elbow routing (12px exit, vertical drop, horizontal entry); SS/FF/SF use cubic Bézier
 */

import type { Task, TaskLink } from '@/types';
import type { GanttScaleData } from './GanttScaleData';
import { ZOOM_CONFIGS, dateToLeft, parseUTCDate } from './GanttScaleData';
import { todayISO } from '@/features/resource/resourceUtils';
import { HEADER_HEIGHT } from '../scheduleConstants';

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
/** Font used inside % completion chips — JetBrains Mono for tabular numerals. */
const CHIP_FONT = '11px "JetBrains Mono", monospace';

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
// Color palettes — light and dark surfaces.
// setRendererColorMode() switches the active palette before each paint pass.
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
  arrowNormal:    'rgba(107,105,101,0.85)',  // neutral-text-secondary based
  arrowCritical:  '#B91C1C',
  selectionRing:  '#1C6B3A',   // brand-primary
  ghostFill:      'rgba(100,116,139,0.12)',
  ghostBorder:    'rgba(100,116,139,0.55)',
  // Chip text tokens (ADR-0040 #212): named so a future high-contrast theme
  // can override them without touching draw call sites.
  chipTextOnCritical: '#FFFFFF',  // semantic-on-critical
  chipTextOnSurface:  '#FFFFFF',  // semantic-on-surface (white reads on every bar fill)
} as const;

/** Semantic type for the color palette. Both COLOR and COLOR_DARK satisfy this. */
export type ColorPalette = Record<keyof typeof COLOR, string>;

/** Dark-surface palette — light tokens for readability on neutral-surface dark (#12141E). */
export const COLOR_DARK: ColorPalette = {
  surface:        '#12141E',   // neutral-surface dark
  rowBandAlt:     'rgba(255,255,255,0.025)',
  weekend:        'rgba(255,255,255,0.03)',
  gridLine:       'rgba(255,255,255,0.08)',
  todayLine:      '#4ADE80',   // semantic-on-track dark — Green-400, 5.28:1 on #12141E
  text:           '#E8E8E8',   // neutral-text-primary dark
  textSecondary:  '#94A3B8',   // Slate-400 — neutral-text-secondary dark
  barNormal:      '#60A5FA',   // Blue-400 — readable on dark surface
  barCritical:    '#F87171',   // Red-400 — semantic-critical dark, 4.87:1 on #12141E
  barComplete:    '#4ADE80',   // Green-400 — semantic-on-track dark
  barSummary:     '#94A3B8',   // Slate-400
  milestone:      '#E8A020',   // brand-accent — unchanged
  arrowNormal:    'rgba(148,163,184,0.85)',  // Slate-400 based
  arrowCritical:  '#F87171',   // Red-400
  selectionRing:  '#4ADE80',   // Green-400, 5.28:1 on dark surface
  ghostFill:      'rgba(100,116,139,0.12)',
  ghostBorder:    'rgba(100,116,139,0.55)',
  chipTextOnCritical: '#FFFFFF',
  chipTextOnSurface:  '#FFFFFF',
};

// Active palette — swapped by GanttEngineImpl before each paint pass.
// Synchronous access only: set immediately before any draw call, never in async context.
let _palette: ColorPalette = COLOR;

/**
 * Switch the active color palette for all subsequent draw calls in the current pass.
 * Called by GanttEngineImpl at the start of each paint method.
 */
export function setRendererColorMode(dark: boolean): void {
  _palette = dark ? COLOR_DARK : COLOR;
}

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
      ctx.fillStyle = _palette.rowBandAlt;
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
  ctx.strokeStyle = _palette.gridLine;
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
        ctx.fillStyle = _palette.weekend;
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
  ctx.strokeStyle = _palette.gridLine;
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
  const today = todayISO();
  const x = dateToLeft(today, scales) - scrollLeft;

  if (x < -2 || x > ctx.canvas.width / (window.devicePixelRatio || 1) + 2) return;

  ctx.save();
  ctx.strokeStyle = _palette.todayLine;
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
  ctx.strokeStyle = _palette.gridLine;
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
  ctx.fillStyle = _palette.textSecondary;
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
  ctx.fillStyle = _palette.surface;
  ctx.fillRect(0, 0, canvasWidth, HEADER_HEIGHT);

  // Bottom border separating header from task area
  ctx.strokeStyle = _palette.gridLine;
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
  if (task.isSummary) return _palette.barSummary;
  if (task.isComplete || task.progress >= 100) return _palette.barComplete;
  if (task.isCritical) return _palette.barCritical;
  return _palette.barNormal;
}

/**
 * Draw a % completion chip inside a task bar (canvas-bars layer).
 *
 * Chip is left-anchored, clipped to bar bounds, and omitted when the bar is
 * narrower than 32px or when the task has 0% progress and is NOT_STARTED
 * (no useful signal to show).  The chip uses a translucent overlay so the bar
 * fill color reads through slightly.
 */
function drawTaskBarChip(
  ctx: CanvasRenderingContext2D,
  task: Task,
  barLeft: number,
  barTop: number,
  barWidth: number,
): void {
  const label = `${Math.round(task.progress)}%`;
  const chipPadX = 4;
  const chipH = 12;

  ctx.save();
  ctx.font = CHIP_FONT;
  const textW = ctx.measureText(label).width;
  const chipW = Math.max(28, textW + chipPadX * 2);
  const chipX = barLeft + 4;
  const chipY = barTop + (BAR_HEIGHT - chipH) / 2;

  // Clip chip rendering to bar bounds so it never overflows
  ctx.beginPath();
  ctx.rect(barLeft, barTop, barWidth, BAR_HEIGHT);
  ctx.clip();

  // Translucent white pill on critical bars; translucent dark pill on others
  const isCritical = task.isCritical && !task.isComplete;
  ctx.fillStyle = isCritical ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.roundRect(chipX, chipY, chipW, chipH, 3);
  ctx.fill();

  ctx.fillStyle = isCritical ? _palette.chipTextOnCritical : _palette.chipTextOnSurface;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, chipX + chipPadX, chipY + chipH / 2);

  ctx.restore();
}

/**
 * Draw a normal (non-summary, non-milestone) task bar on canvas-bars.
 *
 * Renders the bar fill, selection ring, progress overlay, % chip, and
 * assignee initials — everything that lives INSIDE the bar. The task name
 * is drawn separately by {@link drawTaskBarLabel} so the engine can layer
 * bars → arrows → labels. With the label baked in here, dependency arrows
 * (drawn afterward in `_paintAllBars`) crossed through the label text and
 * looked like a strikethrough — the arrow's horizontal exit segment runs
 * at row-center y, exactly where the label sits.
 *
 * Pass `skipLabel: false` when calling this in isolation (single-row
 * repaint, where no arrows are drawn anyway). The full-canvas paint pass
 * passes `skipLabel: true`, draws all arrows, then loops again to draw
 * labels on top via {@link drawTaskBarLabel}.
 *
 * @param viewportWidth - Logical-px viewport width, used to detect flush-right
 *   bars and fall back to rendering the name to the left of the bar start.
 * @param skipLabel - When true, the task name is NOT drawn. The caller is
 *   responsible for invoking {@link drawTaskBarLabel} after dependency
 *   arrows so labels render on top of crossing arrow lines.
 */
export function drawTaskBar(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  isSelected: boolean,
  viewportWidth: number,
  skipLabel = false,
): void {
  // Defense-in-depth: _paintTaskAt already guards, but protect against direct callers too
  if (!task.start || !task.finish) return;
  // Issue #332: do not render a bar when the PM has not committed dates.
  // CPM auto-fills early_start/early_finish for every dated task (so task.start
  // is non-null even for backlog ideas), and these tasks belong in the
  // Unscheduled gutter instead of on the timeline. Sprint membership counts
  // as a commitment.
  if (!task.plannedStart && !task.sprintId) return;
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

  const fill = barFillColor(task);

  // Bar fill + selection ring + progress overlay + chip + initials — all clipped work
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, BAR_HEIGHT, 3);
  ctx.fill();

  // Selection: 2px inset stroke ring
  if (isSelected) {
    ctx.strokeStyle = _palette.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barLeft + 1, barTop + 1, barWidth - 2, BAR_HEIGHT - 2, 2);
    ctx.stroke();
  }

  // Progress fill overlay (darker tint at 30% opacity on the unprogressed right portion)
  if (task.progress > 0 && task.progress < 100) {
    const progressWidth = barWidth * (task.progress / 100);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(barLeft + progressWidth, barTop, barWidth - progressWidth, BAR_HEIGHT, [0, 3, 3, 0]);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // % chip inside bar — omit for very narrow bars and for 0% NOT_STARTED tasks
  if (barWidth >= 32 && !(task.progress === 0 && task.status === 'NOT_STARTED')) {
    drawTaskBarChip(ctx, task, barLeft, barTop, barWidth);
  }

  // Assignee initials — right-aligned inside bar, only when bar is wide enough (>= 48px)
  if (barWidth >= 48 && task.assignees.length > 0) {
    ctx.beginPath();
    ctx.rect(barLeft, barTop, barWidth, BAR_HEIGHT);
    ctx.clip();
    const initials = getInitials(task.assignees[0].name);
    // Initials font matches rule 50 floor when scaled for canvas (rule 71 reset below).
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.fillStyle = _palette.chipTextOnSurface;
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(initials).width;
    ctx.fillText(initials, barLeft + barWidth - 4 - textWidth, barTop + BAR_HEIGHT / 2);
    ctx.font = CANVAS_FONT; // Reset to engine default (rule 71)
  }

  ctx.restore();

  if (!skipLabel) {
    drawTaskBarLabel(ctx, task, rowIndex, scales, scrollLeft, viewportWidth);
  }
}

/**
 * Draw the task name OUTSIDE the bar (rule 72 / #212).
 *
 * Primary: 4px right of bar end. Fallback: 4px left of bar start,
 * right-aligned, when the right-of-bar position would overflow the viewport.
 *
 * Extracted from {@link drawTaskBar} so the engine can layer
 * bars → arrows → labels. The horizontal exit segment of dependency arrows
 * runs at row-center y, which is exactly where the label sits — drawing
 * arrows on top of labels produced a strikethrough artifact. Always invoke
 * this AFTER `drawDependencyArrows` for the same row.
 */
export function drawTaskBarLabel(
  ctx: CanvasRenderingContext2D,
  task: Task,
  rowIndex: number,
  scales: GanttScaleData,
  scrollLeft: number,
  viewportWidth: number,
): void {
  if (!task.start || !task.finish) return;
  if (!task.plannedStart && !task.sprintId) return;
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;

  ctx.save();
  ctx.font = CANVAS_FONT;
  ctx.fillStyle = _palette.textSecondary;
  ctx.textBaseline = 'middle';
  const nameY = barTop + BAR_HEIGHT / 2;
  const nameWidth = ctx.measureText(task.name).width;
  const rightOfBar = barRight + 4;
  const nameRight = rightOfBar + nameWidth;

  if (nameRight <= viewportWidth - 8) {
    // Fits to the right — draw with a right-side clip to avoid overflowing viewport
    ctx.beginPath();
    ctx.rect(rightOfBar, barTop - 2, viewportWidth - rightOfBar - 4, BAR_HEIGHT + 4);
    ctx.clip();
    ctx.fillText(task.name, rightOfBar, nameY);
  } else {
    // Flush right — draw left of the bar start, right-aligned
    const leftX = barLeft - 4 - nameWidth;
    if (leftX >= 0) {
      ctx.fillText(task.name, leftX, nameY);
    }
    // If the bar is also flush left, the name is silently omitted — bar is too
    // wide for any label to fit. Acceptable at extreme zoom-out levels.
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
    color = _palette.barCritical;   // late — semantic-critical
  } else if (variance !== null && variance < 0) {
    color = _palette.barComplete;   // early — semantic-on-track
  } else {
    color = _palette.ghostBorder;   // in-progress or no variance info
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
  const color = variance > 0 ? _palette.barCritical : _palette.barComplete;

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
  // The original #332 fix gated summaries on `plannedStart || sprintId`, the
  // same heuristic used for leaf tasks. That was incorrect for summaries: a
  // PM never sets `planned_start` on a phase row — its dates are CPM rollups
  // from children, and dropping the bar whenever the *phase itself* is
  // uncommitted hid every phase rollup whose children were committed.
  // Summaries should render whenever CPM has produced rollup dates; the
  // `!task.start || !task.finish` guard above already covers the "no
  // children scheduled yet, rollup empty" case.
  const barLeft = dateToLeft(task.start, scales) - scrollLeft;
  const barRight = dateToLeft(task.finish, scales) - scrollLeft;
  const barWidth = Math.max(2, barRight - barLeft);
  const rowCenterY = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;
  const barTop = rowCenterY - SUMMARY_BAR_HEIGHT / 2;

  ctx.save();
  ctx.fillStyle = _palette.barSummary;
  ctx.beginPath();
  ctx.roundRect(barLeft, barTop, barWidth, SUMMARY_BAR_HEIGHT, 2);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = _palette.selectionRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barLeft + 1, barTop + 1, barWidth - 2, SUMMARY_BAR_HEIGHT - 2, 1);
    ctx.stroke();
  }

  // Diamond end-caps — same 45°-rotated square as drawMilestone, centered on
  // the bar midline at each end so the summary endpoints visually match
  // milestones on adjacent rows.
  const capHalf = MILESTONE_SIZE / 2;
  ctx.fillStyle = _palette.barSummary;
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
  // Issue #332: skip uncommitted milestones — same gate as drawTaskBar.
  if (!task.plannedStart && !task.sprintId) return;
  const centerX = dateToLeft(task.start, scales) - scrollLeft;
  const centerY = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2;
  const half = MILESTONE_SIZE / 2;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(Math.PI / 4);

  ctx.fillStyle = _palette.milestone;
  ctx.beginPath();
  ctx.rect(-half, -half, MILESTONE_SIZE, MILESTONE_SIZE);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = _palette.selectionRing;
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
 * FS uses orthogonal elbow routing (rule 75 — issue #466):
 *   exit source right-edge 12px → drop vertically to target row → arrive at target left-edge.
 *   Arrowhead points right (→) when elbow is left of target, left (←) for backward links.
 *
 * SS / FF / SF still use cubic Bézier with 40px control-point offsets:
 *   SS  Start  → Start  : exits left  from src start,  enters left  at tgt start
 *   FF  Finish → Finish : exits right from src finish, enters right at tgt finish
 *   SF  Start  → Finish : exits left  from src start,  enters right at tgt finish
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
    // Issue #332 / #305 follow-up: dependency arrows must not anchor on
    // uncommitted *leaf* tasks — those have no rendered bar (drawTaskBar /
    // drawMilestone skip them) so an arrow would point at empty space.
    // Summaries are exempt: drawSummaryBar always renders the rollup when
    // CPM dates exist, regardless of phase plannedStart, so arrows pointing
    // to/from a phase row remain valid.
    if (!t.isSummary && !t.plannedStart && !t.sprintId) continue;
    // For milestones the bar has zero width (start === finish). Anchor at the
    // diamond's left/right tips using the half-diagonal (ceil so the connection
    // point is just outside the rendered tip, not inside it).
    const milestoneHalfDiag = Math.ceil(MILESTONE_SIZE / 2 * Math.SQRT2); // = 9px
    const cx = dateToLeft(t.start, scales) - scrollLeft;
    taskMap.set(t.id, {
      rowIndex: i,
      barLeft:  t.isMilestone ? cx - milestoneHalfDiag : cx,
      barRight: t.isMilestone ? cx + milestoneHalfDiag : dateToLeft(t.finish, scales) - scrollLeft,
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

    // Compute anchor x-coords per dependency type. cx1/cx2 are Bézier control
    // points for SS/FF/SF; unused for FS (orthogonal routing, rule 75).
    const isFS = link.type !== 'SS' && link.type !== 'FF' && link.type !== 'SF';
    let x1: number, x2: number, cx1 = 0, cx2 = 0;
    switch (link.type) {
      case 'SS':
        x1 = src.barLeft;  x2 = tgt.barLeft;
        cx1 = x1 - 40;    cx2 = x2 - 40;
        break;
      case 'FF':
        x1 = src.barRight; x2 = tgt.barRight;
        cx1 = x1 + 40;    cx2 = x2 + 40;
        break;
      case 'SF':
        x1 = src.barLeft;  x2 = tgt.barRight;
        cx1 = x1 - 40;    cx2 = x2 + 40;
        break;
      default: // 'FS'
        x1 = src.barRight; x2 = tgt.barLeft;
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
    const stroke = isCriticalArrow ? _palette.arrowCritical : _palette.arrowNormal;

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();

    // For FS: arrowhead tip stops 3px short of the bar edge (Visio gap convention).
    // Angle is computed before drawing the line so the line can terminate cleanly
    // at the arrowhead base rather than passing through the triangle interior.
    const tipX = isFS ? x2 - 3 : x2;
    const arrowSize = 6;
    const angle = isFS ? Math.atan2(0, tipX - (x1 + 12)) : Math.atan2(0, x2 - cx2);

    if (isFS) {
      // Orthogonal elbow: exit right 12px → vertical → stop at arrowhead base (rule 75)
      const elbowX = x1 + 12;
      ctx.moveTo(x1, srcY);
      ctx.lineTo(elbowX, srcY);
      ctx.lineTo(elbowX, tgtY);
      ctx.lineTo(tipX - arrowSize * Math.cos(angle), tgtY);
    } else {
      // SS / FF / SF: cubic Bézier, horizontal entry/exit tangent
      ctx.moveTo(x1, srcY);
      ctx.bezierCurveTo(cx1, srcY, cx2, tgtY, x2, tgtY);
    }
    ctx.stroke();

    // Arrowhead: filled triangle with tip at tipX.
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(tipX, tgtY);
    ctx.lineTo(tipX - arrowSize * Math.cos(angle - 0.4), tgtY - arrowSize * Math.sin(angle - 0.4));
    ctx.lineTo(tipX - arrowSize * Math.cos(angle + 0.4), tgtY - arrowSize * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();

    // Connection dot at source bar edge — Visio-style attachment indicator.
    ctx.beginPath();
    ctx.arc(x1, srcY, 2.5, 0, Math.PI * 2);
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
  ctx.fillStyle = _palette.ghostFill;
  ctx.strokeStyle = _palette.ghostBorder;
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
  ctx.strokeStyle = _palette.textSecondary;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, barTop);
  ctx.lineTo(x + 0.5, barTop + BAR_HEIGHT);
  ctx.stroke();
  ctx.restore();
}
