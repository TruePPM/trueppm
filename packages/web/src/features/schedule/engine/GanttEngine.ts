/**
 * Public API contract for the TruePPM canvas Gantt renderer.
 *
 * This interface is the sole integration boundary between the React shell
 * and the canvas renderer. Consumers (ScheduleView, useDragCpm,
 * useKeyboardReschedule, MonteCarloTimeline, PreviewOverlay) hold a
 * GanttEngine reference — they never reach inside the renderer.
 *
 * Versioned: any breaking change to this interface requires an ADR entry.
 * Replaces SVAR's IApi (which had no stable public coordinate API and no
 * unsubscribe mechanism on its intercept() method).
 */

import type { Task, TaskLink } from '@/types';
import type { CadenceSegment, SprintBand } from '../sprintBands';
import type { RowMode } from '../deliveryModePresentation';
import type { FiscalConfig, GanttScaleData, ZoomLevel } from './GanttScaleData';
import type { ChartRenderOptions } from './GanttRenderer';

/**
 * Hover chain payload pushed from React via `engine.setHoverChain` (#475).
 *
 * `predecessors` and `successors` are BFS-reachable closures from `hoveredId`
 * over the dependency graph. The renderer paints arrows in blue when both
 * endpoints are in `predecessors ∪ {hoveredId}` and in green when both are in
 * `successors ∪ {hoveredId}`; everything else dims.
 */
export interface HoverChain {
  hoveredId: string;
  predecessors: ReadonlySet<string>;
  successors: ReadonlySet<string>;
}

/**
 * The label filter's paint instruction (#2384, ADR-0631).
 *
 * Pure id sets — the engine never evaluates a predicate. `dimmed` holds the
 * rows to paint at reduced contrast; `matched` holds the rows that earn a
 * leading marker. A summary that is neither (a *context* row, whose children
 * match but which does not itself) appears in no set: full contrast, no marker.
 */
export interface FilterHighlight {
  dimmed: ReadonlySet<string>;
  matched: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export interface GanttEngineEventMap {
  /**
   * Fired once when the engine has painted its first frame and scale data
   * is available. After this, engine.scales is non-null.
   */
  ready: { scales: GanttScaleData };

  /**
   * Fired on every scroll tick (throttled to rAF, ~60fps max).
   * `scrollLeft` is in logical pixels.
   */
  scroll: { scrollLeft: number };

  /**
   * Fired whenever the coordinate system changes: zoom level change,
   * pinch-to-zoom, window resize, or project date range change.
   */
  'scales-change': { scales: GanttScaleData };

  /**
   * Fired when the user starts dragging a task bar (pointerdown + move > 4px).
   * Equivalent to SVAR's 'drag-task' intercept payload.
   */
  'drag-task': { id: string };

  /**
   * Fired on every pointermove during drag (throttled to rAF).
   * `left` is the canvas-origin x-coordinate of the dragged bar's left edge,
   * snapped to the nearest working-day boundary.
   */
  'drag-task-move': { id: string; left: number };

  /**
   * Fired when the user releases (pointerup) or cancels (Escape /
   * pointercancel) a drag.
   * `cancelled` is true on Escape or pointercancel — commit must be skipped.
   */
  'drag-task-end': { id: string; left: number; cancelled?: boolean };

  /**
   * Fired when the user starts dragging the right edge of a task bar
   * (resize handle, cursor = col-resize).
   */
  'resize-task': { id: string };

  /**
   * Fired on every pointermove during resize. `right` is canvas-origin x
   * of the bar's right edge.
   */
  'resize-task-move': { id: string; right: number };

  /**
   * Fired on pointerup / cancel during resize.
   */
  'resize-task-end': { id: string; right: number; cancelled?: boolean };

  /**
   * Fired when the user completes a dependency link creation gesture
   * (drag from source bar's right-edge dot to a target bar).
   * Default type is FS; the type selector popover is shown after this fires.
   */
  'create-link': { sourceId: string; targetId: string };

  /**
   * Fired on task bar double-click or Enter key while the bar is focused.
   * Consumers should open the task detail panel.
   */
  'task-open': { id: string };

  /**
   * Fired whenever the selection set changes (click, Shift+click,
   * Cmd+click, or keyboard navigation).
   */
  'selection-change': { taskIds: string[] };

  /**
   * Fired when the pointer enters or leaves a task hit zone on the canvas
   * (#475 hover chain). Payload `taskId` is null when the cursor moves off
   * every bar / milestone / summary endcap. React's `useDependencyHover`
   * listener computes the chain and pushes it back via `setHoverChain`.
   *
   * Coalesced internally — only fires when the hovered task id actually
   * changes between pointermove events, so listeners don't see noise.
   */
  'task-hover': { taskId: string | null };
}

// ---------------------------------------------------------------------------
// GanttEngine interface
// ---------------------------------------------------------------------------

export interface GanttEngine {
  // ── Data ──────────────────────────────────────────────────────────────────

  /**
   * Replace the full task list. The renderer diffs against the previous list
   * and issues dirty-rect repaints only for changed rows.
   */
  setTasks(tasks: Task[]): void;

  /**
   * Replace the full dependency link list. Triggers a dependency-arrow repaint.
   */
  setLinks(links: TaskLink[]): void;

  /**
   * Tell the engine its row geometry changed (#2997).
   *
   * Row height is a **runtime** value — 28px on a mouse, 44px on a coarse
   * pointer — so a tablet gaining or losing a keyboard moves every row. React
   * re-renders the outline on its own; the canvas does not, because it paints
   * from an imperative rAF loop that only re-arms when a mutator marks it dirty.
   * Without this call the DOM list sits at the new pitch while the canvas is
   * still painted **and hit-tested** at the old one until some incidental
   * repaint (a scroll, a hover, a zoom) happens to land — and the symptom of
   * that window is not a visual glitch, it is taps opening the row above or
   * below the one under the finger.
   *
   * Takes no argument on purpose: the height is read from the module binding
   * the renderer and the hit index already share, so there is no second value
   * to keep in step (web rule 315).
   */
  rowMetricsChanged(): void;

  /**
   * Apply a partial update to a single task without replacing the full list.
   * Used for real-time collaboration (WebSocket remote updates) — repaints
   * only the affected row, leaving all other rows untouched.
   */
  updateTask(taskId: string, patch: Partial<Task>): void;

  // ── Coordinate system ─────────────────────────────────────────────────────

  /**
   * Current coordinate system. Null until the engine fires 'ready'.
   * After 'ready', always non-null. Read-only — consumers never mutate this.
   */
  readonly scales: GanttScaleData | null;

  // ── Viewport ──────────────────────────────────────────────────────────────

  /**
   * Current horizontal scroll offset in logical pixels.
   * Updated synchronously on each scroll event; safe to read in rAF loops.
   */
  readonly scrollLeft: number;

  /**
   * Programmatically change the zoom level (discrete tier).
   * Routes through `setPxPerDay` with the tier's canonical `pxPerDay` and a
   * viewport-center anchor. Triggers a 'scales-change' event + full repaint.
   */
  setZoom(level: ZoomLevel): void;

  /**
   * Set the continuous zoom (#351). `pxPerDay` is clamped to the
   * [MIN_PX_PER_DAY, MAX_PX_PER_DAY] band; the discrete `ZoomLevel` is derived
   * from it for header formatting and consumer gating.
   *
   * Anchoring:
   * - With `anchor.clientX`: CURSOR-ANCHORED — the date under the cursor stays
   *   fixed (wheel / pinch). The clientX is viewport-relative; the engine
   *   converts it to a canvas X internally.
   * - Without `anchor`: VIEWPORT-CENTER — preserves the viewport-midpoint date
   *   (rule 80; used by the toolbar +/- buttons and keyboard zoom).
   *
   * Triggers a 'scales-change' event + full repaint.
   */
  setPxPerDay(px: number, anchor?: { clientX: number }): void;

  /**
   * Current continuous zoom in logical px/day. Mirrors `scales.pxPerMs`
   * (× 86,400,000); null until the engine fires 'ready'. The toolbar reads this
   * to disable +/- at the band edges and to render the derived tier label.
   */
  readonly pxPerDay: number | null;

  /**
   * Fit the whole project into the viewport width (#351, ⌘0). Computes the
   * `pxPerDay` so `[project.start, max(task finish)]` fits with a small margin,
   * then scrolls so the project start lands near the left edge.
   * Triggers a 'scales-change' event + full repaint.
   */
  fitToProject(): void;

  /**
   * Scroll the timeline so that the given date is centered in the viewport.
   * `behavior: 'smooth'` animates the scroll (respects prefers-reduced-motion).
   * `behavior: 'instant'` (default) jumps immediately.
   */
  scrollToDate(isoDate: string, behavior?: ScrollBehavior): void;

  // ── Selection ─────────────────────────────────────────────────────────────

  /**
   * Select a single task by id. Pass null to deselect all.
   * Emits 'selection-change'.
   */
  selectTask(taskId: string | null): void;

  /**
   * Replace the full selection set (used for Shift+click / Cmd+click / keyboard).
   * Emits 'selection-change'.
   */
  selectTasks(taskIds: string[]): void;

  /**
   * Open the task detail drawer for a task. Emits 'task-open' — the same event
   * a canvas double-click raises — so pointer and keyboard share one open path
   * (#2160/#2205). Used by the ARIA overlay's Enter binding so keyboard users
   * reach task details from a focused bar (WCAG 2.1.1 consistency).
   */
  openTask(taskId: string): void;

  /** Current selection. Immutable — do not mutate the returned set. */
  readonly selectedTaskIds: ReadonlySet<string>;

  // ── Hover chain (#475) ───────────────────────────────────────────────────

  /**
   * Push the hovered-task chain set to the canvas so it can dim non-chain
   * bars and recolor in-chain dependency arrows (blue = predecessor chain,
   * green = successor chain). Pass `null` to clear the chain — non-chain
   * dimming and chain coloring stop.
   *
   * Driven by React: `TaskListRow.onMouseEnter` raises a callback that
   * flows through `ScheduleView` and `useDependencyHover`, which composes
   * the predecessor and successor sets via BFS over the dependency graph
   * and then calls this setter. The engine never recomputes — it only
   * paints what it's told.
   */
  setHoverChain(chain: HoverChain | null): void;

  // ── Filter highlight (#2384) ──────────────────────────────────────────────

  /**
   * Push the label filter's dim set (ADR-0631).
   *
   * The Schedule dims rather than hides, because a filtered-out task still
   * drives dates and still owns the arrows that explain where a matching bar
   * sits. Pass `null` to clear — which is also what the host passes when the
   * filter matches nothing, since dimming *every* row reads as broken rather
   * than as an empty result.
   *
   * The engine classifies nothing: the host computes the state with
   * `classifyScheduleRows` and pushes the resulting id sets here, the same
   * one-way contract as {@link setHoverChain}.
   *
   * TODO(#2443): no caller yet. Taking pure id sets rather than a predicate is
   * what makes this vocabulary-agnostic, so the shared filter vocabulary can
   * drive it unchanged when the Schedule filter surface lands in #2443/#2444.
   */
  setFilterHighlight(highlight: FilterHighlight | null): void;

  // ── Sprint-window bands (#2738) ───────────────────────────────────────────

  /**
   * Push the sprint-window bands to draw behind the bars (ADR-0803).
   *
   * Same one-way contract as {@link setHoverChain} and
   * {@link setFilterHighlight}: the host resolves which rows a sprint drives
   * (`computeSprintBands`) and the engine only paints the result. The engine
   * never reads a sprint, and a band never changes hit-testing, dependency
   * routing or the bars themselves — it is paint on the background layer, which
   * is what lets the gated critical path and the sprint cadence share one
   * picture instead of one of them owning it.
   *
   * Row indices address the array most recently handed to {@link setTasks}, so
   * push bands recomputed from the SAME array whenever that array changes.
   * Passing an empty array clears them.
   */
  setSprintBands(bands: SprintBand[]): void;

  // ── Sprint cadence rail (#3012) ───────────────────────────────────────────

  /**
   * Push the cells of the cadence rail — the strip of named sprint windows on
   * the time axis, under the date ruler (ADR-0803).
   *
   * Same one-way contract as {@link setSprintBands}: the host resolves the
   * windows (`computeCadenceSegments`) and the engine only paints them. Note
   * these are **not** the bands: a band is a row range, a segment is a stretch
   * of the axis, and a sprint with no committed work has a segment and no band.
   * That is the whole reason the rail exists — an empty sprint is a planning
   * fact the row bands structurally cannot show.
   *
   * The rail's *height* is not the engine's to choose: it feeds
   * `CHART_HEADER_HEIGHT`, which the outline header and the scroll spacer also
   * read. The host installs that via `useCadenceRail`; passing segments here
   * only decides what is painted inside the band the host already sized.
   * Passing an empty array clears the rail.
   */
  setCadenceSegments(segments: CadenceSegment[]): void;

  // ── Rolled-up delivery mode (#3040) ───────────────────────────────────────

  /**
   * Push the outline's rolled-up delivery mode per task id, so the bar's mode
   * mark and the outline's gutter/chip are drawn from ONE value.
   *
   * Same one-way contract as {@link setSprintBands}: the host resolves the
   * rollup (`computeRowModes`) and the engine only paints it. The engine must
   * not compute this itself — a parent reads from its DESCENDANTS, not from its
   * own `delivery_mode`, and a second implementation of that walk is a second
   * thing to drift. Before #3040 the canvas read each row's own stored field
   * while the outline read the rollup, so a phase said MIXED in one pane and
   * drew a single mode (or, on a summary bar, nothing) in the other.
   *
   * Keyed by task id rather than row index, so it survives a re-sort without
   * being recomputed. An empty map is legitimate: a host with no rollup to push
   * gets the pre-#3040 per-row behavior.
   */
  setRowModes(modes: ReadonlyMap<string, RowMode>): void;

  // ── Event emitter ─────────────────────────────────────────────────────────

  /**
   * Subscribe to a renderer event.
   *
   * Returns an unsubscribe function. Always call the returned function in the
   * enclosing useEffect cleanup to prevent handler accumulation across
   * re-renders. (Fixes the no-unsubscribe problem with SVAR's intercept().)
   *
   * @example
   * useEffect(() => {
   *   if (!engine) return;
   *   const off = engine.on('drag-task', (ev) => { ... });
   *   return off;
   * }, [engine]);
   */
  on<K extends keyof GanttEngineEventMap>(
    event: K,
    handler: (payload: GanttEngineEventMap[K]) => void,
  ): () => void;

  // ── Imperative drag control ───────────────────────────────────────────────

  /**
   * Programmatically cancel the in-progress drag or resize.
   * Emits 'drag-task-end' / 'resize-task-end' with { cancelled: true }.
   * No-op when no drag/resize is active.
   *
   * Called by useDragCpm on Escape and by the offline guard.
   */
  cancelDrag(): void;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // ── Color mode ────────────────────────────────────────────────────────────

  /**
   * Switch the canvas renderer between light and dark palettes.
   * Call whenever the application color scheme changes (e.g. from useThemeStore).
   * Triggers a full repaint automatically.
   */
  setDark(dark: boolean): void;

  // ── Fiscal quarters ───────────────────────────────────────────────────────

  /**
   * Set how the quarter/year header tiers are labelled and bounded (#755).
   * In `fiscal` mode the tiers follow `startMonth` (the workspace
   * `fiscal_year_start` month, 1–12); in `calendar` mode they use Jan–Mar = Q1.
   * Triggers a full repaint automatically — only the header is affected.
   */
  setFiscalConfig(config: FiscalConfig): void;

  // ── Chart presentation toggles (#2097) ────────────────────────────────────

  /**
   * Set the Chart menu presentation toggles — on-bar task-name placement
   * (`next`/`left`/`hidden`) and progress-pill visibility. Dependency-line
   * visibility is controlled upstream by filtering the links passed to
   * {@link setLinks}, not here. Triggers a full repaint automatically.
   */
  setChartOptions(options: ChartRenderOptions): void;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Release all resources: cancel rAF loops, remove event listeners,
   * detach ResizeObserver, terminate any workers owned by the engine.
   * Called by useGanttEngine when the host component unmounts.
   */
  destroy(): void;
}
