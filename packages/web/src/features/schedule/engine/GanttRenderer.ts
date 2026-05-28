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
import type { FiscalConfig, GanttScaleData } from './GanttScaleData';
import {
  CALENDAR_QUARTERS,
  ZOOM_CONFIGS,
  dateToLeft,
  fiscalQuarterKey,
  fiscalQuarterLabel,
  fiscalYearKey,
  fiscalYearLabel,
  headerUnitsForPxPerDay,
  parseUTCDate,
} from './GanttScaleData';
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
 *
 * In fiscal mode the quarter and year keys follow the workspace fiscal-year
 * start, so cells break on fiscal — not calendar — boundaries (#755).
 */
function getUnitKey(
  date: Date,
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year',
  fiscal: FiscalConfig,
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
      return fiscal.mode === 'fiscal'
        ? fiscalQuarterKey(date, fiscal.startMonth)
        : `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3)}`;
    case 'year':
      return fiscal.mode === 'fiscal'
        ? fiscalYearKey(date, fiscal.startMonth)
        : `${date.getUTCFullYear()}`;
  }
}

/**
 * Label for a header cell, applying fiscal quarter/year labels in fiscal mode
 * and falling back to the zoom config's calendar formatter otherwise (#755).
 */
function unitLabel(
  date: Date,
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year',
  calendarFormat: (d: Date) => string,
  fiscal: FiscalConfig,
): string {
  if (fiscal.mode === 'fiscal') {
    if (unit === 'quarter') return fiscalQuarterLabel(date, fiscal.startMonth);
    if (unit === 'year') return fiscalYearLabel(date, fiscal.startMonth);
  }
  return calendarFormat(date);
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

type HeaderUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Calendar formatter for a header unit when it sits on the MAJOR (top) row.
 *
 * The top row carries the coarser/contextual label, so a month on the major
 * row reads "Apr 2026" (year included) while the same month on the minor row
 * reads just "Apr". Fiscal quarter/year labels are applied later by
 * `unitLabel`; these are the calendar fallbacks.
 */
function majorFormatFor(unit: HeaderUnit): (d: Date) => string {
  switch (unit) {
    case 'day':
      return ZOOM_CONFIGS.day.minorFormat; // day number
    case 'week':
      return ZOOM_CONFIGS.week.minorFormat; // "W15"
    case 'month':
      return ZOOM_CONFIGS.day.majorFormat; // "Apr 2026"
    case 'quarter':
      return ZOOM_CONFIGS.quarter.minorFormat; // "Q2 2026"
    case 'year':
      return ZOOM_CONFIGS.year.majorFormat; // "2026"
  }
}

/** Calendar formatter for a header unit when it sits on the MINOR (bottom) row. */
function minorFormatFor(unit: HeaderUnit): (d: Date) => string {
  switch (unit) {
    case 'day':
      return ZOOM_CONFIGS.day.minorFormat; // day number
    case 'week':
      return ZOOM_CONFIGS.week.minorFormat; // "W15"
    case 'month':
      return ZOOM_CONFIGS.month.minorFormat; // "Apr"
    case 'quarter':
      return ZOOM_CONFIGS.quarter.minorFormat; // "Q2 2026"
    case 'year':
      return ZOOM_CONFIGS.year.minorFormat; // "2026"
  }
}

/**
 * Draw the two-row timeline header at y = 0..HEADER_HEIGHT on canvas-bg.
 * Top row: major unit (day, week, month, quarter, or year).
 * Bottom row: minor unit (day, week, month, quarter, or year).
 *
 * Auto-tier (#351, rule 127): the emphasized (major) and de-emphasized (minor)
 * units are chosen from the CONTINUOUS `pxPerDay` of the scale, not the discrete
 * `zoomLevel` enum — so the header swaps emphasis smoothly across the whole
 * Day↔Year continuum as the user pinch / Ctrl-wheel zooms.
 *
 * Called on every full repaint of canvas-bg, after row bands and grid lines
 * so it paints over any content that overflowed into the header area.
 */
export function drawTimelineHeader(
  ctx: CanvasRenderingContext2D,
  scales: GanttScaleData,
  scrollLeft: number,
  canvasWidth: number,
  fiscal: FiscalConfig = CALENDAR_QUARTERS,
): void {
  const pxPerDay = scales.pxPerMs * 86_400_000;
  const { major: majorUnit, minor: minorUnit } = headerUnitsForPxPerDay(pxPerDay);
  const majorFormat = majorFormatFor(majorUnit);
  const minorFormat = minorFormatFor(minorUnit);
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
      const key = getUnitKey(date, majorUnit, fiscal);

      if (key !== prevKey) {
        if (cellStartDate !== null) {
          const canvasX = (ms - startMs) * scales.pxPerMs;
          const cellX = cellStartCanvasX - scrollLeft;
          const cellWidth = canvasX - scrollLeft - cellX;
          const label = unitLabel(cellStartDate, majorUnit, majorFormat, fiscal);
          drawHeaderCell(ctx, label, cellX, 0, cellWidth, HEADER_MAJOR_HEIGHT);
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
      const label = unitLabel(cellStartDate, majorUnit, majorFormat, fiscal);
      drawHeaderCell(ctx, label, cellX, 0, cellWidth, HEADER_MAJOR_HEIGHT);
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
      const key = getUnitKey(date, minorUnit, fiscal);

      if (key !== prevKey) {
        if (cellStartDate !== null) {
          const canvasX = (ms - startMs) * scales.pxPerMs;
          const cellX = cellStartCanvasX - scrollLeft;
          const cellWidth = canvasX - scrollLeft - cellX;
          const label = unitLabel(cellStartDate, minorUnit, minorFormat, fiscal);
          drawHeaderCell(ctx, label, cellX, HEADER_MAJOR_HEIGHT, cellWidth, HEADER_MINOR_HEIGHT);
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
      const label = unitLabel(cellStartDate, minorUnit, minorFormat, fiscal);
      drawHeaderCell(ctx, label, cellX, HEADER_MAJOR_HEIGHT, cellWidth, HEADER_MINOR_HEIGHT);
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

/** Distance from target entry flank to the merge-junction center (px).
 *  = APPROACH_STUB (8) + arrowSize (9) so the trunk shaft into the arrowhead
 *  base is exactly APPROACH_STUB long. */
export const MERGE_JUNCTION_OFFSET = 17;

/** Outer halo radius of a merge junction dot (px). */
export const MERGE_HALO_RADIUS = 6;

/** Inner filled radius of a merge junction dot (px). */
export const MERGE_DOT_RADIUS = 5;

/** Width of the gap in the "over" segment for a Rule 15 Type A bridge hop (px). */
export const HOP_GAP_WIDTH = 10;

/** Apex height of the bridge hop arc above the "over" segment (px). */
export const HOP_ARC_HEIGHT = 6;

/** Skip a hop if its center is closer than this to either segment endpoint (px) —
 *  prevents hops landing on top of arrowheads or junction dots (Rule 15.6). */
export const HOP_ENDPOINT_CLEARANCE = 12;

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
  isMergePredecessor: boolean = false,
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

  const blockerAtExit = findBlockingBar(exitX, startY, targetY, obstacles, sourceBox, targetBox);

  // SIMPLE L: route V down at a column between source.right and target's entry
  // edge, then H east to the arrowhead base. The V column is placed at the
  // MIDPOINT of the available horizontal gap so both the exit stub and the
  // run-in shaft share the space. For tight sequential cases the midpoint
  // clamps to leave at least 1 px on each side.
  if (!blockerAtExit && targetBox.x > startX) {
    const minV = startX + 1;
    const maxV = targetX - 1;
    const midpoint = Math.round((startX + targetX) / 2);
    if (minV <= maxV) {
      const vColumn = Math.max(minV, Math.min(midpoint, maxV));
      waypoints[waypoints.length - 1] = { x: vColumn, y: startY };
      waypoints.push({ x: vColumn, y: targetY });
      waypoints.push({ x: targetX, y: targetY });
      return waypoints;
    }
  }

  const direction = targetY > startY ? 1 : -1;
  // Gutter Y sits in the row gap immediately above target (= target.Y -
  // ROW_HEIGHT/2 for descending). The approach V then only spans the
  // target's own row, which is filtered from the obstacle list — so the
  // V never has to detour around an intermediate-row wall.
  //
  // For long-span arrows (4+ rows between source and target), lift the
  // gutter higher per UX recommendation, capped so it stays inside a
  // CLEAR row gap (not on a row's bar Y range).
  const spanRows = Math.abs(targetY - startY) / ROW_HEIGHT;
  const gutterOffset = spanRows >= 4 ? ROW_HEIGHT * 1.5 : ROW_HEIGHT * 0.5;
  const gutterY = targetY - direction * gutterOffset;

  const vColumn = blockerAtExit
    ? blockerAtExit.x + blockerAtExit.width + EXIT_STUB
    : exitX;

  // 5-segment canonical path:
  //   1. exit stub: (source.right, source.Y) → (vColumn, source.Y)
  //   2. V drop:    (vColumn, source.Y) → (vColumn, gutterY)
  //   3. H sweep:   (vColumn, gutterY)   → (approachX, gutterY)
  //   4. V into tgt row: (approachX, gutterY) → (approachX, target.Y)
  //   5. run-in:    (approachX, target.Y) → (target.x, target.Y) [arrowhead]
  //
  // For merge predecessors, target.x is the junction.x — approachX == target.x
  // so the run-in collapses (line terminates at the junction; the trunk arrow
  // east of the junction carries the run-in). For single arrows, targetX is the
  // arrowhead BASE (tipX − arrowSize) and the V drop must land APPROACH_STUB
  // west of it so there is a visible straight shaft into the arrowhead.
  let approachX = isMergePredecessor ? targetX : targetX - APPROACH_STUB;

  // Wall-avoidance for the approach V drop: if V at approachX from gutterY to
  // target.Y would cross a non-source/non-target bar, push approachX LEFT past
  // the blocker's left edge so the V drops through clear space.
  const approachBlocker = findBlockingBar(approachX, gutterY, targetY, obstacles, sourceBox, targetBox);
  if (approachBlocker) {
    approachX = approachBlocker.x - EXIT_STUB;
  }

  // If V column was shifted right past a blocker at source row level, jog
  // east first so the V doesn't kink at the exit stub.
  if (vColumn !== exitX) {
    waypoints.push({ x: vColumn, y: startY });
  }
  waypoints.push({ x: vColumn,   y: gutterY });
  waypoints.push({ x: approachX, y: gutterY });
  waypoints.push({ x: approachX, y: targetY });
  if (approachX !== targetX) {
    waypoints.push({ x: targetX, y: targetY });
  }
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

/** A queued draw operation: a polyline (or 2-point Bézier) with optional arrowhead.
 *  Collected before any stroke calls so the renderer can run Rule 15 Type A
 *  (bridge hop) detection across every pair of paths in a single pass. */
interface PendingPath {
  pts: Array<{ x: number; y: number }>;
  stroke: string;
  lineWidth: number;
  /** Hover-chain (#475) — non-chain arrows fade to 20% alpha. Defaults to 1. */
  alpha?: number;
  arrowhead?: { tipX: number; tipY: number; angle: number };
  bezier?: { cx1: number; cx2: number };
}

interface PendingJunction {
  x: number;
  y: number;
  stroke: string;
}

function segHorizontal(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.y - b.y) < 0.5;
}

/** Returns the intersection point of two orthogonal segments — one horizontal,
 *  one vertical — when they cross in the strict interior of BOTH. Returns null
 *  for parallel segments, or when the intersection sits on a segment endpoint
 *  (which would mean it's a corner on the same path, not a true crossing). */
function orthCrossing(
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): { x: number; y: number } | null {
  const aH = segHorizontal(a1, a2);
  const bH = segHorizontal(b1, b2);
  if (aH === bH) return null;
  const h1 = aH ? a1 : b1;
  const h2 = aH ? a2 : b2;
  const v1 = aH ? b1 : a1;
  const v2 = aH ? b2 : a2;
  const ix = v1.x;
  const iy = h1.y;
  const hMinX = Math.min(h1.x, h2.x);
  const hMaxX = Math.max(h1.x, h2.x);
  const vMinY = Math.min(v1.y, v2.y);
  const vMaxY = Math.max(v1.y, v2.y);
  const eps = 0.5;
  if (ix <= hMinX + eps || ix >= hMaxX - eps) return null;
  if (iy <= vMinY + eps || iy >= vMaxY - eps) return null;
  return { x: ix, y: iy };
}

/** Detect every orthogonal crossing in the set of pending Manhattan paths
 *  (Rule 15 Type A). Returns a map keyed by path index → segment index → sorted
 *  list of x-positions where the horizontal segment must lift over a crossing
 *  vertical segment. Bézier paths are skipped — they don't participate in
 *  Manhattan crossings. */
function detectHops(paths: PendingPath[]): Map<number, Map<number, number[]>> {
  const hops = new Map<number, Map<number, number[]>>();
  const record = (pi: number, si: number, x: number) => {
    let m = hops.get(pi);
    if (!m) { m = new Map(); hops.set(pi, m); }
    let arr = m.get(si);
    if (!arr) { arr = []; m.set(si, arr); }
    arr.push(x);
  };
  for (let i = 0; i < paths.length; i++) {
    if (paths[i].bezier) continue;
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[j].bezier) continue;
      const a = paths[i].pts;
      const b = paths[j].pts;
      for (let si = 0; si < a.length - 1; si++) {
        for (let sj = 0; sj < b.length - 1; sj++) {
          const ip = orthCrossing(a[si], a[si + 1], b[sj], b[sj + 1]);
          if (!ip) continue;
          // Horizontal segment goes OVER the vertical (Rule 15.4).
          if (segHorizontal(a[si], a[si + 1])) record(i, si, ip.x);
          else record(j, sj, ip.x);
        }
      }
    }
  }
  for (const m of hops.values()) {
    for (const arr of m.values()) arr.sort((p, q) => p - q);
  }
  return hops;
}

/** Draw a white "channel" halo on every Manhattan segment region that overlaps
 *  a task bar's body. Bars are drawn before arrows in the engine paint order,
 *  so without a halo the charcoal stroke disappears into the bar's fill where
 *  the arrow descends through a target ancestor (Override 4) or any other bar.
 *  The halo is drawn before the arrow stroke so the arrow renders on top with
 *  a clean ~1.5-px white margin on each side. */
function drawSegmentHalos(
  ctx: CanvasRenderingContext2D,
  path: PendingPath,
  allBars: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): void {
  if (path.bezier || allBars.length === 0) return;
  ctx.save();
  ctx.strokeStyle = _palette.surface;
  ctx.lineWidth = path.lineWidth + 3;
  ctx.lineCap = 'butt';
  for (let i = 0; i < path.pts.length - 1; i++) {
    const a = path.pts[i];
    const b = path.pts[i + 1];
    const isH = segHorizontal(a, b);
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y);
    const segMaxY = Math.max(a.y, b.y);
    for (const bar of allBars) {
      const barL = bar.x;
      const barR = bar.x + bar.width;
      const barT = bar.y;
      const barB = bar.y + bar.height;
      if (isH) {
        if (a.y <= barT || a.y >= barB) continue;
        const start = Math.max(segMinX, barL);
        const end = Math.min(segMaxX, barR);
        if (end - start < 0.5) continue;
        ctx.beginPath();
        ctx.moveTo(start, a.y);
        ctx.lineTo(end, a.y);
        ctx.stroke();
      } else {
        if (a.x <= barL || a.x >= barR) continue;
        const start = Math.max(segMinY, barT);
        const end = Math.min(segMaxY, barB);
        if (end - start < 0.5) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, start);
        ctx.lineTo(a.x, end);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Stroke a single PendingPath, lifting horizontal segments over any crossings
 *  recorded for them. Crossings within HOP_ENDPOINT_CLEARANCE of either segment
 *  endpoint are skipped per Rule 15.6 (avoid landing on arrowheads / dots). */
function drawPathWithHops(
  ctx: CanvasRenderingContext2D,
  path: PendingPath,
  segHops: Map<number, number[]> | undefined,
): void {
  ctx.save();
  ctx.strokeStyle = path.stroke;
  ctx.fillStyle = path.stroke;
  ctx.lineWidth = path.lineWidth;
  if (path.alpha !== undefined && path.alpha < 1) ctx.globalAlpha = path.alpha;

  if (path.bezier) {
    const { cx1, cx2 } = path.bezier;
    const a = path.pts[0];
    const b = path.pts[1];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(cx1, a.y, cx2, b.y, b.x, b.y);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(path.pts[0].x, path.pts[0].y);
    for (let si = 0; si < path.pts.length - 1; si++) {
      const a = path.pts[si];
      const b = path.pts[si + 1];
      const hopsOnSeg = segHops?.get(si);
      if (hopsOnSeg && hopsOnSeg.length > 0 && segHorizontal(a, b)) {
        const goingRight = b.x > a.x;
        const ordered = goingRight ? hopsOnSeg : [...hopsOnSeg].reverse();
        const half = HOP_GAP_WIDTH / 2;
        for (const hx of ordered) {
          if (Math.abs(hx - a.x) < HOP_ENDPOINT_CLEARANCE) continue;
          if (Math.abs(hx - b.x) < HOP_ENDPOINT_CLEARANCE) continue;
          const gapStart = goingRight ? hx - half : hx + half;
          const gapEnd = goingRight ? hx + half : hx - half;
          ctx.lineTo(gapStart, a.y);
          ctx.quadraticCurveTo(hx, a.y - HOP_ARC_HEIGHT, gapEnd, a.y);
        }
        ctx.lineTo(b.x, b.y);
      } else {
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
  }

  if (path.arrowhead) {
    const { tipX, tipY, angle } = path.arrowhead;
    const sz = 9;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - sz * Math.cos(angle - 0.4), tipY - sz * Math.sin(angle - 0.4));
    ctx.lineTo(tipX - sz * Math.cos(angle + 0.4), tipY - sz * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Hover-chain coloring (#475). When a chain is supplied, each FS arrow
 * receives one of three pens:
 *   - blue (#60A5FA) when both endpoints are in `predecessors ∪ {hoveredId}` —
 *     edge belongs to the hovered task's incoming chain
 *   - green (#34D399) when both endpoints are in `successors ∪ {hoveredId}` —
 *     outgoing chain
 *   - charcoal at 20% alpha when neither role applies — non-chain arrows fade
 *
 * Selection still wins for explicit selectedTaskIds; chain coloring kicks in
 * only when an arrow is not part of the explicit selection.
 */
export interface DepArrowHoverChain {
  hoveredId: string;
  predecessors: ReadonlySet<string>;
  successors: ReadonlySet<string>;
}

export function drawDependencyArrows(
  ctx: CanvasRenderingContext2D,
  tasks: Task[],
  links: TaskLink[],
  scales: GanttScaleData,
  scrollLeft: number,
  scrollTop: number,
  selectedTaskIds: ReadonlySet<string> = EMPTY_SELECTION,
  hoverChain: DepArrowHoverChain | null = null,
): void {
  if (links.length === 0) return;

  // Build a quick lookup: taskId → { rowIndex, barLeft, barRight }
  // Skip unscheduled tasks (empty start/finish) — NaN coordinates in the map
  // can cause degenerate Bézier paths or unexpected arrow rendering (#92).
  // Anchor map: leaves, milestones, and summaries can ALL be arrow endpoints.
  // Summary rollups have diamond endcaps that extend ±milestoneHalfDiag past
  // the rectangular body, so we anchor arrows on the OUTER vertex of those
  // endcaps (same as milestones) — otherwise the arrow's exit stub starts
  // INSIDE the visible endcap diamond and reads as disconnected.
  const taskMap = new Map<string, { rowIndex: number; barLeft: number; barRight: number; isCritical: boolean; isMilestone: boolean; parentId: string | null }>();
  const milestoneHalfDiag = Math.ceil(MILESTONE_SIZE / 2 * Math.SQRT2); // = 9px
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;
    if (!t.isSummary && !t.plannedStart && !t.sprintId) continue;
    const cx = dateToLeft(t.start, scales) - scrollLeft;
    const rectRight = dateToLeft(t.finish, scales) - scrollLeft;
    let anchorLeft: number, anchorRight: number;
    if (t.isMilestone) {
      anchorLeft  = cx - milestoneHalfDiag;
      anchorRight = cx + milestoneHalfDiag;
    } else if (t.isSummary) {
      // Endcap diamonds extend ±milestoneHalfDiag past the rect.
      anchorLeft  = cx - milestoneHalfDiag;
      anchorRight = rectRight + milestoneHalfDiag;
    } else {
      anchorLeft  = cx;
      anchorRight = rectRight;
    }
    taskMap.set(t.id, {
      rowIndex: i,
      barLeft:  anchorLeft,
      barRight: anchorRight,
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

  // Hierarchy lookup for ancestor checks (target-transparent obstacles and
  // redundant-edge suppression). taskMap already carries parentId so we walk
  // the chain there.
  const isAncestor = (candidateId: string, descendantId: string): boolean => {
    const desc = taskMap.get(descendantId);
    if (!desc) return false;
    let parentId = desc.parentId;
    while (parentId) {
      if (parentId === candidateId) return true;
      const parent = taskMap.get(parentId);
      if (!parent) return false;
      parentId = parent.parentId;
    }
    return false;
  };

  // Per-arrow obstacle filter: every bar is a WALL except (a) the arrow's own
  // source and target and (b) any ancestor of the target. Ancestors are
  // conceptually transparent — a summary rollup is a visual aggregation of its
  // children, not a real wall. Without this exclusion, an arrow from an outside
  // task to a deep descendant has to detour the full width of every containing
  // summary bar (often a chart-spanning U), even though the descent could pass
  // cleanly through the rollup's body.
  function obstaclesFor(srcId: string, tgtId: string): RoutingBox[] {
    return allBars.filter((b) => {
      if (b.id === srcId || b.id === tgtId) return false;
      if (isAncestor(b.id, tgtId)) return false;
      return true;
    });
  }

  // Pre-filter: suppress redundant FS edges. When a source has FS to a summary
  // AND to one or more descendants of that summary, the descendant edges are
  // implied by the summary edge — a summary's earliest start is gated by its
  // first child's start, so "source → summary" already forces every descendant
  // to wait. Dropping the descendant edges declutters the chart without
  // changing schedule semantics. Issue #466.
  const taskByIdFull = new Map(tasks.map((t) => [t.id, t]));
  const isFsLink = (l: TaskLink) => l.type !== 'SS' && l.type !== 'FF' && l.type !== 'SF';
  const droppedLinks = new Set<TaskLink>();
  {
    const fsBySource = new Map<string, TaskLink[]>();
    for (const l of links) {
      if (!isFsLink(l)) continue;
      const arr = fsBySource.get(l.sourceId);
      if (arr) arr.push(l);
      else fsBySource.set(l.sourceId, [l]);
    }
    for (const group of fsBySource.values()) {
      const summaryTargetIds = group
        .filter((l) => taskByIdFull.get(l.targetId)?.isSummary)
        .map((l) => l.targetId);
      if (summaryTargetIds.length === 0) continue;
      for (const link of group) {
        const tgt = taskByIdFull.get(link.targetId);
        if (!tgt || tgt.isSummary) continue;
        for (const summaryId of summaryTargetIds) {
          if (isAncestor(summaryId, link.targetId)) {
            droppedLinks.add(link);
            break;
          }
        }
      }
    }
  }

  // Group FS links by target (for merge junctions — convergences). Junction
  // dots only mark TRUE convergences (multiple distinct arrow lines arriving
  // at one point). Split T-junctions on a shared V column look like ordinary
  // corners to the eye (one V line passing through + one H branching off) so
  // they get no dot.
  const fsByTarget = new Map<string, TaskLink[]>();
  const nonFSLinks: TaskLink[] = [];
  for (const link of links) {
    if (droppedLinks.has(link)) continue;
    if (isFsLink(link)) {
      const tList = fsByTarget.get(link.targetId);
      if (tList) tList.push(link);
      else fsByTarget.set(link.targetId, [link]);
    } else {
      nonFSLinks.push(link);
    }
  }

  // ------------------------------------------------------------------------
  // PHASE 1 — collect every drawable path into pendingPaths without stroking.
  // The collect-then-draw pattern is required for Rule 15 Type A bridge hops:
  // we need to know every Manhattan segment before we can detect orthogonal
  // crossings and decide which segments must lift over which.
  // ------------------------------------------------------------------------
  const pendingPaths: PendingPath[] = [];
  const pendingJunctions: PendingJunction[] = [];

  const pushSingleFS = (link: TaskLink, src: NonNullable<ReturnType<typeof taskMap.get>>): void => {
    const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const tgt = taskMap.get(link.targetId);
    if (!tgt) return;
    const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    if (offScreen(src.barRight, tgt.barLeft, srcY, tgtY, cpWidth, cpHeight)) return;
    const isSelected = selectedTaskIds.has(link.sourceId) || selectedTaskIds.has(link.targetId);
    const role = arrowRole(link.sourceId, link.targetId, hoverChain);
    const { stroke, lineWidth, alpha } = arrowPen(isSelected, role);
    const arrowSize = 9;
    const tipX = tgt.isMilestone ? tgt.barLeft : tgt.barLeft - 1;
    const srcBox = boxFor(src, srcY, milestoneHalfDiag);
    const tgtBox = boxFor(tgt, tgtY, milestoneHalfDiag);
    const pts = calculateDependencyPath(srcBox, tgtBox, obstaclesFor(link.sourceId, link.targetId), cpHeight, tipX - arrowSize);
    pendingPaths.push({ pts, stroke, lineWidth, alpha, arrowhead: { tipX, tipY: tgtY, angle: 0 } });
  };

  for (const [targetId, group] of fsByTarget) {
    const tgt = taskMap.get(targetId);
    if (!tgt) continue;
    const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const useMergeJunction = group.length >= 2;

    if (!useMergeJunction) {
      for (const link of group) {
        const src = taskMap.get(link.sourceId);
        if (src) pushSingleFS(link, src);
      }
      continue;
    }

    let selectedGroup = selectedTaskIds.has(targetId);
    const validPreds: { link: TaskLink; src: NonNullable<ReturnType<typeof taskMap.get>> }[] = [];
    for (const link of group) {
      const src = taskMap.get(link.sourceId);
      if (!src) continue;
      validPreds.push({ link, src });
      if (selectedTaskIds.has(link.sourceId)) selectedGroup = true;
    }
    if (validPreds.length < 2) {
      for (const link of group) {
        const src = taskMap.get(link.sourceId);
        if (src) pushSingleFS(link, src);
      }
      continue;
    }

    // Merge junction. Junction sits at the rightmost predecessor exit X,
    // bounded so the trunk shaft preceding the arrowhead stays ≥ APPROACH_STUB.
    const arrowSize  = 9;
    const tipX       = tgt.isMilestone ? tgt.barLeft : tgt.barLeft - 1;
    const trunkLimit = tipX - arrowSize - APPROACH_STUB;
    let maxExitX = -Infinity;
    for (const { src } of validPreds) {
      const ex = src.barRight + EXIT_STUB;
      if (ex > maxExitX) maxExitX = ex;
    }
    const junctionX = Math.min(maxExitX, trunkLimit);
    const junctionY = tgtY;

    // Each predecessor's path ends AT the junction (no arrowhead — the trunk
    // carries the only arrowhead).
    for (const { link, src } of validPreds) {
      const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
      const isSelected = selectedTaskIds.has(link.sourceId) || selectedTaskIds.has(link.targetId);
      const role = arrowRole(link.sourceId, link.targetId, hoverChain);
      const { stroke, lineWidth, alpha } = arrowPen(isSelected, role);
      const srcBox = boxFor(src, srcY, milestoneHalfDiag);
      const tgtBox = boxFor(tgt, tgtY, milestoneHalfDiag);
      if (offScreen(src.barRight, junctionX, srcY, junctionY, cpWidth, cpHeight)) continue;
      const obstaclesForLink = obstaclesFor(link.sourceId, link.targetId);
      const pts = calculateDependencyPath(srcBox, tgtBox, obstaclesForLink, cpHeight, junctionX, true);
      pendingPaths.push({ pts, stroke, lineWidth, alpha });
    }

    // Trunk: 2-point horizontal from junction east to the arrowhead base.
    // The trunk's chain role is derived from the merge target — every
    // predecessor edge into the same target shares its role on a merge.
    const trunkRole = arrowRole(targetId, targetId, hoverChain);
    const { stroke: trunkStroke, lineWidth: trunkLineWidth, alpha: trunkAlpha } =
      arrowPen(selectedGroup, trunkRole);
    pendingPaths.push({
      pts: [{ x: junctionX, y: junctionY }, { x: tipX - arrowSize, y: junctionY }],
      stroke: trunkStroke,
      lineWidth: trunkLineWidth,
      alpha: trunkAlpha,
      arrowhead: { tipX, tipY: junctionY, angle: 0 },
    });

    pendingJunctions.push({ x: junctionX, y: junctionY, stroke: trunkStroke });
  }

  // Split junctions intentionally absent (issue #466). A split T-junction is
  // one V line passing through plus one H branching off — visually a plain
  // Manhattan corner. Merge junctions remain because 2+ lines visibly meet.

  // SS / FF / SF — cubic Bézier. Skipped from hop detection (Bézier-vs-Manhattan
  // crossings are out of scope for Rule 15 v1).
  for (const link of nonFSLinks) {
    const src = taskMap.get(link.sourceId);
    const tgt = taskMap.get(link.targetId);
    if (!src || !tgt) continue;
    const srcY = src.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    const tgtY = tgt.rowIndex * ROW_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT / 2 - scrollTop;
    let x1: number, x2: number, cx1: number, cx2: number;
    switch (link.type) {
      case 'SS': x1 = src.barLeft;  x2 = tgt.barLeft;  cx1 = x1 - 40; cx2 = x2 - 40; break;
      case 'FF': x1 = src.barRight; x2 = tgt.barRight; cx1 = x1 + 40; cx2 = x2 + 40; break;
      default:   x1 = src.barLeft;  x2 = tgt.barRight; cx1 = x1 - 40; cx2 = x2 + 40;
    }
    if (offScreen(x1, x2, srcY, tgtY, cpWidth, cpHeight)) continue;
    const isSelected = selectedTaskIds.has(link.sourceId) || selectedTaskIds.has(link.targetId);
    const role = arrowRole(link.sourceId, link.targetId, hoverChain);
    const { stroke, lineWidth, alpha } = arrowPen(isSelected, role);
    const angle = Math.atan2(0, x2 - cx2);
    pendingPaths.push({
      pts: [{ x: x1, y: srcY }, { x: x2, y: tgtY }],
      stroke,
      lineWidth,
      alpha,
      arrowhead: { tipX: x2, tipY: tgtY, angle },
      bezier: { cx1, cx2 },
    });
  }

  // ------------------------------------------------------------------------
  // PHASE 2 — Rule 15 Type A: detect every orthogonal crossing across the
  // full set of Manhattan paths. Horizontal segments go OVER vertical by
  // convention (Rule 15.4).
  // ------------------------------------------------------------------------
  const hopsByPath = detectHops(pendingPaths);

  // ------------------------------------------------------------------------
  // PHASE 3a — cut a white "channel" halo across every bar body that any path
  // segment overlaps. Done as a separate pass before any strokes so two arrows
  // crossing inside the same bar don't have their second halo erase the
  // first's stroke.
  // ------------------------------------------------------------------------
  for (let i = 0; i < pendingPaths.length; i++) {
    drawSegmentHalos(ctx, pendingPaths[i], allBars);
  }

  // ------------------------------------------------------------------------
  // PHASE 3b — stroke every path, lifting horizontal segments over crossings.
  // ------------------------------------------------------------------------
  for (let i = 0; i < pendingPaths.length; i++) {
    drawPathWithHops(ctx, pendingPaths[i], hopsByPath.get(i));
  }

  // ------------------------------------------------------------------------
  // PHASE 4 — junction halos + dots, drawn LAST so they sit on top of every
  // line endcap and the trunk's start point.
  // ------------------------------------------------------------------------
  for (const j of pendingJunctions) {
    ctx.save();
    ctx.fillStyle = _palette.surface;
    ctx.beginPath();
    ctx.arc(j.x, j.y, MERGE_HALO_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = j.stroke;
    ctx.beginPath();
    ctx.arc(j.x, j.y, MERGE_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

// Hover-chain arrow colors (#475). Constant across light/dark — both colors
// were measured ≥ 3.06:1 against light AND dark surfaces (WCAG 1.4.11 spec
// floor for non-text components), so a single value works in both modes.
const CHAIN_ARROW_PREDECESSOR = '#60A5FA'; // blue — flows into hovered task
const CHAIN_ARROW_SUCCESSOR = '#34D399'; // green — flows out of hovered task
const CHAIN_ARROW_DIM_ALPHA = 0.2; // non-chain arrows fade to 20% of the charcoal default

type ArrowRole = 'predecessor' | 'successor' | 'dim' | 'normal';

function arrowRole(
  sourceId: string,
  targetId: string,
  chain: DepArrowHoverChain | null,
): ArrowRole {
  if (!chain) return 'normal';
  const { hoveredId, predecessors, successors } = chain;
  // Predecessor chain: both endpoints in predecessors ∪ {hoveredId}.
  const sourceInPred = sourceId === hoveredId || predecessors.has(sourceId);
  const targetInPred = targetId === hoveredId || predecessors.has(targetId);
  if (sourceInPred && targetInPred) return 'predecessor';
  // Successor chain: both endpoints in successors ∪ {hoveredId}.
  const sourceInSucc = sourceId === hoveredId || successors.has(sourceId);
  const targetInSucc = targetId === hoveredId || successors.has(targetId);
  if (sourceInSucc && targetInSucc) return 'successor';
  return 'dim';
}

/**
 * Pen settings (stroke color + line width + alpha) for an arrow.
 *
 * Critical-path arrows do NOT change color — critical state is conveyed by the
 * red BAR fill (rule 73), not the connector. Issue #466 gap analysis P0-1.
 *
 * Hover-chain (#475): when a chain is supplied, in-chain arrows recolor to
 * blue (predecessors) or green (successors); out-of-chain arrows dim to 20%.
 * Explicit selection still wins so a selected arrow stays prominent.
 */
function arrowPen(
  isSelected: boolean,
  role: ArrowRole = 'normal',
): { stroke: string; lineWidth: number; alpha: number } {
  if (isSelected) return { stroke: _palette.selectionRing, lineWidth: 2.5, alpha: 1 };
  if (role === 'predecessor')
    return { stroke: CHAIN_ARROW_PREDECESSOR, lineWidth: 2, alpha: 1 };
  if (role === 'successor')
    return { stroke: CHAIN_ARROW_SUCCESSOR, lineWidth: 2, alpha: 1 };
  if (role === 'dim')
    return { stroke: _palette.arrowNormal, lineWidth: 2, alpha: CHAIN_ARROW_DIM_ALPHA };
  return { stroke: _palette.arrowNormal, lineWidth: 2, alpha: 1 };
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
