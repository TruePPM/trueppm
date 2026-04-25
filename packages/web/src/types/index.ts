// Hand-authored domain types not covered by the OpenAPI-generated output.
// Update when API schema changes, then verify against generated src/api/types.ts.

export type HealthState = 'on-track' | 'at-risk' | 'critical' | 'unknown';

export type BarType = 'normal' | 'critical' | 'complete' | 'summary' | 'milestone' | 'baseline';
export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETE';
export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface TaskAssignee {
  resourceId: string;
  name: string;
  units: number;
}

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
  /** Resource assignments from TaskResource */
  assignees: TaskAssignee[];
  /**
   * ISO date-time when the task entered its current status column.
   * Used to compute entry stamps ("Entered at 72% · 3d ago") on board cards.
   * Absent until the API backfills the field (issue #130).
   */
  statusEnteredAt?: string;
  /**
   * Integer priority rank within the project — drives default sort order on
   * the board. Lower number = higher priority. Absent until API is wired (issue #130).
   */
  priorityRank?: number;
  /** Three-point PERT estimate fields (issue #141). All three must be set for MC. */
  optimisticDuration?: number | null;
  mostLikelyDuration?: number | null;
  pessimisticDuration?: number | null;
  /** Approval state in suggest_approve mode; null in open/pm_only modes. */
  estimateStatus?: 'pending' | 'accepted' | null;
  /** Total float in working days from CPM; negative = already late. Absent until CPM runs. */
  totalFloat?: number | null;
}

/** Estimation governance mode on Project (issue #141 / ADR-0032). */
export type EstimationMode = 'open' | 'suggest_approve' | 'pm_only';

export interface TaskAssignment {
  id: string;
  resourceId: string;
  resourceName: string;
  /** Decimal allocation: 1.0 = 100% */
  units: number;
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
// Resource pool and skills types (issues #149, #150)
// ---------------------------------------------------------------------------

export type Proficiency = 1 | 2 | 3;
export const PROFICIENCY_LABEL: Record<Proficiency, string> = {
  1: 'Beginner',
  2: 'Intermediate',
  3: 'Expert',
};

export interface Skill {
  id: string;
  name: string;
  normalizedName: string;
  category: string;
}

export interface ResourceSkill {
  id: string;
  resourceId: string;
  skillId: string;
  skill: Skill;
  proficiency: Proficiency;
}

export interface ResourceDetail {
  id: string;
  name: string;
  email: string;
  jobRole: string;
  maxUnits: number;
  calendarId: string | null;
  skills: ResourceSkill[];
}

export interface ProjectResource {
  id: string;
  projectId: string;
  resourceId: string;
  resource: ResourceDetail;
  roleTitle: string;
  unitsOverride: number | null;
  effectiveMaxUnits: number;
  notes: string;
}

export interface TaskSkillRequirement {
  id: string;
  taskId: string;
  skillId: string;
  skill: Skill;
  minProficiency: Proficiency;
}

/** Skill fit annotation returned when ?task= is passed to /resources/ */
export type SkillFit = 'exact' | 'partial' | 'missing';

export interface MissingSkill {
  skillId: string;
  skillName: string;
  required: Proficiency;
  requiredLabel: string;
  actual: number;
  actualLabel: string;
}

export interface ResourceWithSkillFit extends ResourceDetail {
  skillFit: SkillFit;
  missingSkills: MissingSkill[];
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
