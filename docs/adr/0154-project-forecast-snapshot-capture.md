# ADR-0154: Project-Grain Forecast Snapshot Capture

## Status
Accepted

## Context
Today a project's forecast — the deterministic CPM finish and (when a Monte Carlo
run has been triggered) the P50/P80/P95 finish-date percentiles — is recomputed on
every schedule change but only the *latest* values survive. The CPM finish lands on
`Task.early_finish` (overwritten each recompute); the probabilistic band lives in the
`mc_latest:<pk>` Valkey cache (24 h TTL) and, since ADR-0175/0144, in a `MonteCarloRun`
row **only when a user explicitly runs Monte Carlo**. There is no continuous record of
how a project's forecast *drifted* over time — the "we were saying end of June a month
ago, now we're saying end of August" history that a PM uses to argue for scope cuts or
more people.

Issue #388 asks for the **storage layer** for that drift history: a `ProjectForecastSnapshot`
row captured automatically on every recompute (plus a daily floor), so ~30 days of real
history accumulate before the forecast-trend chart (#368, 0.4) and the history-aware
sample loader (#376, 0.4) ship. This ADR covers the backend slice only — model, capture,
retention, and a read endpoint. No UI consumer ships this release.

**P3M layer:** Programs and Projects. This is *single-project* forecast drift — a PM
governing their own schedule. Cross-program / portfolio forecast-drift aggregation (the
"schedule forensics narrative") stays Enterprise. → **OSS.**

### Why this is not `MonteCarloRun` and not `projects.ForecastSnapshot`
Two adjacent forecast-history models already exist; neither fits, and conflating them
would corrupt their read contracts:

| Model | Grain | Trigger | Retention | Why it does not fit #388 |
|-------|-------|---------|-----------|--------------------------|
| `projects.ForecastSnapshot` (ADR-0106 §5) | **milestone** | sprint reforecast-on-close / explicit refresh | latest-per-milestone + 90 d | Wrong grain; carries a velocity-privacy band + `confidence` enum; read is *latest-per-milestone*, not a project history series. No P95. |
| `scheduling.MonteCarloRun` (ADR-0175/0144) | project | **explicit MC run only** | newest-N (default 100) per project | Only exists when someone runs MC. A project never forecast still needs CPM-finish drift. Flat newest-N cap loses the long tail the trend chart needs. No CPM-on-every-recompute capture. |

`ProjectForecastSnapshot` is the third, distinct concern: **CPM-primary, captured on every
recompute regardless of whether MC ever ran**, with MC values copied best-effort from the
most recent `MonteCarloRun`. It mirrors the precedent ADR-0175 itself set — a *new* model
rather than overloading `ForecastSnapshot`.

## Decision

### 1. New model `scheduling.ProjectForecastSnapshot`
A plain `models.Model` (not a `VersionedModel`), placed in the `scheduling` app beside
`MonteCarloRun` (same tier: server-generated, project-level, online-read-only forecast
metadata). Placing it here also keeps the new migration in `scheduling/` (next number
`0007`), sidestepping the contested `projects/` migration sequence.

Fields: `id` (UUID pk); `project` FK → `projects.Project` (CASCADE,
**`related_name="project_forecast_snapshots"`**); `captured_at` (`DateTimeField`,
`auto_now_add`); `cpm_finish` (`DateField`, null); `total_float_days` (`IntegerField`,
null); `mc_p50_finish` / `mc_p80_finish` / `mc_p95_finish` (`DateField`, null);
`mc_iterations` (`PositiveIntegerField`, null); `task_count` / `completed_task_count`
(`PositiveIntegerField`); `triggered_by` (`CharField(16)`, choices
`recompute | scheduled | manual`). `Meta`: `db_table="scheduling_projectforecastsnapshot"`,
`ordering=["-captured_at"]`, composite index `["project", "-captured_at"]` named
`projfcast_proj_recent_idx` (≤30 chars, the Postgres/Django index-name limit).

**Deviations from the issue's proposed model spec (both deliberate):**
- **`related_name` is `project_forecast_snapshots`, not `forecast_snapshots`.** The
  milestone-grain `ForecastSnapshot` already owns `forecast_snapshots` on `Project`
  (`projects/models.py:4300`); reusing it is a Django `E304` reverse-accessor clash.
- **No `server_version` column.** See decision #2.

`total_float_days` = the tightest total float (minimum `total_float`) across the project's
non-deleted tasks: `0` on an unconstrained critical path, **negative** when a
deadline/constraint is breached — so schedule *pressure* drift is visible, not just the
finish date. `task_count` / `completed_task_count` count non-deleted tasks
(`status == COMPLETE` for the latter). MC fields are copied from the project's most-recent
`MonteCarloRun` at capture time and may predate this capture (truthful: the MC line stays
flat until someone reruns MC — there is no newer probabilistic data to report).

### 2. Not on the offline-sync surface; no `server_version`
The issue lists `server_version` as a "standard sync field", but `server_version` alone
syncs nothing — the WatermelonDB delta requires three explicit wirings (a queryset key in
`ProjectSyncView`, a `SyncXxxSerializer`, and a watermark receiver). Every server-generated,
read-only forecast/audit sibling — `MonteCarloRun`, `projects.ForecastSnapshot`,
`SprintBurnSnapshot`, `SprintTaskOutcome`, `TaskNote`, `ApiTokenAuditEntry`,
`VelocitySuggestion` — is a plain `models.Model` with **no `server_version`** and is **not**
in the sync set. A high-churn, server-only history table (potentially one row per project
per recompute) has no mobile consumer and would bloat every client's pull for nothing.
**Decision: omit `server_version` entirely and register nothing in `apps/sync/`.** History
is an online read, exactly like `MonteCarloRun`.

### 3. Capture: best-effort post-commit, daily floor as the durability backstop
Capture is a single service, `scheduling/services.py::capture_forecast_snapshot(project_id, trigger)`,
that derives every field from already-committed DB state (the just-written `Task` rows +
the latest `MonteCarloRun`). It is invoked from two places:

- **On recompute** — a `transaction.on_commit()` callback registered inside the existing
  atomic block in `recalculate_schedule` (`tasks.py`), *after* the CPM bulk-update commits.
  Wrapped in `safe_capture_forecast_snapshot` (try/except, logged) so a capture failure can
  **never** roll back or block the CPM write — we are strictly post-commit.
- **Daily floor** — a Celery Beat task `capture_daily_forecast_floor` (00:30 UTC) sweeps
  every non-deleted, non-archived project and captures a `scheduled` snapshot for any
  project lacking one in the last 24 h. This guarantees ≥1 row/project/day even with no
  recompute activity, and **is the durability backstop**: any capture missed by a broker
  blip or a worker death between commit and `on_commit` is backfilled the next night.

**Why no transactional outbox** (the issue proposed one): the snapshot is fully
reconstructable from durably-committed state and drift history is lossy-tolerant (a missed
hourly capture is invisible at the chart's daily resolution). The daily floor already
provides at-least-once-per-day coverage, so an outbox's at-least-once guarantee buys
nothing it does not already provide — at the cost of a new outbox model, drain task, and
orphan-window. Fewer moving parts (decision-framework factor #3). The capture is a single
cheap `INSERT`; it does not warrant its own outbox category.

**Dedup lives in the capture path, not the prune path.** Before inserting, `capture_forecast_snapshot`
reads the latest snapshot for the project; if it is < 1 h old **and** every forecast field is
unchanged, it no-ops. This stops a project recomputed 50× during a heavy edit session from
writing 50 identical rows. The latest-row check is also the idempotency guard — a duplicate
recompute (broker retry, manual re-queue) within the window is a no-op. The prune path
(decision #4) handles *long-term* thinning, a separate concern.

### 4. Tiered retention via a Django setting + nightly prune + management command
`settings.FORECAST_SNAPSHOT_RETENTION` (a dict, overridable) defines the tiered policy:
keep **all** rows < `daily_days` (default 90) old; keep one-per-ISO-week for
`daily_days … weekly_days` (default 365); keep one-per-calendar-month beyond that (kept
forever). `prune_forecast_snapshots` runs nightly via Beat (04:15 UTC) calling
`_do_prune_forecast_snapshots()` (extracted for testability, ADR-0081 house style), and the
identical logic is exposed as a `prune_forecast_snapshots` management command (with
`--dry-run`) for operators. Per project, rows are scanned newest-first and the first row in
each week/month bucket is the keeper — so the newest representative per period survives. A
standalone nightly Beat entry (matching `purge-monte-carlo-runs-nightly`), not the ADR-0173
retention coordinator, because the tiered curve is forecast-specific, not a flat-window
purge.

### 5. Read endpoint, no write endpoint
`GET /api/v1/projects/{id}/forecast-snapshots/?since=&until=` — a DRF `ListAPIView`
(paginated, ordered `-captured_at`), permission `[IsAuthenticated, IsProjectMember,
IsProjectNotArchived]` (any role ≥ Viewer, the project-read gate, matching the Monte Carlo
history read). `since`/`until` accept ISO datetimes (falling back to date-only).
`ProjectForecastSnapshotSerializer` is fully read-only. No write surface exists — rows are
server-generated only. Shipping a read endpoint with no UI consumer this release is sound
and intentional: it is API-first (principle #1, MCP-reachable now) and deliberately split
out so real history accrues before #368's chart consumes it.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **New `scheduling.ProjectForecastSnapshot` (chosen)** | Correct grain + trigger + retention; migration in uncontested `scheduling/`; mirrors `MonteCarloRun` precedent | A third forecast-ish table |
| Extend `projects.ForecastSnapshot` | One fewer table | Opposite read contract (latest-per-milestone vs history series); pollutes it with project-grain rows + null velocity band; `projects/` migration race |
| Extend `MonteCarloRun` | Reuses MC retention/serializer | MC rows only exist on explicit runs; flat newest-N cap drops the long tail the trend chart needs; would force a synthetic "run" per recompute |
| Transactional outbox for capture | At-least-once capture | New model + drain + orphan window for a fully-reconstructable, lossy-tolerant insert the daily floor already guards |
| Put `server_version` on it + sync it | "Standard" field | No mobile consumer; high-churn table bloats every client pull; contradicts 7 sibling precedents |

## Consequences
- **Easier:** #368 forecast-trend chart and #376 history-aware sample loader get a stable
  storage + read contract to build on; ~30 days of real drift history accrue before the UI
  ships. Drift is queryable now via the API/MCP.
- **Harder:** a third forecast-history model to keep mentally distinct from `MonteCarloRun`
  and `ForecastSnapshot` — mitigated by an explicit cross-referencing docstring on each.
- **Risks:** (1) capture on every recompute could be chatty → mitigated by the 1 h+unchanged
  dedup. (2) Unbounded growth → mitigated by tiered prune (one-per-month forever is ~12
  rows/project/year in the cold tail). (3) `total_float_days` semantics are a judgment call
  (tightest-slack) → documented on the field; the chart can reinterpret. (4) ADR/migration
  number races in a saturated worktree environment → `scheduling/0007` is currently
  uncontested; `api:migration-numbering` CI guards it; renumbered to ADR-0154 at merge —
  0150/#1182, 0151/#414, 0152/#327, and 0153/#976 landed on main first.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (scheduler engine untouched — capture reads its committed output)
- Migration required: yes — `scheduling/0007_projectforecastsnapshot.py` (additive, new table only)
- API changes: yes — one read-only endpoint `GET /projects/{id}/forecast-snapshots/`
- OSS or Enterprise: **OSS** (single-project drift; cross-program rollup stays Enterprise)

### Durable Execution
1. **Broker-down behaviour:** Capture is a post-commit best-effort `INSERT`, not an async
   dispatch — there is no `.delay()` in the capture path, so a down broker cannot strand a
   queued task. A capture missed because the worker died between commit and `on_commit` is
   backfilled by the daily-floor Beat task. The CPM write itself already commits
   independently of capture.
2. **Drain task:** N/A — no outbox. The daily-floor task `capture_daily_forecast_floor`
   (00:30 UTC) is the functional backstop: it captures a `scheduled` snapshot for any
   project without one in the last 24 h, recovering any missed `recompute` capture.
3. **Orphan window:** N/A (no outbox rows). The floor's "no snapshot in the last 24 h" check
   is the equivalent freshness guard; it never races an in-flight commit because it reads
   only committed `captured_at` values.
4. **Service layer:** new `scheduling/services.py::capture_forecast_snapshot(project_id, trigger)`
   and its `safe_capture_forecast_snapshot` wrapper. The recompute path registers the
   wrapper via `transaction.on_commit`; it never calls `recalculate_schedule.delay()` —
   capture is downstream of, not a trigger for, recompute.
5. **API response on best-effort dispatch:** N/A — capture is server-internal, no caller
   awaits it and no endpoint returns a task id. The only API surface is the read endpoint.
6. **Outbox cleanup:** N/A (no outbox). Snapshot retention is the tiered nightly
   `prune_forecast_snapshots` (04:15 UTC) + management command.
7. **Idempotency:** the capture-path dedup (latest snapshot < 1 h old AND all forecast
   fields unchanged → no-op) makes duplicate recomputes idempotent. The daily floor's
   "lacking a 24 h row" check makes a double-run of the floor a no-op. The prune is a
   rank/bucket delete, safe to run repeatedly.
8. **Dead-letter / failure handling:** a capture exception is caught and logged by
   `safe_capture_forecast_snapshot` and discarded — acceptable because the daily floor
   backfills and the data is fully reconstructable; there is no human-actionable failure
   state to surface. The prune and floor Beat tasks use `@idempotent_task(on_contention="skip")`
   and inherit the standard Celery retry/time-limit envelope; a permanently failing prune
   leaves rows in place (bounded growth, retried next night), and Beat liveness is already
   monitored (ADR-0081, `GET /health/beat/`).
