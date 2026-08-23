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
 *
 * Worked example of what the bands are for: an "Auditor" — read access plus
 * export and history, more than a Viewer but less than a Member — has no OSS
 * tier that fits, so Enterprise registers it at an ordinal in the 2–99 band.
 * Every `role >= ROLE_MEMBER` write gate keeps excluding it for free, and no
 * OSS ordinal has to move.
 *
 * Every ordinal is truthy on purpose (#2489). ROLE_VIEWER was 0 until 0.4, and
 * `0` is falsy in JavaScript — one `role || ROLE_MEMBER` anywhere in a consumer
 * would silently promote a Viewer. Absence of a role is `null`/`undefined`, a
 * distinct type; never the number 0.
 */

/** Read-only access to all project data. The lowest ordinal in use — 0 is unused. */
export const ROLE_VIEWER = 1;

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
 * May this reader mutate **this row**? (web rule 302, #2961, extended #2960)
 *
 * Three inputs, and the order matters:
 *
 * 1. `taskCanEdit` — the server's per-task verdict, when it sent one. It is a
 *    *settled* answer that does not depend on the role query at all, so it wins
 *    outright: a row the server declares uneditable must not offer a mutation
 *    anywhere, on any surface.
 * 2. `roleUnsettled` — the membership lookup is still in flight **or failed**
 *    (`retry: false` makes a single blip indistinguishable from "not a member").
 *    Assume rights: the server is the enforcement point, so a control briefly
 *    offered to a viewer costs at worst one silent refusal, while a control
 *    briefly withheld from an editor is visible on every load.
 * 3. Otherwise the project role decides.
 *
 * It lives here rather than inline because two surfaces ask it about the same
 * row — the outline's row menu and the Schedule canvas's right-click menu — and
 * two copies drift into one surface hiding an action the other still offers,
 * which is the divergence #2960 exists to close.
 */
export function canEditTaskRow(
  taskCanEdit: boolean | undefined,
  role: number | null | undefined,
  roleUnsettled: boolean,
): boolean {
  return taskCanEdit ?? (roleUnsettled ? true : canEditTask(role));
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

/**
 * Target status the server auto-promotes a task to when `percent_complete` is
 * set to 100 with no explicit `status` in the same write (Option E, #381
 * follow-up; #2639). Contributors (role < ROLE_ADMIN) route through REVIEW so
 * a PM/PMO sign-off step survives; ROLE_ADMIN+ (Project Manager, Project
 * Admin) complete directly.
 *
 * Mirrors `TaskSerializer._apply_percent_complete_auto_status` exactly — this
 * is a UX preview so the confirmation dialog can name the real outcome before
 * the write commits, never a substitute for the server decision. `null`/
 * `undefined` (role still loading) is treated as below-Admin (REVIEW) so the
 * dialog never over-promises COMPLETE before the role resolves.
 */
export function progressCompleteAutoStatus(role: number | null | undefined): 'REVIEW' | 'COMPLETE' {
  return role != null && role >= ROLE_ADMIN ? 'COMPLETE' : 'REVIEW';
}
