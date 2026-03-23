/**
 * Message types shared between the main thread and the CPM Web Worker.
 *
 * The worker performs an incremental CPM forward pass over the downstream
 * subgraph of a dragged task. All dates are ISO strings to avoid structured-
 * clone issues with Date objects across the worker boundary.
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
