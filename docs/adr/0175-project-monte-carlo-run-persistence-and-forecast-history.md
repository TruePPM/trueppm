# ADR-0175: Project Monte Carlo Run Persistence and Forecast History

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class MonteCarloRun)

## Context

Today a project-level Monte Carlo run (`POST /api/v1/projects/<pk>/monte-carlo/`,
`scheduling/views.py::run_monte_carlo`) is **compute-and-return only**: it builds a
`trueppm_scheduler` project, calls `monte_carlo(...)`, returns P50/P80/P95 as dates,
and writes the result to a 24-hour Valkey cache key `mc_latest:{pk}` (ADR-0012). Close
the dialog or let the TTL lapse and the result is gone. A PM cannot answer the one
question this feature exists to answer: *"how is my finish-date confidence drifting?"*
— e.g. "my P80 finish was Aug 14 two weeks ago, now it's Aug 28."

Issue #961 (OSS, milestone 0.3) asks to **persist each project-level Monte Carlo run**
(timestamp, who ran it, P50/P80/P95 at the time, and enough basis to interpret it) and
expose a **per-project forecast history** with a per-run delta, so the drift is legible.

**Forces at play:**

- A `ForecastSnapshot` model already exists (`projects/models.py:3566`, ADR-0106 §5,
  #860/#411), but it is **milestone-scoped** and purpose-built for the agile
  reforecast-on-close sprint→milestone bridge: its read contract is *latest-per-milestone*,
  it stores **P50/P80 only (no P95)**, and it carries a **velocity-privacy band**
  (`velocity_low/high`) and `basis`/`confidence` enums that are meaningless for an
  explicit project-level CPM Monte Carlo run.
- VoC (panel avg 4.1/10, correctly OSS — see below) surfaced two design refinements
  that must be designed in, not bolted on later:
  - 🟡 **Morgan (Agile Coach)**: "who ran it" attribution + an undefined RBAC read-scope
    risks turning forecast drift into a de-facto individual-performance/surveillance
    signal. Keep run-author attribution in an admin-only layer; surface values to all.
  - 🟡 **Sarah (PM, target persona, 6/10)**: show a per-run delta (±N days vs the
    previous run); the history must be mobile-readable.
- The two 🔴 (Janet/Marcus, 3/10) are requests for the explicit **Enterprise non-goals**
  (cross-program/portfolio rollup, proactive digest, tamper-evident audit trail). They
  are the OSS/Enterprise boundary working as designed — **not** blockers.

**P3M layer:** Programs and Projects (single project finish-date forecast) → **OSS**.
Highest resonance is the PM. Anything that aggregates this *across* projects (portfolio
drift dashboard, exec digest) is the Enterprise upsell and is out of scope here.

## Decision

**Create a new model `MonteCarloRun` in the `scheduling` app** to persist each
project-level Monte Carlo run, rather than extending `ForecastSnapshot`.

### Why a new model (Option B), not extending ForecastSnapshot (Option A)

- **No semantic overload.** `ForecastSnapshot` means "the latest reforecast for a bound
  milestone." `MonteCarloRun` means "an explicit project-level simulation event." The
  read contracts are opposite: *latest-per-milestone* vs *list-all-runs-newest-first*.
  Conflating them forces a `scope`/`source` discriminator and breaks the existing
  `/forecast/` read.
- **No dead fields.** Project MC runs have no velocity band, no `confidence`,
  no `milestone`. Extending would carry four always-null columns and dilute the
  velocity-privacy invariant that ADR-0106 §5 deliberately encodes.
- **No enum-collision tax.** A separate model needs **no new enum** (no `basis`/`scope`
  discriminator), so it avoids the `drf-spectacular` enum-name collision that any new
  `basis`-named choice set would trigger (project memory: `ENUM_NAME_OVERRIDES` pinning).
- **Co-location.** The write happens in `scheduling/views.py` right after
  `monte_carlo()` returns; the model lives next to it. FK to `projects.Project` is a
  normal cross-app FK.
- **Independent retention.** History is bounded by the OSS Monte Carlo cap philosophy
  (a per-project run count), governed separately from ForecastSnapshot's
  latest-per-milestone + 90-day purge (#952).

### Model

`scheduling/models.py` (plain `models.Model`, **not** `VersionedModel` — display/forecast
metadata, not on the mobile sync surface; consistent with `ForecastSnapshot`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | `UUIDField` PK | `default=uuid.uuid4, editable=False` |
| `project` | `FK(Project, CASCADE, related_name="monte_carlo_runs")` | OSS entity |
| `taken_at` | `DateTimeField(auto_now_add=True)` | run timestamp |
| `triggered_by` | `FK(settings.AUTH_USER_MODEL, SET_NULL, null, blank, related_name="+")` | **admin-visible only** (see RBAC). User PKs are int. |
| `p50` / `p80` / `p95` | `DateField(null=True, blank=True)` | finish-date percentiles as of this run |
| `cpm_finish` | `DateField(null=True, blank=True)` | deterministic CPM spine at run time, for context/delta |
| `n_simulations` | `PositiveIntegerField` | iterations actually run (≤ `MC_SIMULATION_CAP`) — needed to interpret the run |
| `task_count` | `PositiveIntegerField(null=True, blank=True)` | committed tasks included (≤ `MC_TASK_CAP`) |

`Meta`: `db_table="scheduling_montecarlorun"`, `ordering=["-taken_at"]`,
`indexes=[Index(fields=["project", "-taken_at"], name="mcrun_project_recent_idx")]`.
No `server_version`. No new enum. (Seed/reproducibility deferred — the scheduler
`monte_carlo()` does not currently expose a seed parameter; add later if it does.)

### Write path (synchronous, best-effort persistence)

`run_monte_carlo` persists one `MonteCarloRun` row **synchronously** after
`monte_carlo()` returns — mirroring `ForecastSnapshot`'s inline `.objects.create()` and
honoring ADR-0012's synchronous (<100 ms) contract. Persistence is wrapped so a write
failure **logs and still returns the computed result** — the simulation is the primary
deliverable; the history row is best-effort. The response keeps the ADR-0012 shape and
gains `run_id`. The existing `mc_latest:{pk}` cache write is unchanged.

A thin service function `scheduling/services.py::record_monte_carlo_run(project, result, *, n_simulations, task_count, user)` owns the create (testable, keeps the view lean).

### Read path

- **New:** `GET /api/v1/projects/<pk>/monte-carlo/history/` → newest-first list of runs
  (bounded by the cap), each with `taken_at`, `p50/p80/p95`, `cpm_finish`, and a
  **computed-on-read delta** (±days vs the immediately-previous run's p50/p80/p95;
  ADR-0108 computed-on-read precedent — no stored delta column).
- **Unchanged + hardened:** `GET /api/v1/projects/<pk>/monte-carlo/latest/` keeps the
  Valkey cache as the hot read but **falls back to the latest `MonteCarloRun` row** when
  the TTL has lapsed (durability win — "latest" survives past 24h now).

### RBAC (resolves Morgan's surveillance concern)

- **Run a simulation:** unchanged from today (Scheduler/Admin/Owner; the schedule MC
  surface is already hidden from Contributor).
- **Read history values** (`taken_at`, `p50/p80/p95`, `cpm_finish`, delta): **any project
  member** (Viewer and up) — consistent with the `/forecast/` read contract.
- **`triggered_by` ("who ran it"):** serialized **only for Admin/Owner**. Member/Viewer
  see the drift values with **no run-author attribution**. This keeps attribution in an
  admin/audit-only layer so forecast drift cannot be read as a named-individual
  performance signal by the team at large.

### Retention (OSS cap, not unlimited)

Keep the **newest N runs per project** (`MC_HISTORY_CAP`, default **100**; Enterprise
override `None` = unlimited — the upsell). Enforced by a **new nightly Celery Beat purge
task** following the ADR-0081 `_do_*_purge()` pattern (`@idempotent_task(on_contention="skip")`,
rank-based DELETE of rows beyond the newest N per project). This is *bounded history*,
the OSS-cap philosophy applied to run count — distinct from ForecastSnapshot's #952
latest-per-milestone + 90-day purge.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — Extend `ForecastSnapshot`** (add p95, triggered_by, null milestone, scope discriminator) | One model; reuses serializer/purge scaffolding | Semantic overload (latest-per-milestone vs list-all); 4 dead fields on project rows; dilutes velocity-privacy invariant; needs scope enum → `drf-spectacular` collision risk; entangles #952 purge with a different retention rule |
| **B — New `MonteCarloRun` model (chosen)** | Clean semantics; no dead fields; no new enum; independent retention; co-located with the MC endpoint | A second forecast-ish table; mild conceptual overlap with ForecastSnapshot |
| **C — Persist to cache only (longer TTL) / `Project.p*_finish` columns** | Trivial | No history (the entire ask); columns hold only the latest, lose drift; cache is not durable |

## Consequences

- **Easier:** PM reads finish-date drift over time; "latest" MC survives past the 24h
  TTL; a clean OSS seam where Enterprise can later add portfolio rollup/digest by
  *reading* `MonteCarloRun` (one-way enterprise→core).
- **Harder:** a new table + nightly purge to operate; two forecast-history concepts
  (milestone reforecast vs project MC run) that docs must distinguish clearly.
- **Risks:** (1) history clutter from repeated identical clicks — bounded by the cap,
  de-dup is a non-goal. (2) RBAC must gate `triggered_by` at the *serializer* layer, not
  just the endpoint — easy to leak; covered by a pytest asserting Member/Viewer never
  receive the field. (3) MC is inherently online (server compute), so history is an
  online read (mobile-web responsive), **not** WatermelonDB-synced — acceptable and
  consistent with MC itself.

## Implementation Notes

- **P3M layer:** Programs and Projects → **OSS** (`trueppm-suite`).
- **Affected packages:** `api` (model, migration, service, history endpoint+serializer,
  RBAC, purge task), `web` (history view + `useMonteCarloHistory` hook). `scheduler`:
  none. `mobile`: read-only responsive view only (no sync surface).
- **Migration required:** yes — new model in the **`scheduling`** app (use that app's
  next migration number; **not** projects `0061`). No data backfill.
- **API changes:** yes — new `GET /projects/<pk>/monte-carlo/history/`; `POST
  /monte-carlo/` response gains `run_id`; `/monte-carlo/latest/` gains DB fallback.
  Regenerate `docs/api/openapi.json` (merge origin/main first).
- **OSS or Enterprise:** OSS. Enterprise non-goals kept out: portfolio/cross-program
  rollup, proactive exec digest, tamper-evident/immutable audit trail, retention-policy
  controls, sensitivity analysis.
- **Coordinate:** #952 (ForecastSnapshot purge — separate task, same ADR-0081 pattern),
  #953 (agile-aware MC API input wiring — shared MC call site), ADR-0012 (cap), ADR-0106
  §5 (the sibling milestone forecast contract this deliberately does *not* reuse).

### Durable Execution
1. **Broker-down behaviour:** N/A — persistence is a synchronous `MonteCarloRun.objects.create()`
   inside the MC request (ADR-0012 synchronous contract); no async dispatch on the write
   path. Wrapped best-effort: a write failure logs and still returns the computed result.
2. **Drain task:** N/A for the write. A **new Beat purge task** is required for history-cap
   enforcement (not a drain) — see #6.
3. **Orphan window:** N/A — synchronous write, no `on_commit`-deferred rows to race.
4. **Service layer:** new function `scheduling/services.py::record_monte_carlo_run(...)`,
   called synchronously by `run_monte_carlo` after `monte_carlo()` returns.
5. **API response on best-effort dispatch:** synchronous **200** with the MC result
   (unchanged) plus `run_id`. Not 202 — there is no deferred work.
6. **Outbox cleanup:** N/A (no outbox). **Purge:** nightly Beat task keeps newest
   `MC_HISTORY_CAP` (default 100) rows per project; Enterprise `None` = unlimited.
   `@idempotent_task(on_contention="skip")`, rank-based DELETE, per ADR-0081.
7. **Idempotency:** each run is a distinct user-initiated event — two runs (even
   identical) intentionally create two history rows; no dedup key. The **purge** task is
   idempotent (rank/age-based DELETE, safe to run twice).
8. **Dead-letter / failure handling:** write failure → log + return the computed result
   (history simply misses that row; the simulation succeeded). Purge failure → retried
   next nightly tick; no DLQ needed (idempotent, self-healing).
```
```

## VoC Panel Summary (input to this ADR)

Avg 4.1/10 but **correctly OSS** — target persona **Sarah (PM) 6/10** at the
Programs/Projects layer. 🔴 Janet (3) / Marcus (3) = requests for the explicit Enterprise
non-goals (portfolio rollup, exec digest, audit trail), **not** blockers. Folded-in 🟡:
Morgan (attribution → admin-only RBAC) and Sarah (per-run delta + mobile-readable).
David/Jordan/Alex/Priya neutral (correctly not their feature).
