# ADR-0113: Sprint `exclude_from_velocity` Flag and Sprint 0 / Setup-Iteration Guidance

## Status
Accepted (2026-06-10) — no 🔴 blocking questions. The design reuses established
precedent (ADR-0073 field-level SCHEDULER+ gating, ADR-0011 HistoricalRecords audit,
ADR-0102 synced-flag pattern). Implementation may begin. Filed against **#1092**,
milestone **0.3**.

## Context

A "Sprint 0" / "Iteration 0" — a setup/mobilization iteration run before real delivery
begins (environment setup, team formation, backlog building, architecture spikes) — is a
common-but-contested agile practice. Its throughput is low or zero, so when it closes it
**contaminates the team's velocity baseline**:

- `velocity_summary()` (`packages/api/src/trueppm_api/apps/projects/services.py:391`) takes
  the rolling **last-8 COMPLETED, non-deleted sprints** with no exclusion mechanism. A
  ramp-up sprint that closes with a few points (when the team later runs much higher) drags
  the rolling average down and widens the forecast band until it ages out of the window.
- ADR-0106's reforecast-on-close derives its **velocity band** (the Monte Carlo fallback,
  and the band that crosses upward to milestone forecasts) from that same `velocity_summary`
  data. So a contaminated Sprint 0 pessimistically shifts milestone delivery-date forecasts.
- ADR-0065 (Accepted, not yet implemented) will feed velocity into the scheduler's
  duration suggestions. If that wiring derives its sample set without an exclusion concept,
  the contamination gets baked into CPM durations too.

**Product stance (the part we are *not* building).** TruePPM is scheduling-first / hybrid.
Mobilization/setup work has a **better home than a sprint**: real CPM tasks on the schedule
(the waterfall side of the bridge), with durations and dependencies. We therefore **do not**
add a first-class "Sprint 0" entity, a sprint index/sequence field, or any special-casing of
"the first sprint." The opinionated guidance — *model setup work as schedule tasks* — ships
in the docs. This flag is the **escape hatch** for teams that nonetheless run a ramp-up
sprint and need to keep it from poisoning velocity.

**P3M layer**: Programs and Projects / Operations — single-project, team-scoped sprint
self-governance. **OSS**. The flag never crosses upward toward a Portfolio/Senior-Leadership
surface; it is set and owned at the team layer.

**VoC** (full 8-panel, avg 6.5/10). Jordan (PO) 8🟢 + Alex (SM) 8🟢 = strongest OSS adoption
signal. The panel surfaced one 🔴 and three 🟡 that this design resolves:

1. **🔴 Marcus (PMO) — no visibility into team exclusions.** A team silently marking sprints
   excluded undermines forecast credibility at portfolio scale. **Resolved as visibility, not
   control**: every change is recorded in the existing `HistoricalSprint` audit trail (actor +
   timestamp + old→new). There is **no PMO/admin approval gate, no policy to disallow
   exclusion, and no force-include/force-exclude override** — that would trip Alex + Morgan's
   sprint-sovereignty hard-NO (ADR-0101 §Tier-2, ADR-0102, ADR-0078). We design the audit
   trail and refuse the gate.
2. **🟡 Surface the *effect* in plain language** (Janet, David, Sarah, Jordan, Priya): the
   velocity payload exposes an `excluded_count` so the UI can render "*N sprint(s) excluded
   from this forecast*" — not scheduler jargon.
3. **🟡 Settable post-close** (Alex, Sarah): teams realize contamination retrospectively, so
   the flag must remain editable in **all** states, including COMPLETED. It only filters which
   sprints enter the velocity window; it must never mutate `completed_points`/`committed_points`
   snapshots.
4. **🟡 Future-proof the MC path** (Jordan, Sarah): when ADR-0065/0106's velocity-sample
   gathering is wired, it must filter excluded sprints at the source. We centralize the
   eligibility predicate so the exclusion can never be baked out (see Implementation Notes).

## Decision

Add a single team-owned boolean to the `Sprint` model and honor it in the one canonical
velocity computation.

1. **Model.** `Sprint.exclude_from_velocity = BooleanField(default=False, db_index=False)`.
   Additive, NOT NULL with default `False`. Sprint already carries `HistoricalRecords`, so the
   field is **auto-tracked** in `HistoricalSprint` — the audit trail (who/when/old→new) comes
   for free; no new audit model. Sprint is a `VersionedModel`, so the flag **syncs to mobile**
   via `server_version` automatically (cf. ADR-0102's `sprint_pending`).

2. **Velocity computation.** `velocity_summary()` adds `.exclude(exclude_from_velocity=True)`
   to its COMPLETED-sprint query, and returns a new `excluded_count` (count of COMPLETED,
   non-deleted sprints in the would-be window that were excluded). All velocity-derived
   computation — the rolling avg/stdev/band, the `team_velocity_per_day`, and any future
   `Project.velocity_samples` population for the scheduler — must route through a single
   **`velocity_eligible_sprints(project_id)`** queryset predicate
   (`state=COMPLETED, is_deleted=False, exclude_from_velocity=False`) so the exclusion is
   applied exactly once, in one place.

3. **RBAC.** Writable at `Role.SCHEDULER` (200) and above, enforced field-level in
   `SprintSerializer.validate()` alongside the existing `capacity_points` / `wip_limit` /
   `goal_outcome` gate. Rationale below.

4. **Validation.** Editable in **every** sprint state (no state lock) — unlike
   `capacity_points`, which locks on COMPLETED/CANCELLED. This is deliberate: a team may
   forward-mark a PLANNED Sprint 0, or retrospectively exclude a COMPLETED one. Excluding a
   non-COMPLETED sprint is a harmless no-op for velocity today (only COMPLETED sprints count)
   but is allowed for forward-marking ergonomics.

5. **Serializer / API.** `exclude_from_velocity` becomes a read+write field on `SprintSerializer`.
   `excluded_count` is added to `ProjectVelocitySerializer` (and rides along in the embedded
   `velocity` block of the `/forecast/` endpoint). No new endpoint.

6. **Broadcast.** None added. The standard `PATCH` rides `perform_update`'s existing
   `transaction.on_commit(... "sprint_updated" ...)`. The web client must invalidate the
   `['project', projectId, 'velocity']` (and `forecast`) query keys on `sprint_updated` so the
   velocity card refreshes (verify the existing invalidation already covers this; extend if not).

7. **UI (specified fully in the ux-design pass).** A plain-language toggle ("Exclude from
   velocity") with helper text referencing setup/ramp-up sprints, on the sprint edit surface;
   excluded sprints **visibly annotated** (not silently dropped) in the velocity chart; the
   `excluded_count` rendered as "*N excluded from this forecast*" near the forecast band.

8. **Docs.** A "Setup work & Sprint 0" section in `features/sprints.md` and `features/velocity.md`,
   plus the sprint-planning getting-started flow: (a) model mobilization as schedule tasks;
   (b) if you run a ramp-up sprint, mark it excluded.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. `exclude_from_velocity` boolean on Sprint (chosen)** | Minimal surface; reuses HistoricalRecords audit + VersionedModel sync; team-owned; one query predicate | Per-sprint manual action; SCHEDULER+ is a project role, not strictly "the team" (mitigated by audit) |
| B. First-class `Sprint 0` / setup-sprint type | Explicit semantics | Fights the scheduling-first thesis; invents a sprint taxonomy; setup work belongs on the schedule, not in a sprint type |
| C. Sprint index/sequence + auto-exclude the first sprint | Zero user action | Magic and wrong as often as right (not every project has a Sprint 0); brittle; hidden behavior the team can't see |
| D. Outlier auto-detection (statistically drop low-throughput sprints) | No manual action | Opaque, un-auditable, "the tool massaged my numbers" — exactly Morgan's trust failure; un-explainable to an AI/MCP client |
| E. PMO-approved exclusion (governance gate) | Marcus's full ask | Hard-NO: PMO override of sprint composition (ADR-0101/0102/0078 sprint sovereignty); kills Alex + Morgan adoption |

## Consequences

**Easier**
- Teams running a Sprint 0 get a clean velocity baseline and clean ADR-0106 milestone
  forecasts without deleting the sprint (which would destroy its retro/outcome history).
- The single `velocity_eligible_sprints` predicate makes the eventual ADR-0065 MC wiring
  honor exclusion by construction.
- Marcus gets audit visibility (he is Admin+, sees `history_user`); the team sees the chart
  annotation and the value change.

**Harder / Risks**
- **SCHEDULER+ ≠ "the team" (Morgan 🟡).** A PM holding the Scheduler role can flip the flag.
  Accepted for v1: it matches the existing `capacity_points` gate (ADR-0073), the change is
  fully audited, and there is no Team entity to gate against yet (ADR-0078 is Proposed,
  milestone 0.6). **Forward dependency:** when ADR-0078's `TeamMembership` / team-sovereignty
  model lands, the team-ownership refinement should apply uniformly to `capacity_points`,
  `goal_outcome`, **and** `exclude_from_velocity` — tracked as a follow-up, not blocking 0.3.
- **`history_user` visibility is Owner/Admin-only (ADR-0011).** The team sees *that* a sprint
  is excluded (chart annotation + the boolean) but not *who* set it unless they are Admin+.
  Acceptable for v1; full team-visible actor attribution is a possible refinement.
- **Interim MC state.** Until ADR-0065/0106's `velocity_samples` wiring lands, the flag affects
  only `velocity_summary()` and the band-derived forecast (ADR-0106). There is no misleading
  "UI says excluded but MC ignores it" gap today, because the API does not yet populate
  `Project.velocity_samples` into the scheduler. The eligibility predicate guarantees the gap
  cannot open when that wiring arrives.

## Implementation Notes

- **P3M layer**: Programs and Projects / Operations.
- **Affected packages**: api (model + migration + serializer + service), web (toggle + velocity
  annotation + types), docs. **scheduler**: none now; the predicate note future-proofs ADR-0065.
- **Migration required**: yes — `0066_sprint_exclude_from_velocity` (+ the paired
  `historicalsprint` column). **Generate with `makemigrations`** (never hand-write a
  HistoricalRecords migration). `BooleanField(default=False)` → safe additive, no NOT-NULL
  backfill hazard.
- **API changes**: yes — `SprintSerializer` gains a writable `exclude_from_velocity` (SCHEDULER+
  field-gate); `ProjectVelocitySerializer` gains read-only `excluded_count`. OpenAPI schema
  regenerates (watch for a DRF enum-name collision per project memory — none expected for a
  bare boolean). Regenerate `docs/api/openapi.json` after merging `origin/main`.
- **OSS or Enterprise**: **OSS** (`trueppm-suite`).
- **Cross-ADR note**: ADR-0065 and ADR-0106 should reference `velocity_eligible_sprints` as the
  mandatory source predicate for any velocity-sample / band derivation, so excluded sprints are
  filtered at the source. Add a short forward-pointer to those ADRs (or rely on this ADR's
  predicate being the single code path).

### Durable Execution
1. **Broker-down behaviour**: N/A — the flag write is a synchronous DB `PATCH`; no async
   dispatch at the moment of write. (Sprint *close* still rides its existing `SprintCloseRequest`
   outbox + `ScheduleRequest` recompute path, unchanged by this ADR.)
2. **Drain task**: N/A — no new async category. Velocity is computed on read.
3. **Orphan window**: N/A — no outbox row introduced.
4. **Service layer**: `velocity_summary()` (extended) and a new `velocity_eligible_sprints()`
   predicate helper, both in `apps/projects/services.py`. No new dispatch service.
5. **API response on best-effort dispatch**: N/A — synchronous `200` on the sprint `PATCH`.
6. **Outbox cleanup**: N/A — no outbox row.
7. **Idempotency**: The flag is a plain idempotent field write (PATCH to the same value is a
   no-op). Velocity recomputation is a pure read over the eligible-sprint set — naturally
   idempotent.
8. **Dead-letter / failure handling**: N/A — no task. A failed `PATCH` returns a 4xx/5xx to the
   caller with no partial state (single-row update inside the request transaction).
