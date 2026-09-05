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
 * May this reader enter the Designer's **Author** mode at all? (#3034, ADR-0773 §(d))
 *
 * Takes the server's `Project.can_author`, not a role ordinal, and that is the
 * whole point. The authoring rule is
 * `role >= MEMBER && !(SCHEDULER <= role < ADMIN)` — a *band exclusion*, not a
 * threshold — so the obvious client-side `canEditTask(role)` (`role >= MEMBER`)
 * gets Scheduler exactly backwards: ordinally above Member, refused task content
 * by the server. That mismatch is not a cosmetic one. It splits into two
 * failures, and the second is the reason this is resolved server-side:
 *
 * 1. paste-many and the classification cascade 403 outright (`IsProjectPlanAuthor`);
 * 2. a single row **commits** and then every subsequent edit 403s — `TaskViewSet`
 *    admits the create at `IsProjectMemberWrite` and refuses the update at
 *    `IsProjectMemberWriteOrOwn`. In a keyboard-fast row grid that is a trap, and
 *    it is verbatim the trap `can_user_author_plan`'s docstring was written about.
 *
 * `undefined` — the project detail query has not resolved — returns `false`, so
 * the apparatus is ABSENT until the server answers rather than flashing on for
 * the non-author majority. Same pessimism `canEditTask(null)` already applies,
 * and the same rule #2949 settled: absence beats a false affordance.
 *
 * Deliberately NOT the resolver for a single row — that stays
 * {@link canEditTaskRow}, which the server answers per task. This one is the
 * project-level "is there a mode to be in".
 */
export function canAuthorPlan(canAuthor: boolean | undefined): boolean {
  return canAuthor === true;
}

/**
 * Should a surface DISCLOSE that this caller cannot reverse a batch write?
 * (#3357, web rule 373(d))
 *
 * Takes `Project.can_undo_batch_operations` — the server's own verdict, from the
 * predicate the `/…-operations/{id}/undo/` endpoints enforce — never a client-side
 * `role >= ROLE_ADMIN`.
 *
 * Be precise about why, because the obvious reason is the one that does NOT apply.
 * Unlike {@link canAuthorPlan}, the server's rule here IS a plain threshold, so an
 * ordinal comparison would agree with it today, custom Enterprise band included. Two
 * other things decide it:
 *
 * 1. **The floor is under live revision.** #3355 is open on whether Admin+ is right
 *    at all, and `structural_operation_services` already implements actor-or-Admin
 *    instead. A client-side copy is a second implementation of a rule the server has
 *    said it may change, and nothing would fail when it drifts.
 * 2. **`useCurrentUserRole` sets `retry: false`**, so one dropped request is terminal
 *    and returns `role: null` for the life of the page. Against a `>= ROLE_ADMIN`
 *    test that renders as a standing "you cannot undo" shown to a Project Manager who
 *    can — and 35 of its 41 call sites do not destructure `isError`, so the miss is
 *    the default outcome, not a hypothetical (#2961, rule 302).
 *
 * A third trap is not about the ordinal at all: on the product backlog the authority
 * already in scope is `canManageBacklog` (Admin+ **or** the Product Owner facet),
 * which is a different rule and answers this question wrong for a PO below Admin.
 * Reusing the variable at hand is the mistake this field exists to make impossible.
 *
 * **The pessimism is inverted relative to {@link canAuthorPlan}, on purpose.** That
 * one returns `false` on `undefined` so an affordance stays ABSENT until the server
 * answers — absence beats a false affordance (#2949). Here the output is not an
 * affordance but a *withdrawal*, so the same default would produce the opposite
 * harm: it would tell a Project Manager they cannot undo, every time the project
 * query is in flight. Assuming rights on an unknown costs at worst a note that
 * appears a beat late; assuming denial states something false to the one reader who
 * has the right. So this discloses ONLY on an affirmative `false`.
 *
 * Named for the disclosure rather than the capability for the same reason: a
 * `canUndo()` helper reads as a capability check and every call site would then have
 * to remember to negate it *and* re-handle `undefined`, which is the shape that
 * produced the wrong default the first time.
 */
export function shouldDiscloseUndoFloor(canUndoBatchOperations: boolean | undefined): boolean {
  return canUndoBatchOperations === false;
}

/**
 * May this reader author dependency **edges**? (#3053, ADR-0773 §7)
 *
 * A SECOND permission, not a rephrasing of {@link canAuthorPlan}, and the two are
 * not nested. Task content is `IsProjectPlanAuthor` — `role >= MEMBER` minus the
 * 200–299 band, so it EXCLUDES Scheduler. Dependency edges are
 * `IsProjectScheduler` — `role >= SCHEDULER`, so they EXCLUDE Member. Neither
 * rule is a superset of the other, which is why one boolean could not front both:
 * whichever way it resolved it was wrong for one band. It resolved as task
 * content, and a Scheduler lost canvas drag-to-link the server would have
 * accepted.
 *
 * The role ordinal is the right input here, unlike {@link canAuthorPlan}: the
 * server's rule for edges IS a threshold, so there is no band exclusion for a
 * client-side `>=` to get backwards, and the server sends no `can_author`
 * equivalent for dependencies.
 *
 * Where the server actually enforces it is worth knowing before you change this.
 * `POST /api/v1/dependencies/` is a FLAT route with no `project_pk`, so
 * `IsProjectScheduler.has_permission` takes its `return True` fail-open branch
 * (#2745) and `has_object_permission` does not run on a create. The floor is
 * enforced one layer down instead, by `DependencySerializer.validate` →
 * `_authorize_same_project_edge`, which calls `check_object_permissions` on BOTH
 * endpoint tasks and therefore does reach `has_object_permission`. It is a real
 * gate, but not where you would look for it — pinned by
 * `tests/apps/access/test_rbac.py::TestDependencyAuthoringBand`.
 *
 * `null`/`undefined` returns `false` — the pessimism `canEditTask` and the
 * `canImport` gate already apply, so the affordance stays absent until the answer
 * arrives rather than flashing on and then refusing.
 *
 * That covers two of the three ways a role can be null, and the caller is expected
 * to re-open the third. Loading and no-membership are correctly `false` here; a
 * FAILED read is not (#2961). `useCurrentUserRole` sets `retry: false`, so one
 * dropped request is terminal, and treating it as a refusal removes a working
 * control for the life of the page. This resolver cannot tell the three apart —
 * it receives only the ordinal — so a caller that has `isError` must OR it in.
 * `ScheduleView`'s `dependenciesReadOnly` is the reference for that.
 */
export function canAuthorDependencies(role: number | null | undefined): boolean {
  return role != null && role >= ROLE_SCHEDULER;
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

/**
 * Whether this role may take a plan out of draft (`POST /projects/{id}/commit/`).
 *
 * Admin+ (Project Manager, Project Admin). This is the row ADR-0773's matrix already
 * decided — "Publish / commit the plan (0.5 draft lifecycle)" is ❌ for Viewer, Member
 * **and Scheduler** — and the endpoint enforced one band lower than that until #3129.
 * The floor is `IsProjectAdmin` on the server; this predicate exists so the button and
 * the endpoint state the same rule rather than drifting.
 *
 * A threshold (`>=`), not equality, so an Enterprise custom role registered in the
 * 301–399 project-lead band inherits it — the ADR-0072 band contract.
 *
 * `null`/`undefined` (role still loading, or no membership) is `false`: pessimistic
 * until settled, so a Commit button never flashes and then vanishes. Deliberately NOT
 * the optimistic `roleUnsettled` treatment `canEditTaskRow` uses — that one keeps a
 * row editable during a flicker, which is recoverable; offering a one-way,
 * non-undoable action to someone who may turn out to lack it is not.
 */
export function canCommitPlan(role: number | null | undefined): boolean {
  return role != null && role >= ROLE_ADMIN;
}
