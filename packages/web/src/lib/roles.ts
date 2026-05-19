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
