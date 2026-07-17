// Hand-maintained API types — edit manually.
//
// NOTE: despite the `generate:types` script in package.json, this file is NOT
// openapi-typescript output. It is a curated set of flat interfaces (some with
// issue-referencing JSDoc) kept in sync by hand against docs/api/openapi.json.
// Running `npm run generate:types` would overwrite this with a different
// (paths/components) shape and break the build — do not run it blindly. When the
// API schema changes, update the affected interfaces here by hand.
// Committed to version control so CI can typecheck without a running API.

export type {};

/**
 * DRF PageNumberPagination envelope — all list endpoints return this shape.
 * The API uses PAGE_SIZE=50 globally (settings/base.py).
 */
export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ---------------------------------------------------------------------------
// Access / membership types (ADR-0061)
// ---------------------------------------------------------------------------

export interface UserSummary {
  id: string;
  username: string;
  email: string;
}

export interface ProjectMembership {
  id: string;
  server_version: number;
  project: string;
  user: string;
  user_detail: UserSummary;
  role: number;
  role_label: string;
  /** ISO 8601 timestamp of when the member was added to the project. */
  joined_at: string;
  /** ISO 8601 timestamp of the last role change, or null if unchanged since joining. */
  role_changed_at: string | null;
  /** Count of other active (non-archived) projects this user belongs to, excluding this one (#598). */
  other_active_project_count: number;
  /** Names of those other projects, limited to ones the requesting user owns (visibility-gated). */
  other_active_project_names: string[];
}

export interface UserSearchResult {
  id: string;
  username: string;
  // email is intentionally NOT exposed by /users/search/ (#815) — the typeahead
  // matches on email server-side but never returns it, to prevent PII harvesting.
  display_name: string;
  initials: string;
}

// ---------------------------------------------------------------------------
// Program types (ADR-0070, #502)
// ---------------------------------------------------------------------------

/**
 * Program planning methodology — mirrors the API's Methodology enum and is
 * intentionally a string literal union so it survives JSON round-trips and
 * narrows naturally in switch statements.
 */
export type ProgramMethodology = 'WATERFALL' | 'AGILE' | 'HYBRID';

/**
 * Workspace policy for how the default methodology cascades to programs/projects
 * (ADR-0107, issue 955). Because methodology is NOT-NULL on every scope (no null
 * "inherit" sentinel), inheritance is policy-driven: `inherit` locks the per-scope
 * affordance to the workspace default (picker read-only); `suggest` (OSS default)
 * lets programs/projects override; `enforce` is the Enterprise hard lock — OSS
 * stores it but degrades it to `suggest` (no provider registered).
 */
export type MethodologyOverridePolicy = 'inherit' | 'suggest' | 'enforce';

/**
 * Resolved working-calendar payload embedded on Project/Program reads (ADR-0441,
 * issue #1987). `working_days` is a single integer bitmask (Mon=1, Tue=2, Wed=4,
 * Thu=8, Fri=16, Sat=32, Sun=64) — the same shape `describeWorkingDays` expects,
 * NOT a per-day array. `holiday_count` is the number of exception rows on the
 * calendar (0 for a plain work-week with no holidays configured).
 */
export interface EffectiveCalendar {
  id: string;
  name: string;
  working_days: number;
  hours_per_day: number;
  timezone: string;
  holiday_count: number;
}

/**
 * Which scope supplied a project's `effective_calendar` (ADR-0441, issue #1987):
 * the project's own override, its program, the workspace default, or nothing up
 * the chain (the hardcoded Mon-Fri/8h/UTC system default).
 */
export type ProjectCalendarSource = 'project' | 'program' | 'workspace' | 'system_default';

/**
 * Which scope supplied a program's `effective_calendar` (ADR-0441, issue #1987).
 * A program has no calendar of its own to report as the source — it is the top
 * of the Project → Program chain, so the source is either its own override
 * (`program`), the workspace default, or the system default.
 */
export type ProgramCalendarSource = 'program' | 'workspace' | 'system_default';

/**
 * Cascade policy for the workspace default working calendar (ADR-0441, issue
 * #1987). Mirrors `MethodologyOverridePolicy`: `inherit` locks the per-scope
 * affordance to the workspace default (picker read-only downstream); `suggest`
 * (OSS default) lets programs/projects override; `enforce` is the Enterprise
 * hard lock — OSS stores it but degrades it to `suggest` (no provider registered).
 */
export type CalendarOverridePolicy = 'inherit' | 'suggest' | 'enforce';

/**
 * Program health override. ``AUTO`` defers to the (future) rollup; the explicit
 * values are PM overrides. Mirrors ``apps.projects.models.Health`` (issue #523).
 */
export type ProgramHealth = 'AUTO' | 'ON_TRACK' | 'AT_RISK' | 'CRITICAL';

/**
 * What a program does when a cross-project dependency slips (issue 529). Mirrors
 * ``apps.projects.models.SlipPropagation``. Direct column, default `warn`.
 */
export type ProgramSlipPropagation = 'none' | 'warn' | 'block';

/**
 * Program listing scope. Queryset enforcement is a future change; the field is
 * stored and rendered today. Mirrors ``apps.projects.models.Visibility`` (#523).
 */
export type ProgramVisibility = 'WORKSPACE' | 'PRIVATE';

/**
 * Project health override (issue #520). Reuses the same enum values as Program
 * — both surface the same chip palette and labels. Defined as a distinct alias
 * so call sites read self-describingly even though the value set is identical.
 */
export type ProjectHealth = ProgramHealth;

/**
 * Project listing scope (issue #520). Same value set as ``ProgramVisibility``;
 * see that type's note about queryset enforcement landing in a future change.
 */
export type ProjectVisibility = ProgramVisibility;

/**
 * Default landing view when a project is opened without a view in the URL
 * (issue #520). Drives the redirect target only — every view stays reachable
 * by direct URL regardless of this preference.
 */
export type ProjectDefaultView = 'SCHEDULE' | 'BOARD' | 'TABLE' | 'OVERVIEW';

/**
 * Who may see the per-run attribution (which member triggered a Monte Carlo run)
 * on the forecast-history list (ADR-0144, issue 1232). `ADMIN_OWNER` preserves the
 * historical default exactly; `SCHEDULER_PLUS` widens it to Scheduler and above;
 * `NONE` hides attribution from everyone. Inheritable Workspace → Program → Project.
 */
export type MCAttributionAudience = 'ADMIN_OWNER' | 'SCHEDULER_PLUS' | 'NONE';

/**
 * Workspace policy for downstream forecast-history overrides (ADR-0144). Shares
 * the three-value `TermOverridePolicy` shape used by every other override policy:
 * `inherit`/`suggest` both let programs/projects override (OSS honors them
 * identically); `enforce` pins the workspace values and is Enterprise-enforced —
 * OSS stores it but never enforces the lock downstream. The old `allow`/`lock`
 * pair was a frontend-only invention the backend never accepted (#2010).
 */
export type MCHistoryOverridePolicy = 'inherit' | 'suggest' | 'enforce';

/** Hard ceiling on the retained-run count, enforced server-side (ADR-0144). */
export const MC_HISTORY_RETENTION_MIN = 1;
export const MC_HISTORY_RETENTION_MAX = 500;

/**
 * What happens to a task's percent-complete when its duration changes (ADR-0151,
 * issue 1254). `keep` (default) leaves the entered % untouched; `prorate` scales
 * it by the duration ratio server-side; `confirm` keeps the % server-side and the
 * desktop client offers an inline opt-in "Recalc %?" prompt. Inheritable
 * Workspace → Program → Project.
 */
export type DurationChangePercentPolicy = 'keep' | 'prorate' | 'confirm';

/**
 * Product-backlog prioritization scoring model for a project (ADR-0105 §3, #922).
 * `none` hides the scoring surface (pure manual drag); the others drive which
 * distinct Task input columns feed the computed prioritization score.
 */
export type PrioritizationModel = 'none' | 'wsjf' | 'rice' | 'value_effort';

/**
 * Estimate-governance mode for a project (ADR-0041, #769). `open` = any member
 * writes estimates; `suggest_approve` = members propose, a Scheduler approves;
 * `pm_only` = only Schedulers write. Scheduler+-writable server-side.
 */
export type EstimationMode = 'open' | 'suggest_approve' | 'pm_only';

/**
 * One row of a task's duration-change audit trail (ADR-0151, issue 1254), read
 * from `GET /api/v1/tasks/{id}/duration-events/`. Append-only;
 * `percent_complete_after` is set only when the policy mutated the % (prorate).
 * `actor_name` is null for automated (CPM-cascade) events.
 */
export interface TaskDurationChangeEvent {
  id: string;
  task: string;
  actor: string | null;
  actor_name: string | null;
  old_duration: number;
  new_duration: number;
  percent_complete_at_change: number;
  percent_complete_after: number | null;
  policy_applied: DurationChangePercentPolicy;
  source: 'user_edit' | 'cpm_cascade';
  sprint: string | null;
  created_at: string;
}

export interface Program {
  id: string;
  server_version: number;
  name: string;
  description: string;
  /** Optional short code; empty string when unset. */
  code: string;
  methodology: ProgramMethodology;
  /** Read-only server-resolved methodology (ADR-0107): program ?? workspace, gated
   *  by the workspace policy. `inherited_methodology` is the workspace default the
   *  program shows under an active lock or when its own value is ignored. */
  effective_methodology: ProgramMethodology;
  inherited_methodology: ProgramMethodology;
  /** Iteration-container label override (ADR-0116, #1106). null = inherit the
   *  workspace default. */
  iteration_label: string | null;
  /** Read-only label inherited when the override is null — the workspace default. */
  inherited_iteration_label: string;
  /** Sharing overrides (ADR-0135). null = inherit the workspace value. */
  public_sharing: boolean | null;
  allow_guests: boolean | null;
  /** Read-only server-resolved effective values (program override ?? workspace). */
  effective_public_sharing: boolean;
  effective_allow_guests: boolean;
  /** Read-only values inherited if the override were cleared (the workspace value). */
  inherited_public_sharing: boolean;
  inherited_allow_guests: boolean;
  /** Forecast-history overrides (ADR-0144, issue 1232). null = inherit the workspace value. */
  mc_history_enabled: boolean | null;
  mc_history_retention_cap: number | null;
  mc_history_attribution_audience: MCAttributionAudience | null;
  /** Read-only server-resolved effective values (program override ?? workspace). */
  effective_mc_history_enabled: boolean;
  effective_mc_history_retention_cap: number;
  effective_mc_history_attribution_audience: MCAttributionAudience;
  /** Read-only values inherited if the override were cleared (the workspace value). */
  inherited_mc_history_enabled: boolean;
  inherited_mc_history_retention_cap: number;
  inherited_mc_history_attribution_audience: MCAttributionAudience;
  /**
   * Attachment-policy overrides (ADR-0153, issue 976). `attachments_enabled`: null =
   * inherit the workspace value. `allowed_attachment_types` is tri-state:
   * null = inherit, [] = explicit empty, [...] = explicit allow-list.
   */
  attachments_enabled: boolean | null;
  allowed_attachment_types: string[] | null;
  /** Read-only server-resolved policy (program override ?? workspace, denylist subtracted). */
  effective_attachments_enabled: boolean;
  effective_allowed_attachment_types: string[];
  /** Read-only values inherited if the override were cleared (the workspace value). */
  inherited_attachments_enabled: boolean;
  inherited_allowed_attachment_types: string[];
  /** Duration-change percent policy override (ADR-0151, issue 1254). null = inherit
   *  the workspace value. */
  task_duration_change_percent_policy: DurationChangePercentPolicy | null;
  /** Read-only server-resolved effective policy (program override ?? workspace). */
  effective_task_duration_change_percent_policy: DurationChangePercentPolicy;
  /** Read-only policy inherited if the override were cleared (the workspace value). */
  inherited_task_duration_change_percent_policy: DurationChangePercentPolicy;
  /**
   * Calendar override (ADR-0441, issue #1987). null = inherit the workspace
   * calendar (or the system default when the workspace has none set either).
   */
  calendar: string | null;
  /**
   * Read-only server-resolved calendar (program override ?? workspace default),
   * or null when nothing up the chain sets one (CPM then uses the hardcoded
   * Mon-Fri/8h/UTC system default). Optional — absent on a stale cached response
   * from before #1987 shipped.
   */
  effective_calendar?: EffectiveCalendar | null;
  /**
   * Read-only calendar this program would show if its own override were cleared
   * (the workspace value), or null for the system default.
   */
  inherited_calendar?: EffectiveCalendar | null;
  /** Which scope supplied `effective_calendar`. */
  calendar_source?: ProgramCalendarSource;
  /** Cross-project dependency slip behaviour (issue 529). Direct column (default
   *  `warn`), not inheritable, so it carries no effective/inherited pair.
   *  Bulk-editable from the Workspace → Programs matrix (issue 1283). */
  risk_slip_propagation: ProgramSlipPropagation;
  /** Days a cross-project slip may persist before escalation (issue 529), 1–30
   *  (default 3). Bulk-editable from the Workspace → Programs matrix (issue 1283). */
  risk_escalation_days: number;
  /** PM health override; AUTO defers to the rollup. */
  health: ProgramHealth;
  /** Headline target finish date as an ISO `YYYY-MM-DD` string, or null when the
   *  program is open-ended (issue 560). Read/write; ADMIN+ to set. */
  target_date: string | null;
  /** Workspace or private listing scope. */
  visibility: ProgramVisibility;
  /** Accent color as #RRGGBB hex, or null when unset (#698). */
  color: string | null;
  /** User ID of the displayed program lead, or null when unset. */
  lead: string | null;
  /** Read-only nested user payload for the lead — null when ``lead`` is null. */
  lead_detail: { id: string; username: string; email: string } | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Caller's role on the program (0–4) or null when not a member. */
  my_role: number | null;
  my_role_label: string | null;
  /** Live counts annotated on the list endpoint — defaults to 0. */
  project_count: number;
  member_count: number;
  /** True when this is bundled demo data (any project is_sample) (#375). */
  is_sample: boolean;
  /** Lifecycle (#530) — closed programs are read-only at the program shell. */
  is_closed: boolean;
  closed_at: string | null;
  closed_by: string | null;
}

export interface ProgramMembership {
  id: string;
  server_version: number;
  program: string;
  user: string;
  user_detail: UserSummary;
  role: number;
  role_label: string;
  /** ISO 8601 timestamp of when the member was added to the program (#878). */
  joined_at: string;
  /** ISO 8601 timestamp of the last role change, or null if unchanged since joining (#878). */
  role_changed_at: string | null;
}

// ---------------------------------------------------------------------------
// Risk Register types (issues #52, #221). Hand-authored until openapi-typescript regeneration.
export interface Risk {
  id: string;
  /** Raw per-project decimal risk sequence as a string (e.g. "7"); #929 moved
   *  risks off the shared hex counter. Render `short_id_display`/`qualified_id`
   *  rather than formatting this directly. */
  short_id: string;
  /** Server-formatted compact identifier, e.g. "R-007" (#929). */
  short_id_display: string;
  /** Server-formatted fully-qualified identifier for exports / cross-project
   *  surfaces, e.g. "PLAT-R-007", or the compact form when the project has no
   *  code (#929). */
  qualified_id: string;
  server_version: number;
  project: string;
  title: string;
  description: string;
  status: 'OPEN' | 'MITIGATING' | 'RESOLVED' | 'ACCEPTED' | 'CLOSED';
  probability: number;
  impact: number;
  /** Computed by the API: probability × impact (1–25). */
  severity: number;
  owner: string | null;
  /** Display name for the owner — first+last, falls back to username. Null when unassigned. */
  owner_name?: string | null;
  /** 1–2 char initials for the owner — used in matrix bubbles and the register table avatar. */
  owner_initials?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tasks: string[];
  // Risk framework fields (ADR-0043, wave 7 issue #221) — all optional/nullable
  category?: 'TECHNICAL' | 'EXTERNAL' | 'ORGANIZATIONAL' | 'PROJECT_MANAGEMENT' | null;
  response?: 'AVOID' | 'MITIGATE' | 'TRANSFER' | 'ACCEPT' | null;
  mitigation_due_date?: string | null;
  trigger?: string;
  contingency?: string;
  /** Long-form PM annotations (ADR-0048). Empty string when unset. */
  notes: string;
}

// Risk comments — append-only discussion thread (ADR-0044, issue #244)
export interface RiskCommentAuthor {
  id: string;
  display_name: string;
}

export interface RiskComment {
  id: string;
  author: RiskCommentAuthor | null;
  message: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Program ceremony templates + phase-gate config (ADR-0079, issue #528)
// ---------------------------------------------------------------------------

export type CeremonyCadenceType = 'weekly' | 'biweekly' | 'monthly' | 'on_milestone';

export interface CeremonyTemplate {
  id: string;
  server_version: number;
  program: string;
  name: string;
  cadence_type: CeremonyCadenceType;
  /** Day specifier — weekday slug, "1st-thursday" form, or "" for on_milestone. */
  cadence_day: string;
  /** ISO time "HH:MM:SS" or null for on_milestone. */
  cadence_time: string | null;
  duration_minutes: number;
  owner_role: string;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhaseGateConfig {
  id: string;
  server_version: number;
  program: string;
  enabled: boolean;
  invite_template: string;
  updated_at: string;
}

// ===========================================================================
// CLIENT-PROJECTED SHAPES (camelCase) — NOT the wire contract.
//
// Unlike every interface above (snake_case, mirroring the DRF serializers),
// the Workspace block below is the *post-transform* output of the settings
// hooks (features/settings/hooks/useWorkspaceSettings.ts etc.), which map the
// snake_case API response (apps/workspace/serializers.py) into camelCase for
// the UI. Do NOT treat these as the schema: `fiscalYearStartMonth`, `workWeek`,
// `roleValue`, `projectCount`, `createdAt`, … do not exist on the wire — the
// serializer emits `fiscal_year_start_month`, `work_week`, `role_value`, etc.
// The OpenAPI schema (docs/api/openapi.json) is the authoritative wire shape.
// ---------------------------------------------------------------------------
// Workspace settings types (ADR-0032, #517–#520)
// ===========================================================================

/**
 * Workspace-level settings returned by GET /workspace/ and accepted by PATCH
 * /workspace/. `subdomain` is read-only on the wire and never sent in PATCH.
 */
export interface WorkspaceSettings {
  name: string;
  /** Read-only — set at workspace creation; never sent in PATCH. */
  subdomain: string;
  timezone: string;
  /** Fiscal-year anchor month, 1 (January) – 12 (December). */
  fiscalYearStartMonth: number;
  /** Fiscal-year anchor day of month, 1 – 31 (validated against the month). */
  fiscalYearStartDay: number;
  /** Read-only human label derived from month/day, e.g. "April 6". */
  fiscalYearStartDisplay: string;
  /** 7 booleans, Monday (index 0) through Sunday (index 6). */
  workWeek: boolean[];
  defaultProjectView: string;
  allowGuests: boolean;
  publicSharing: boolean;
  /** Cascade policy for `publicSharing` (ADR-0135, #978). `inherit`/`suggest`
   *  (OSS) let programs/projects narrow or widen freely; `enforce` is the
   *  Enterprise hard lock (stored, never enforced in OSS). */
  publicSharingOverridePolicy: 'inherit' | 'suggest' | 'enforce';
  /** Workspace-wide default iteration-container label (ADR-0116, #1106) — the
   *  root of the Workspace → Program → Project inheritance chain. */
  iterationLabel: string;
  /** Cascade policy. `inherit`/`suggest` (OSS) let lower scopes override;
   *  `enforce` locks the term and is an Enterprise capability (no-op in OSS). */
  iterationLabelOverridePolicy: 'inherit' | 'suggest' | 'enforce';
  /** Forecast-history config (ADR-0144, issue 1232) — the root of the
   *  Workspace → Program → Project inheritance chain (non-null at this scope). */
  mcHistoryEnabled: boolean;
  /** Retained-run cap; clamped server-side to [1, 500]. */
  mcHistoryRetentionCap: number;
  mcHistoryAttributionAudience: MCAttributionAudience;
  /** `allow` lets lower scopes override; `lock` is Enterprise-enforced (no-op in OSS). */
  mcHistoryOverridePolicy: MCHistoryOverridePolicy;
  /** Workspace-wide default planning methodology (ADR-0107, issue 955) — the
   *  non-null root of the Workspace → Program → Project methodology chain. New
   *  projects pre-fill from this default. */
  methodology: ProgramMethodology;
  /** How the workspace default cascades. `inherit` locks the per-scope affordance
   *  to the default; `suggest` (OSS default) lets programs/projects override;
   *  `enforce` is the Enterprise hard lock (no-op in OSS — stored, never enforced). */
  methodologyOverridePolicy: MethodologyOverridePolicy;
  /** Per-workspace attachment policy (ADR-0153, issue 976) — the non-null root of the
   *  Workspace → Program → Project chain. `attachmentsEnabled` gates task file
   *  uploads (external links are unaffected); `allowedAttachmentTypes` is the MIME
   *  allow-list seeded from the system default (the security denylist is always
   *  subtracted server-side). */
  attachmentsEnabled: boolean;
  allowedAttachmentTypes: string[];
  /** `suggest`/`inherit` (OSS) let lower scopes override freely; `enforce` is the
   *  Enterprise hard lock (stored, never enforced in OSS). */
  attachmentsOverridePolicy: 'inherit' | 'suggest' | 'enforce';
  /** Workspace-wide default for what happens to a task's % complete when its
   *  duration changes (ADR-0151, issue 1254) — the non-null root of the
   *  Workspace → Program → Project chain. */
  taskDurationChangePercentPolicy: DurationChangePercentPolicy;
  /** `suggest`/`inherit` (OSS) let programs/projects override; `enforce` is the
   *  Enterprise hard lock (stored, never enforced in OSS). */
  taskDurationChangePercentOverridePolicy: 'inherit' | 'suggest' | 'enforce';
  /** Workspace-wide default working calendar (ADR-0441, issue #1987) — the root of
   *  the Project → Program → Workspace → system-default chain. null = fall through
   *  to the system default (Mon–Fri, 8h/day); we do not materialize a system-default
   *  Calendar row. */
  calendar: string | null;
  /** `suggest`/`inherit` (OSS) let programs/projects override; `enforce` is the
   *  Enterprise hard lock (stored, never enforced in OSS). */
  calendarOverridePolicy: CalendarOverridePolicy;
  /** Read-only public serve URL for the uploaded workspace logo (#969, ADR-0149),
   *  or null when no logo is set. Carries a `?v=` cache-buster keyed to updated_at. */
  logoUrl: string | null;
}

/**
 * A single workspace member row returned by GET /workspace/members/ and PATCH
 * /workspace/members/{user_id}/.
 */
export interface WorkspaceMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  email: string;
  /** Human-readable role label e.g. "Admin". */
  role: string;
  /** Integer role value: MEMBER=100, ADMIN=300, OWNER=400. */
  roleValue: number;
  groups: string[];
  projectCount: number;
  /** Human-readable last-active string (may be null from the API). */
  lastActive: string | null;
  status: 'active' | 'guest' | 'deactivated';
  sso: boolean;
  twoFa: boolean;
}

/**
 * Pending workspace invite row returned by GET /workspace/invites/.
 */
export interface WorkspaceInvite {
  id: string;
  email: string;
  /** Human-readable role label. */
  role: string;
  /** Integer role value. */
  roleValue: number;
  status: string;
  /** Initials of the inviter, or null when unknown. */
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Subset of WorkspaceInvite used in the Members page pending-invite section —
 * matches the legacy stub shape so the existing component keeps compiling.
 */
export interface PendingInvite {
  /** Same as `WorkspaceInvite.id` — kept so revoke can reference it. */
  id: string;
  email: string;
  role: string;
  /** Initials of the sender (mapped from `invited_by`). */
  sentBy: string;
  /** Human-readable relative time (mapped from `created_at`). */
  sentAt: string;
}

/**
 * A member entry nested inside a WorkspaceGroup.
 */
export interface WorkspaceGroupMember {
  id: string;
  name: string;
  initials: string;
  color: string;
}

/**
 * A workspace group row returned by GET /workspace/groups/.
 */
export interface WorkspaceGroup {
  id: string;
  name: string;
  description: string;
  /** Initials of the lead user, or null when unset. */
  lead: string | null;
  /** UUID of the lead user, or null when unset. */
  leadUserId: string | null;
  memberCount: number;
  members: WorkspaceGroupMember[];
  /** Project names this group has access to. */
  projects: string[];
}
