// Hand-authored domain types not covered by the OpenAPI-generated output.
// Update when API schema changes, then verify against generated src/api/types.ts.

export type HealthState = 'on-track' | 'at-risk' | 'critical' | 'unknown';

export type BarType = 'normal' | 'critical' | 'complete' | 'summary' | 'milestone' | 'baseline';
export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETE';
export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface Task {
  id: string;
  wbs: string;
  name: string;
  /** ISO date string */
  start: string;
  /** ISO date string */
  finish: string;
  duration: number;
  /** 0–100 */
  progress: number;
  parentId: string | null;
  isCritical: boolean;
  isComplete: boolean;
  isSummary: boolean;
  isMilestone: boolean;
  status: TaskStatus;
  /** ISO date string — when work actually started */
  actualStart?: string;
  /** ISO date string — when work actually finished */
  actualFinish?: string;
  /** actual_finish - early_finish in calendar days; positive = late */
  scheduleVarianceDays?: number | null;
  baselineStart?: string;
  baselineFinish?: string;
}

export interface TaskLink {
  id: string;
  sourceId: string;
  targetId: string;
  type: LinkType;
  /** Lag in working days (positive = delay, negative = lead). */
  lag: number;
  isCritical: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** Hex color for the 8px project dot, e.g. '#1C6B3A' */
  colorDot: string;
  healthState: HealthState;
}

/** One weekly bucket in a Monte Carlo distribution histogram */
export interface McBucket {
  /** ISO date string for the Monday that starts this week */
  weekStart: string;
  count: number;
}

/**
 * Monte Carlo simulation result. Fixture data uses pre-bucketed distribution
 * to keep file size small; real API returns the same shape.
 */
export interface MonteCarloResult {
  projectId: string;
  runs: number;
  /** P50 completion date, ISO string */
  p50: string;
  /** P80 completion date, ISO string */
  p80: string;
  /** P95 completion date, ISO string */
  p95: string;
  /** Weekly bucket histogram of the full distribution */
  buckets: McBucket[];
}

// ---------------------------------------------------------------------------
// Drag CPM preview types (issue #19)
// ---------------------------------------------------------------------------

/** Per-task result from the in-browser incremental CPM forward pass. */
export interface DragPreviewResult {
  taskId: string;
  /** New early start after the drag, ISO date string */
  earlyStart: string;
  /** New early finish after the drag, ISO date string */
  earlyFinish: string;
  /**
   * True when the task's new earlyFinish exceeds its pre-drag lateFinish
   * (i.e. it has flipped onto the critical path due to this drag).
   */
  isCritical: boolean;
  /** Signed calendar-day delta vs baseline earlyFinish (positive = slipping) */
  deltaDays: number;
}

/** The most-impacted milestone — used to anchor the tooltip. */
export interface WorstMilestone {
  taskId: string;
  name: string;
  baselineFinish: string;
  newFinish: string;
  deltaDays: number;
}

/** Drag state machine phases */
export type DragPhase = 'idle' | 'dragging' | 'committing' | 'error';

export interface ShellStatTask {
  id: string;
  wbs: string;
  name: string;
}

export interface ShellStats {
  taskCount: number;
  criticalPathCount: number;
  /** P80 completion date as ISO string */
  monteCarlop80: string | null;
  atRiskCount: number;
  criticalCount: number;
  /** Tasks with health = at-risk (up to 5 shown in badge popover) */
  atRiskTasks: ShellStatTask[];
  /** Tasks on critical path that are incomplete (up to 5 shown in badge popover) */
  criticalTasks: ShellStatTask[];
  onlineUsers: number;
  lastSaved: string | null;
  /** ISO timestamp of most recent CPM engine recalculation; null if never run */
  recalculatedAt: string | null;
}
