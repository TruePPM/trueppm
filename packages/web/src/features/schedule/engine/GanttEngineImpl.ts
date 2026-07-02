/**
 * Concrete canvas Gantt renderer implementing the GanttEngine interface.
 *
 * Architecture:
 * - Three stacked canvas elements (bg, bars, interaction) — one responsibility each (rule 59).
 * - rAF loop with dirty-rect invalidation — never full-repaint during drag (rule 60).
 * - The rAF loop parks itself (cancels its own reschedule) once idle — no
 *   pending repaint flag and no active drag/pan gesture — instead of looping
 *   at 60fps forever. Every mutator that sets a repaint flag re-arms it via
 *   `_requestRepaint()` (issue 1569).
 * - Row virtualisation — only paints visible rows + 5-row overscan (rule 61).
 * - devicePixelRatio scaling applied once at init and on ResizeObserver (rule 62).
 * - prefers-reduced-motion evaluated at init and on media query change (rule 70).
 * - Event emitter with unsubscribe — fixes SVAR intercept() memory leak (rule 55).
 */

import type { Task, TaskLink } from '@/types';
import type { GanttEngine, GanttEngineEventMap } from './GanttEngine';
import type { FiscalConfig, GanttScaleData, ZoomLevel } from './GanttScaleData';
import {
  CALENDAR_QUARTERS,
  ZOOM_CONFIGS,
  ZOOM_WHEEL_FACTOR,
  buildScaleDataFromPxPerDay,
  clampPxPerDay,
  dateToLeft,
  leftToDate,
} from './GanttScaleData';
import { buildHitIndex } from './GanttHitIndex';
import type { HitIndex, HitZone } from './GanttHitIndex';
import { GanttDragFSM } from './GanttDragFSM';
import { GanttPanFSM } from './GanttPanFSM';
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
  drawTaskBarLabel,
  drawSummaryBar,
  drawMilestone,
  prepareDependencyLayout,
  paintDependencyLayout,
  drawDragShadow,
  drawResizeIndicator,
  drawActualDateBar,
  drawScheduleVarianceBadge,
} from './GanttRenderer';
import type { DependencyLayout } from './GanttRenderer';
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
  // Cached scroll-independent dependency-arrow geometry (#1000). Rebuilt only
  // when tasks, links, or scales change — NOT on scroll — so panning a
  // dependency-dense schedule re-projects the cached layout instead of
  // rebuilding the full-N routing structures every frame. Invalidated to null.
  private _depLayout: DependencyLayout | null = null;
  private _projectStart = '2024-01-01';
  private _projectEnd = '2025-01-01';
  // Continuous zoom (#351). `pxPerDay` is the source of truth; the discrete
  // `ZoomLevel` is derived from it (via deriveTier in the scale builder) and
  // exposed only through `scales.zoomLevel` for header formatting + the
  // QuarterModeControl gate.
  private _pxPerDay: number;
  private _scrollLeft = 0;
  private _scrollTop = 0;
  private _viewportWidth = 0;
  private _viewportHeight = 0;
  private _selectedTaskIds: Set<string> = new Set();
  // Hover chain — set from the React side (#475). When non-null, the canvas
  // dims out-of-chain bars (globalAlpha 0.25) and recolors in-chain dep
  // arrows (predecessor chain blue, successor chain green). React owns the
  // BFS compute; the engine just paints what it's told.
  private _hoverChain: import('./GanttEngine').HoverChain | null = null;
  // Last hovered task id reported via `task-hover`. Used to debounce the
  // event to taskId transitions only (pointermove fires many times per row).
  private _lastHoveredTaskId: string | null = null;
  private _hitIndex: HitIndex | null = null;
  private _dragFSM: GanttDragFSM = new GanttDragFSM();

  // Drag-to-pan (#491). A separate FSM coexisting with the drag FSM, arbitrated
  // on pointerdown: if Space is held OR the middle button is pressed, the pan
  // FSM claims the gesture and the drag FSM is bypassed. The two flags below
  // feed _updateCursor's precedence (rule 130): _panning → grabbing,
  // _panArmed → grab, else hit-zone cursors.
  private _panFSM: GanttPanFSM = new GanttPanFSM();
  /** True while Space is held with the canvas hovered/focused — pan is armed. */
  private _panArmed = false;
  /** True while a pan gesture is actively dragging the viewport. */
  private _panning = false;
  /** Set when a pan just ended so the synthetic contextmenu is suppressed once. */
  private _suppressNextContextMenu = false;
  /** True while the pointer is over / the canvas has focus — scopes Space-arm. */
  private _canvasHovered = false;

  // Dirty-rect tracking. As of #1499 nothing populates `_dirtyRows` (updateTask
  // was its only producer and now sets `_barsRepaintPending` instead, since a
  // row-only repaint never rebuilds/redraws dependency arrows). The branch
  // below is kept as a general single-row invalidation path for any future
  // mutation that is provably row-local and arrow-independent.
  private _dirtyRows: Set<number> = new Set();
  private _fullRepaintPending = true;
  // Bars-layer-only repaint flag. Set by mutations that only affect the bars
  // canvas (hover chain dimming + arrow recolor, #475; live task patches from
  // updateTask during drag preview, #1499) so we don't clear and redraw the bg
  // layer (row bands, grid, today line, header) — that path produced visible
  // flicker as the cursor moved through rows.
  private _barsRepaintPending = false;

  // rAF
  private _rafId = 0;
  private _isDestroyed = false;
  private _hasEmittedReady = false;
  // True once the interaction canvas has content drawn to it that a later,
  // gesture-idle tick still needs to clear (issue 1569). Lets the tick skip
  // `_paintInteraction`/`_clearIxCanvas` entirely while genuinely idle instead
  // of clearRect-ing an already-blank canvas at 60fps.
  private _ixDirty = false;

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

  // Last snapped x already emitted via drag-task-move for the active drag.
  // A slow drag fires dozens of pointermove events per day column, but the CPM
  // preview only changes when the *snapped start date* changes. Coalescing on
  // this value keeps the worker idle for sub-day cursor jitter (issue 1524).
  // Reset to null at each drag start/end so a new drag never inherits a stale
  // guard value.
  private _lastEmittedDragX: number | null = null;

  // Color mode
  private _isDark = false;

  // Quarter/year header tier config (#755) — calendar quarters until the host
  // (ScheduleView) pushes the workspace fiscal config + the user's view pref.
  private _fiscal: FiscalConfig = CALENDAR_QUARTERS;

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
    // Seed the continuous scale from the initial discrete tier (#351).
    this._pxPerDay = ZOOM_CONFIGS[initialZoom].pxPerDay;

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
    // Pointer-leave clears the hover chain (#475) — without this, moving the
    // cursor out of the canvas while still hovering a bar leaves the chain
    // stuck on screen until the next pointermove.
    this._ixCanvas.addEventListener('pointerleave', this._onPointerLeave);
    // Pointer enter/leave scope the Space-to-arm-pan gesture to the canvas
    // (#491, rule 130) — Space anywhere else (search boxes, the task list) must
    // never arm a pan. pointerenter is distinct from pointermove so the flag is
    // set even before the first move.
    this._ixCanvas.addEventListener('pointerenter', this._onPointerEnter);
    // Keyboard listeners
    this._ixCanvas.addEventListener('dblclick', this._onDblClick);

    // Ctrl/Cmd + wheel over the timeline → cursor-anchored zoom (#351). Plain
    // wheel keeps the browser's native scroll. Trackpad pinch is delivered by
    // the browser AS a ctrl+wheel event, so e.ctrlKey covers both pinch and the
    // explicit Ctrl/Cmd-wheel modifier. Non-passive so we can preventDefault the
    // browser's page-zoom on Ctrl+wheel.
    this._ixCanvas.addEventListener('wheel', this._onWheel, { passive: false });

    // Suppress the contextmenu that a middle/right pan release would otherwise
    // fire (#491, rule 130).
    this._ixCanvas.addEventListener('contextmenu', this._onContextMenu);

    // Space-to-arm pan is scoped to the canvas: the window keydown/keyup only
    // act when the canvas is hovered or focused (#491). A global Space capture
    // would break Space elsewhere (buttons, checkboxes, the page scroll).
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
    }

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
    this._requestRepaint();
  }

  setLinks(links: TaskLink[]): void {
    this._links = links;
    this._depLayout = null; // links changed → arrow layout is stale (#1000)
    this._fullRepaintPending = true;
    this._requestRepaint();
  }

  updateTask(taskId: string, patch: Partial<Task>): void {
    const idx = this._tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    this._tasks = this._tasks.slice();
    this._tasks[idx] = { ...this._tasks[idx], ...patch };
    this._rebuildHitIndex();
    // The patch may move/resize/re-parent the task, changing its arrow geometry
    // (and any arrow anchored to it). Drop the cache so the next repaint
    // re-prepares it (#1000).
    //
    // useScheduleCommit calls this on every drag/resize-end, revert, and
    // "snap to project start" preview (ADR-0067's pull-to-commit gate moves the
    // bar to its pending position ahead of Confirm) — so we must NOT fall
    // through to the dirty-row-only tick branch (#1499): that branch calls
    // _paintRow, which clearRects just the changed row's band and never touches
    // _depLayout — arrows to/from the moved task go stale and any arrow segment
    // crossing that row is erased, with nothing repainting them until an
    // incidental full repaint (scroll, zoom, selection, hover) happens to come
    // along. Instead, route through the same bars-only invalidation flag
    // setHoverChain uses (#475): it skips the bg layer (row bands/grid/today
    // line/header stay untouched, same as the dirty-row path would) but
    // repaints the full bars layer, which rebuilds _depLayout since it's null
    // and redraws every visible arrow — cheap enough for a per-gesture event
    // and correct, unlike a full canvas repaint that would also redraw the bg.
    this._depLayout = null;
    this._barsRepaintPending = true;
    this._requestRepaint();
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

  get pxPerDay(): number | null {
    return this._scales ? this._pxPerDay : null;
  }

  setZoom(level: ZoomLevel): void {
    // Discrete tier selection routes through the continuous path with a
    // viewport-center anchor (rule 80) — keeps a single zoom code path (#351).
    this.setPxPerDay(ZOOM_CONFIGS[level].pxPerDay);
  }

  setPxPerDay(px: number, anchor?: { clientX: number }): void {
    const next = clampPxPerDay(px);
    // No-op when already at the clamped target (e.g. repeated zoom-in at MAX) —
    // avoids a wasted full repaint and a redundant scales-change emit.
    if (next === this._pxPerDay && this._scales) return;

    // Compute the anchor's canvas X and the date currently under it BEFORE the
    // scale changes. Cursor-anchored (rule 128) when a clientX is given; else
    // viewport-center (rule 80).
    let anchorCanvasX: number | null = null;
    let anchorDate: Date | null = null;
    if (this._scales) {
      if (anchor) {
        const rect = this._ixCanvas.getBoundingClientRect();
        const cursorX = anchor.clientX - rect.left; // viewport-relative
        anchorCanvasX = this._scrollLeft + cursorX;
      } else {
        anchorCanvasX = this._scrollLeft + this._viewportWidth / 2;
      }
      anchorDate = leftToDate(anchorCanvasX, this._scales);
    }

    this._pxPerDay = next;
    this._rebuildScales();
    this._rebuildHitIndex();

    // Restore the anchor: keep the same date pinned under the same on-screen x.
    // viewportX = anchorCanvasX - oldScrollLeft (unchanged by zoom); new
    // scrollLeft = newCanvasX(anchorDate) - viewportX. For viewport-center the
    // viewportX is simply viewportWidth/2.
    if (anchorDate && anchorCanvasX !== null && this._scales) {
      const viewportX = anchor ? anchorCanvasX - this._scrollLeft : this._viewportWidth / 2;
      const newAnchorCanvasX = dateToLeft(anchorDate.toISOString().slice(0, 10), this._scales);
      const newScrollLeft = Math.max(0, newAnchorCanvasX - viewportX);
      this._container.scrollLeft = newScrollLeft;
    }

    if (this._scales) {
      this._emit('scales-change', { scales: this._scales });
    }
    this._fullRepaintPending = true;
    this._requestRepaint();
  }

  fitToProject(): void {
    if (!this._scales) return;
    // Fit [project.start, project.end] into the viewport width with a small
    // margin, then scroll the start near the left edge (#351, ⌘0). The project
    // range here is the padded extent the engine already tracks; using the raw
    // task span without padding would clip the leading/trailing buffer.
    const startMs = new Date(this._projectStart + 'T00:00:00Z').getTime();
    const endMs = new Date(this._projectEnd + 'T00:00:00Z').getTime();
    const spanDays = Math.max(1, (endMs - startMs) / 86_400_000);
    const MARGIN = 0.92; // leave ~8% breathing room so end bars aren't flush
    const targetPxPerDay = (this._viewportWidth * MARGIN) / spanDays;

    this.setPxPerDay(targetPxPerDay);
    // setPxPerDay rebuilt the scale; scroll the project start near the left edge
    // (a small inset so the leading pad doesn't sit exactly at x=0). scrollToDate
    // centers, which would push half the project off-screen left, so set
    // scrollLeft directly here.
    if (this._scales) {
      const startX = dateToLeft(this._projectStart, this._scales);
      const INSET_PX = this._viewportWidth * ((1 - MARGIN) / 2);
      this._container.scrollLeft = Math.max(0, startX - INSET_PX);
    }
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
  // GanttEngine — Hover chain (#475)
  // ---------------------------------------------------------------------------

  setHoverChain(chain: import('./GanttEngine').HoverChain | null): void {
    // Reference comparison is enough — React calls with a stable identity
    // until the BFS result actually changes (useMemo in useDependencyHover).
    if (this._hoverChain === chain) return;
    this._hoverChain = chain;
    // Hover affects bars and arrows but NOT the bg layer (row bands, grid,
    // today line, header). Invalidating only the bars layer avoids the
    // visible flash on the bg canvas as the cursor sweeps across rows.
    this._barsRepaintPending = true;
    this._requestRepaint();
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
    // The rAF loop may be parked (issue 1569) — re-arm it so the next tick actually
    // runs and picks up the pending full repaint.
    this._requestRepaint();
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Fiscal quarters (#755)
  // ---------------------------------------------------------------------------

  setFiscalConfig(config: FiscalConfig): void {
    this._fiscal = config;
    // Only the header tiers change, but a full repaint is the cheapest correct
    // path (header is redrawn on every full paint) and the call is rare.
    this._fullRepaintPending = true;
    this._requestRepaint();
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
    this._lastEmittedDragX = null;
    this._clearIxCanvas();
    // The gesture ended synchronously here — nothing left for the tick to
    // clear on a follow-up frame (issue 1569).
    this._ixDirty = false;
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
    this._ixCanvas.removeEventListener('pointerleave', this._onPointerLeave);
    this._ixCanvas.removeEventListener('pointerenter', this._onPointerEnter);
    this._ixCanvas.removeEventListener('dblclick', this._onDblClick);
    this._ixCanvas.removeEventListener('wheel', this._onWheel);
    this._ixCanvas.removeEventListener('contextmenu', this._onContextMenu);

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
    }

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
    this._scales = buildScaleDataFromPxPerDay(
      this._pxPerDay,
      this._projectStart,
      this._projectEnd,
      minWidthPx,
    );
    // Arrow geometry is scale-dependent (dateToLeft/dateToRight) — drop the cache
    // so the next paint rebuilds it. Covers setTasks (calls here) and zoom (#1000).
    this._depLayout = null;
  }

  private _rebuildHitIndex(): void {
    if (!this._scales) return;
    this._hitIndex = buildHitIndex(this._tasks, this._scales);
  }

  private _applySelection(next: Set<string>): void {
    this._selectedTaskIds = next;
    this._emit('selection-change', { taskIds: Array.from(next) });
    this._fullRepaintPending = true;
    this._requestRepaint();
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
        this._requestRepaint();
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
    this._requestRepaint();
  };

  // ---------------------------------------------------------------------------
  // Private — rAF loop
  // ---------------------------------------------------------------------------

  /**
   * Re-arms the rAF loop if it is currently parked.
   *
   * The loop cancels its own reschedule once idle (issue 1569) — an open, static
   * Gantt must not pin the compositor at 60fps with an unconditional
   * `clearRect`. Every mutator that flips a repaint flag (or starts a
   * drag/pan gesture) calls this so the next paint isn't stranded waiting for
   * some unrelated event to happen to wake the loop back up.
   */
  private _requestRepaint(): void {
    if (this._isDestroyed || this._rafId !== 0) return;
    this._rafId = requestAnimationFrame(this._tick);
  }

  private readonly _tick = (): void => {
    if (this._isDestroyed) return;
    // Consume this frame's id up front; re-armed at the bottom only if work
    // remains. Parking here (rather than always rescheduling) is what lets an
    // idle Gantt stop running entirely instead of spinning at 60fps (issue 1569).
    this._rafId = 0;

    if (!this._scales) {
      // Nothing paintable yet. setTasks()/setPxPerDay() call _requestRepaint()
      // once _rebuildScales() gives us scale data, so no self-reschedule here.
      return;
    }

    const fsmState = this._dragFSM.state;
    // Only DRAGGING/DRAG_STARTED/RESIZING draw to the interaction canvas
    // (_paintInteraction below) — panning never touches it (drag shadow /
    // resize indicator are drag-FSM-only), so it's excluded here.
    const gestureActive =
      fsmState === 'DRAGGING' || fsmState === 'DRAG_STARTED' || fsmState === 'RESIZING';

    if (this._fullRepaintPending) {
      this._paintBg();
      this._paintAllBars();
      this._fullRepaintPending = false;
      this._barsRepaintPending = false;
      this._dirtyRows.clear();

      if (!this._hasEmittedReady) {
        this._hasEmittedReady = true;
        this._emit('ready', { scales: this._scales });
      }
    } else if (this._barsRepaintPending) {
      // Bars-only invalidation (hover chain) — skip the bg layer entirely.
      this._paintAllBars();
      this._barsRepaintPending = false;
      this._dirtyRows.clear();
    } else if (this._dirtyRows.size > 0) {
      for (const rowIndex of this._dirtyRows) {
        this._paintRow(rowIndex);
      }
      this._dirtyRows.clear();
    }

    // Interaction layer: paint (and mark dirty) only while a drag/resize
    // gesture is actually live. Once idle, clear once more if the last frame
    // left something drawn, then stop touching this canvas — an idle Gantt
    // must not clearRect the full viewport every frame (issue 1569). Note that
    // pointerup/pointercancel/cancelDrag already clear synchronously and reset
    // `_ixDirty`, so this branch is normally a no-op safety net, not the
    // primary cleanup path.
    if (gestureActive) {
      this._paintInteraction();
      this._ixDirty = true;
    } else if (this._ixDirty) {
      this._clearIxCanvas();
      this._ixDirty = false;
    }

    if (
      this._fullRepaintPending ||
      this._barsRepaintPending ||
      this._dirtyRows.size > 0 ||
      gestureActive ||
      this._ixDirty
    ) {
      this._rafId = requestAnimationFrame(this._tick);
    }
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
    drawTimelineHeader(ctx, this._scales, this._scrollLeft, w, this._fiscal);
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

    // Layer order on canvas-bars: bars (no labels) → arrows → labels.
    //
    // The horizontal exit/entry segment of every dependency arrow runs at
    // row-center y, which is exactly where the task name label sits. If the
    // arrows are drawn on top of the labels (the natural last-pass position)
    // they cut horizontally through the text and look like a strikethrough.
    // Drawing labels last keeps text readable on top of any crossing arrow.
    for (let i = firstRow; i <= lastRow; i++) {
      this._paintTaskAt(ctx, i, /* skipLabel */ true);
    }

    // Prepare the scroll-independent arrow geometry once per data/zoom change and
    // reuse it across scroll/hover repaints (#1000). _onScroll only flips
    // _fullRepaintPending; it never invalidates _depLayout, so panning re-projects
    // the cache instead of rebuilding the full-N routing structures every frame.
    if (!this._depLayout) {
      this._depLayout = prepareDependencyLayout(this._tasks, this._links, this._scales);
    }
    paintDependencyLayout(
      ctx,
      this._depLayout,
      this._scrollLeft,
      this._scrollTop,
      this._selectedTaskIds,
      this._hoverChain,
    );

    for (let i = firstRow; i <= lastRow; i++) {
      const task = this._tasks[i];
      if (!task || task.isMilestone || task.isSummary) continue;
      ctx.save();
      ctx.translate(0, -this._scrollTop);
      drawTaskBarLabel(ctx, task, i, this._scales, this._scrollLeft, this._viewportWidth);
      ctx.restore();
    }
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

  private _paintTaskAt(ctx: CanvasRenderingContext2D, rowIndex: number, skipLabel = false): void {
    if (!this._scales) return;
    const task = this._tasks[rowIndex];
    if (!task || !task.start || !task.finish) return;

    const isSelected = this._selectedTaskIds.has(task.id);

    // Hover-chain dimming (#475) — bars NOT in the hovered task's chain fade
    // to 25% opacity. The chain set is empty when no hover is active.
    const isInChain =
      this._hoverChain == null
        ? true
        : task.id === this._hoverChain.hoveredId ||
          this._hoverChain.predecessors.has(task.id) ||
          this._hoverChain.successors.has(task.id);

    // Translate so that scrollTop is offset
    ctx.save();
    ctx.translate(0, -this._scrollTop);
    if (!isInChain) ctx.globalAlpha = 0.25;

    if (task.isMilestone) {
      drawMilestone(ctx, task, rowIndex, this._scales, this._scrollLeft, isSelected);
    } else if (task.isSummary) {
      drawSummaryBar(ctx, task, rowIndex, this._scales, this._scrollLeft, isSelected);
    } else {
      drawTaskBar(ctx, task, rowIndex, this._scales, this._scrollLeft, isSelected, this._viewportWidth, skipLabel);
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

    // ── Pan arbitration (#491, rule 129) ──────────────────────────────────
    // Space-held OR middle button claims the gesture; the drag FSM is bypassed.
    // Middle-click pans immediately (no arm step); preventDefault suppresses the
    // browser's middle-click auto-scroll puck. Pan is allowed to start anywhere
    // on the canvas including the header band — only task drag is header-gated.
    const isMiddle = e.button === 1;
    if (this._panArmed || isMiddle) {
      const claimed = this._panFSM.start(e.clientX, e.clientY, e.pointerId, isMiddle);
      if (claimed) {
        e.preventDefault();
        this._panning = true;
        this._ixCanvas.setPointerCapture(e.pointerId);
        this._updateCursor(null);
        return;
      }
    }

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
      // Fresh drag: clear the coalescing guard so the first move always emits.
      this._lastEmittedDragX = null;
      this._emit('drag-task', { id: zone.taskId });
    } else {
      this._emit('resize-task', { id: zone.taskId });
    }
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    // ── Pan move (#491) ───────────────────────────────────────────────────
    // Direct 1:1 manipulation on both axes. Dragging content right (positive
    // dx) reveals earlier dates, so scrollLeft decreases by dx; same for dy.
    // Clamp to [0, max] on each axis (rule 129). The vertical scroll change
    // flows back to the task-list via the container's scroll event → the
    // ScheduleView scroll-sync handler (taskListScrollRef), so no extra wiring
    // is needed here.
    const panDelta = this._panFSM.move(e.clientX, e.clientY);
    if (panDelta) {
      const maxLeft = Math.max(0, (this._scales?.totalWidth ?? 0) - this._viewportWidth);
      const maxTop = Math.max(0, this._container.scrollHeight - this._container.clientHeight);
      this._container.scrollLeft = Math.min(maxLeft, Math.max(0, this._scrollLeft - panDelta.dx));
      this._container.scrollTop = Math.min(maxTop, Math.max(0, this._scrollTop - panDelta.dy));
      return;
    }

    const { x, y } = this._pointerToCanvas(e);
    const result = this._dragFSM.onPointerMove(x, y);
    if (result !== 'none') {
      // The FSM just entered (or is continuing) DRAG_STARTED/DRAGGING/RESIZING
      // — the tick may be parked (issue 1569), and nothing else marks a repaint
      // flag for the interaction-canvas drag shadow, so wake it explicitly.
      this._requestRepaint();
    }

    if (result === 'none' || result === 'started') {
      // Update hover cursor when not dragging
      if (this._hitIndex && this._scales) {
        const isTouch = e.pointerType === 'touch';
        const canvasX = (e.clientX - this._ixCanvas.getBoundingClientRect().left) + this._scrollLeft;
        const canvasY = (e.clientY - this._ixCanvas.getBoundingClientRect().top) + this._scrollTop;
        this._hoverZone = this._hitIndex.query(canvasX, canvasY, isTouch);
        this._updateCursor(this._hoverZone);
        // Emit task-hover transitions so React-side useDependencyHover can
        // recompute the chain (#475). Coalesced to taskId changes only —
        // pointermove fires dozens of times per row but the chain only needs
        // to refresh when the underlying task changes.
        const hoveredTaskId = this._hoverZone?.taskId ?? null;
        if (hoveredTaskId !== this._lastHoveredTaskId) {
          this._lastHoveredTaskId = hoveredTaskId;
          this._emit('task-hover', { taskId: hoveredTaskId });
        }
      }
      return;
    }

    // result === 'moved'
    const { taskId, isDragType } = this._dragFSM.context;
    if (!taskId || !this._scales) return;

    if (isDragType === 'move') {
      const snappedX = snapToDayBoundary(x - this._dragOffsetX, this._scales);
      // Only emit when the snapped start date actually changes. The visual drag
      // shadow is repainted from the FSM's raw currentX above (via
      // _requestRepaint), so suppressing a same-day emit never stutters the bar —
      // it only spares useDragCpm/the worker a redundant CPM recompute (#1524).
      if (snappedX !== this._lastEmittedDragX) {
        this._lastEmittedDragX = snappedX;
        this._emit('drag-task-move', { id: taskId, left: snappedX });
      }
      this._updateCursor({ type: 'bar' } as HitZone);
    } else {
      this._emit('resize-task-move', { id: taskId, right: x });
      this._updateCursor({ type: 'resize' } as HitZone);
    }
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    // ── Pan end (#491) ────────────────────────────────────────────────────
    if (this._panning) {
      this._panFSM.end(this._panArmed);
      this._panning = false;
      // A right/middle-button release fires a synthetic contextmenu next tick;
      // suppress it once so a pan release never opens the context menu (rule 130).
      this._suppressNextContextMenu = true;
      try {
        this._ixCanvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if already released.
      }
      // Cursor returns to grab (still armed) or default (disarmed).
      this._updateCursor(this._hoverZone);
      return;
    }

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
    this._lastEmittedDragX = null;
    this._ixCanvas.releasePointerCapture(e.pointerId);
    this._clearIxCanvas();
    // The gesture ended synchronously here — nothing left for the tick to
    // clear on a follow-up frame (issue 1569).
    this._ixDirty = false;
    this._updateCursor(null);
  };

  private readonly _onPointerCancel = (e: PointerEvent): void => {
    if (this._panning) {
      this._panFSM.reset();
      this._panning = false;
    }
    this.cancelDrag();
    try {
      this._ixCanvas.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if already released
    }
  };

  private readonly _onPointerEnter = (): void => {
    // Scope Space-to-arm-pan to the canvas (#491, rule 130).
    this._canvasHovered = true;
  };

  private readonly _onPointerLeave = (): void => {
    // Clear hover state when the cursor leaves the canvas entirely (#475).
    if (this._lastHoveredTaskId !== null) {
      this._lastHoveredTaskId = null;
      this._emit('task-hover', { taskId: null });
    }
    this._hoverZone = null;
    // Leaving the canvas un-scopes the Space-arm gesture. A pan in progress is
    // unaffected — pointer capture keeps the gesture alive past the edge.
    this._canvasHovered = false;
    this._updateCursor(null);
  };

  // ---------------------------------------------------------------------------
  // Private — Wheel zoom (#351)
  // ---------------------------------------------------------------------------

  private readonly _onWheel = (e: WheelEvent): void => {
    // Only zoom when Ctrl/Cmd is held (the issue: plain wheel keeps scrolling).
    // The browser delivers trackpad pinch AS a ctrl+wheel event, so e.ctrlKey
    // covers both pinch and the explicit modifier (rule 128). e.metaKey is
    // accepted too for the Cmd-wheel convention on macOS browsers that set it.
    if (!e.ctrlKey && !e.metaKey) return;
    // Prevent the browser's native page zoom on Ctrl/Cmd+wheel.
    e.preventDefault();
    if (!this._scales) return;
    // deltaY < 0 (scroll up / pinch out) → zoom in → multiply px/day.
    const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
    this.setPxPerDay(this._pxPerDay * factor, { clientX: e.clientX });
  };

  // ---------------------------------------------------------------------------
  // Private — Space-to-arm pan (#491)
  // ---------------------------------------------------------------------------

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    // Arm pan on Space only when the canvas is hovered/focused — never a global
    // capture (rule 130). Ignore auto-repeat. Don't hijack Space typed into an
    // input that happens to overlap; the canvas-hover scope already excludes
    // most of those, but bail if the target is an editable element.
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!this._canvasHovered) return;
    if (this._isEditableTarget(e.target)) return;
    if (e.repeat) return;
    // Suppress the page scroll Space would otherwise trigger while panning.
    e.preventDefault();
    this._panArmed = true;
    this._panFSM.arm();
    if (!this._panning) this._updateCursor(this._hoverZone);
  };

  private readonly _onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    this._panArmed = false;
    this._panFSM.disarm();
    if (!this._panning) this._updateCursor(this._hoverZone);
  };

  private _isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target.isContentEditable
    );
  }

  // ---------------------------------------------------------------------------
  // Private — Context menu suppression after pan (#491, rule 130)
  // ---------------------------------------------------------------------------

  private readonly _onContextMenu = (e: MouseEvent): void => {
    if (this._panning || this._suppressNextContextMenu) {
      e.preventDefault();
      this._suppressNextContextMenu = false;
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
    // Pan precedence (rule 130, extends rule 84): an active pan forces
    // 'grabbing' over the whole canvas; an armed (Space-held) pan forces 'grab'
    // and overrides any hit-zone cursor; otherwise the existing drag/hit-zone
    // logic applies.
    if (this._panning) {
      this._ixCanvas.style.cursor = 'grabbing';
      return;
    }
    if (this._panArmed) {
      this._ixCanvas.style.cursor = 'grab';
      return;
    }
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
