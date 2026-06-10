// Hand-authored domain types not covered by the OpenAPI-generated output.
// Update when API schema changes, then verify against generated src/api/types.ts.

export type HealthState = 'on-track' | 'at-risk' | 'critical' | 'unknown';

export type BarType = 'normal' | 'critical' | 'complete' | 'summary' | 'milestone' | 'baseline';
export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
// 5-column board model (issues #177/#178). BACKLOG and REVIEW are new values;
// ON_HOLD is kept for migration compatibility and maps to BACKLOG in the default config.
export type TaskStatus = 'BACKLOG' | 'NOT_STARTED' | 'IN_PROGRESS' | 'REVIEW' | 'ON_HOLD' | 'COMPLETE';
export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type TaskReadiness = 'idea' | 'estimated' | 'ready' | 'baselined';

/** Work-item taxonomy (ADR-0105 / #363). */
export type TaskType = 'epic' | 'story' | 'task' | 'bug' | 'spike';

/** Definition-of-Ready signal for a backlog story (ADR-0105 / #731). Distinct from
 *  the computed board `readiness` chip — this is the PO's stored grooming intent. */
export type DorState = 'idea' | 'refine' | 'ready';

/** Prioritization scoring model for a project's product backlog (ADR-0105 / #922).
 *  `none` hides the scoring surface (pure manual drag). */
export type PrioritizationModel = 'none' | 'wsjf' | 'rice' | 'value_effort';

/** A single first-class acceptance criterion (ADR-0105 / #493). The `metBy`/`metAt`
 *  review trail is exposed as an attribution name only (never a raw user id). */
export interface AcceptanceCriterion {
  id: string;
  text: string;
  given?: string;
  when?: string;
  then?: string;
  met: boolean;
  position: number;
  metByName?: string | null;
  metAt?: string | null;
}

/**
 * Sprint scope-change decision status (ADR-0102 §1, `ScopeChangeStatus`).
 *
 * Lowercase wire strings (plain CharField, no generated Enum component — see
 * the backend contract). `pending` = injected mid-sprint, visible but excluded
 * from commitment/burndown until a team-owned actor accepts or rejects it.
 */
export type ScopeChangeStatus = 'pending' | 'accepted' | 'rejected';

export interface TaskAssignee {
  resourceId: string;
  name: string;
  units: number;
}

export interface Task {
  id: string;
  wbs: string;
  name: string;
  /** ISO date string — `max(planned_start, early_start)`. CPM fills in
   * `early_start` for every task, so this is rarely empty in production —
   * it's "where the bar paints", not "what the PM committed to". Use
   * `plannedStart` to check whether the PM has actually committed a date. */
  start: string;
  /** ISO date string */
  finish: string;
  /** ISO date string — the PM-committed start (SNET constraint). Distinct
   * from `start`: CPM auto-computes `early_start` for every task it
   * processes, so `start` is rarely empty in production. `plannedStart`
   * stays null until a PM (or a drag-to-promote gesture) sets a date.
   * The Unscheduled gutter filter (#317) uses this. */
  plannedStart?: string | null;
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
  /** Computed readiness state for board cards (issue #179). */
  readiness?: TaskReadiness;
  /** Count of live incoming dependency edges (board batch 3, ADR-0035). */
  predecessorCount?: number;
  /** True when any predecessor is not COMPLETE (board batch 3, ADR-0035). */
  isBlocked?: boolean;
  /** Count of active linked risks (OPEN + MITIGATING; board batch 3, ADR-0035). */
  linkedRisksCount?: number;
  /** Max(probability * impact) across active linked risks; null when none. */
  linkedRisksMaxSeverity?: number | null;
  /** Cost Performance Index = EV / AC. Null until cost data is available (board batch 4). */
  cpi?: number | null;
  /** Total planned cost (Budget at Completion). Null until cost data is available (board batch 4). */
  budgetAtCompletion?: number | null;
  /** Actual cost incurred to date. Null until cost data is available (board batch 4). */
  actualCost?: number | null;
  /** True when the assignee's total units across active tasks for this project exceeds 1.0. */
  assigneeIsOverallocated?: boolean;
  /** Monotonically increasing version counter — used for optimistic locking on phase reorder. */
  serverVersion?: number;
  /**
   * Sprint membership: when set, the task is committed to a sprint and is treated
   * as scheduled — it must not appear in the Schedule view's Unscheduled gutter
   * (issue #317). Null/undefined for tasks not assigned to a sprint.
   */
  sprintId?: string | null;
  /**
   * Sprint scope-injection pending-acceptance flag (ADR-0102 §1).
   *
   * `true` ⇔ the task was linked to its ACTIVE sprint post-activation and has
   * not yet been accepted into the commitment — it is visible on the board but
   * excluded from `committed_points`/burndown. Read-only: the only way to clear
   * it is the accept/reject endpoints (a contributor cannot self-accept by
   * PATCHing the field). Wire key is snake_case `sprint_pending`; mapped to
   * this camelCase field in `mapTask`. Absent/false for non-pending tasks. */
  sprintPending?: boolean;
  /** Original sprint commitment estimate in story points. Null for non-agile tasks. */
  storyPoints?: number | null;
  /**
   * Live remaining-effort signal for sprint burndown (issue #366).
   * Auto-set to 0 on COMPLETE; restored from storyPoints on reopen.
   * Null means fall back to storyPoints in burndown math.
   */
  remainingPoints?: number | null;
  /**
   * Long-form description / notes. Maps to the API's `Task.notes` field.
   * Empty string when unset (ADR-0048). Read by the task create/edit modal
   * (#305) for the description textarea; not displayed elsewhere on board cards.
   */
  notes: string;
  /** True for tasks created via the drawer subtask action (ADR-0060 #308). */
  isSubtask?: boolean;
  /** 8-hex-digit project-scoped ID (ADR-0016 / issue #50). Rendered as the task's short reference. */
  shortId?: string;
  /** Sprint scope-change audit rows — populated when subtasks are added to an in-sprint task (ADR-0060). */
  sprintScopeChanges?: Array<{
    /** ADR-0102: scope-change row id — targets the single accept/reject
     *  endpoints. Absent on rows from legacy payloads. */
    id?: string;
    subtaskName: string;
    /** ADR-0101: forward-looking name (generalized beyond subtasks). */
    itemName: string;
    addedByName: string | null;
    addedAt: string;
    /** ADR-0101: does this late addition threaten the Sprint Goal? */
    goalImpact: boolean;
    /** ADR-0102: decision status of this scope change. `pending` until a
     *  team-owned actor accepts (joins commitment) or rejects (removes).
     *  Optional in the type so legacy fixtures need not set it; `mapTask`
     *  defaults absent rows to `'accepted'`. */
    status?: ScopeChangeStatus;
  }>;
  /**
   * Sprint→milestone rollup payload (ADR-0074). Populated only on milestone
   * tasks with at least one live targeting sprint; `null` for non-milestones
   * and for milestones without sprint links. When `rollup_basis === 'none'`
   * the manual `percent_complete` value still applies; the UI surfaces no
   * lock chrome in that case.
   */
  milestoneRollup?: MilestoneRollup | null;
  // ── Product backlog & scoring (ADR-0105) ──────────────────────────────────
  /** Work-item type. Absent on legacy payloads → treat as 'task'. */
  taskType?: TaskType;
  /** Parent epic id (grouping parallel to the WBS), or null when ungrouped. */
  parentEpic?: string | null;
  /** Definition-of-Ready signal set by the PO; field is `dor` to avoid the
   *  collision with the computed `readiness` board chip. */
  dor?: DorState;
  /** Within-sprint execution order (#365); null outside a sprint. */
  sprintRank?: number | null;
  /** First-class acceptance criteria (read-only nested; write via the criteria API). */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Computed prioritization score under the project's active model; null when unscored. */
  score?: number | null;
  /** Acceptance-criteria meter: met / total. */
  acMet?: number;
  acTotal?: number;
  /** Definition-of-Ready blocker codes; empty ⇒ the story may be marked ready. */
  dorBlockers?: string[];
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

/**
 * Project planning methodology preset (ADR-0041).
 * Drives default tab visibility in the project workspace; does not gate API access.
 */
export type Methodology = 'WATERFALL' | 'AGILE' | 'HYBRID';

export interface Project {
  id: string;
  name: string;
  /** Hex color for the 8px project dot, e.g. '#3E8C6D' */
  colorDot: string;
  healthState: HealthState;
  /** Project methodology preset — drives default tab visibility (ADR-0041). */
  methodology: Methodology;
  /**
   * Program UUID this project belongs to (ADR-0070), or null for standalone.
   * The sidebar badge and project-list grouping switch on the presence of
   * this field; the program name is fetched on demand via useProgram(id).
   */
  programId: string | null;
}

/**
 * Sprint state machine (ADR-0037 §Q2).
 *
 * `PLANNED` → `ACTIVE` → `COMPLETED`, with `PLANNED → CANCELLED` and rare
 * `ACTIVE → CANCELLED` (admin-only) escapes. Only one `ACTIVE` sprint per
 * project at a time (enforced server-side, 409 on activate conflict).
 */
export type SprintState = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

/**
 * Sprint → milestone rollup payload (ADR-0074).
 *
 * Aggregated only — never contains per-assignee task lists or raw
 * committed/completed point counts (Morgan VoC guardrail). The rolled-up
 * `percent_complete` is the single source of truth that both the
 * AdvancingToMilestoneCard and the Gantt milestone diamond render.
 */
export interface MilestoneRollup {
  /** 0–100, capped. Null when basis is "none" (no points and no committed tasks). */
  percent_complete: number | null;
  /** "points" when the team sizes in story points; "tasks" when only counting completion;
   *  "none" when neither input is available. */
  rollup_basis: 'points' | 'tasks' | 'none';
  /** Days between the latest ACTIVE/PLANNED sprint's finish_date and the
   *  milestone's early_finish. Positive = sprint plan slips past the
   *  milestone date. Null when there is no live sprint or no CPM date. */
  variance_days: number | null;
  /** True when an active sprint's current backlog points sum diverges from
   *  its activation-snapshot committed_points. The PM cap on % at 100% is
   *  honest when this flag is set. */
  sprint_scope_changed: boolean;
  /** True when a bound sprint's current committed points diverge from the
   *  snapshot captured at promote time (ADR-0106 §1) — the milestone chip /
   *  bridge banner show a "scope changed since bound" caveat. Optional until
   *  the drift caveat UI lands (#550). */
  binding_drifted?: boolean;
  /** Total number of sprints targeting this milestone (any state). */
  sprint_count: number;
}

/**
 * Optional milestone link surfaced inline on the sprint detail.
 *
 * The Sprint serializer expands the foreign key into a small object so the
 * UI can render the "Advancing to milestone" card without a second
 * round-trip. `wbs_path` may be absent on legacy tasks.
 */
export interface SprintTargetMilestone {
  id: string;
  name: string;
  wbs_path?: string | null;
  /** ISO date string for the milestone's planned finish. */
  finish?: string | null;
  /** Rolled-up progress + variance (ADR-0074). Null when no live targeting
   *  sprints OR when this serializer was called from a legacy path that
   *  predates the rollup. */
  rollup?: MilestoneRollup | null;
}

/**
 * Sprint as returned by the API (`SprintSerializer`).
 *
 * `committed_*` is snapshotted on activation; `completed_*` on close.
 * `completion_ratio_*` are computed by the serializer; nullable when
 * either input is null. `short_id` is rendered as `SP-{value}` in the UI.
 */
export interface ApiSprint {
  id: string;
  server_version: number;
  short_id: string;
  /** Pre-formatted display id, e.g. ``SP-A1B2``. */
  short_id_display: string;
  name: string;
  goal: string;
  /** Long-form PM annotations (ADR-0048). Empty string when unset. */
  notes: string;
  /** ISO date — sprint window start (inclusive). */
  start_date: string;
  /** ISO date — sprint window finish (inclusive). */
  finish_date: string;
  state: SprintState;
  /** FK id of the milestone task this sprint advances toward (writable). */
  target_milestone: string | null;
  /** Inline milestone detail returned by the serializer (read-only). */
  target_milestone_detail: SprintTargetMilestone | null;
  /**
   * Binding provenance (ADR-0106 §1) — written only by the promote/unbind
   * endpoints, read-only here. `milestone_bound_by` is the user id; null
   * whenever the sprint is unbound (or was bound via the legacy FK PATCH).
   */
  milestone_bound_by?: number | null;
  milestone_bound_at?: string | null;
  binding_committed_snapshot?: number | null;
  /**
   * Planning target — points the team thinks they can take on at planning
   * time (ADR-0073). Writable by SCHEDULER+ on PLANNED and ACTIVE sprints;
   * locked on COMPLETED and CANCELLED. Null = no points-based planning
   * target set (the correct sentinel for teams that do not size in points).
   * Distinct from committed_points (snapshot of the backlog at activation).
   */
  capacity_points: number | null;
  /**
   * Optional WIP-overload threshold for the sprint (#546). Writable by
   * SCHEDULER+ on PLANNED and ACTIVE sprints; locked on COMPLETED and
   * CANCELLED — same field-level gate as capacity_points. Null = no limit set
   * (the SprintPanel WIP chip is suppressed). The cheap per-sprint signal, not
   * a flow engine — per-column WIP limits live on BoardColumnConfig.
   */
  wip_limit: number | null;
  /**
   * Hold this sprint out of the velocity average/band and forecast (ADR-0113) —
   * the "Sprint 0" / setup-iteration escape hatch. Writable by SCHEDULER+ in
   * EVERY state, including COMPLETED (unlike capacity_points), because teams
   * usually realise a ramp-up sprint is skewing velocity only in hindsight.
   * Optional in the type so legacy fixtures need not set it; the API always
   * sends it and consumers read with `?? false`.
   */
  exclude_from_velocity?: boolean;
  committed_points: number | null;
  committed_task_count: number | null;
  /**
   * Count of tasks linked to this sprint that are still pending acceptance
   * (ADR-0102 §5) — `Task.sprint_pending=True`. Annotated on every sprint
   * payload (list/detail/activate/close/burndown). Drives the
   * "forecast reflects accepted scope only — N pending" transparency copy and
   * the board banner's pending line. `0` when nothing is pending. Optional in
   * the type (so legacy fixtures need not set it); the API always sends it and
   * consumers read it with `?? 0`. */
  pending_count?: number;
  /**
   * Count of in-flight tasks in this sprint (#546) — status IN_PROGRESS or
   * REVIEW. Annotated on every sprint payload. Drives the SprintPanel WIP chip
   * "WIP {wip_count}/{wip_limit}". Optional in the type so legacy
   * fixtures need not set it; the API always sends it, consumers read with
   * `?? 0`.
   */
  wip_count?: number;
  completed_points: number | null;
  completed_task_count: number | null;
  completion_ratio_points: number | null;
  completion_ratio_tasks: number | null;
  /** ISO datetime — when the sprint was activated (null until ACTIVE). */
  activated_at: string | null;
  /** ISO datetime — when the sprint was closed (null until COMPLETED). */
  closed_at: string | null;
  created_at: string;
  updated_at: string;
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
  /** ISO timestamp of when the simulation was run, captured at cache-write time. */
  lastRunAt?: string;
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
  /** True when this resource represents the requesting user — populated
   * server-side from `Resource.user` FK with email fallback (issue #198). */
  isMe?: boolean;
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
export type DragPhase = 'idle' | 'dragging' | 'committing' | 'error' | 'building';

export interface ShellStatTask {
  id: string;
  wbs: string;
  name: string;
}

export interface WorkshopParticipant {
  id: number;
  user_id: string;
  display_name: string;
  joined_at: string;
  left_at: string | null;
  color_index: number;
}

export interface WorkshopSession {
  id: string;
  project_id: string;
  started_by_id: string | null;
  started_at: string;
  ended_at: string | null;
  participants: WorkshopParticipant[];
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

// ---------------------------------------------------------------------------
// Task collaboration — ADR-0075 (#310 #311)
// ---------------------------------------------------------------------------

/** Inline user summary returned by collaboration serializers. */
export interface CollabUserMini {
  id: string;
  username: string;
  display_name: string;
}

/** Task attachment — file XOR external URL (DB CheckConstraint). */
export interface TaskAttachment {
  id: string;
  file: string;
  file_name: string;
  file_size: number | null;
  file_mime: string;
  external_url: string;
  external_title: string;
  is_pinned: boolean;
  uploaded_by: CollabUserMini | null;
  deleted_by: CollabUserMini | null;
  created_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
}

/** Task comment — append-only thread with single-level reply nesting. */
export interface TaskComment {
  id: string;
  task: string;
  parent: string | null;
  author: CollabUserMini | null;
  body: string;
  edited_at: string | null;
  created_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: CollabUserMini | null;
  /** Count of distinct users who have ✅-acknowledged this comment. */
  acknowledged_count: number;
  /** Count of all reaction rows on this comment (0.2 allow-list: 👍 only). */
  reaction_count: number;
  /** Whether the requesting user has acknowledged this comment. */
  has_my_acknowledgement: boolean;
}

/** Per-user "I'm on it" ack — never triggers notification (ADR-0075 §A.3, Morgan blocker). */
export interface CommentAcknowledgement {
  id: string;
  user: CollabUserMini;
  created_at: string;
}

/** Lightweight emoji reaction — never triggers notification. */
export interface CommentReaction {
  id: string;
  user: CollabUserMini;
  emoji: string;
  created_at: string;
}

/** Response from GET /api/v1/projects/{id}/tasks/{tid}/attachments/{aid}/signed-url/ */
export interface SignedDownloadUrl {
  url: string;
  expires_at: string;
}
