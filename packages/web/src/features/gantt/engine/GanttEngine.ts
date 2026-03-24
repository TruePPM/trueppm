/**
 * Public API contract for the TruePPM canvas Gantt renderer.
 *
 * This interface is the sole integration boundary between the React shell
 * and the canvas renderer. Consumers (GanttView, useDragCpm,
 * useKeyboardReschedule, MonteCarloTimeline, PreviewOverlay) hold a
 * GanttEngine reference — they never reach inside the renderer.
 *
 * Versioned: any breaking change to this interface requires an ADR entry.
 * Replaces SVAR's IApi (which had no stable public coordinate API and no
 * unsubscribe mechanism on its intercept() method).
 */

import type { Task, TaskLink } from '@/types';
import type { GanttScaleData, ZoomLevel } from './GanttScaleData';

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
   * Programmatically change the zoom level.
   * Triggers a 'scales-change' event followed by a full repaint.
   */
  setZoom(level: ZoomLevel): void;

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

  /** Current selection. Immutable — do not mutate the returned set. */
  readonly selectedTaskIds: ReadonlySet<string>;

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

  /**
   * Release all resources: cancel rAF loops, remove event listeners,
   * detach ResizeObserver, terminate any workers owned by the engine.
   * Called by useGanttEngine when the host component unmounts.
   */
  destroy(): void;
}
