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
 *
 * Progress fidelity (issue #2813): the progress fields below are what let the
 * engine apply ADR-0132's three floors. They are optional so a caller that
 * knows nothing about progress still gets the pre-#2813 (progress-blind)
 * behavior rather than a silently wrong one; `buildSubgraph` always sends them.
 */

/** Minimal task shape for the in-browser CPM engine. */
export interface CpmTask {
  id: string;
  /**
   * ISO date string — the task's current (pre-drag) SPAN start: the date the
   * bar paints from, i.e. the web `Task.start` (`max(planned_start,
   * scheduled_start)`, ADR-0752).
   *
   * For a not-started task this is also its `early_start`. For an in-progress
   * one the two DIVERGE — `early_start` names the remaining-work window, which
   * the engine recovers internally from `earlyFinish` + `remainingDuration`
   * rather than being told (the web `Task` type carries no `early_start`).
   */
  earlyStart: string;
  /**
   * ISO date string — the task's current (pre-drag) early finish. Identical to
   * `scheduled_finish` for every task (ADR-0752): remaining work ends when the
   * task ends, so the finish side has one meaning regardless of progress.
   */
  earlyFinish: string;
  /** ISO date string — the task's late finish (from last server CPM) */
  lateFinish: string;
  /** FULL working-day duration (`Task.duration`), not the remaining portion. */
  durationDays: number;
  isMilestone: boolean;
  name: string;
  /**
   * ADR-0132 §2: a completed task with recorded actuals is PINNED — the server
   * takes it out of network logic entirely (`_pinned_placement`), so the
   * preview must never move it either. Its finish still constrains successors.
   */
  isComplete?: boolean;
  /**
   * ISO date string — recorded `actual_start`. Floors an in-progress task's
   * early start (`engine.py:862-869`): work already underway is never smoothed
   * back to an earlier network slot. Also anchors a pinned task's span.
   */
  actualStart?: string | null;
  /** ISO date string — recorded `actual_finish`. Anchors a pinned task's finish. */
  actualFinish?: string | null;
  /**
   * Working days of REMAINING work (server-computed `remaining_duration`,
   * ADR-0132 §3). In-progress work is laid forward at THIS, not at
   * `durationDays` — a 10-day task at 80% contributes 2 days to its successors,
   * not 10. Equal to `durationDays` on a not-started task, so using it is a
   * no-op there. Falls back to `durationDays` when absent.
   */
  remainingDuration?: number | null;
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
  /**
   * The project's data date (`Project.status_date`), or null to resolve it to
   * today the way the server's `resolve_cpm_status_date()` does. Floors the
   * DRAGGED task only — see the note in `cpmEngine.ts`.
   */
  statusDate?: string | null;
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
  /** See {@link DragStartMessage.statusDate}. */
  statusDate?: string | null;
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
  /**
   * ISO date string — the previewed SPAN start (what the bar paints), matching
   * the `earlyStart` the engine was given rather than the remaining-work window
   * (ADR-0752, issue #2813). For an in-progress task with a recorded
   * `actual_start` this does not move at all: the span began when work began,
   * and only the finish side responds to the drag.
   */
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
