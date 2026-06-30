# ADR-0136: Completed Tasks Retain Their Full-Duration Span

## Status
Accepted — refines ADR-0132 (Data-Date-Aware Forecasting) and amends ADR-0023
(Actual Start and Finish Dates on Tasks) — implemented on main; status corrected 2026-06-30 after ADR audit (verified: ADR-0136)

## Context

**P3M layer:** Programs and Projects (OSS). This is core scheduling-engine IP and
touches only single-project CPM; no cross-project or portfolio aggregation.

A task marked 100 % complete collapses to a **one-day bar** in the schedule grid
(Start == Finish) while the Duration column keeps the original value (a 5d task
shows `Dur = 5d` but `Start == Finish`). This is a user-visible correctness bug:
completed work loses its span.

### Root cause — two coupled defects

The progress-aware CPM forward pass introduced by ADR-0132 (#1186) collapses any task
whose `percent_complete == 100` but whose `actual_finish` is `None`:

1. **Engine 0-remaining path.** `_effective_duration_days()` returns
   `duration − floor(duration × pct/100)` = **0** for a 100 % task
   (`packages/scheduler/src/trueppm_scheduler/engine.py:332`). The forward pass only
   pins a completed task when `actual_finish is not None` (`engine.py:566`); a 100 %
   task without it falls through with 0 remaining duration, and
   `_finish_from_start(start, 0)` returns `start` (`engine.py:292`) → Start == Finish.
   The backward pass has the identical gap (`engine.py:649`), so late dates collapse
   too and the task is mis-flagged critical (float 0).

2. **Write path forces fake actuals.** On the `COMPLETE` transition, the serializer
   sets **both** `actual_start` and `actual_finish` to `today` when the task has no
   prior start (`projects/serializers.py:2127-2131`). A task taken straight to done
   without ever being `IN_PROGRESS` therefore pins to `today → today` — a one-day bar
   parked at the wrong place. This means the engine fix alone is insufficient: the
   engine *trusts two present actuals*, so `[today, today]` would re-collapse the span.

### How the bad state is reached (all three are real)

- **Seed fixtures** — 58 of 58 completed tasks across the four sample projects carry
  `actual_start: null, actual_finish: null` (this is the data in the bug screenshot).
- **Contributor completion** — marking 100 % as a non-admin auto-promotes to `REVIEW`,
  which sets `actual_start = today` but never `actual_finish`
  (`serializers.py:2119-2125`).
- **Direct completion without a recorded start** — the `[today, today]` case above.

### Constraints this fix must respect

- **The scheduler package has zero Django dependencies** (`models.py`/`engine.py` see
  only the dataclass `Task`, which has `percent_complete`, `actual_start`,
  `actual_finish` — **not** `status`). Completion must be detected from
  `percent_complete`/`actual_finish`, never `status`.
- **Python ↔ Rust conformance** (ADR-0015). The Rust/WASM engine ignores
  `percent_complete`/`actual_finish` and always uses full duration with no
  `status_date` floor. Per ADR-0132's staging (#1187, 0.4) the shared
  `wasm:conformance` fixtures carry **no** progress fields and must stay that way —
  adding actuals/`status_date` to the shared set would diverge the engines and redden
  the gate.
- **`actual_start` and `planned_start` are independent** (ADR-0023); never conflate.
- **CPM `bulk_update` bypasses `VersionedModel.save()`** (ADR-0091); no
  `server_version` bump on CPM-output fields.

## Decision

A task is **effectively complete** in the engine when
`percent_complete >= 100` **or** `actual_finish is not None`. (In practice these are
equivalent: `Task.save()` coerces `REVIEW`/`COMPLETE → percent_complete = 100` and the
serializer coerces `percent_complete = 100 → REVIEW`/`COMPLETE`.) An effectively-complete
task is **always laid out with its full working-day duration** — it never takes the
0-remaining path — and its span is anchored to whatever actuals exist:

| Actuals present | Early start | Early finish |
|---|---|---|
| both | `actual_start` | `actual_finish` *(actuals are truth, even if span ≠ duration)* |
| only `actual_finish` | `actual_finish − full_duration` (working days back) | `actual_finish` |
| only `actual_start` | `actual_start` | `actual_start + full_duration` |
| neither | predecessor/`planned_start`/project-start position, **not** floored at `status_date` | `early_start + full_duration` |

Rules:

- **Full duration, not remaining.** A completed task contributes its full estimate, so
  the bar keeps its shape. (Remaining-duration scaling stays as ADR-0132 defines it for
  *in-progress* tasks — that path is unchanged.)
- **Derive the missing endpoint.** When exactly one actual is recorded, the other is
  derived from full working-day duration via the existing
  `_start_from_finish`/`_finish_from_start` helpers.
- **No actuals → network position, unfloored.** A completed task with no actuals is
  positioned by its FS/SS predecessor constraints, `planned_start`, and project start —
  but **not** floored at the data date, because completed work is historical. FF/SF
  constraints are not applied to a completed task (its dates are its own).
- **Symmetry & float.** Applied identically in the backward pass: a completed task gets
  `late_finish = early_finish`, `late_start = early_start` → total float 0, and it
  **drives successors** from its resolved `early_start` (SS/SF) / `early_finish` (FS).
- **Negative float is reality, not error** (ADR-0132): an out-of-sequence actual may
  give a successor negative float; surface it, don't correct it.

### Write-path amendment (ADR-0023)

On the `COMPLETE` and `REVIEW` transitions, **stop auto-filling `actual_start = today`
when the task has no prior start.** Leave `actual_start` null and let the engine derive
the historical start from `actual_finish − full_duration` (COMPLETE) or position it via
network logic (REVIEW). A genuine `actual_start` recorded at `IN_PROGRESS` is still
preserved, and an explicit payload value still wins. `actual_finish = today` on COMPLETE
is unchanged. This removes the `[today, today]` collapse at the source and yields a
realistic span without inventing a start date.

> Capacity/EVM consumers that read `actual_start` must fall back to the engine's
> `early_start` when `actual_start` is null (the engine now supplies a realistic derived
> start). Verified clean under `regression-check` / `perf-check` before merge.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Full-duration span in engine + write-path amendment (chosen)** | Fixes all three sources; bar keeps its shape; single-sourced in the engine; no schema change | Touches core IP (forward + backward pass); amends an Accepted ADR |
| B. Engine fix only (treat pct≥100 as full duration), leave write path | Smaller diff | `[today, today]` straight-to-done tasks still collapse — engine trusts two actuals |
| C. Write-path / data fix only (always stamp realistic actuals), leave engine | No engine risk | Latent engine bug remains for imported/synced data with null actuals; doesn't fix the 0-remaining backward-pass float bug |
| D. Backfill `actual_start`/`actual_finish` into all 58 seed tasks, no engine change | Demo data looks right | Doesn't fix the product; every future completion re-triggers the bug |

## Consequences

**Easier**
- Completed tasks render with their true span everywhere CPM output drives the bar.
- One completion rule, single-sourced in the engine; the grid Duration column and the
  bar finally agree.

**Harder / risks**
- Core-engine change in both passes — must not regress not-started / in-progress paths
  (ADR-0132). Covered by Python unit tests plus the existing conformance suite (which
  carries no progress fields and stays byte-identical → green).
- Write-path change amends ADR-0023's "COMPLETE → actual_start = today" rule; any
  consumer assuming `actual_start` is non-null on a COMPLETE task must tolerate null and
  fall back to `early_start`. Audited in `regression-check`.
- Python ↔ Rust progress divergence remains as ADR-0132 already documented (#1187, 0.4).
  This ADR does **not** add progress fields to the shared conformance fixtures; the
  progress path is covered by Python-only tests. The server is authoritative (ADR-0015).

**Follow-ups**
- *Actuals span guard (done in this change).* Routing `actual_finish`/`actual_start`
  into the working-day walk added a new user-controlled input to a calendar scan. To
  match the existing far-future guards on `planned_start`/`status_date`/`planned_finish`
  (#951), `_validate_project` now rejects an `actual_*` more than `MAX_PROJECT_SPAN_DAYS`
  from the project start on both the CPM and Monte Carlo paths.
- *Monte Carlo treatment of undated-complete tasks (deferred).* The deterministic pass
  treats `percent_complete >= 100` as complete; the MC sampler still pins only on
  `actual_finish`, so a REVIEW task (100%, no finish) or undated seed task is pinned in
  CPM but re-sampled in MC. After the write-path fix a COMPLETE task always carries
  `actual_finish`, so the gap only affects not-yet-signed-off REVIEW work and demo
  seeds. Aligning the MC sampler with `_is_complete` (and the Rust/WASM parity in #1187)
  is a separate, scoped change — filed as a follow-up, not bundled here.

**Seed data**
- With the engine fix, the "neither actual" branch already gives completed seed tasks a
  full-duration network position, so the **bug screenshot is fixed by the engine alone**.
  Backfilling realistic `actual_start`/`actual_finish` into the seed builder scripts is
  desirable for demo fidelity (and exercises the both-/one-actual branches) but is not
  required for correctness; scoped as a follow-on within this change, deferrable if the
  builder-script churn is disproportionate.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: **scheduler** (forward + backward pass), **api** (serializer write
  path; optionally seed builder scripts), **web** (none — bar already reads CPM output)
- Migration required: **no** (`actual_start`/`actual_finish` exist since projects 0016;
  no schema change)
- API changes: behavioral only — `actual_start` is no longer auto-stamped to today on a
  COMPLETE/REVIEW transition that had no prior start; OpenAPI surface unchanged
- OSS or Enterprise: **OSS** (`trueppm-suite`); `grep -r trueppm_enterprise
  packages/scheduler packages/wasm-scheduler` → zero, unchanged

### Durable Execution
1. **Broker-down behaviour:** N/A — no new async work. Setting completion already
   triggers CPM recompute through the existing `scheduling/services.py::enqueue_recalculate()`
   outbox path (ADR-0027); this ADR only changes what that recompute *computes*.
2. **Drain task:** Reuses the existing CPM recalculation drain; semantics unchanged.
3. **Orphan window:** N/A — no new outbox rows.
4. **Service layer:** Existing `enqueue_recalculate()`; no new dispatch path.
5. **API response on best-effort dispatch:** Unchanged — task PATCH returns the updated
   task synchronously; CPM recompute is the existing async follow-up.
6. **Outbox cleanup:** N/A — no new outbox category.
7. **Idempotency:** The engine pass is a pure function of task inputs; recomputing twice
   yields identical CPM output. The write-path change is idempotent (a second COMPLETE
   PATCH leaves `actual_start` null and `actual_finish` set — no drift).
8. **Dead-letter / failure handling:** N/A — inherits the existing CPM recompute
   retry/DLQ behaviour (ADR-0017/0084); no new failure mode introduced.
