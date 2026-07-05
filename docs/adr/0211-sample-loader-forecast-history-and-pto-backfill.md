# ADR-0211: Sample-loader forecast-history and PTO backfill

## Status
Accepted

## Context

Issue #376 is the second iteration of the bundled sample-project loader
(ADR-0109 format, ADR-0114 v2 replay). The 0.3 loader already materializes a
program that has *run* for months: sprint velocity history, per-sprint
`SprintBurnSnapshot` rows, captured baselines, and an authored events timeline
(status moves, comments, risk lifecycle, scope injections). What it does **not**
produce is the data the 0.4 differentiator surfaces read:

- The forecast-trend chart (#368) reads `scheduling.ProjectForecastSnapshot` —
  a continuous, project-grain record of how the whole-project forecast drifts
  over time (ADR-0154). A freshly-loaded demo has zero snapshots, so the chart
  is empty on day one. It needs ~60 days of *history* to render a trend line.
- Capacity reality (#369) reads `CalendarException` non-working ranges (PTO). The
  sample calendars carry none.

The narrow decision: **how to encode 60 days of forecast drift, plus PTO, in the
seed fixture format** without a new model or migration, keeping the format a
stable extension point (ADR-0109) and round-trip-faithful (the seed exporter).

P3M layer: Programs and Projects (single-program demo data). OSS.

## Decision

Two **additive, optional** extensions to the v2 seed schema, both materialized
inside the existing import transaction:

1. **`forecast_history` (per-project object) — parameter-encoded, not row-encoded.**
   A project may carry a `forecast_history` block holding *drift parameters*:
   window length in days, a stable `commitment_finish` (the promised date that
   does **not** move), and start+end `seedDate`s for the CPM spine and each Monte
   Carlo percentile (P50/P80/P95). A new deterministic backfill
   (`seed/forecast_backfill.py`) synthesizes one `ProjectForecastSnapshot` per day
   across the window, linearly interpolating each percentile from its start to its
   end date with a small **seeded** jitter, and backdates `captured_at` so the row
   sits on its historical day. Determinism is keyed on `(program_code, project
   slug)` so re-import reproduces the identical trend.

2. **`exceptions` (per-calendar array) — PTO as `CalendarException` ranges.**
   A calendar may carry `exceptions[]` (`exc_start`, `exc_end`, `description`),
   materialized by extending `importer._resolve_calendars`. These double as the
   weekend/holiday ranges the relative-date resolver already snaps against
   (`reldates.WorkingCalendar`), so a PTO range authored here also affects date
   snapping — a single source of non-working truth.

The forecast backfill runs in the importer's **Pass B** (the per-project
cross-cutting pass that already captures baselines), because it needs the
committed `Project` row and the resolved anchor/calendar, and belongs inside the
same atomic import as every other history row. The cross-app import of the
`scheduling` model mirrors the importer's existing `enqueue_recalculate` import —
the boundary is already crossed one-way (api-internal), not an OSS/Enterprise
concern.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Parameter-encoded `forecast_history` (chosen)** | ~8 lines of fixture per project vs 180 rows; drift math lives in one tested function; deterministic; trivially kept current (relative dates re-anchor at import) | A second synthesis path beside replay; must be exporter-aware |
| 60 explicit snapshot rows in the fixture | Fully declarative; no synthesis code | 180 hand-authored rows across 3 projects; unreadable; ages badly; every drift tweak is a mass edit |
| Derive snapshots from post-commit CPM state | "Real" numbers | CPM recompute is async/post-commit — at import time tasks have **no** `early_finish`, so `cpm_finish`/percentiles would all be null; no history depth regardless |
| PTO as a new resource-availability model | Per-person granularity | New model + migration; #376 explicitly scopes to `CalendarException`; capacity feature already reads calendar exceptions |

## Consequences

- **Easier**: the forecast-trend, baseline-variance, and capacity surfaces all
  render on a freshly-loaded demo with no manual setup; the drift shape is one
  function to tune.
- **Harder**: forecast history is now a second synthesis path alongside replay;
  a schema-format change means the exporter must emit both new blocks to stay
  round-trip-faithful (covered by the exporter fixpoint tests).
- **Risks**: `captured_at` is `auto_now_add`, so backdating requires a
  post-`bulk_create` `bulk_update` — the standard replay-module pattern for
  backdating auto-stamped rows. Bounded: the window is validated (schema caps
  offsets at 4 digits) and the loop is at most `days` iterations per project.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (seed importer, schema, exporter, atlas fixture), docs
- Migration required: **no** — `ProjectForecastSnapshot`, `CalendarException`,
  `SprintBurnSnapshot`, `Baseline` all already exist; this is pure loader logic
- API changes: no
- OSS or Enterprise: OSS (`trueppm-suite`)

### Durable Execution
1. Broker-down behaviour: **N/A** — the backfill runs synchronously inside the
   import `transaction.atomic()`; it enqueues no tasks. (The one async side
   effect of the whole import — the per-project CPM recalc — is unchanged and
   already goes through `enqueue_recalculate` on commit.)
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: the CPM recalc still routes through
   `scheduling.services.enqueue_recalculate` (unchanged). Forecast backfill is a
   new pure function `seed/forecast_backfill.py::backfill_forecast_history`.
5. API response on best-effort dispatch: **N/A** — no new endpoint; the loader is
   a management command / existing sample endpoint.
6. Outbox cleanup: **N/A**.
7. Idempotency: the import is wipe-and-recreate on the program slug
   (`_replace_existing`), so the whole subtree — including the backfilled
   snapshots and exceptions — is rebuilt from a clean base on every reload.
   Determinism (seeded on program+project) makes the rebuilt history identical.
8. Dead-letter / failure handling: **N/A** — a synthesis failure raises inside
   the atomic import and rolls the whole import back, exactly like any other
   malformed-seed failure. There is no partial-history state to recover.
