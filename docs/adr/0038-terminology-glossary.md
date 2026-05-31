# ADR-0038: TruePPM Terminology Glossary

## Status
Accepted

## Context

As the ADR corpus grew and new personas (Alex Rivera, Scrum Master) were added, several
terms accumulated inconsistent usage across documents. This ADR is a living reference for
canonical terminology. When adding new ADRs or updating existing ones, consult this file
for the correct term, storage convention, and display rule.

**Scope:** This glossary covers terms that have caused or risk causing confusion. It is
not exhaustive. Technical terms with a single unambiguous meaning throughout the codebase
are not listed.

## Decision

### View name: "Schedule view" (not "Gantt")

TruePPM's Gantt-style timeline view is named **Schedule view** in all user-facing copy and
documentation prose. The rename was introduced in the `chore/rename-gantt-to-schedule`
branch to avoid trademark and IP exposure.

| Context | Correct term | Wrong term |
|---------|-------------|------------|
| Prose (ADRs, docs, UI copy) | "Schedule view", "the Schedule" | "Gantt", "Gantt view" |
| Code symbols (do not rename) | `GanttRenderer.ts`, `useGanttTasks`, `GanttView.tsx` | — |
| General industry concept (other tools) | "Gantt chart" is acceptable | — |

**Rule:** When referring to TruePPM's own feature, use "Schedule view". When referring
to the general project management concept (e.g., in competitive analysis), "Gantt chart"
is acceptable.

---

### `max_units` — storage vs. display

`Resource.max_units` and `TaskResource.units` are stored as **decimal fractions**
where `1.0 = 100% FTE / full-time`.

| Value | Stored as | Displayed as (UI) |
|-------|-----------|-------------------|
| Full-time | `1.0` | `100%` or `8h/day` |
| Half-time | `0.5` | `50%` or `4h/day` |
| 20% | `0.2` | `20%` or `1.6h/day` |

**Hours conversion:** `hours_per_day = max_units × resource.calendar.hours_per_day`
(falls back to `8.0` when no calendar is assigned).

The model never stores hours directly. All hours displayed in the UI are derived at
render time from the decimal field and the calendar. See ADR-0033 `CapacityInput`
for the canonical dual-mode component.

---

### `planned_start` vs. `actual_start`

These are **independent fields** that must not be conflated:

| Field | Meaning | Set by |
|-------|---------|--------|
| `planned_start` | SNET constraint — the earliest the CPM forward pass will schedule this task. PM's intent. | PM sets explicitly; never auto-set from work events |
| `early_start` | CPM-computed earliest start — result of the forward pass. May differ from `planned_start` if predecessors constrain the task further. | Scheduler engine (read-only to PM) |
| `actual_start` | Date work actually began. Always recorded when task transitions to `IN_PROGRESS`, regardless of whether a baseline exists. | Auto-set on status transition; PM can override |

A baseline is a **comparison tool**, not a prerequisite for recording actual dates.
`actual_start` is set on every `IN_PROGRESS` transition whether or not the project has
a baseline snapshot. See ADR-0023 for the full auto-set rules.

**PMBOK / PMI EVM alignment:** Actual dates track reality; baseline dates track the
approved plan; CPM-computed dates track the current re-forecast. All three layers
coexist and are independently maintained.

---

### Version targets

| Label | Meaning |
|-------|---------|
| `v0.1` | Pre-alpha / internal prototype — no stability guarantees |
| `v1.0` | General Availability (GA) — first public release with production-quality guarantees |
| `v1.1` | First minor release after GA — velocity-to-CPM feedback loop, WASM drag-preview |

When an ADR defers a feature to a milestone, use these labels:
- "Deferred to post-v1.0" or "v1.1" for features that need the GA release as a foundation
- "v1.0" as the target for first-class features that must ship with GA (e.g. mobile app)

---

### `TaskStatus` — canonical values

The five canonical `TaskStatus` values (as of migration `0020`):

| Value | Board column concept |
|-------|----------------------|
| `BACKLOG` | Not yet started; no sprint; product backlog |
| `NOT_STARTED` | In scope for current sprint or project phase, not started |
| `IN_PROGRESS` | Work begun; triggers `actual_start` auto-set |
| `REVIEW` | Work complete, awaiting sign-off |
| `COMPLETE` | Accepted; triggers `actual_finish` auto-set |

**Important:** `BACKLOG` is a **board column concept**. Tasks created outside the board
(via the task list, API, or MS Project import) are created with `NOT_STARTED`, not
`BACKLOG`. `BACKLOG` is reserved for tasks explicitly placed in the sprint/project
backlog. Do not use `BACKLOG` as a default status for new tasks.

(`ON_HOLD` is a legacy value; migration `0020` moved existing rows to `NOT_STARTED`.
It must not appear in new code paths.)

---

### OSS vs. Enterprise boundary rule

The single deciding question: **"Does this feature require aggregating data across
more than one project?"**

| Answer | Classification |
|--------|---------------|
| No — single-project scope | **OSS** (`trueppm-suite`, Apache 2.0) |
| Yes — cross-project aggregation | **Enterprise** (`trueppm-enterprise`, proprietary) |

The OSS core must remain fully functional without the enterprise package. Enterprise
code registers against OSS extension points (signals, slot registry, URL patterns);
OSS never imports from `trueppm_enterprise`. Verify with:
```bash
grep -r "trueppm_enterprise" packages/  # must return zero results in OSS code
```

---

### `BurnSnapshot` vs. `SprintBurnSnapshot`

Two separate snapshot models exist in v1.0 (see ADRs 0022 and 0037):

| Model | Scope | Lifecycle |
|-------|-------|-----------|
| `BurnSnapshot` (ADR-0022) | Project-level burndown | Persists for the project lifetime |
| `SprintBurnSnapshot` (ADR-0037) | Sprint-level burndown | Exists from activation through close + 30-day retention |

Schema convergence into a polymorphic model is a **post-v1.0** concern. A dedicated ADR
(planned before the v1.1 milestone) will decide whether to merge the two tables. Until
then, both models are authoritative for their respective scopes.

## Consequences

- **Easier**: New ADR authors have a single reference for naming decisions; reviewers
  have a checklist for terminology regressions.
- **Harder**: This ADR requires maintenance. When a new term is introduced that could
  become ambiguous, add it here in the same PR.

## Implementation Notes

- P3M layer: N/A — documentation only
- Affected packages: none
- Migration required: no
- API changes: no
- OSS or Enterprise: OSS (documentation lives in `trueppm-suite`)

## Tracking

Tracking: design-only artifact (no implementation issue) — terminology glossary.
