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
  email: string;
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
 * Program health override. ``AUTO`` defers to the (future) rollup; the explicit
 * values are PM overrides. Mirrors ``apps.projects.models.Health`` (issue #523).
 */
export type ProgramHealth = 'AUTO' | 'ON_TRACK' | 'AT_RISK' | 'CRITICAL';

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

export interface Program {
  id: string;
  server_version: number;
  name: string;
  description: string;
  /** Optional short code; empty string when unset. */
  code: string;
  methodology: ProgramMethodology;
  /** PM health override; AUTO defers to the rollup. */
  health: ProgramHealth;
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
}

// ---------------------------------------------------------------------------
// Risk Register types (issues #52, #221). Hand-authored until openapi-typescript regeneration.
export interface Risk {
  id: string;
  /** Short per-project hex ID shared with the Task counter (e.g. "a3f1"). */
  short_id: string;
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
  // PMI framework fields (ADR-0043, wave 7 issue #221) — all optional/nullable
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

// ---------------------------------------------------------------------------
// Workspace settings types (ADR-0032, #517–#520)
// ---------------------------------------------------------------------------

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
