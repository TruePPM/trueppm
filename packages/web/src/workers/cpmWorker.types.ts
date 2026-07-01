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

/** Message sent from main thread to worker on each drag frame. */
export interface RecalcMessage {
  type: 'RECALC';
  /** Monotonically increasing sequence number — stale results are discarded. */
  seq: number;
  draggedTaskId: string;
  /** The new start date the user is dragging to, ISO string. */
  newStartIso: string;
  /** Only tasks reachable downstream from draggedTaskId (inclusive). */
  subgraph: {
    tasks: CpmTask[];
    edges: CpmEdge[];
  };
}

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
