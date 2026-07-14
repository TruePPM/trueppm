/**
 * Role ordinal constants (ADR-0072).
 *
 * The OSS edition ships exactly 5 named roles with spaced ordinals — 99-unit
 * slot bands are reserved between them for Enterprise to register custom roles
 * (e.g., a "Senior Scheduler" at 250) via the slot-registration pattern
 * (ADR-0029) without forcing an OSS renumber.
 *
 * Always import from this module — never write a numeric literal like `>= 2`
 * or `=== 4` against a role value. Symbolic comparisons stay correct when
 * ordinals change; raw integers do not.
 *
 * Comparison guidance:
 *   role >= ROLE_X          → "at least the X-band" (extensible; Enterprise
 *                              custom roles in this band inherit capabilities)
 *   role === ROLE_X         → "specifically the OSS X tier" (NOT extensible;
 *                              custom roles do not absorb these matches)
 */

/** Read-only access to all project data. */
export const ROLE_VIEWER = 0;

/** Edit own assigned tasks; log time. */
export const ROLE_MEMBER = 100;

/** Assign resources, manage roster; no task edit. */
export const ROLE_SCHEDULER = 200;

/** Full task/dependency edit; create baselines. */
export const ROLE_ADMIN = 300;

/** Project Admin — delete project, manage membership. Singular ceiling tier. */
export const ROLE_OWNER = 400;

/**
 * True iff a viewer with this project role may edit task content — add/remove
 * links and attachments, edit the description (#1046). Member+ qualifies;
 * Viewers do not. `null`/`undefined` (role still loading or not threaded)
 * returns `false` so a write control never flashes before the role resolves —
 * a false affordance that 403s on submit is worse than a brief absence. The
 * server still enforces; this is the UX gate.
 */
export function canEditTask(role: number | null | undefined): boolean {
  return role != null && role >= ROLE_MEMBER;
}

/**
 * True iff a viewer with this project role may write risks — create, edit, and
 * import via CSV (issue 223). Member+ qualifies; Viewers do not. Mirrors the server
 * gate (IsProjectMemberWrite on the risk import action). `null`/`undefined`
 * returns `false` so the Import affordance never flashes before the role
 * resolves; the server still enforces, this is only the UX gate.
 */
export function canEditRisk(role: number | null | undefined): boolean {
  return role != null && role >= ROLE_MEMBER;
}

/**
 * True iff a viewer with this project role may create a task label (ADR-0400).
 * Member+ qualifies — adoption-first, so a team can coin `tech-debt` mid-retro
 * without a ticket (the server soft-caps the count). Mirrors the server gate
 * (IsProjectMemberWrite on label create). `null`/`undefined` → `false`.
 */
export function canCreateLabel(role: number | null | undefined): boolean {
  return role != null && role >= ROLE_MEMBER;
}

/**
 * True iff a viewer with this project role may curate the label catalog (ADR-0400)
 * — rename, recolor, reorder, or delete a label. Admin+ only, because a shared
 * label edit changes every card that carries it. Mirrors the server gate
 * (IsProjectAdmin). `null`/`undefined` → `false`.
 */
export function canManageLabels(role: number | null | undefined): boolean {
  return role != null && role >= ROLE_ADMIN;
}
