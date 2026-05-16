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
 * - Rule 75: FS arrows use Manhattan routing with merge junctions, charcoal stroke for all
 *   arrows (no critical-red), summary rollups excluded as endpoints. SS/FF/SF Bézier.
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
  // Dependency arrows are charcoal regardless of critical-path state.
  // Critical path is conveyed by red bar fill (rule 73), not by arrow color.
  // The previous "critical = red arrow" rule made arrows visually merge with
  // bars where they crossed (issue #466 gap analysis P0-1).
  arrowNormal:    '#444441',
  arrowCritical:  '#444441',
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
  // Light charcoal for arrows on the dark surface. Unified — no red variant.
  arrowNormal:    '#B8B5AE',
  arrowCritical:  '#B8B5AE',
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

// ---------------------------------------------------------------------------
// Manhattan routing engine — Right-Sweep collision avoidance (issue #466)
// ---------------------------------------------------------------------------
//
// Baseline algorithm: M → H exit stub → (H sweep right) → V drop → (H back) → H final.
// The line is a single OPEN polyline; the caller calls `ctx.stroke()` only on
// this path (never `ctx.fill()` and never `ctx.closePath()`), and the arrowhead
// is a separate closed triangle drawn afterward.

/** Axis-aligned bounding box for dependency-line collision detection. */
export interface RoutingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Visual buffer (px) around every obstacle in collision checks. */
export const ROUTING_PADDING = 8;

/** Mandatory horizontal exit-stub length off the source's right edge (px). */
export const EXIT_STUB = 5;

/** Mandatory horizontal approach-stub length into the target's left edge (px). */
export const APPROACH_STUB = 8;

/** Distance from target entry flank to the merge-junction center (px). */
export const MERGE_JUNCTION_OFFSET = 14;

/** Outer halo radius of a merge junction dot (px). */
export const MERGE_HALO_RADIUS = 4;

/** Inner filled radius of a merge junction dot (px). */
export const MERGE_DOT_RADIUS = 3;

/**
 * Compute the dependency-line path per ADR-0063 (Gantt dependency arrow
 * routing rules). The path is a Manhattan polyline of 3 to 7 segments.
 *
 * Decision tree:
 *   1. Same row → 3 segments: exit stub → H → run-in. (collapsed R6)
 *   2. Stacked sequential (R12: target.y > source.y AND target overlaps source
 *      horizontally) → 5-segment gutter dogleg: exit stub → V to mid-row
 *      gutter → H along gutter → V to target row → run-in.
 *   3. V at exit column blocked by a non-source/non-target bar → 5-segment
 *      left-detour: exit stub → V to gutter → H west to past blocker's left
 *      edge → V south past blocker → run-in.
 *   4. Otherwise → 3 segments collapsed canonical: exit stub → V at exit
 *      column → run-in.
 *
 * The caller draws pts[0]…pts[length−2] as a polyline, then a manual
 * approach lineTo to (tipX − arrowSize, targetY) which is the arrowhead base,
 * then the arrowhead triangle. Last waypoint is the sentinel at the target's
 * entry edge.
 */
export function calculateDependencyPath(
  sourceBox: RoutingBox,
  targetBox: RoutingBox,
  obstacles: RoutingBox[],
  _viewportHeight: number,  // retained for API compat; unused
  targetEntryX?: number,
): Array<{ x: number; y: number }> {
  const startX  = sourceBox.x + sourceBox.width;
  const startY  = sourceBox.y + sourceBox.height / 2;
  const targetX = targetEntryX ?? targetBox.x;
  const targetY = targetBox.y + targetBox.height / 2;
  const exitX = startX + EXIT_STUB;
  const sameRow = Math.abs(targetY - startY) < 1;

  const waypoints: Array<{ x: number; y: number }> = [];
  waypoints.push({ x: startX, y: startY });
  waypoints.push({ x: exitX,  y: startY });

  if (sameRow) {
    waypoints.push({ x: targetX, y: targetY });
    return waypoints;
  }

  const direction = targetY > startY ? 1 : -1;
  const gutterY   = startY + direction * (ROW_HEIGHT / 2);

  // R12 gutter dogleg: when target overlaps source horizontally (stacked
  // sequential — target.barLeft is at or before source.barRight + exit stub),
  // the V at exitX would land inside the target's own X-range. Route through
  // the row-gutter midline between source and target rows instead.
  // SUPPRESSED when targetEntryX is provided (merge-junction predecessor) —
  // those lines should drop straight to the junction Y at their own exitX so
  // the geometric convergence happens at the corner (maxExitX, junctionY).
  const isMergePredecessor = targetEntryX !== undefined;
  const stackedSequential = !isMergePredecessor && targetX <= exitX;
  if (stackedSequential) {
    // If V at approachX would cross a non-source/non-target bar (typically the
    // target's parent summary, e.g., milestone → child-of-phase), push the
    // approach column LEFT past the blocker so the V drops through clear space
    // and re-enters target's row from outside the blocker's X range.
    let approachX = targetX - APPROACH_STUB;
    const dogLegBlocker = findBlockingBar(approachX, gutterY, targetY, obstacles, sourceBox, targetBox);
    if (dogLegBlocker) {
      approachX = dogLegBlocker.x - EXIT_STUB;
    }
    waypoints.push({ x: exitX,     y: gutterY });
    waypoints.push({ x: approachX, y: gutterY });
    waypoints.push({ x: approachX, y: targetY });
    waypoints.push({ x: targetX,   y: targetY });
    return waypoints;
  }

  // Detour-around-left: V at exitX would cross a non-source/non-target bar.
  // Route around the blocker's LEFT side.
  const blocker = findBlockingBar(exitX, startY, targetY, obstacles, sourceBox, targetBox);
  if (blocker) {
    const detourX = blocker.x - EXIT_STUB;
    waypoints.push({ x: exitX,   y: gutterY });
    waypoints.push({ x: detourX, y: gutterY });
    waypoints.push({ x: detourX, y: targetY });
  } else {
    // Canonical collapsed 3-segment L: V at exitX straight to target row.
    waypoints.push({ x: exitX, y: targetY });
  }

  waypoints.push({ x: targetX, y: targetY });
  return waypoints;
}

/**
 * Return the first obstacle whose body the V drop from `y1` to `y2` at column
 * `x` would cross, excluding the arrow's own source and target boxes.
 */
function findBlockingBar(
  x: number,
  y1: number,
  y2: number,
  obstacles: RoutingBox[],
  srcBox: RoutingBox,
  tgtBox: RoutingBox,
): RoutingBox | null {
  const top    = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  for (const obs of obstacles) {
    if (obs.x === srcBox.x && obs.y === srcBox.y && obs.width === srcBox.width) continue;
    if (obs.x === tgtBox.x && obs.y === tgtBox.y && obs.width === tgtBox.width) continue;
    const xHit = x >= obs.x && x <= obs.x + obs.width;
    const yHit = top < obs.y + obs.height && obs.y < bottom;
    if (xHit && yHit) return obs;
  }
  return null;
}

/**
 * Draw dependency arrows for all four link types (FS, SS, FF, SF).
 *
 * FS routing (rule 75 — issue #466): Manhattan polyline with collision-avoiding
 * column selection. See `calculateDependencyPath` above for the algorithm.
 *
 * Milestone vertex flanks: incoming FS arrows enter at the LEFT vertex (cx - 9),
 * outgoing FS arrows exit at the RIGHT vertex (cx + 9). Entry and exit vertices
 * on the same milestone are guaranteed different because FS sources use the
 * right edge and FS targets use the left edge.
 *
 * Merge junctions: when 2+ FS arrows terminate at the same milestone, each
 * predecessor terminates 2px short of a junction point 14px left of the target
 * flank (no arrowhead). A single trunk arrow with arrowhead runs from the
 * junction to the milestone. Junction halo + dot are drawn LAST so they sit on
 * top of the predecessor line endcaps. Critical-wins for the trunk color.
 *
 * Selection emphasis: when source OR target is in selectedTaskIds, the arrow
 * uses brand-primary (selectionRing token) stroke at 2.5px instead of the
 * normal 2px arrowNormal/arrowCritical.
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
  selectedTaskIds: ReadonlySet<string> = EMPTY_SELECTION,
): void {
  if (links.length === 0) return;

  // Build a quick lookup: taskId → { rowIndex, barLeft, barRight }
  // Skip unscheduled tasks (empty start/finish) — NaN coordinates in the map
  // can cause degenerate Bézier paths or unexpected arrow rendering (#92).
  // Anchor map: leaves, milestones, and summaries can ALL be arrow endpoints.
  const taskMap = new Map<string, { rowIndex: number; barLeft: number; barRight: number; isCritical: boolean; isMilestone: boolean; parentId: string | null }>();
  const milestoneHalfDiag = Math.ceil(MILESTONE_SIZE / 2 * Math.SQRT2); // = 9px
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;
    if (!t.isSummary && !t.plannedStart && !t.sprintId) continue;
    const cx = dateToLeft(t.start, scales) - scrollLeft;
    taskMap.set(t.id, {
      rowIndex: i,
      barLeft:  t.isMilestone ? cx - milestoneHalfDiag : cx,
      barRight: t.isMilestone ? cx + milestoneHalfDiag : dateToLeft(t.finish, scales) - scrollLeft,
      isCritical: t.isCritical,
      isMilestone: !!t.isMilestone,
      parentId: t.parentId ?? null,
    });
  }


  const cpWidth  = ctx.canvas.width  / (window.devicePixelRatio || 1);
  const cpHeight = ctx.canvas.height / (window.devicePixelRatio || 1);

  // Obstacle list — every rendered bar including summary rollups. We DO want
  // arrows to route around visible summary bars in general; per-arrow filtering
  // (below, via `obstaclesFor`) removes ancestor summaries so arrows into a
  // phase's child don't see that phase as a wall.
  const allBars: Array<RoutingBox & { id: string }> = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;
    const cx = dateToLeft(t.start, scales) - scrollLeft;
    const rectLeft  = t.isMilestone ? cx - milestoneHalfDiag : cx;
    const rectRight = t.isMilestone ? cx + milestoneHalfDiag : dateToLeft(t.finish, scales) - scrollLeft;
    const rowCenterY = i * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    let boxLeft: number, boxRight: number, halfH: number;
    if (t.isMilestone) {
      boxLeft = rectLeft; boxRight = rectRight;
      halfH = milestoneHalfDiag;
    } else if (t.isSummary) {
      // Endcap diamonds extend ±milestoneHalfDiag past the rect bounds.
      boxLeft = rectLeft - milestoneHalfDiag;
      boxRight = rectRight + milestoneHalfDiag;
      halfH = milestoneHalfDiag;
    } else {
      boxLeft = rectLeft; boxRight = rectRight;
      halfH = BAR_HEIGHT / 2;
    }
    allBars.push({
      id:     t.id,
      x:      boxLeft,
      y:      rowCenterY - halfH,
      width:  boxRight - boxLeft,
      height: halfH * 2,
    });
  }

  // Per-arrow obstacle filter: drop the arrow's own source and target so the
  // routing layer never flags itself as a blocker.
  function obstaclesFor(srcId: string, tgtId: string): RoutingBox[] {
    return allBars.filter((b) => b.id !== srcId && b.id !== tgtId);
  }

  // Group FS links by target id (for merge junctions). Junctions only render
  // for true convergences — multiple predecessors terminating at the same
  // target. Diverging arrows from a shared source get no junction.
  const fsByTarget = new Map<string, TaskLink[]>();
  const nonFSLinks: TaskLink[] = [];
  for (const link of links) {
    const isFS = link.type !== 'SS' && link.type !== 'FF' && link.type !== 'SF';
    if (isFS) {
      const tList = fsByTarget.get(link.targetId);
      if (tList) tList.push(link);
      else fsByTarget.set(link.targetId, [link]);
    } else {
      nonFSLinks.push(link);
    }
  }

  // ------------------------------------------------------------------------
  // FS arrows — single-predecessor and multi-predecessor (merge) cases.
  // ------------------------------------------------------------------------
  for (const [targetId, group] of fsByTarget) {
    const tgt = taskMap.get(targetId);
    if (!tgt) continue;
    const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    // Merge-junction routing applies whenever 2+ FS arrows terminate at the
    // same target (milestone, leaf task, OR summary). The junction collects
    // the predecessors visibly into a shared trunk + T-junction dots.
    const useMergeJunction = group.length >= 2;

    if (!useMergeJunction) {
      for (const link of group) {
        drawSingleFSArrow(ctx, link, taskMap, obstaclesFor(link.sourceId, link.targetId),
          milestoneHalfDiag, scrollTop, cpWidth, cpHeight, selectedTaskIds);
      }
      continue;
    }

    // Selection emphasis: trunk highlights when target or any predecessor is selected.
    let selectedGroup = selectedTaskIds.has(targetId);
    const validPreds: { link: TaskLink; src: NonNullable<ReturnType<typeof taskMap.get>> }[] = [];
    for (const link of group) {
      const src = taskMap.get(link.sourceId);
      if (!src) continue;
      validPreds.push({ link, src });
      if (selectedTaskIds.has(link.sourceId)) selectedGroup = true;
    }
    if (validPreds.length < 2) {
      // After validity filtering only one predecessor remains — fall back.
      for (const link of group) {
        drawSingleFSArrow(ctx, link, taskMap, obstaclesFor(link.sourceId, link.targetId),
          milestoneHalfDiag, scrollTop, cpWidth, cpHeight, selectedTaskIds);
      }
      continue;
    }

    // Junction sits at the actual line-convergence point: the rightmost
    // predecessor's exit column. That's where the last V drops onto the shared
    // trunk Y — i.e., the X coordinate where ALL predecessor lines have
    // merged into one. After that point, a single trunk arrow runs east to
    // the target's arrowhead.
    //
    // Bounded below by `tgt.barLeft − (APPROACH_STUB + arrowSize)` so the
    // straight trunk shaft preceding the arrowhead stays ≥ APPROACH_STUB
    // (8px) regardless of how close a predecessor is to the target.
    const arrowSize    = 6;
    const tipX         = tgt.isMilestone ? tgt.barLeft : tgt.barLeft - 1;
    const trunkLimit   = tipX - arrowSize - APPROACH_STUB;
    let maxExitX = -Infinity;
    for (const { src } of validPreds) {
      const ex = src.barRight + EXIT_STUB;
      if (ex > maxExitX) maxExitX = ex;
    }
    const junctionX = Math.min(maxExitX, trunkLimit);
    const junctionY = tgtY;
    const stopX     = junctionX - 2;

    // Each predecessor draws its full path terminating at (junctionX, junctionY).
    // All predecessor lines literally converge at that single point — the only
    // place where multiple lines meet. A junction dot at that point covers the
    // line endcaps. After the junction, a single trunk arrow with the arrowhead
    // runs east to the target's entry edge.
    for (const { link, src } of validPreds) {
      const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
      const isSelected = selectedTaskIds.has(link.sourceId) || selectedTaskIds.has(link.targetId);
      const { stroke, lineWidth } = arrowPen(isSelected);
      const srcBox: RoutingBox = boxFor(src, srcY, milestoneHalfDiag);
      const tgtBox: RoutingBox = boxFor(tgt, tgtY, milestoneHalfDiag);
      if (offScreen(src.barRight, junctionX, srcY, junctionY, cpWidth, cpHeight)) continue;

      const obstaclesForLink = obstaclesFor(link.sourceId, link.targetId);
      const pts = calculateDependencyPath(srcBox, tgtBox, obstaclesForLink, cpHeight, stopX);

      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = lineWidth;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    // Trunk arrow: a single straight horizontal segment from the junction
    // east to the arrowhead. The trunk shaft length is at least APPROACH_STUB
    // because junctionX ≤ trunkLimit = tipX − arrowSize − APPROACH_STUB.
    const { stroke: trunkStroke, lineWidth: trunkLineWidth } = arrowPen(selectedGroup);

    ctx.save();
    ctx.strokeStyle = trunkStroke;
    ctx.fillStyle   = trunkStroke;
    ctx.lineWidth   = trunkLineWidth;
    ctx.beginPath();
    ctx.moveTo(junctionX, junctionY);
    ctx.lineTo(tipX - arrowSize, junctionY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tipX, junctionY);
    ctx.lineTo(tipX - arrowSize * Math.cos(-0.4), junctionY - arrowSize * Math.sin(-0.4));
    ctx.lineTo(tipX - arrowSize * Math.cos( 0.4), junctionY - arrowSize * Math.sin( 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Junction halo + dot at the single convergence point — drawn LAST so it
    // sits on top of every predecessor's line endcap.
    ctx.save();
    ctx.fillStyle = _palette.surface;
    ctx.beginPath();
    ctx.arc(junctionX, junctionY, MERGE_HALO_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = trunkStroke;
    ctx.beginPath();
    ctx.arc(junctionX, junctionY, MERGE_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Note: diverging arrows from a shared source do NOT get a junction dot.
  // Junctions only mark TRUE convergences — multiple lines terminating at the
  // same point. Lines fanning out from a source are diverging, not converging.

  // ------------------------------------------------------------------------
  // SS / FF / SF — Bézier (unchanged from prior behavior).
  // ------------------------------------------------------------------------
  for (const link of nonFSLinks) {
    const src = taskMap.get(link.sourceId);
    const tgt = taskMap.get(link.targetId);
    if (!src || !tgt) continue;
    const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;

    let x1: number, x2: number, cx1: number, cx2: number;
    switch (link.type) {
      case 'SS':
        x1 = src.barLeft;  x2 = tgt.barLeft;
        cx1 = x1 - 40;     cx2 = x2 - 40;
        break;
      case 'FF':
        x1 = src.barRight; x2 = tgt.barRight;
        cx1 = x1 + 40;     cx2 = x2 + 40;
        break;
      default: // 'SF'
        x1 = src.barLeft;  x2 = tgt.barRight;
        cx1 = x1 - 40;     cx2 = x2 + 40;
    }

    if (offScreen(x1, x2, srcY, tgtY, cpWidth, cpHeight)) continue;

    const isSelected = selectedTaskIds.has(link.sourceId) || selectedTaskIds.has(link.targetId);
    const { stroke, lineWidth } = arrowPen(isSelected);

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.fillStyle   = stroke;
    ctx.lineWidth   = lineWidth;

    const arrowSize = 6;
    const tipX  = x2;
    const angle = Math.atan2(0, x2 - cx2);

    ctx.beginPath();
    ctx.moveTo(x1, srcY);
    ctx.bezierCurveTo(cx1, srcY, cx2, tgtY, x2, tgtY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tipX, tgtY);
    ctx.lineTo(tipX - arrowSize * Math.cos(angle - 0.4), tgtY - arrowSize * Math.sin(angle - 0.4));
    ctx.lineTo(tipX - arrowSize * Math.cos(angle + 0.4), tgtY - arrowSize * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/**
 * Pen settings (stroke color + line width) for an arrow.
 * Critical-path arrows do NOT change color — critical state is conveyed by the
 * red BAR fill (rule 73), not the connector. Issue #466 gap analysis P0-1.
 */
function arrowPen(isSelected: boolean): { stroke: string; lineWidth: number } {
  if (isSelected) return { stroke: _palette.selectionRing, lineWidth: 2.5 };
  return { stroke: _palette.arrowNormal, lineWidth: 2 };
}

/** RoutingBox for a task entry in the taskMap. */
function boxFor(
  entry: { barLeft: number; barRight: number; isMilestone: boolean },
  rowCenterY: number,
  milestoneHalfDiag: number,
): RoutingBox {
  const halfH = entry.isMilestone ? milestoneHalfDiag : BAR_HEIGHT / 2;
  return {
    x:      entry.barLeft,
    y:      rowCenterY - halfH,
    width:  entry.barRight - entry.barLeft,
    height: halfH * 2,
  };
}

/** Off-screen cull for a single arrow span. */
function offScreen(
  x1: number, x2: number, y1: number, y2: number,
  cpWidth: number, cpHeight: number,
): boolean {
  return (
    (x1 < -10 && x2 < -10) ||
    (x1 > cpWidth + 10 && x2 > cpWidth + 10) ||
    (y1 < -10 && y2 < -10) ||
    (y1 > cpHeight + 10 && y2 > cpHeight + 10)
  );
}

/** Draw one FS arrow (single-predecessor path, no merge junction). */
function drawSingleFSArrow(
  ctx: CanvasRenderingContext2D,
  link: TaskLink,
  taskMap: Map<string, { rowIndex: number; barLeft: number; barRight: number; isCritical: boolean; isMilestone: boolean; parentId: string | null }>,
  obstacles: RoutingBox[],
  milestoneHalfDiag: number,
  scrollTop: number,
  cpWidth: number,
  cpHeight: number,
  selectedTaskIds: ReadonlySet<string>,
): void {
  const src = taskMap.get(link.sourceId);
  const tgt = taskMap.get(link.targetId);
  if (!src || !tgt) return;
  const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
  const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
  if (offScreen(src.barRight, tgt.barLeft, srcY, tgtY, cpWidth, cpHeight)) return;

  const isSelected = selectedTaskIds.has(link.sourceId) || selectedTaskIds.has(link.targetId);
  const { stroke, lineWidth } = arrowPen(isSelected);

  const arrowSize = 6;
  // Arrowhead tip: tight to the milestone vertex; 1px gap on regular bars.
  const tipX = tgt.isMilestone ? tgt.barLeft : tgt.barLeft - 1;

  const srcBox = boxFor(src, srcY, milestoneHalfDiag);
  const tgtBox = boxFor(tgt, tgtY, milestoneHalfDiag);
  const pts = calculateDependencyPath(srcBox, tgtBox, obstacles, cpHeight);

  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.fillStyle   = stroke;
  ctx.lineWidth   = lineWidth;

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(tipX - arrowSize, tgtY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(tipX, tgtY);
  ctx.lineTo(tipX - arrowSize * Math.cos(-0.4), tgtY - arrowSize * Math.sin(-0.4));
  ctx.lineTo(tipX - arrowSize * Math.cos( 0.4), tgtY - arrowSize * Math.sin( 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
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
