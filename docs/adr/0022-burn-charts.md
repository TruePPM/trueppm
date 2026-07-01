# ADR-0022: Burn Charts — Burn Down, Burn Up, and Combined

## Status
Accepted (2026-04-30) — API portion implemented in #239. The MVP endpoint
replays `HistoricalTask` directly rather than materialising daily
snapshots; the `BurnSnapshot` table and nightly Celery job described in §1
are deferred until measured query performance demands them. The web UI
(Recharts components, PNG export) ships as part of wave/10 issue #228.

> §2 (response shape) superseded by [ADR-0062](0062-burn-charts-web-implementation.md) (as-built API surface).

## Context

Issue #53 requests three standard agile progress charts scoped to a single project:
burn down (remaining work over time), burn up (completed work + scope line), and a
combined overlay. VoC panel scored this 6.0/10 — table stakes for a PM tool but not
a differentiator. Key blockers from the panel: (1) mobile offline support for cached
chart data, (2) API response shape must be extensible for Enterprise portfolio
aggregation, (3) PNG export must be presentation-quality, (4) server-side computation.

This feature sits at the **Programs and Projects** layer — single-project scope,
consumed by the PM (Sarah) and visible to the executive (Janet) in status reports.
No cross-project aggregation (that's Enterprise). Belongs in **OSS**.

### Data availability

The `HistoricalTask` table (django-simple-history, ADR-0011) tracks `status` and
`percent_complete` with `history_date` timestamps. This allows reconstructing the
state of all tasks on any past date by querying the most recent history record per
task before that date. No new model is strictly required.

However, replaying history for every chart request is expensive: O(days × tasks) with
window functions. For a 200-task project over 90 days, this means scanning thousands
of history rows per request. A **materialized daily snapshot** (pre-aggregated by a
nightly Celery job) trades one small table for predictable O(days) query performance.

### Charting library

No charting library exists in the web package. `MonteCarloHistogram` uses hand-rolled
SVG. Burn charts require line/area charts with tooltips, legends, responsive sizing,
and axis formatting — significantly more complex than a histogram. A library is justified.

### Metric availability

- **Tasks** (count of remaining/completed): available now via `Task.status`
- **Duration** (sum of `duration` field, working days): available now as a proxy for effort
- **Hours** (actual effort): requires `TimeEntry` model which does not exist yet
- **Story points**: requires a `points` field on Task which does not exist yet

## Decision

### 1. Materialized daily snapshot table (`BurnSnapshot`)

Add a new model `BurnSnapshot` in the `projects` app:

```
BurnSnapshot
  id              UUID PK
  project         FK → Project (CASCADE), indexed
  snapshot_date   DateField, indexed
  total_tasks     IntegerField        # scope line
  completed_tasks IntegerField        # burn up actual line
  total_duration  IntegerField        # scope in working days
  completed_duration IntegerField     # completed in working days

  Meta:
    unique_together = (project, snapshot_date)
    indexes = [(project, snapshot_date)]
```

No `server_version` — this is a derived/computed table, not a user-editable entity.
Not synced to mobile as a model; mobile receives the API response JSON and caches it.

**Backfill**: A management command `backfill_burn_snapshots` replays `HistoricalTask`
to populate past dates. Runs once on deploy, idempotent.

**Nightly job**: Celery beat task `burn_snapshot_daily` runs at 01:00 UTC (before
history purge at 02:00 UTC). For each active project, counts current task statuses
and inserts/updates the snapshot for today.

**Real-time update**: When a task status changes to/from COMPLETE, a `post_save`
signal updates today's snapshot row (upsert). This keeps the chart current within
the day without waiting for the nightly job.

### 2. API endpoint

```
GET /api/v1/projects/{pk}/burn-chart/?metric=tasks&from=2026-01-01&to=2026-04-11
```

Response (extensible shape — `project_id` field supports future Enterprise aggregation):

```json
{
  "project_id": "uuid",
  "metric": "tasks",
  "from": "2026-01-01",
  "to": "2026-04-11",
  "data_points": [
    {
      "date": "2026-01-01",
      "total": 45,
      "completed": 0,
      "remaining": 45
    },
    {
      "date": "2026-01-02",
      "total": 45,
      "completed": 2,
      "remaining": 43
    }
  ],
  "scope_changes": [
    {
      "date": "2026-02-15",
      "previous_total": 45,
      "new_total": 52,
      "delta": 7
    }
  ]
}
```

- `metric` param: `tasks` (default) or `duration`. Returns 400 for unsupported values.
- `from` / `to` default to project `start_date` and today.
- `scope_changes` array: entries where `total` changed from the previous day.
- Permission: project Viewer role or above.
- Redis-cached for 5 minutes (same pattern as `ProjectHistorySummaryView`).

### 3. Charting library: Recharts

**Recharts** (MIT license, 24k+ GitHub stars, 1.4M weekly npm downloads):
- Built on React + D3 — composable, declarative API
- `<LineChart>`, `<AreaChart>`, `<ComposedChart>` cover all three burn variants
- Built-in responsive container, tooltips, legends, reference lines (ideal burn)
- SVG-based — supports client-side PNG export via `html-to-image`
- Lightweight tree-shakeable imports
- Large contributor pool, battle-tested

### 4. Web UI components

Three chart variants rendered by a single `<BurnChart>` component with a `variant`
prop (`burndown | burnup | combined`):

- **Burn down**: `<AreaChart>` with remaining work area + ideal burn `<ReferenceLine>`
- **Burn up**: `<AreaChart>` with completed area + total scope line
- **Combined**: `<ComposedChart>` overlaying both
- **Segmented control**: toggles variant without remount (shared data)
- **Metric selector**: dropdown for tasks / duration
- **Date range**: from/to date pickers, defaults to project lifetime
- **Scope change markers**: `<ReferenceDot>` on dates where scope changed
- **PNG export button**: captures chart SVG via `html-to-image` → download

Located at `packages/web/src/features/reports/BurnChart.tsx` with a
`useBurnChart(projectId, metric, from, to)` TanStack Query hook.

### 5. Mobile

Simplified single-line burn down on the project overview card — a sparkline-style
mini chart using React Native SVG (already a transitive dependency). No full
interactive chart on mobile in Phase 1. The API response is cached locally; a
stale indicator shows if data is > 24 hours old.

### 6. PNG export

Client-side via `html-to-image` library (MIT, 5k+ stars, ~400KB):
- Captures the Recharts SVG container as a PNG at 2x resolution
- Includes title, legend, and axis labels in the capture
- Triggers browser download with filename `burn-{variant}-{project-name}-{date}.png`

Server-side export (matplotlib) rejected — adds a heavy Python dependency for
something the browser handles natively.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **On-demand HistoricalTask replay** (no snapshot table) | No new model, no migration, no Celery job | O(days × tasks) per request, slow for large projects, hammers history table |
| **Snapshot table** (chosen) | O(days) query, predictable performance, Redis-cacheable | New model + migration, nightly job, backfill command |
| **Client-side computation** (send raw task data) | No new endpoint, flexible | Transfers entire task list + history to browser, violates API-first principle |
| **Plain SVG** (no charting library) | Zero new dependencies | Massive effort for line charts with tooltips/legends/responsive behavior |
| **Recharts** (chosen) | MIT, battle-tested, React-native API, composable | Adds ~45KB gzipped to bundle |
| **Chart.js + react-chartjs-2** | Smaller bundle, canvas-based | Canvas harder to export as crisp PNG, less React-idiomatic |
| **D3 direct** | Maximum flexibility | Steep learning curve, imperative API, poor DX for simple charts |
| **Server-side PNG** (matplotlib) | Works without JS | Adds matplotlib (~30MB), slower iteration, can't do interactive tooltips |

## Consequences

- **Easier**: PMs get standard burn charts with no manual tracking; scope creep is
  immediately visible; PNG export replaces screenshot workflows
- **Harder**: `BurnSnapshot` table grows linearly (1 row/project/day — 365 rows/year
  for a project, negligible); nightly job adds one more Celery beat entry
- **Risks**: History purge (90 days default, ADR-0011) means backfill can only
  reconstruct data within the retention window. Projects older than 90 days will
  have incomplete burn history unless snapshots were captured before purge.
  Mitigation: the nightly snapshot job runs before the purge job (01:00 vs 02:00 UTC),
  so once snapshots start, no data is lost going forward.
- **Bundle impact**: Recharts adds ~45KB gzipped; `html-to-image` adds ~15KB gzipped.
  Total: ~60KB — acceptable for a feature used on every project's Reports tab.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: `api`, `web` (mobile deferred to Phase 2)
- Migration required: **yes** — new `BurnSnapshot` model in `projects` app
- API changes: **yes** — new `GET /api/v1/projects/{pk}/burn-chart/` endpoint
- OSS or Enterprise: **OSS** (single-project scope)
- Celery beat: add `burn-snapshot-daily` task at 01:00 UTC
- Management command: `backfill_burn_snapshots` for initial population
- Depends on: ADR-0011 (HistoricalTask for backfill), Task.status (ADR-0013/issue #58)
- Future extensibility: Enterprise can aggregate `BurnSnapshot` rows across projects
  for program/portfolio burn charts — the `project_id` in the API response and the
  per-project snapshot table design support this without schema changes
