/**
 * Concrete canvas Gantt renderer implementing the GanttEngine interface.
 *
 * Architecture:
 * - Three stacked canvas elements (bg, bars, interaction) — one responsibility each (rule 59).
 * - rAF loop with dirty-rect invalidation — never full-repaint during drag (rule 60).
 * - Row virtualisation — only paints visible rows + 5-row overscan (rule 61).
 * - devicePixelRatio scaling applied once at init and on ResizeObserver (rule 62).
 * - prefers-reduced-motion evaluated at init and on media query change (rule 70).
 * - Event emitter with unsubscribe — fixes SVAR intercept() memory leak (rule 55).
 */

import type { Task, TaskLink } from '@/types';
import type { GanttEngine, GanttEngineEventMap } from './GanttEngine';
import type { GanttScaleData, ZoomLevel } from './GanttScaleData';
import { buildScaleData, dateToLeft, leftToDate } from './GanttScaleData';
import { buildHitIndex } from './GanttHitIndex';
import type { HitIndex, HitZone } from './GanttHitIndex';
import { GanttDragFSM } from './GanttDragFSM';
import {
  ROW_HEIGHT,
  BAR_TOP_OFFSET,
  COLOR,
  COLOR_DARK,
  setRendererColorMode,
  CANVAS_FONT,
  drawRowBands,
  drawGridLines,
  drawTodayLine,
  drawTimelineHeader,
  drawTaskBar,
  drawSummaryBar,
  drawMilestone,
  drawDependencyArrows,
  drawDragShadow,
  drawResizeIndicator,
  drawActualDateBar,
  drawScheduleVarianceBadge,
} from './GanttRenderer';
import { HEADER_HEIGHT } from '../scheduleConstants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OVERSCAN_ROWS = 5;

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface GanttEngineImplOptions {
  container: HTMLDivElement;
  bgCanvas: HTMLCanvasElement;
  barsCanvas: HTMLCanvasElement;
  ixCanvas: HTMLCanvasElement;
  initialZoom: ZoomLevel;
  /** Initial color mode — pass true if the app is already in dark mode at mount time. */
  isDark?: boolean;
}

// ---------------------------------------------------------------------------
// Snap-to-day helper
// ---------------------------------------------------------------------------

function snapToDayBoundary(canvasX: number, scales: GanttScaleData): number {
  const msPerDay = 86_400_000;
  const pxPerDay = scales.pxPerMs * msPerDay;
  return Math.round(canvasX / pxPerDay) * pxPerDay;
}

// ---------------------------------------------------------------------------
// GanttEngineImpl
// ---------------------------------------------------------------------------

export class GanttEngineImpl implements GanttEngine {
  // ── Canvas elements and contexts ──────────────────────────────────────────
  private readonly _container: HTMLDivElement;
  private readonly _bgCanvas: HTMLCanvasElement;
  private readonly _barsCanvas: HTMLCanvasElement;
  private readonly _ixCanvas: HTMLCanvasElement;
  private _bgCtx: CanvasRenderingContext2D;
  private _barsCtx: CanvasRenderingContext2D;
  private _ixCtx: CanvasRenderingContext2D;

  // ── State ─────────────────────────────────────────────────────────────────
  private _tasks: Task[] = [];
  private _links: TaskLink[] = [];
  private _scales: GanttScaleData | null = null;
  private _projectStart = '2024-01-01';
  private _projectEnd = '2025-01-01';
  private _zoomLevel: ZoomLevel;
  private _scrollLeft = 0;
  private _scrollTop = 0;
  private _viewportWidth = 0;
  private _viewportHeight = 0;
  private _selectedTaskIds: Set<string> = new Set();
  private _hitIndex: HitIndex | null = null;
  private _dragFSM: GanttDragFSM = new GanttDragFSM();

  // Dirty-rect tracking
  private _dirtyRows: Set<number> = new Set();
  private _fullRepaintPending = true;

  // rAF
  private _rafId = 0;
  private _isDestroyed = false;
  private _hasEmittedReady = false;

  // DPR
  private _dpr = 1;

  // Accessibility
  private _reducedMotion = false;
  private _reducedMotionMQ: MediaQueryList | null = null;

  // Resize
  private _resizeObserver: ResizeObserver;

  // Event emitter
  private readonly _handlers = new Map<string, Set<(payload: unknown) => void>>();

  // Current hover hit zone (for cursor management)
  private _hoverZone: HitZone | null = null;

  // Offset between the pointer and the bar's left edge at drag start.
  // Subtracted from pointer x on every move/up so the bar follows the grab point,
  // not the cursor position.
  private _dragOffsetX = 0;

  // Color mode
  private _isDark = false;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(options: GanttEngineImplOptions) {
    const { container, bgCanvas, barsCanvas, ixCanvas, initialZoom, isDark } = options;
    this._isDark = isDark ?? false;
    setRendererColorMode(this._isDark);
    this._container = container;
    this._bgCanvas = bgCanvas;
    this._barsCanvas = barsCanvas;
    this._ixCanvas = ixCanvas;
    this._zoomLevel = initialZoom;

    // Obtain contexts — callers must ensure canvas.getContext('2d') is non-null
    const bgCtx = bgCanvas.getContext('2d');
    const barsCtx = barsCanvas.getContext('2d');
    const ixCtx = ixCanvas.getContext('2d');

    if (!bgCtx || !barsCtx || !ixCtx) {
      throw new Error('GanttEngineImpl: canvas.getContext("2d") returned null');
    }

    this._bgCtx = bgCtx;
    this._barsCtx = barsCtx;
    this._ixCtx = ixCtx;

    // Font set once (rule 71)
    this._bgCtx.font = CANVAS_FONT;
    this._barsCtx.font = CANVAS_FONT;
    this._ixCtx.font = CANVAS_FONT;

    // prefers-reduced-motion (rule 70)
    if (typeof window !== 'undefined') {
      this._reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotion = this._reducedMotionMQ.matches;
      this._reducedMotionMQ.addEventListener('change', this._onReducedMotionChange);
    }

    // ResizeObserver
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(container);

    // Scroll listener
    this._container.addEventListener('scroll', this._onScroll, { passive: true });

    // Pointer listeners on interaction canvas
    this._ixCanvas.addEventListener('pointermove', this._onPointerMove);
    this._ixCanvas.addEventListener('pointerdown', this._onPointerDown);
    this._ixCanvas.addEventListener('pointerup', this._onPointerUp);
    this._ixCanvas.addEventListener('pointercancel', this._onPointerCancel);
    // Keyboard listeners
    this._ixCanvas.addEventListener('dblclick', this._onDblClick);

    // Seed viewport size from container
    this._viewportWidth = container.clientWidth;
    this._viewportHeight = container.clientHeight;

    // Apply DPR and start rAF loop
    this._applyDpr();
    this._rafId = requestAnimationFrame(this._tick);
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Data
  // ---------------------------------------------------------------------------

  setTasks(tasks: Task[]): void {
    this._tasks = tasks;
    this._updateProjectRange();
    this._rebuildScales();
    this._rebuildHitIndex();
    this._fullRepaintPending = true;
  }

  setLinks(links: TaskLink[]): void {
    this._links = links;
    this._fullRepaintPending = true;
  }

  updateTask(taskId: string, patch: Partial<Task>): void {
    const idx = this._tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    this._tasks = this._tasks.slice();
    this._tasks[idx] = { ...this._tasks[idx], ...patch };
    this._rebuildHitIndex();
    this._dirtyRows.add(idx);
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Coordinate system
  // ---------------------------------------------------------------------------

  get scales(): GanttScaleData | null {
    return this._scales;
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Viewport
  // ---------------------------------------------------------------------------

  get scrollLeft(): number {
    return this._scrollLeft;
  }

  setZoom(level: ZoomLevel): void {
    // Preserve center date before zoom
    const centerX = this._scrollLeft + this._viewportWidth / 2;
    const centerDate = this._scales ? leftToDate(centerX, this._scales) : null;

    this._zoomLevel = level;
    this._rebuildScales();
    this._rebuildHitIndex();

    // Restore center date after zoom
    if (centerDate && this._scales) {
      const newCenterX = dateToLeft(centerDate.toISOString().slice(0, 10), this._scales);
      const newScrollLeft = Math.max(0, newCenterX - this._viewportWidth / 2);
      this._container.scrollLeft = newScrollLeft;
    }

    if (this._scales) {
      this._emit('scales-change', { scales: this._scales });
    }
    this._fullRepaintPending = true;
  }

  scrollToDate(isoDate: string, behavior: ScrollBehavior = 'instant'): void {
    if (!this._scales) return;
    const targetX = dateToLeft(isoDate, this._scales);
    const targetScrollLeft = Math.max(0, targetX - this._viewportWidth / 2);

    // Respect reduced motion (rule 70)
    const effectiveBehavior = this._reducedMotion ? 'instant' : behavior;
    this._container.scrollTo({ left: targetScrollLeft, behavior: effectiveBehavior });
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Selection
  // ---------------------------------------------------------------------------

  selectTask(taskId: string | null): void {
    const next = taskId ? new Set([taskId]) : new Set<string>();
    this._applySelection(next);
  }

  selectTasks(taskIds: string[]): void {
    this._applySelection(new Set(taskIds));
  }

  get selectedTaskIds(): ReadonlySet<string> {
    return this._selectedTaskIds;
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Event emitter
  // ---------------------------------------------------------------------------

  on<K extends keyof GanttEngineEventMap>(
    event: K,
    handler: (payload: GanttEngineEventMap[K]) => void,
  ): () => void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    const set = this._handlers.get(event)!;
    // Handler is coerced to the wider type stored in the map
    const h = handler as (payload: unknown) => void;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Color mode
  // ---------------------------------------------------------------------------

  setDark(dark: boolean): void {
    this._isDark = dark;
    setRendererColorMode(dark);
    this._fullRepaintPending = true;
    // The rAF loop is always running; _fullRepaintPending causes a full repaint on the next tick.
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Drag control
  // ---------------------------------------------------------------------------

  cancelDrag(): void {
    const fsm = this._dragFSM;
    const taskId = fsm.context.taskId;
    const currentX = fsm.context.currentX;
    const wasResizing = fsm.state === 'RESIZING';
    fsm.onCancel();

    if (taskId) {
      if (wasResizing) {
        this._emit('resize-task-end', { id: taskId, right: currentX, cancelled: true });
      } else {
        this._emit('drag-task-end', { id: taskId, left: currentX, cancelled: true });
      }
    }

    fsm.reset();
    this._clearIxCanvas();
    this._updateCursor(null);
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Lifecycle
  // ---------------------------------------------------------------------------

  destroy(): void {
    this._isDestroyed = true;
    cancelAnimationFrame(this._rafId);

    this._container.removeEventListener('scroll', this._onScroll);
    this._ixCanvas.removeEventListener('pointermove', this._onPointerMove);
    this._ixCanvas.removeEventListener('pointerdown', this._onPointerDown);
    this._ixCanvas.removeEventListener('pointerup', this._onPointerUp);
    this._ixCanvas.removeEventListener('pointercancel', this._onPointerCancel);
    this._ixCanvas.removeEventListener('dblclick', this._onDblClick);

    this._resizeObserver.disconnect();

    if (this._reducedMotionMQ) {
      this._reducedMotionMQ.removeEventListener('change', this._onReducedMotionChange);
    }

    this._handlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private — Helpers
  // ---------------------------------------------------------------------------

  private _updateProjectRange(): void {
    if (this._tasks.length === 0) return;
    // Skip tasks with empty/missing dates — unscheduled tasks have no position
    const dated = this._tasks.filter((t) => t.start && t.finish);
    const PAD_BEFORE_MS = 30 * 86_400_000;   // 30 days before earliest task
    const PAD_AFTER_MS  = 90 * 86_400_000;   // 90 days after latest task
    if (dated.length === 0) {
      // All tasks unscheduled — default to ±90 days around today
      const today = new Date();
      this._projectStart = new Date(today.getTime() - PAD_BEFORE_MS).toISOString().slice(0, 10);
      this._projectEnd   = new Date(today.getTime() + PAD_AFTER_MS).toISOString().slice(0, 10);
      return;
    }
    let startMs = new Date(dated[0].start + 'T00:00:00Z').getTime();
    let endMs   = new Date(dated[0].finish + 'T00:00:00Z').getTime();
    for (const t of dated) {
      const s = new Date(t.start + 'T00:00:00Z').getTime();
      const e = new Date(t.finish + 'T00:00:00Z').getTime();
      if (s < startMs) startMs = s;
      if (e > endMs)   endMs   = e;
    }
    this._projectStart = new Date(startMs - PAD_BEFORE_MS).toISOString().slice(0, 10);
    this._projectEnd   = new Date(endMs   + PAD_AFTER_MS).toISOString().slice(0, 10);
  }

  private _rebuildScales(): void {
    // Pass 3× the viewport width as the minimum canvas width so the scroll
    // container always extends well past the last task bar at coarse zoom levels
    // (month/quarter/year). Without this, a short project on month zoom produces
    // a canvas only slightly wider than the viewport, making the timeline appear
    // to terminate at the last bar (issue #96).
    const minWidthPx = this._viewportWidth * 3;
    this._scales = buildScaleData(this._zoomLevel, this._projectStart, this._projectEnd, minWidthPx);
  }

  private _rebuildHitIndex(): void {
    if (!this._scales) return;
    this._hitIndex = buildHitIndex(this._tasks, this._scales);
  }

  private _applySelection(next: Set<string>): void {
    this._selectedTaskIds = next;
    this._emit('selection-change', { taskIds: Array.from(next) });
    this._fullRepaintPending = true;
  }

  private _emit<K extends keyof GanttEngineEventMap>(
    event: K,
    payload: GanttEngineEventMap[K],
  ): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      h(payload);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — DPR / resize
  // ---------------------------------------------------------------------------

  private _applyDpr(): void {
    this._dpr = window.devicePixelRatio || 1;
    const w = this._viewportWidth;
    const h = this._viewportHeight;

    // Expose viewport dimensions as CSS custom properties so the sticky canvas
    // wrapper in ScheduleView can match the exact viewport size. Without this, the
    // wrapper's width: 100% resolves to totalCanvasWidth (the scroll spacer's
    // width), making position:sticky left:0 impossible to satisfy — the element
    // is as wide as its containing block and has no room to "stick" (issue #96).
    this._container.style.setProperty('--gantt-vw', `${w}px`);
    this._container.style.setProperty('--gantt-vh', `${h}px`);

    for (const canvas of [this._bgCanvas, this._barsCanvas, this._ixCanvas]) {
      canvas.width = w * this._dpr;
      canvas.height = h * this._dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    // Re-acquire contexts after resize (scale resets)
    const bgCtx = this._bgCanvas.getContext('2d');
    const barsCtx = this._barsCanvas.getContext('2d');
    const ixCtx = this._ixCanvas.getContext('2d');
    if (!bgCtx || !barsCtx || !ixCtx) return;

    this._bgCtx = bgCtx;
    this._barsCtx = barsCtx;
    this._ixCtx = ixCtx;

    this._bgCtx.scale(this._dpr, this._dpr);
    this._barsCtx.scale(this._dpr, this._dpr);
    this._ixCtx.scale(this._dpr, this._dpr);

    // Restore font after context re-acquisition
    this._bgCtx.font = CANVAS_FONT;
    this._barsCtx.font = CANVAS_FONT;
    this._ixCtx.font = CANVAS_FONT;

    this._fullRepaintPending = true;
  }

  private readonly _onResize: ResizeObserverCallback = (entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width !== this._viewportWidth || height !== this._viewportHeight) {
        this._viewportWidth = width;
        this._viewportHeight = height;
        this._applyDpr();
        // Rebuild scales so the minimum canvas width floor (3× viewport) is
        // recalculated after a resize. Without this, shrinking the window and
        // then re-enlarging it could leave the scroll container too narrow.
        this._rebuildScales();
        this._emit('scales-change', { scales: this._scales! });
        this._fullRepaintPending = true;
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Private — Scroll
  // ---------------------------------------------------------------------------

  private readonly _onScroll = (): void => {
    this._scrollLeft = this._container.scrollLeft;
    this._scrollTop = this._container.scrollTop;
    this._emit('scroll', { scrollLeft: this._scrollLeft });
    this._fullRepaintPending = true;
  };

  // ---------------------------------------------------------------------------
  // Private — rAF loop
  // ---------------------------------------------------------------------------

  private readonly _tick = (): void => {
    if (this._isDestroyed) return;
    this._rafId = requestAnimationFrame(this._tick);

    if (!this._scales) return;

    if (this._fullRepaintPending) {
      this._paintBg();
      this._paintAllBars();
      this._fullRepaintPending = false;
      this._dirtyRows.clear();

      if (!this._hasEmittedReady) {
        this._hasEmittedReady = true;
        this._emit('ready', { scales: this._scales });
      }
    } else if (this._dirtyRows.size > 0) {
      for (const rowIndex of this._dirtyRows) {
        this._paintRow(rowIndex);
      }
      this._dirtyRows.clear();
    }

    this._paintInteraction();
  };

  // ---------------------------------------------------------------------------
  // Private — Virtualisation helpers
  // ---------------------------------------------------------------------------

  private _visibleRange(): { firstRow: number; lastRow: number } {
    const overscan = OVERSCAN_ROWS * ROW_HEIGHT;
    // The usable viewport height for tasks is reduced by the fixed header band.
    const minY = this._scrollTop - overscan;
    const maxY = this._scrollTop + this._viewportHeight - HEADER_HEIGHT + overscan;
    const firstRow = Math.max(0, Math.floor(minY / ROW_HEIGHT));
    const lastRow = Math.min(this._tasks.length - 1, Math.ceil(maxY / ROW_HEIGHT));
    return { firstRow, lastRow };
  }

  // ---------------------------------------------------------------------------
  // Private — Paint: background
  // ---------------------------------------------------------------------------

  private _paintBg(): void {
    setRendererColorMode(this._isDark);
    const ctx = this._bgCtx;
    const w = this._viewportWidth;
    const h = this._viewportHeight;

    ctx.clearRect(0, 0, w, h);

    // Surface fill
    ctx.fillStyle = this._isDark ? COLOR_DARK.surface : COLOR.surface;
    ctx.fillRect(0, 0, w, h);

    if (!this._scales) return;

    const { firstRow, lastRow } = this._visibleRange();

    drawRowBands(ctx, firstRow, lastRow, this._scrollLeft, this._scrollTop, w);
    drawGridLines(
      ctx,
      this._scales,
      this._scrollLeft,
      this._scrollTop,
      h,
      firstRow,
      lastRow,
    );
    drawTodayLine(ctx, this._scales, this._scrollLeft, h);
    // Timeline header drawn last so it paints over any content in the header band
    drawTimelineHeader(ctx, this._scales, this._scrollLeft, w);
  }

  // ---------------------------------------------------------------------------
  // Private — Paint: bars
  // ---------------------------------------------------------------------------

  private _paintAllBars(): void {
    const ctx = this._barsCtx;
    const w = this._viewportWidth;
    const h = this._viewportHeight;

    ctx.clearRect(0, 0, w, h);

    if (!this._scales) return;

    const { firstRow, lastRow } = this._visibleRange();

    for (let i = firstRow; i <= lastRow; i++) {
      this._paintTaskAt(ctx, i);
    }

    // Dependency arrows on top of bars
    drawDependencyArrows(ctx, this._tasks, this._links, this._scales, this._scrollLeft, this._scrollTop);
  }

  private _paintRow(rowIndex: number): void {
    setRendererColorMode(this._isDark);
    if (!this._scales) return;
    const ctx = this._barsCtx;
    const rowTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT - this._scrollTop;
    const rowBottom = rowTop + ROW_HEIGHT;

    // Clamp to avoid overwriting the fixed header band
    const clampedTop = Math.max(rowTop, HEADER_HEIGHT);
    const clampedHeight = rowBottom - clampedTop;
    if (clampedHeight <= 0) return;

    // Clear only the row rect (below the header)
    ctx.clearRect(0, clampedTop, this._viewportWidth, clampedHeight);

    // Re-fill surface color for the cleared row
    ctx.fillStyle = this._isDark ? COLOR_DARK.surface : COLOR.surface;
    ctx.fillRect(0, clampedTop, this._viewportWidth, clampedHeight);

    if (rowTop > this._viewportHeight || rowBottom < HEADER_HEIGHT) return;

    this._paintTaskAt(ctx, rowIndex);
  }

  private _paintTaskAt(ctx: CanvasRenderingContext2D, rowIndex: number): void {
    if (!this._scales) return;
    const task = this._tasks[rowIndex];
    if (!task || !task.start || !task.finish) return;

    const isSelected = this._selectedTaskIds.has(task.id);

    // Translate so that scrollTop is offset
    ctx.save();
    ctx.translate(0, -this._scrollTop);

    if (task.isMilestone) {
      drawMilestone(ctx, task, rowIndex, this._scales, this._scrollLeft, isSelected);
    } else if (task.isSummary) {
      drawSummaryBar(ctx, task, rowIndex, this._scales, this._scrollLeft, isSelected);
    } else {
      drawTaskBar(ctx, task, rowIndex, this._scales, this._scrollLeft, isSelected, this._viewportWidth);
    }

    // Actual-date overlay: drawn after the planned bar so it renders on top.
    // Only shown for non-summary tasks that have actual execution data.
    if (!task.isSummary && !task.isMilestone && (task.actualStart || task.actualFinish)) {
      drawActualDateBar(ctx, task, rowIndex, this._scales, this._scrollLeft);
      drawScheduleVarianceBadge(
        ctx, task, rowIndex, this._scales, this._scrollLeft, this._viewportWidth,
      );
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private — Paint: interaction
  // ---------------------------------------------------------------------------

  private _paintInteraction(): void {
    const ctx = this._ixCtx;
    const w = this._viewportWidth;
    const h = this._viewportHeight;

    this._clearIxCanvas();

    const fsm = this._dragFSM;
    if (
      (fsm.state !== 'DRAGGING' && fsm.state !== 'DRAG_STARTED' && fsm.state !== 'RESIZING') ||
      !this._scales
    ) {
      return;
    }

    const { taskId, currentX } = fsm.context;
    if (!taskId) return;

    const task = this._tasks.find((t) => t.id === taskId);
    if (!task) return;

    const rowIndex = this._tasks.indexOf(task);
    if (rowIndex === -1) return;

    ctx.save();
    ctx.translate(0, -this._scrollTop);

    if (fsm.state === 'DRAGGING' || fsm.state === 'DRAG_STARTED') {
      // Subtract drag offset so the shadow's left edge tracks the bar's left edge,
      // not the cursor. Subtract scrollLeft to convert canvas-origin to viewport-relative.
      const snappedX = snapToDayBoundary(currentX - this._dragOffsetX, this._scales) - this._scrollLeft;
      drawDragShadow(ctx, task, snappedX, rowIndex, this._scales);
    } else if (fsm.state === 'RESIZING') {
      const barTop = rowIndex * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET;
      // currentX is canvas-origin; convert to viewport-relative for drawing.
      drawResizeIndicator(ctx, currentX - this._scrollLeft, barTop);
    }

    ctx.restore();

    // Suppress unused variable warning
    void w;
    void h;
  }

  private _clearIxCanvas(): void {
    this._ixCtx.clearRect(0, 0, this._viewportWidth, this._viewportHeight);
  }

  // ---------------------------------------------------------------------------
  // Private — Pointer events
  // ---------------------------------------------------------------------------

  private _pointerToCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this._ixCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) + this._scrollLeft,
      y: (e.clientY - rect.top) + this._scrollTop,
    };
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    if (!this._hitIndex || !this._scales) return;

    // Ignore pointer events in the fixed header band (viewport y < HEADER_HEIGHT)
    const rect = this._ixCanvas.getBoundingClientRect();
    if (e.clientY - rect.top < HEADER_HEIGHT) return;

    const { x, y } = this._pointerToCanvas(e);
    const isTouch = e.pointerType === 'touch';
    const zone = this._hitIndex.query(x, y, isTouch);

    if (!zone) return;

    e.preventDefault();
    const dragType = zone.type === 'resize' ? 'resize' : 'move';
    this._dragFSM.onPointerDown(zone.taskId, x, y, e.pointerId, dragType);
    // Record how far inside the bar the user clicked so the bar follows the
    // grab point rather than jumping its left edge to the cursor.
    this._dragOffsetX = dragType === 'move' ? x - zone.barLeft : 0;
    this._ixCanvas.setPointerCapture(e.pointerId);

    // Emit drag-task or resize-task start
    if (dragType === 'move') {
      this._emit('drag-task', { id: zone.taskId });
    } else {
      this._emit('resize-task', { id: zone.taskId });
    }
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const { x, y } = this._pointerToCanvas(e);
    const result = this._dragFSM.onPointerMove(x, y);

    if (result === 'none' || result === 'started') {
      // Update hover cursor when not dragging
      if (this._hitIndex && this._scales) {
        const isTouch = e.pointerType === 'touch';
        const canvasX = (e.clientX - this._ixCanvas.getBoundingClientRect().left) + this._scrollLeft;
        const canvasY = (e.clientY - this._ixCanvas.getBoundingClientRect().top) + this._scrollTop;
        this._hoverZone = this._hitIndex.query(canvasX, canvasY, isTouch);
        this._updateCursor(this._hoverZone);
      }
      return;
    }

    // result === 'moved'
    const { taskId, isDragType } = this._dragFSM.context;
    if (!taskId || !this._scales) return;

    if (isDragType === 'move') {
      const snappedX = snapToDayBoundary(x - this._dragOffsetX, this._scales);
      this._emit('drag-task-move', { id: taskId, left: snappedX });
      this._updateCursor({ type: 'bar' } as HitZone);
    } else {
      this._emit('resize-task-move', { id: taskId, right: x });
      this._updateCursor({ type: 'resize' } as HitZone);
    }
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    const prevState = this._dragFSM.state;
    this._dragFSM.onPointerUp();

    const { taskId, currentX, isDragType } = this._dragFSM.context;

    if (
      taskId &&
      (prevState === 'DRAGGING' || prevState === 'DRAG_STARTED' || prevState === 'RESIZING')
    ) {
      if (isDragType === 'move') {
        const snappedX = this._scales ? snapToDayBoundary(currentX - this._dragOffsetX, this._scales) : currentX;
        this._emit('drag-task-end', { id: taskId, left: snappedX });
      } else {
        this._emit('resize-task-end', { id: taskId, right: currentX });
      }
    } else if (taskId && prevState === 'HOVER_WAIT') {
      // It was a click, not a drag — select the task
      this.selectTask(taskId);
    }

    this._dragFSM.reset();
    this._ixCanvas.releasePointerCapture(e.pointerId);
    this._clearIxCanvas();
    this._updateCursor(null);
  };

  private readonly _onPointerCancel = (e: PointerEvent): void => {
    this.cancelDrag();
    try {
      this._ixCanvas.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if already released
    }
  };

  private readonly _onDblClick = (e: MouseEvent): void => {
    if (!this._hitIndex || !this._scales) return;
    const rect = this._ixCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) + this._scrollLeft;
    const y = (e.clientY - rect.top) + this._scrollTop;
    const zone = this._hitIndex.query(x, y, false);
    if (zone) {
      this._emit('task-open', { id: zone.taskId });
    }
  };

  // ---------------------------------------------------------------------------
  // Private — Cursor management (rule 84)
  // ---------------------------------------------------------------------------

  private _updateCursor(zone: Pick<HitZone, 'type'> | null): void {
    const state = this._dragFSM.state;
    if (state === 'DRAGGING' || state === 'DRAG_STARTED') {
      this._ixCanvas.style.cursor = 'grabbing';
      return;
    }
    if (state === 'RESIZING') {
      this._ixCanvas.style.cursor = 'col-resize';
      return;
    }
    if (!zone) {
      this._ixCanvas.style.cursor = 'default';
      return;
    }
    switch (zone.type) {
      case 'bar':
        this._ixCanvas.style.cursor = 'grab';
        break;
      case 'resize':
        this._ixCanvas.style.cursor = 'col-resize';
        break;
      case 'link-dot':
        this._ixCanvas.style.cursor = 'crosshair';
        break;
      default:
        this._ixCanvas.style.cursor = 'default';
    }
  }

  // ---------------------------------------------------------------------------
  // Private — prefers-reduced-motion
  // ---------------------------------------------------------------------------

  private readonly _onReducedMotionChange = (e: MediaQueryListEvent): void => {
    this._reducedMotion = e.matches;
  };
}
