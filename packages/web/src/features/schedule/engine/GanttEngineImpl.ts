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
import { GanttLinkFSM } from './GanttLinkFSM';
import { GanttPanFSM } from './GanttPanFSM';
import {
  ROW_HEIGHT,
  BAR_TOP_OFFSET,
  COLOR,
  COLOR_DARK,
  setRendererColorMode,
  setRendererChartOptions,
  CANVAS_FONT,
  drawRowBands,
  drawHoverRowBand,
  drawGridLines,
  drawTodayLine,
  drawTimelineHeader,
  drawTaskBar,
  drawTaskBarLabel,
  drawTimelineNameGutter,
  drawSummaryBar,
  drawMilestone,
  prepareDependencyLayout,
  paintDependencyLayout,
  drawDragShadow,
  drawResizeIndicator,
  drawLinkPreview,
  drawActualDateBar,
  drawScheduleVarianceBadge,
} from './GanttRenderer';
import type { ChartRenderOptions, DependencyLayout } from './GanttRenderer';
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
  // Cached row index of _hoverChain.hoveredId so the per-frame hover-row band
  // (#2096) never scans _tasks; recomputed only when the hovered id changes.
  private _hoverRowIndex = -1;
  // Last hovered task id reported via `task-hover`. Used to debounce the
  // event to taskId transitions only (pointermove fires many times per row).
  private _lastHoveredTaskId: string | null = null;
  private _hitIndex: HitIndex | null = null;
  private _dragFSM: GanttDragFSM = new GanttDragFSM();

  // Drag-to-link (#1666). A third FSM coexisting with the drag/pan FSMs,
  // arbitrated on pointerdown: a `link-dot` hit zone arms this FSM and
  // short-circuits the bar move/resize path entirely, so the two never race.
  // Pointer-only — gated on `_pointerFine` so it never arms on touch (touch
  // users reach dependency creation through the ScheduleDependencyPicker
  // drawer, which stays a11y-complete).
  private _linkFSM: GanttLinkFSM = new GanttLinkFSM();
  /** True on a fine pointer (mouse/pen). Gates drag-to-link arming (rule 84/#1666). */
  private _pointerFine =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: fine)').matches
      : true;

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

  // Touch navigation (#2160). Tablets have no Space key, no middle button, and
  // no ctrl+wheel, so the desktop canvas (768-1024px width) was un-navigable by
  // touch. A single finger on empty canvas pans (bar hits still win); two active
  // fingers pinch-zoom the timeline (rule 66). All active touch points are
  // tracked so the second finger can switch a pan into a pinch.
  private readonly _activeTouches = new Map<number, { x: number; y: number }>();
  /** Live pinch gesture: the span + zoom captured when the second finger landed. */
  private _pinch: {
    startDist: number;
    startPxPerDay: number;
  } | null = null;

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

  // Header-band repaint tracking (issue 1523). The two-row timeline header and
  // the vertical grid walk depend only on scrollLeft, scales, fiscal mode, dark
  // mode, and viewport width — never on scrollTop. A pure vertical scroll leaves
  // the header band (y 0..HEADER_HEIGHT) pixel-identical, yet _onScroll still
  // marks a full bg repaint because the row bands and horizontal separators DO
  // move with scrollTop. Re-walking the (viewport-clamped, but still O(visible
  // days)) header date range twice — major + minor rows — on every vertical
  // scroll frame was the dominant per-frame cost the audit flagged. _paintBg
  // therefore skips drawTimelineHeader and retains the prior header band unless
  // the header content could actually have changed since it was last drawn.
  //
  // The skip is DERIVED from state rather than from a flag each mutator must
  // remember to set: the header is redrawn whenever scrollLeft differs from the
  // scrollLeft it was last drawn at (horizontal scroll / zoom recenter) OR
  // _headerContentDirty is set (scales / fiscal / dark / viewport changed). The
  // -1 / true seeds force a draw on the first paint.
  private _headerContentDirty = true;
  private _lastHeaderScrollLeft = -1;

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
  // forced-colors (Windows High Contrast, #1742): a canvas is not touched by the
  // UA forced-colors transform, so we repaint with system-color keywords when active.
  private _forcedColors = false;
  private _forcedColorsMQ: MediaQueryList | null = null;

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
  // Chart menu presentation toggles (#2097). Applied to the module-level renderer
  // state before each bar/label paint pass, mirroring the _isDark → palette flow.
  private _chartOptions: ChartRenderOptions = {
    taskNamePlacement: 'next',
    showProgressPills: true,
    showNameGutter: false,
  };

  // Quarter/year header tier config (#755) — calendar quarters until the host
  // (ScheduleView) pushes the workspace fiscal config + the user's view pref.
  private _fiscal: FiscalConfig = CALENDAR_QUARTERS;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(options: GanttEngineImplOptions) {
    const { container, bgCanvas, barsCanvas, ixCanvas, initialZoom, isDark } = options;
    this._isDark = isDark ?? false;
    setRendererColorMode(this._isDark, this._forcedColors);
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

      // forced-colors (#1742) — repaint with the system-color palette when active,
      // and re-detect on theme change (High Contrast toggled at runtime).
      this._forcedColorsMQ = window.matchMedia('(forced-colors: active)');
      this._forcedColors = this._forcedColorsMQ.matches;
      setRendererColorMode(this._isDark, this._forcedColors);
      this._forcedColorsMQ.addEventListener('change', this._onForcedColorsChange);
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
    // Keep the cached hover-row index (#2096) valid across data changes — a
    // reorder/insert could otherwise leave the band on the wrong row.
    this._hoverRowIndex = this._hoverChain
      ? tasks.findIndex((t) => t.id === this._hoverChain?.hoveredId)
      : -1;
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

  openTask(taskId: string): void {
    // Mirror the canvas double-click open path (#2205): emit the same
    // 'task-open' event ScheduleView routes into the drawer store, so the
    // keyboard Enter binding and the pointer dblclick share one code path.
    this._emit('task-open', { id: taskId });
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
    // Cache the hovered row index for the hover-row band (#2096) — scanned here
    // (on hover change), never per paint frame.
    this._hoverRowIndex = chain ? this._tasks.findIndex((t) => t.id === chain.hoveredId) : -1;
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
    setRendererColorMode(dark, this._forcedColors);
    this._headerContentDirty = true; // header palette changes (issue 1523)
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
    this._headerContentDirty = true; // header quarter/year labels change (issue 1523)
    this._fullRepaintPending = true;
    this._requestRepaint();
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Chart presentation toggles (#2097)
  // ---------------------------------------------------------------------------

  setChartOptions(options: ChartRenderOptions): void {
    this._chartOptions = options;
    // Toggling names/pills changes only the bars layer, but a full repaint is the
    // cheapest correct path and the call is user-driven (rare).
    this._fullRepaintPending = true;
    this._requestRepaint();
  }

  // ---------------------------------------------------------------------------
  // GanttEngine — Drag control
  // ---------------------------------------------------------------------------

  /**
   * Silently cancel an in-progress drag-to-link gesture (#1666): Escape,
   * pointercancel, or the offline/error guard. No `create-link` is emitted; the
   * preview layer is cleared immediately. No-op when no link gesture is active.
   */
  private _cancelLinkDrag(): void {
    if (this._linkFSM.state === 'IDLE') return;
    this._linkFSM.onCancel();
    this._linkFSM.reset();
    this._clearIxCanvas();
    this._ixDirty = false;
    this._updateCursor(this._hoverZone);
  }

  cancelDrag(): void {
    // Link gesture and bar drag are mutually exclusive (arming a link-dot
    // short-circuits the drag path), but guard defensively so an external
    // Escape/offline caller cancels whichever is live.
    if (this._linkFSM.state !== 'IDLE') {
      this._cancelLinkDrag();
      return;
    }
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
    if (this._forcedColorsMQ) {
      this._forcedColorsMQ.removeEventListener('change', this._onForcedColorsChange);
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
    const PAD_BEFORE_MS = 30 * 86_400_000; // 30 days before earliest task
    const PAD_AFTER_MS = 90 * 86_400_000; // 90 days after latest task
    if (dated.length === 0) {
      // All tasks unscheduled — default to ±90 days around today
      const today = new Date();
      this._projectStart = new Date(today.getTime() - PAD_BEFORE_MS).toISOString().slice(0, 10);
      this._projectEnd = new Date(today.getTime() + PAD_AFTER_MS).toISOString().slice(0, 10);
      return;
    }
    let startMs = new Date(dated[0].start + 'T00:00:00Z').getTime();
    let endMs = new Date(dated[0].finish + 'T00:00:00Z').getTime();
    for (const t of dated) {
      const s = new Date(t.start + 'T00:00:00Z').getTime();
      const e = new Date(t.finish + 'T00:00:00Z').getTime();
      if (s < startMs) startMs = s;
      if (e > endMs) endMs = e;
    }
    this._projectStart = new Date(startMs - PAD_BEFORE_MS).toISOString().slice(0, 10);
    this._projectEnd = new Date(endMs + PAD_AFTER_MS).toISOString().slice(0, 10);
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
    // Header cells (units, tick positions, labels) are scale-dependent too, so
    // force the header band to redraw even if scrollLeft happens to be unchanged
    // (e.g. a zoom that recenters on the same anchor) (issue 1523).
    this._headerContentDirty = true;
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

    // Resizing the canvas backing store wipes every pixel, including the retained
    // header band, and the viewport width the header is laid out against just
    // changed — force a header redraw on the next paint (issue 1523).
    this._headerContentDirty = true;
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
    // A full bg repaint is still required — row bands and horizontal separators
    // move with scrollTop — but the header band is NOT invalidated here: _paintBg
    // derives whether to skip the header date-walk by comparing _scrollLeft to
    // the scrollLeft it was last drawn at, so a pure vertical scroll retains it
    // (issue 1523). Comparing at paint time (not here) also collapses correctly
    // when several scroll events coalesce into one frame.
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
      fsmState === 'DRAGGING' ||
      fsmState === 'DRAG_STARTED' ||
      fsmState === 'RESIZING' ||
      // Drag-to-link paints its preview line to the interaction layer (#1666).
      this._linkFSM.state === 'DRAGGING';

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
    setRendererColorMode(this._isDark, this._forcedColors);
    const ctx = this._bgCtx;
    const w = this._viewportWidth;
    const h = this._viewportHeight;

    // Redraw the header band only when its content could have moved or changed
    // (issue 1523). On a pure vertical scroll scrollLeft is unchanged and no
    // header-affecting state is dirty, so the prior header band is retained and
    // the expensive drawTimelineHeader date-walk is skipped entirely.
    const drawHeader = this._headerContentDirty || this._scrollLeft !== this._lastHeaderScrollLeft;

    if (drawHeader) {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = this._isDark ? COLOR_DARK.surface : COLOR.surface;
      ctx.fillRect(0, 0, w, h);
    } else {
      // Clip every task-area draw below the header band and clear/fill only that
      // region. Row bands and horizontal separators for rows scrolled above the
      // fold overflow upward into the header band and normally rely on
      // drawTimelineHeader (drawn last) to cover them — with the header skipped,
      // the clip is what keeps them from bleeding over the retained header.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, HEADER_HEIGHT, w, h - HEADER_HEIGHT);
      ctx.clip();
      ctx.clearRect(0, HEADER_HEIGHT, w, h - HEADER_HEIGHT);
      ctx.fillStyle = this._isDark ? COLOR_DARK.surface : COLOR.surface;
      ctx.fillRect(0, HEADER_HEIGHT, w, h - HEADER_HEIGHT);
    }

    if (!this._scales) {
      if (!drawHeader) ctx.restore();
      return;
    }

    const { firstRow, lastRow } = this._visibleRange();

    drawRowBands(ctx, firstRow, lastRow, this._scrollLeft, this._scrollTop, w);
    drawGridLines(ctx, this._scales, this._scrollLeft, this._scrollTop, h, firstRow, lastRow);
    drawTodayLine(ctx, this._scales, this._scrollLeft, h);

    if (drawHeader) {
      // Timeline header drawn last so it paints over any content in the header band
      drawTimelineHeader(ctx, this._scales, this._scrollLeft, w, this._fiscal);
      this._headerContentDirty = false;
      this._lastHeaderScrollLeft = this._scrollLeft;
    } else {
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Paint: bars
  // ---------------------------------------------------------------------------

  private _paintAllBars(): void {
    const ctx = this._barsCtx;
    const w = this._viewportWidth;
    const h = this._viewportHeight;

    // Apply Chart menu toggles (name placement / progress pills) for this pass —
    // the bars layer reads them from module state, same as the palette (#2097).
    setRendererChartOptions(this._chartOptions);

    ctx.clearRect(0, 0, w, h);

    if (!this._scales) return;

    const { firstRow, lastRow } = this._visibleRange();

    // Hover-row wash first, so bars and labels paint on top (#2096). Drawn on the
    // bars layer (not bg) because hover invalidates only this layer.
    if (this._hoverRowIndex >= 0) {
      drawHoverRowBand(ctx, this._hoverRowIndex, this._scrollTop, w, h);
    }

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

    // Aligned-left name gutter (#2096) — painted last so it reads as a frozen
    // column the timeline scrolls under. Drawn in screen coords (no translate).
    if (this._chartOptions.showNameGutter) {
      drawTimelineNameGutter(
        ctx,
        this._tasks,
        firstRow,
        lastRow,
        this._scrollTop,
        this._viewportHeight,
      );
    }
  }

  private _paintRow(rowIndex: number): void {
    setRendererColorMode(this._isDark, this._forcedColors);
    setRendererChartOptions(this._chartOptions);
    if (!this._scales) return;
    // The frozen name gutter (#2096) spans the row's left edge; a single-row
    // repaint would draw the bar back over its gutter cell. Promote to a full
    // repaint (cheap, and only in Timeline aligned-left mode) so the gutter is
    // repainted on top afterward.
    if (this._chartOptions.showNameGutter) {
      this._fullRepaintPending = true;
      this._requestRepaint();
      return;
    }
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
      drawTaskBar(
        ctx,
        task,
        rowIndex,
        this._scales,
        this._scrollLeft,
        isSelected,
        this._viewportWidth,
        skipLabel,
      );
    }

    // Actual-date overlay: drawn after the planned bar so it renders on top.
    // Only shown for non-summary tasks that have actual execution data.
    if (!task.isSummary && !task.isMilestone && (task.actualStart || task.actualFinish)) {
      drawActualDateBar(ctx, task, rowIndex, this._scales, this._scrollLeft);
      drawScheduleVarianceBadge(
        ctx,
        task,
        rowIndex,
        this._scales,
        this._scrollLeft,
        this._viewportWidth,
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

    if (!this._scales) return;

    // ── Drag-to-link preview (#1666) ──────────────────────────────────────
    // Painted in VIEWPORT coords (scrollLeft/scrollTop subtracted here) rather
    // than the drag-shadow's canvas-origin + translate convention, because the
    // line endpoints span the source and (possibly far-away) target rows.
    if (this._linkFSM.state === 'DRAGGING') {
      const lc = this._linkFSM.context;
      const originX = lc.sourceBarRight - this._scrollLeft;
      const originY = lc.sourceBarCenterY - this._scrollTop;
      const snapped = lc.targetId != null && lc.targetBarLeft != null && lc.targetBarTop != null;
      let endX = lc.currentX - this._scrollLeft;
      let endY = lc.currentY - this._scrollTop;
      let targetRing: { left: number; top: number; width: number; height: number } | null = null;
      if (
        snapped &&
        lc.targetBarLeft != null &&
        lc.targetBarTop != null &&
        lc.targetBarBottom != null &&
        lc.targetBarRight != null
      ) {
        // Snap the endpoint to the target bar's START-edge midpoint.
        endX = lc.targetBarLeft - this._scrollLeft;
        endY = (lc.targetBarTop + lc.targetBarBottom) / 2 - this._scrollTop;
        targetRing = {
          left: lc.targetBarLeft - this._scrollLeft,
          top: lc.targetBarTop - this._scrollTop,
          width: lc.targetBarRight - lc.targetBarLeft,
          height: lc.targetBarBottom - lc.targetBarTop,
        };
      }
      drawLinkPreview(this._ixCtx, { originX, originY, endX, endY, snapped, targetRing });
      void w;
      void h;
      return;
    }

    const fsm = this._dragFSM;
    if (fsm.state !== 'DRAGGING' && fsm.state !== 'DRAG_STARTED' && fsm.state !== 'RESIZING') {
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
      const snappedX =
        snapToDayBoundary(currentX - this._dragOffsetX, this._scales) - this._scrollLeft;
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
      x: e.clientX - rect.left + this._scrollLeft,
      y: e.clientY - rect.top + this._scrollTop,
    };
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    if (!this._hitIndex || !this._scales) return;

    // ── Touch tracking + two-finger pinch (#2160, rule 66) ────────────────
    // Track every active touch point. The second finger down begins a pinch —
    // canceling any in-progress single-finger pan or bar drag from the first
    // finger — so tablets can zoom the timeline (no ctrl+wheel on touch).
    if (e.pointerType === 'touch') {
      this._activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._activeTouches.size === 2) {
        e.preventDefault();
        this._beginPinch();
        return;
      }
    }

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

    // ── Single-finger touch pan on empty canvas (#2160) ───────────────────
    // A touch that misses every bar / resize handle / link-dot pans the
    // viewport (both axes — this is also the only vertical-scroll path in
    // Timeline mode, which has no task-list panel). Bar hits fall through to
    // the drag path below, so dragging a bar still moves the bar.
    if (isTouch && !zone) {
      if (this._panFSM.startTouch(e.clientX, e.clientY, e.pointerId)) {
        e.preventDefault();
        this._panning = true;
        this._ixCanvas.setPointerCapture(e.pointerId);
        this._updateCursor(null);
      }
      return;
    }

    if (!zone) return;

    // ── Drag-to-link arm (#1666) ──────────────────────────────────────────
    // A link-dot hit arms the link FSM and never falls through to the bar
    // move/resize path — collapsing it into a 'move' drag was the dead-spot
    // this fixes. Pointer-only: on touch (or a coarse pointer) do nothing so
    // the gesture never arms; the picker drawer covers those users.
    if (zone.type === 'link-dot') {
      if (this._pointerFine && e.pointerType !== 'touch') {
        e.preventDefault();
        const centerY = (zone.barTop + zone.barBottom) / 2;
        this._linkFSM.onPointerDown(zone.taskId, zone.barRight, centerY, x, y, e.pointerId);
        try {
          this._ixCanvas.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic pointers (headless tests) are not active — capture is
          // not required; the interaction canvas still receives the move/up.
        }
      }
      return;
    }

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
    // ── Two-finger pinch zoom (#2160, rule 66) ────────────────────────────
    // Recompute the finger span each frame and set pxPerDay from the ratio to
    // the span captured at gesture start — absolute, not incremental, so the
    // zoom never drifts. The pinch midpoint anchors the zoom (rule 128) so the
    // date under the fingers stays put.
    if (e.pointerType === 'touch' && this._activeTouches.has(e.pointerId)) {
      this._activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch && this._activeTouches.size >= 2) {
        const [a, b] = [...this._activeTouches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 0 && this._pinch.startDist > 0) {
          e.preventDefault();
          const midX = (a.x + b.x) / 2;
          const factor = dist / this._pinch.startDist;
          this.setPxPerDay(this._pinch.startPxPerDay * factor, { clientX: midX });
        }
        return;
      }
    }

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

    // ── Drag-to-link move (#1666) ─────────────────────────────────────────
    // While the link FSM owns the gesture it fully consumes pointermove — the
    // bar drag FSM never sees it. Compute the current valid target from the
    // hit index each frame (any bar that is not the source) and drive the
    // crosshair / not-allowed cursor + preview repaint.
    if (this._linkFSM.state !== 'IDLE') {
      const { x: lx, y: ly } = this._pointerToCanvas(e);
      const res = this._linkFSM.onPointerMove(lx, ly);
      if (res !== 'none') {
        const zone = this._hitIndex ? this._hitIndex.query(lx, ly, false) : null;
        const sourceId = this._linkFSM.context.sourceId;
        if (zone && zone.taskId !== sourceId) {
          this._linkFSM.setTarget(zone.taskId, {
            left: zone.barLeft,
            right: zone.barRight,
            top: zone.barTop,
            bottom: zone.barBottom,
          });
          this._ixCanvas.style.cursor = 'crosshair';
        } else {
          this._linkFSM.setTarget(null, null);
          // Over the source bar itself → not-allowed (self-link is rejected);
          // over empty space → keep the crosshair (still hunting for a target).
          this._ixCanvas.style.cursor =
            zone && zone.taskId === sourceId ? 'not-allowed' : 'crosshair';
        }
        this._requestRepaint();
      } else {
        // Armed but below threshold — keep the crosshair, wait for the drag.
        this._ixCanvas.style.cursor = 'crosshair';
      }
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
        const canvasX = e.clientX - this._ixCanvas.getBoundingClientRect().left + this._scrollLeft;
        const canvasY = e.clientY - this._ixCanvas.getBoundingClientRect().top + this._scrollTop;
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

  /**
   * Begin a two-finger pinch (#2160). Cancels whatever the first finger was
   * doing — a single-finger pan or a bar drag — so the pinch owns the gesture,
   * then captures the span and zoom to measure the pinch against.
   */
  private _beginPinch(): void {
    if (this._panning) {
      this._panFSM.reset();
      this._panning = false;
    }
    // If the first finger had grabbed a bar, abort that drag cleanly.
    this.cancelDrag();
    const [a, b] = [...this._activeTouches.values()];
    if (!a || !b) return;
    this._pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      startPxPerDay: this._pxPerDay,
    };
    this._updateCursor(null);
  }

  private readonly _onPointerUp = (e: PointerEvent): void => {
    // ── Touch lift (#2160) ────────────────────────────────────────────────
    // Drop the finger; ending a pinch when fewer than two remain. The pan-end
    // path below still runs for a single-finger touch pan (that finger set
    // `_panning`), returning the FSM to IDLE.
    if (e.pointerType === 'touch') {
      this._activeTouches.delete(e.pointerId);
      if (this._pinch && this._activeTouches.size < 2) this._pinch = null;
    }

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

    // ── Drag-to-link drop (#1666) ─────────────────────────────────────────
    // Commit only when the gesture actually crossed the drag threshold AND is
    // released over a valid target. A release in place (still ARMED), over
    // empty space, or over the source bar (targetId null) is a silent cancel —
    // no create-link event, no toast. The preview is cleared immediately; the
    // real arrow is drawn by the mutation's cache invalidation, not here.
    if (this._linkFSM.state !== 'IDLE') {
      const prevLinkState = this._linkFSM.state;
      const { sourceId, targetId } = this._linkFSM.context;
      this._linkFSM.onPointerUp();
      if (prevLinkState === 'DRAGGING' && sourceId && targetId) {
        this._emit('create-link', { sourceId, targetId });
      }
      this._linkFSM.reset();
      try {
        this._ixCanvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if already released / synthetic pointer.
      }
      this._clearIxCanvas();
      this._ixDirty = false;
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
        const snappedX = this._scales
          ? snapToDayBoundary(currentX - this._dragOffsetX, this._scales)
          : currentX;
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
    if (e.pointerType === 'touch') {
      this._activeTouches.delete(e.pointerId);
      if (this._pinch && this._activeTouches.size < 2) this._pinch = null;
    }
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
    // Escape cancels an in-progress drag-to-link gesture (#1666, rule 28 idiom).
    // The engine owns the gesture via pointer capture, so it also owns its
    // Escape — a global handler, active only while the link FSM is live.
    if (e.key === 'Escape' && this._linkFSM.state !== 'IDLE') {
      this._cancelLinkDrag();
      return;
    }
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
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
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
    const x = e.clientX - rect.left + this._scrollLeft;
    const y = e.clientY - rect.top + this._scrollTop;
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

  // forced-colors change (#1742): flip the palette and force a full repaint so the
  // canvas re-renders in (or out of) the system-color theme immediately.
  private readonly _onForcedColorsChange = (e: MediaQueryListEvent): void => {
    this._forcedColors = e.matches;
    setRendererColorMode(this._isDark, this._forcedColors);
    this._headerContentDirty = true;
    this._fullRepaintPending = true;
    this._requestRepaint();
  };
}
