# ADR-0251: Composable working calendars (OSS slice of #906)

## Status
Accepted

## Context

A project's effective non-working mask for CPM is today a **single** `Calendar`
(`Project.calendar` FK). Real programs need to overlay several reusable calendars:
a base project calendar (weekend pattern + hours) + a shared holidays calendar
(e.g. "US Federal 2026") + an optional workspace/shutdown calendar. The effective
schedule must treat a day as non-working if **any** applied calendar marks it
non-working.

Two facts from the code shape the design:

- **The scheduler needs no change.** `trueppm_scheduler.models.Calendar` already
  carries `working_days: int` (bit0=Mon) + `exceptions: list[DateRange]` with the
  `_exception_intervals()` merge+bisect index (O(log E) `is_working_day`).
  Composition is therefore done by folding N calendars into **one** scheduler
  `Calendar` and passing it to the engine exactly as today — not by teaching the
  engine to union internally (the engine is dual-implemented in Python + Rust/WASM;
  duplicating fold logic across both is avoidable, and the merge index already
  handles the concatenated exception set for free). This resolves issue #906 Q3.
- **A single conversion primitive already exists.** `build_sched_calendar(cal)`
  (`scheduling/services.py`) is the sole API→engine calendar mapping (shipped in
  #1491, which added the `calendar__exceptions` prefetch). Every CPM / Monte Carlo
  / program-schedule call site feeds it.

**OSS/Enterprise boundary (enterprise-check, this issue).** The whole slice is
🟢 OSS: composing *one project's own* non-working mask from several *applied*
(opt-in, removable) calendars is adoption, not governance. Enterprise keeps
*enforced/governed* cross-program calendars and per-resource calendars that feed
*cross-portfolio* resource leveling. Two guardrails from that review are encoded
below: (1) composition reads an **ordered list of calendar sources** through a
resolver registry, never a hardcoded 3-tuple; (2) the applied-calendar link is
**project-owned and removable** — no `is_enforced` column in OSS.

## Decision

### 1. Data model — keep the base FK, add an overlay through model

Keep `Project.calendar` as the **base** calendar. Add a `ProjectCalendarLayer`
through model for **overlays only**. Do not migrate to a full M2M.

- The base's scalar attributes (`hours_per_day`, `timezone`) are structurally
  unambiguous — they come from the FK, so we never define "which calendar's
  hours_per_day wins" as data. Overlays contribute **only** mask + exceptions.
- The entire non-scheduling read surface (sync delta, sprint capacity,
  utilization, seed export) keeps reading `project.calendar` with zero change.
- Migration is purely additive (one new table). No data migration.

```python
class CalendarRole(models.TextChoices):
    PROJECT   = "project",   "Project"               # base only; never stored in a layer row
    HOLIDAYS  = "holidays",  "Holidays"
    WORKSPACE = "workspace", "Workspace / shutdown"

class ProjectCalendarLayer(VersionedModel):
    project    = FK(Project, on_delete=CASCADE, related_name="calendar_layers")
    calendar   = FK(Calendar, on_delete=PROTECT, related_name="applied_to_layers")
    role       = CharField(choices=CalendarRole.choices, default=HOLIDAYS)
    sort_order = PositiveSmallIntegerField(default=0)
    # UniqueConstraint(project, calendar); ordering = [sort_order]
```

- `VersionedModel` so overlay changes ride the sync delta, matching `Calendar`.
- `calendar` is `PROTECT`: a shared library calendar in use as an overlay cannot
  be deleted out from under a project (parity with `Project.calendar`).
- The serializer **rejects** `role=PROJECT` on a layer, and rejects
  `calendar_id == project.calendar_id` (a calendar AND-ed with itself is a no-op).
- The "applied calendars list" the UI renders = base (implied `role=project`,
  position 0) prepended to the overlay layers ordered by `sort_order`.

### 2. Composition semantics

- **Effective `working_days` = bitwise-AND of all applied masks.** A day is
  working only if working in *every* calendar → non-working if *any* marks it so.
- **Effective exceptions = union (concatenation) of every applied calendar's
  ranges.** The engine's `_exception_intervals()` sorts+merges, so plain
  concatenation is safe — no API-side dedup.
- **`hours_per_day`/`timezone` come from the base only** (overlays carry no
  meaningful value; the engine treats both as reserved/inert today).
- **Holidays edge case:** a holidays calendar should have mask `127` so AND is
  identity and it contributes only exceptions. This is **soft guidance, not a DB
  constraint** — a `Calendar` is a shared resource whose role is per-application.
  The preview endpoint surfaces *why* each day is non-working, so an overlay that
  unexpectedly strips a weekday is visible.

The fold lives in `trueppm_scheduler.models.Calendar.compose(iterable)` (Apache
package) — the OSS composition seam enterprise extends by contributing more
sources. It stays Django-free (takes plain dataclasses).

### 3. Composition helper + resolver registry — compute-on-read

`compose_project_calendar(project)` (new, `scheduling/calendars.py`) folds the
project's applied calendars into one scheduler `Calendar`:

- Applied calendars are gathered through a **settings registry**
  `CALENDAR_LAYER_RESOLVERS` (mirrors `EXTERNAL_TASK_SOURCES` / ADR-0029 slot
  registration). Each resolver is `(project) -> list[Calendar]`. OSS registers one
  resolver returning `[base, *overlay_layers]`. `compose_project_calendar` folds
  over the **union** of every registered resolver's output, so enterprise appends
  a resolver (per-resource, cross-program calendars) **without changing the OSS
  helper signature**. Because the fold is AND-of-masks + union-of-exceptions, any
  added resolver is always additive and order-independent.
- **No persistent cache.** The fold is O(layers) over a tiny set; the expensive
  per-day lookup is already indexed inside the scheduler `Calendar`. A materialized
  cache would need invalidation on base edit, overlay edit, layer add/remove, and
  any exception edit on any applied calendar — high complexity, negligible gain.
- **Every scheduling call site** (CPM pass, Monte Carlo, program schedule) swaps
  `build_sched_calendar(project.calendar)` → `compose_project_calendar(project)`
  and extends its prefetch with `calendar_layers__calendar__exceptions`. One path,
  no divergence between CPM / Monte Carlo / baselines (resolves Q7).

**Recompute fan-out (must-fix).** `_recalc_projects_for_calendar` fanned out to
`Project.filter(calendar_id=cal)` only. Once a calendar can be an overlay, editing
an overlay calendar (or its exceptions) must also recompute projects that use it as
an overlay — extended to `Q(calendar_id=cal) | Q(calendar_layers__calendar_id=cal)`
`.distinct()`. Adding/removing a layer enqueues a recompute for that one project; a
pure `sort_order` reorder does not (it never changes the schedule).

### 4. API shape

- **Calendar library CRUD** (`CalendarViewSet` + nested `CalendarExceptionViewSet`,
  writes gated `IsOrgAdmin`) — unchanged.
- **Project applied calendars** — new nested resource `/projects/{pk}/calendars/`:
  - `GET` → `{ base, overlays[], applied[] }` (assembled ordered payload).
  - `PUT` → atomic replace: `{ base_calendar_id, overlays: [{calendar_id, role}] }`.
    One transaction sets `Project.calendar`, diff-replaces the layer rows, assigns
    `sort_order` by array index, and fires a single `on_commit` recompute.
- **Effective preview** — `GET /projects/{pk}/calendars/preview/?start=&end=`:
  returns each day in the window with provenance (`working`, `sources[]` = which
  applied calendar(s) block it). Provenance evaluates each applied calendar
  individually per day (the merged calendar loses which source caused the block).
  Window capped at 366 days to keep it O(days × layers).

**RBAC:** authoring the shared library → `IsOrgAdmin` (unchanged); **applying**
calendars to a project (`PUT …/calendars/`) → **Scheduler+ on that project** (a
local scheduling decision that mutates no shared resource); preview → any project
member (Viewer+).

### 5. Scope fence

- Per-resource calendars (Q2) → OUT (larger engine change; extension-point seam).
- iCal / .ics import (Q4) → OUT (manual/seed authoring only).
- Cross-program / org-enforced calendar governance → OUT (Enterprise).
- Baselines / Monte Carlo (Q7) → same `compose_project_calendar` helper, no
  separate path.
- **Offline/WASM composition parity → OUT of this slice (tracked follow-up).**
  The sync delta ships only `Project.calendar`, so offline recompute composes
  against the base only until the delta also ships overlay calendars + layer rows
  and the TS/Rust wrapper mirrors the fold. Offline calendar-aware CPM is not in
  #906's scope; server-side composition ships now and the offline fold is tracked
  as **#1661**. The server remains the authority for scheduled dates.

### 6. Extension point (stable enterprise seam)

`CALENDAR_LAYER_RESOLVERS` (§3) is the one-way (enterprise → core) contract: OSS
ships one resolver, enterprise registers more against the same signature. No OSS
import of enterprise calendar types (`grep -r "trueppm_enterprise" packages/`
stays zero).

## Consequences

- **Migration:** additive — one new table `projects_project_calendar_layer`
  (+ its historical table). No data migration.
- **Scheduling call sites:** swap the converter + extend prefetches — the
  "change the thing, don't miss the shadow copy" surface.
- **Recompute fan-out:** must include overlay usage or overlay edits silently skip
  recompute.
- **Non-scheduling reads unchanged** — sprint capacity, utilization, seed keep
  using the base calendar's scalars. (Sprint capacity ignores exceptions even for
  a single calendar today; composition does not regress that — a separate,
  pre-existing gap.)
- **Follow-ups filed:** offline/WASM composition parity (#1661); single-project
  per-resource PTO calendars (#1662 — OSS, per enterprise-check; the cross-portfolio
  variant is the Enterprise boundary).
