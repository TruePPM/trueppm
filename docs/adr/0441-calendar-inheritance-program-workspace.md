# ADR-0441: Working-Calendar Inheritance (Project → Program → Workspace → System Default)

## Status
Accepted

## Context

Working calendars (the working-day mask, hours-per-day, timezone, and holiday/shutdown
exceptions that CPM uses to lay out a schedule) are today configurable **only at the
project level**. `Project.calendar` is a nullable FK; `Program` and `Workspace` have no
calendar at all. When `Project.calendar` is null and the project carries no
`ProjectCalendarLayer` overlays (ADR-0251), `build_sched_calendar(None)` falls through to
a **hardcoded Mon–Fri / 8h / UTC** default.

That means a program of related projects must have its working calendar configured
independently on every project — repetitive and drift-prone. Issue #1987 asks for
calendars to be settable at **workspace** and **program** scope and **inherited** by
everything below, while remaining **changeable down** (a program can override the
workspace calendar; a project can override the program calendar).

Resolution order (most specific wins):

```
project.calendar → program.calendar → workspace.calendar → system default (Mon–Fri/8h/UTC)
```

**P3M layer:** Programs and Projects (and the workspace root that seeds them). `Program`
and `Workspace` are OSS entities; this is single-org configuration, not cross-program
governance → **OSS**. Org-policy *enforcement* (locking a calendar so lower scopes
**cannot** override it) is portfolio governance → **Enterprise**, out of scope here; we
leave the seam.

**Forces / prior art:**
- **ADR-0116 (Iteration-Label Inheritance)** is a near-exact structural precedent: the
  same workspace→program→project→system-default chain, the same `TermOverridePolicy`
  (`INHERIT`/`SUGGEST`/`ENFORCE`), the same single-resolver-is-the-only-source-of-truth
  rule, and the same Enterprise `ENFORCE`→`SUGGEST` degradation. This ADR mirrors 0116's
  shape rather than inventing a new one.
- **ADR-0251 (Composable working calendars)** owns the calendar model and the
  `compose_project_calendar` → resolver-registry → `Calendar.compose` pipeline. Base-calendar
  *inheritance* (which calendar a project gets when it sets none) is a **new, orthogonal
  axis** to 0251's *overlay* composition (holidays/shutdowns applied on top). They compose:
  inheritance picks the base; overlays still stack on top of it.
- **ADR-0194 (Calendar-change recompute)** established the recompute-on-calendar-change
  convention (`_recalc_projects_for_calendar` → `enqueue_recalculate(reason=CALENDAR_CHANGE)`).
  This ADR **widens** that fan-out to projects that *inherit* an edited/reassigned
  program- or workspace-level calendar.
- **ADR-0161 (bulk-PATCH inherited settings)** explicitly excluded `calendar` from the
  bulk endpoint because "no calendar→recalc trigger exists." 0194 has since supplied that
  trigger; this ADR does not re-open bulk-PATCH for calendar (still deferred) but records
  that the blocking reason is now resolved.
- **VoC (load-bearing, Nadia / API):** the resolved effective calendar **and which scope
  it came from** must be a first-class, additive, read-only API fact — not a UI-only
  computation — so an agent/integration reads it without re-implementing precedence.

## Decision

Follow the ADR-0116 "NULL-means-inherit + one resolver + Enterprise enforce seam" pattern,
adapted so the resolved base feeds the existing ADR-0251 calendar-composition pipeline.

### 1. Data model (additive, nullable)
- `Program.calendar` — `FK(Calendar, on_delete=PROTECT, null=True, blank=True,
  related_name="programs")`. `null` = inherit the workspace calendar.
- `Workspace.calendar` — `FK(Calendar, on_delete=PROTECT, null=True, blank=True,
  related_name="+")`. `null` = fall through to the **system default** (Mon–Fri/8h/UTC);
  we do **not** materialize a system-default `Calendar` row — the code-level fallback in
  `build_sched_calendar(None)` remains the single source of the system default.
- `Workspace.calendar_override_policy` — `TermOverridePolicy` (`INHERIT`/`SUGGEST`/`ENFORCE`),
  default `SUGGEST`. In OSS, `INHERIT` and `SUGGEST` both allow lower scopes to override;
  `ENFORCE` degrades to `SUGGEST` (no lock) unless an Enterprise provider is registered.
- `Project.calendar` is **unchanged** (still the most-specific override; `null` now means
  "inherit from program/workspace" instead of "system default"). No rename — additive only.

### 2. Resolver (single source of truth)
New module `apps/scheduling/calendar_inheritance.py`, mirroring
`apps/projects/methodology.py`:
- `resolve_effective_base_calendar(project, *, workspace=None) -> Calendar | None` —
  first-non-null of `project.calendar`, `project.program.calendar` (if the project has a
  program), `workspace.calendar`; `None` ⇒ system default.
- `resolve_inherited_base_calendar(project, ...)` — same but skips the project's own value
  (drives the "Inherited from {scope}" UI).
- `resolve_base_calendar_source(project, ...) -> "project" | "program" | "workspace" |
  "system_default"` — the breadcrumb.
- `calendar_override_locked(workspace) -> bool` and
  `register_calendar_enforcement_provider(...)` / `calendar_enforcement_active()` — the
  Enterprise seam, no-op in OSS (returns `False`).

### 3. CPM wiring (the injection point)
`oss_project_layers(project)` (in `apps/scheduling/calendars.py`) changes its **base**
from the raw `project.calendar` to `resolve_effective_base_calendar(project)`. Overlays
(`ProjectCalendarLayer`) are appended unchanged, so they still compose on top. Because
`Calendar.compose()` is AND-of-masks + union-of-exceptions (commutative) with first-wins
for the inert `hours_per_day`/`timezone`, and the resolved base leads the list, semantics
for a project that sets its own calendar are **byte-identical** to today. `Calendar.compose()`
itself needs **no change**. Every CPM/Monte-Carlo/program/export call site already routes
through `compose_project_calendar` / `resolve_applied_calendars`, so they inherit the fix.

### 4. API surface (additive read facts — Nadia)
- `ProjectSerializer`: add read-only `effective_calendar` (nested `CalendarSerializer`) and
  `calendar_source` (`project|program|workspace|system_default`). Existing `calendar`
  field unchanged.
- `ProgramSerializer`: add write `calendar` (id, nullable), read-only `effective_calendar`,
  `inherited_calendar`, and `calendar_source` (`program|workspace|system_default`).
- `WorkspaceSerializer`: add `calendar` (id, nullable) and `calendar_override_policy`.
- New enum name pinned in drf-spectacular `ENUM_NAME_OVERRIDES` to avoid schema-drift
  collisions (per ADR-0116/0107 convention). All fields additive → non-breaking; changelog
  fragment records the schema addition.

### 5. Recompute fan-out (extends ADR-0194)
- Editing a `Calendar` definition already recomputes projects using it as base/overlay;
  widen `_recalc_projects_for_calendar(calendar_id)` to also include projects that
  *inherit* it — i.e. programs whose `calendar_id` matches (for their non-overriding
  projects) and, when it is the workspace calendar, all projects resolving up to workspace.
- Reassigning `Program.calendar` recomputes that program's inheriting projects
  (`program.projects` with `calendar__isnull=True`).
- Reassigning `Workspace.calendar` recomputes every project that resolves to workspace
  (`calendar__isnull=True` AND (`program__isnull=True` OR `program__calendar__isnull=True`)).
- All dispatch goes through the existing `enqueue_recalculate` / scheduling outbox
  (`reason=CALENDAR_CHANGE`) — no new task type, no new drain.

### 6. Settings UI (ADR-0146 sections)
- Workspace: a "Working calendar" `<SettingsSection>` (sibling to `WorkspaceSchedulePage`)
  — pick the workspace default from `useCalendars()`; policy control is present but the
  `ENFORCE` option renders as a disabled Enterprise-upsell row.
- Program: a "Working calendar" `<SettingsSection>` mirroring `ProjectMethodologyPage`'s
  inherit/override rendering — "Inherited from workspace ({name})" when null, override
  picker to set it.
- Project: `ProjectGeneralPage` already frames `calendar=null` as "Inherit from workspace";
  update its copy/breadcrumb to show the true resolved source (which may now be the program).
- Override is presented as a **first-class equal choice**, not a "policy break" (VoC:
  Morgan/Sarah/Alex) — no warning modals; a neutral "Overriding {scope} default" hint.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. NULL-means-inherit + resolver feeding `oss_project_layers` (chosen)** | Mirrors ADR-0116 exactly; zero change to `Calendar.compose`; additive/non-breaking; overlays keep composing | Adds one resolver module + fan-out widening |
| B. Denormalize a stored `effective_calendar_id` column per project | Simple reads | Drift risk (must recompute on every ancestor change); violates the 0116 "resolver is the only place inheritance is computed" rule |
| C. Model program/workspace calendars as additional `ProjectCalendarLayer` rows on every project | Reuses overlay table | AND-composition would *intersect* masks instead of *override* them (wrong semantics — "most specific wins" ≠ "AND of all scopes"); explosive row count; breaks on reassignment |
| D. Dedicated `GET /projects/{id}/effective-calendar/` endpoint instead of embedded fields | Very explicit | Extra round-trip; inconsistent with `effective_methodology` embedded-field convention; Nadia accepted either — embedded is cheaper |

## Consequences

- **Easier:** set a calendar once at workspace/program level and every non-overriding
  project inherits it; CPM, Monte-Carlo, program schedule, and MS Project export all read
  the resolved calendar through the one existing seam; agents/integrations read
  `effective_calendar` + `calendar_source` as first-class facts.
- **Harder / risks:** a workspace-calendar change can fan out a recompute across **all**
  inheriting projects — bounded and async (CPM queue), but a large workspace triggers many
  jobs; the fan-out queries must be indexed (`Project.program` is already `db_index=True`;
  `Project.calendar` FK is indexed). Editing the resolver is the only correct place to
  change precedence — a second precedence implementation would drift (0116's warning).
- **Enterprise seam:** `calendar_override_policy=ENFORCE` is inert in OSS; the
  `CALENDAR_ENFORCEMENT_PROVIDER` registry slot lets Enterprise add a real lock without an
  OSS change.

## Implementation Notes
- **P3M layer:** Programs and Projects (+ Workspace root). OSS.
- **Affected packages:** api (models, resolver, serializers, views, migration), web
  (settings sections), docs. `scheduler` unchanged (compose already supports it).
- **Migration required:** yes — additive: `Program.calendar`, `Workspace.calendar`,
  `Workspace.calendar_override_policy`. All nullable / defaulted → no data backfill, no
  NOT-NULL-without-default. One migration for the whole feature (migration discipline #1).
- **API changes:** yes — additive read/write fields on Project/Program/Workspace
  serializers + one new enum. Non-breaking; changelog + OpenAPI regenerate.
- **OSS or Enterprise:** OSS (`trueppm-suite`). Enforcement provider is the only
  Enterprise-side follow-up.

### Durable Execution
1. **Broker-down behaviour:** reuses the existing scheduling outbox via
   `enqueue_recalculate` (ADR-0194) — the outbox row is written in the same transaction as
   the calendar/assignment change and drained if `.delay()` fails. No new direct `.delay()`.
2. **Drain task:** reuses the existing scheduling-request drain — semantics are identical
   (a CPM recompute request per project); no new category of async work.
3. **Orphan window:** unchanged from the scheduling outbox (10-min schedule-request
   threshold); this feature adds no new outbox type.
4. **Service layer:** `scheduling/services.py::enqueue_recalculate(project_id,
   reason=CALENDAR_CHANGE)` — the established entry point; the widened
   `_recalc_projects_for_calendar` and the new program/workspace fan-out helpers call it,
   never `recalculate_schedule.delay()` directly.
5. **API response on best-effort dispatch:** calendar assignment is a normal serializer
   PATCH returning the updated entity (200) with the recompute enqueued on
   `transaction.on_commit`; no synchronous task id is promised.
6. **Outbox cleanup:** unchanged — the existing scheduling-outbox nightly purge (7-day
   retention) covers these rows; no new outbox table.
7. **Idempotency:** CPM recompute is idempotent by `project_id` (last-write-wins on the
   computed schedule); duplicate enqueue collapses in the outbox / is safe to run twice.
8. **Dead-letter / failure handling:** inherits the scheduling queue's existing retry and
   dead-letter behaviour; a failed recompute leaves the prior computed schedule intact and
   surfaces through the existing schedule-request failure path — no new DLQ.
