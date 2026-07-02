/**
 * Message types shared between the main thread and the CPM Web Worker.
 *
 * The worker performs an incremental CPM forward pass over the downstream
 * subgraph of a dragged task. All dates are ISO strings to avoid structured-
 * clone issues with Date objects across the worker boundary.
 *
 * Calendar fidelity (issue #1493): the worker approximates the server's
 * calendar-aware CPM with a fixed Mon–Fri working week — it has no access to
 * the project's custom `WorkCalendar`/`CalendarException` rows (those live
 * server-side only; see ADR-0120). This is a live-preview estimate, not the
 * source of truth: the post-commit server CPM run reconciles the real dates,
 * including any custom calendar or holiday effects this preview cannot see.
 */

/** Minimal task shape for the in-browser CPM engine. */
export interface CpmTask {
  id: string;
  /** ISO date string — the task's current (pre-drag) early start */
  earlyStart: string;
  /** ISO date string — the task's current (pre-drag) early finish */
  earlyFinish: string;
  /** ISO date string — the task's late finish (from last server CPM) */
  lateFinish: string;
  /** Calendar days duration (earlyFinish - earlyStart, inclusive) */
  durationDays: number;
  isMilestone: boolean;
  name: string;
}

/** Dependency edge in the subgraph. */
export interface CpmEdge {
  sourceId: string;
  targetId: string;
  /** FS | SS | FF | SF */
  type: 'FS' | 'SS' | 'FF' | 'SF';
  /**
   * Lag in calendar days (positive = delay, negative = lead) — mirrors
   * `Dependency.lag` on the server (issue #1493). Applied as a raw calendar-day
   * offset and then snapped forward/backward to the nearest working day, same
   * as the server engine's `_advance_calendar_days`/`_retreat_calendar_days`.
   */
  lag: number;
}

/**
 * Sent once at drag start (issue #1524). The dragged task's downstream subgraph
 * is topologically invariant for the whole drag — a drag moves a bar's date, not
 * the dependency network — so the worker keeps it resident and every subsequent
 * DRAG_MOVE reuses it. This avoids rebuilding the O(N+E) subgraph and re-cloning
 * it across the worker boundary on every animation frame (the pre-#1524 cost).
 */
export interface DragStartMessage {
  type: 'DRAG_START';
  draggedTaskId: string;
  /** Only tasks reachable downstream from draggedTaskId (inclusive). */
  subgraph: {
    tasks: CpmTask[];
    edges: CpmEdge[];
  };
}

/**
 * Sent on each drag frame after DRAG_START. Carries only the changed start —
 * the worker recomputes the forward pass over the resident subgraph. If no
 * DRAG_START preceded it (e.g. a race on remount) the worker drops it silently.
 */
export interface DragMoveMessage {
  type: 'DRAG_MOVE';
  /** Monotonically increasing sequence number — stale results are discarded. */
  seq: number;
  /** The new start date the user is dragging to, ISO string. */
  newStartIso: string;
}

/** Sent at drag end (commit or cancel) so the worker releases the subgraph. */
export interface DragEndMessage {
  type: 'DRAG_END';
}

/**
 * Stateless one-shot recompute — carries its own subgraph and computes without
 * touching any resident drag state. Used by the keyboard reschedule path
 * (issue #34), which fires once per keypress (human-paced, not a 60fps drag), so
 * rebuilding and shipping the subgraph per nudge is cheap and keeps that flow
 * independent of the resident-subgraph drag protocol.
 */
export interface RecalcMessage {
  type: 'RECALC';
  /** Monotonically increasing sequence number — stale results are discarded. */
  seq: number;
  draggedTaskId: string;
  /** The new start date, ISO string. */
  newStartIso: string;
  /** Only tasks reachable downstream from draggedTaskId (inclusive). */
  subgraph: {
    tasks: CpmTask[];
    edges: CpmEdge[];
  };
}

/** Discriminated union of every message the worker accepts. */
export type WorkerRequest =
  | DragStartMessage
  | DragMoveMessage
  | DragEndMessage
  | RecalcMessage;

/** Per-task result posted back from the worker. */
export interface PreviewTaskResult {
  taskId: string;
  earlyStart: string;
  earlyFinish: string;
  /** True when new earlyFinish > lateFinish (task flipped onto critical path). */
  isCritical: boolean;
  /** Signed calendar-day delta vs baseline earlyFinish. */
  deltaDays: number;
}

/** The most-impacted milestone in the subgraph. */
export interface PreviewMilestone {
  taskId: string;
  name: string;
  baselineFinish: string;
  newFinish: string;
  deltaDays: number;
}

/** Message posted from worker to main thread after recalculation. */
export interface ResultMessage {
  type: 'RESULT';
  /** Echoed sequence number so stale results can be discarded. */
  seq: number;
  draggedTaskId: string;
  results: PreviewTaskResult[];
  worstMilestone: PreviewMilestone | null;
  /** Number of affected tasks beyond the first 10 (for "+N more" label). */
  overflowCount: number;
}
