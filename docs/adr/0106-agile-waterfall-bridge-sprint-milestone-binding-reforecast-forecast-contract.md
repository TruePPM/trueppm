# ADR-0106: Agile/Waterfall Bridge — Sprint↔Milestone Binding, Reforecast-on-Close, and Forecast Contract

> **Companion ADRs (0.3 agile-team architecture batch).** ADR-0104 = Unified Team-Signal Privacy Model · ADR-0105 = PO Product-Backlog Hierarchy & Scoring · ADR-0106 = Agile/Waterfall Bridge. Where this ADR refers to "the Privacy ADR", "the Backlog ADR", or "the Bridge ADR" it means 0104 / 0105 / 0106 respectively. **ADR-0106** is this document.

## Status
Accepted (2026-06-05) — §1/§2 shipped in #931, §E1 in #928, §3/§5 in #860. The four
sign-off decisions below are resolved (see "Decisions resolved at acceptance").

## Context

The 0.3 "agile team" release ships the hybrid bridge demo (#860): one-click promote a sprint's committed scope to a schedule milestone, and on sprint close reforecast the bound milestone's finish as a **range** (CPM finish + P50/P80) rather than a single false-precision date. Alongside it land the velocity-based forecast view (#487) and the milestone rollup chip + scope-delta drawer with team+PM parity (#550). A late acceptance criterion on #860/#487 adds an **unmodeled cross-team dependency flag**, because deep CPM-aware feasibility (#372) is deferred to 0.5 and the 0.3 forecast must not show false confidence over work it is not actually tracking.

**P3M layer**: Programs and Projects / Operations — single-project, single-team sprint execution feeding the project's own schedule. Fully **OSS**. Cross-team and cross-program aggregation of these forecasts is **Enterprise** and is already filed there as #140 (velocity rollup), #141 (coaching-maturity dashboard), and #142 (portfolio sprint-scope approval) at milestone 1.0. This ADR's job at the boundary is to define the **read-only extension point** those mirrors register against, never to build the cross-team feature in OSS.

**VoC constraints honored (non-negotiable):**
- **Sprint sovereignty** (Morgan/Alex hard-NO) — already enforced by ADR-0101 (guardrails) + ADR-0102 (scope-injection approve-gate). This ADR does not touch sprint composition; it binds a *milestone* to a sprint, a schedule-side write, and gates it on a schedule-authoring role, not the team-owned sprint-lifecycle gate.
- **Velocity privacy** (Morgan hard-NO, 🔴 if wrong) — team velocity is team-private by default with no automatic velocity→PMO pipeline. This ADR emits *milestone confidence* (dates + a coarse band) upward, never the raw velocity series, and stores only the band at rest. The band that flows upward is additionally gated by the consent record defined in the companion Unified Team-Signal Privacy Model ADR (see §6).
- **Sarah's trust concern** (the reforecast is only as trustworthy as the binding) — the binding is made durable, idempotent, and **drift-visible**: it cannot silently re-point, and when underlying committed scope diverges from the promote-time snapshot a drift flag lights rather than the bound number changing underneath her.

### Grounding in the actual code (verified 2026-05-31)

1. **`Sprint.target_milestone` already exists** (`apps/projects/models.py:1750`) as `ForeignKey(Task, SET_NULL, null=True, related_name="targeting_sprints")` — a milestone is a `Task(is_milestone=True)`; there is no separate `ScheduleMilestone` model (ADR-0094 confirms this). It is set today at sprint-planning time and carries **no provenance** (who bound it, when, against what committed scope).
2. **The close path already recomputes the rollup**: `apps/projects/tasks.py::close_sprint` (line 155) calls `recompute_milestone_rollup(sprint.target_milestone_id)` inside the drain transaction and broadcasts `milestone_rollup_updated`. But that rollup is **percent-complete only** (`compute_milestone_rollup_payload`, `services.py:1142`) — it produces no date range, no P50/P80, no CPM-anchored finish. That is the #860 gap.
3. **The rollup is already pending-aware**: ADR-0102 §2 wired `committed_sprint_tasks(sprint.pk)` (the `sprint_pending`-excluding manager, `services.py:789`) into `compute_milestone_rollup_payload`, so the binding's math already excludes un-accepted injections for free. No new exclusion work is needed.
4. **Velocity forecast already exists**: `velocity_summary` (`services.py:391`) returns `forecast_range_low`/`forecast_range_high` (avg ± 1 stdev over the last closed sprints), `rolling_avg_points`/`rolling_stdev_points`, `team_velocity_per_day`, AND a per-closed-sprint `sprints[]` array carrying `completed_points` (the raw series, `services.py:445`). It is exposed on `ProjectVelocityView` (`views.py:6182`) gated `[IsAuthenticated, IsProjectMember, IsProjectNotArchived]`. **`IsProjectMember` (`permissions.py:101-125`) is membership-only with NO role floor** — so **every VIEWER+ project member reads the full series today**. That is the current velocity-privacy posture and is the baseline the privacy ADR must preserve at the TEAM-facing default (see §6): the privacy-sensitive direction is *upward*, not downward to the team.
5. **No `ForecastSnapshot` model exists** — verified. Monte Carlo is project-level and cache-only (`mc_latest:{pk}`, 24h). #388 (forecast snapshot) and #411 (agile-aware MC) are 0.3 dependencies still in flight, not shipped.
6. **Dependencies for the unmodeled-flag heuristic exist**: `Dependency` with `predecessor`→`related_name="successors"` and `successor`→`related_name="predecessors"`. A milestone task's CPM predecessors are reachable via `milestone.predecessors` — a cheap scan, no graph walk.
7. **CPM recompute is canonical**: all schedule recompute goes through `scheduling/services.py::enqueue_recalculate` (outbox + drain). No bare `.delay()`.
8. **Role ordinals** (`access/models.py`): VIEWER=0, MEMBER=100, SCHEDULER=200 ("Resource Manager"), ADMIN=300 ("Project Manager"), OWNER=400. The PM persona (Sarah) is **ADMIN**, not SCHEDULER. This matters for §2's gate rationale and aligns with the privacy ADR's tier mapping.

### Forces

- **API-first**: every bridge action must be a named endpoint before it is UI. Promote, unbind, project forecast read, and milestone reforecast are all enumerated below.
- **Durability**: the binding (a DB write) must be synchronous and durable; the reforecast (CPM recompute + MC + broadcast) must ride the existing `transaction.on_commit()` + `enqueue_recalculate` discipline so a broker outage self-heals.
- **Boundary**: the forecast is a single-team output; the *aggregation* of forecasts across teams is Enterprise. OSS must ship the seam, not the aggregation, and the seam must respect the unified consent record.
- **Privacy at the payload AND at rest**: confidence-as-dates may flow upward (subject to consent); velocity-as-throughput may not. The signal payload and the persisted snapshot both carry the band, never the series.
- **No false confidence**: a reforecast that silently trusts an untracked upstream predecessor is worse than no forecast. The cheap predecessor heuristic flags it; the full feasibility engine is #372 (0.5).

## Decision

### §1 — The binding model: enrich the existing FK with provenance + a drift baseline

Keep `Sprint.target_milestone` as the single binding edge — do **not** introduce a join table or a `MilestoneBinding` entity. The FK's cardinality (one sprint → one milestone; many sprints → one milestone) is exactly correct, and the percent-complete rollup pipeline already hangs off it and is already pending-aware.

Add three provenance fields to `Sprint`:

- `milestone_bound_by` — `ForeignKey(User, SET_NULL, null=True)` — who promoted.
- `milestone_bound_at` — `DateTimeField(null=True)` — when.
- `binding_committed_snapshot` — `PositiveIntegerField(null=True)` — the sprint's committed points captured at promote time, the baseline against which drift is measured.

**Drift is derived and surfaced, never silent.** `compute_milestone_rollup_payload` gains `binding_drifted = (binding_committed_snapshot is not None and binding_committed_snapshot != current_committed_points)`. When true, the milestone chip and bridge banner show a 'scope changed since this milestone was bound' caveat. The bound FK and snapshot are **immutable except through the promote/unbind endpoints** — a re-plan or scope change lights the drift flag; it does not move the binding. This is the structural answer to Sarah's spreadsheet-fallback concern.

**Lifecycle**: sprint delete → FK SET_NULL (milestone keeps other targeting sprints, rollup recomputes). Milestone delete → FK SET_NULL on every targeting sprint, rollup clears via the existing `recompute_milestone_rollup` None-path. Unbind → clears FK + all three provenance fields + snapshot.

### §2 — The promote affordance contract

Two DRF `@action`s on the sprint detail surface:

| Method & path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/v1/sprints/{id}/promote-to-milestone/` | `role >= Role.SCHEDULER`, project member | `{"milestone_id": uuid}` (bind existing) or `{}` (create+bind) | `200`/`201` updated `SprintSerializer` (incl. `target_milestone_detail` + provenance) |
| `POST /api/v1/sprints/{id}/unbind-milestone/` | same | — | `200` updated `SprintSerializer` (FK + provenance cleared) |

- **`{}` body** creates a new `Task(is_milestone=True)` named from `Sprint.goal` (fallback `"<sprint name> milestone"`), dated at the sprint `finish_date`, on the project's WBS, then binds it. **`{"milestone_id"}`** binds an existing milestone task in the same project (validated: `is_milestone=True`, same project, not deleted).
- **RBAC = schedule-authoring gate, not the team sprint-lifecycle gate.** Promotion writes a *schedule* object onto the CPM line. It uses `role >= Role.SCHEDULER` — the lowest role that may author schedule structure (Resource Manager and up; **ADMIN/the PM and OWNER are included**). It is deliberately NOT the team sprint *composition* gate (`>= ADMIN` for activate/close in ADR-0102). A plain MEMBER cannot reshape the schedule. (Note on labels: SCHEDULER=200 is "Resource Manager"; ADMIN=300 is "Project Manager". The gate is the lower schedule-authoring rung, which the PM also clears — see the consistency note reconciling this against the privacy ADR's PM-tier mapping.)
- **Idempotency.** Under `select_for_update` on the sprint row: promoting a sprint already bound to milestone M (the same M) is a no-op `200` returning the existing binding. Re-promoting to a *different* milestone is `409 {"code": "sprint_already_bound", "detail": "Unbind before binding to a different milestone."}` — the binding never silently re-points.
- **Durability.** The FK + provenance writes are synchronous. Creating a new milestone task triggers a CPM recompute via `enqueue_recalculate(project_id, reason=TASK_CHANGE)` deferred in `transaction.on_commit()`; the board broadcast (`milestone_rollup_updated`) rides the same on_commit. Response is synchronous; the recompute is fire-and-forget.

### §3 — Reforecast-on-close

Extend `apps/projects/tasks.py::close_sprint`. Today it calls `recompute_milestone_rollup(target_milestone_id)` inside the drain transaction. Add, in the same flow, a `reforecast_bound_milestone(milestone_id)` step that runs (deferred via `transaction.on_commit()`, after the close commits) and:

1. **Feeds CPM.** Reuses `enqueue_recalculate(project_id, reason=SPRINT_CLOSED)` so the just-closed sprint's `completed_*` flows into the milestone's `early_finish`.
2. **Computes a milestone-anchored range.** `cpm_finish` = the milestone's recomputed `early_finish` (deterministic spine). `p50`/`p80` = from the #411 agile-aware Monte Carlo when sufficient simulation history exists; **graceful fallback** to a velocity band derived from `velocity_summary` (avg ± 1 stdev applied to the milestone's remaining bound backlog story_points) when MC is unavailable or below the 2-closed-sprint floor. `basis` records which path produced it.
3. **Persists a `ForecastSnapshot`** (§5) — one row per reforecast.
4. **Broadcasts `milestone_forecast_updated`** carrying **only** `{milestone_id, cpm_finish, p50, p80, confidence, unmodeled_dependency, binding_drifted}`. **Never** raw velocity, never per-sprint `completed_points`.
5. **Fires the `milestone_forecast_recomputed` signal** (§6) with the same band-and-dates payload for the Enterprise seam.

**Velocity privacy.** The reforecast emits *milestone confidence* (a schedule output the PM is entitled to) while the raw velocity series stays behind the project-member-scoped `velocity_summary` read, suppressed for below-tier readers by the privacy ADR's gate (which only suppresses once a team raises the velocity signal above the reader's tier — the default is TEAM, so ordinary members are unaffected). The confidence band, not the throughput series, is the only thing that crosses upward — at the broadcast, at the signal, and at rest (§5).

### §4 — The unmodeled cross-team dependency flag

A boolean `unmodeled_dependency` (+ `unmodeled_predecessor_ids: list[uuid]` for the drawer) is added to: the live `compute_milestone_rollup_payload` return, the persisted `ForecastSnapshot`, and the `milestone_forecast_updated` broadcast.

**Cheap heuristic (NOT #372):** the bound milestone has one or more CPM predecessors (`milestone.predecessors`) whose `sprint_id` is NULL, or whose `sprint_id` is a sprint **not** bound to this milestone. It is a single predecessor scan over dependency rows already loaded for the rollup — no simulation, no cross-project graph walk. When true, the forecast surface renders the range with an explicit 'forecast excludes N upstream item(s) not in this sprint — actual finish may be later' caveat. The full date-feasibility analysis is #372 (0.5); this is a predecessor-*existence* check.

### §5 — The forecast contract (#487) and storage (#388)

**Read surface** `GET /api/v1/projects/{id}/forecast/` (project member, any role) returns:
- the velocity range from `velocity_summary` (avg ± 1 stdev) — already shipped; **the raw `sprints[]` series is included at the default velocity tier and omitted only for readers below a team-raised tier per the privacy gate**;
- remaining-backlog committed story_points sum (pending-excluded per ADR-0102) ÷ velocity range → a sprints-to-complete range. (Uses story_points, NOT prioritization_score — scoring inputs are PO-private per the backlog ADR.);
- per bound milestone, the latest `ForecastSnapshot` (cpm_finish, p50, p80, confidence, unmodeled_dependency, binding_drifted, basis).

**Storage — new `ForecastSnapshot` model** (`apps/projects`, plain `models.Model` — display/forecast metadata, **not** a `VersionedModel`, consistent with `SprintScopeChange`/`SprintBurnSnapshot`; not on the mobile sync surface):
- `id` UUID PK; `project` FK (CASCADE); `milestone` FK→Task (SET_NULL, null);
- `taken_at` DateTimeField; `basis` TextChoices `monte_carlo | velocity_band`;
- `cpm_finish` DateField(null); `p50` DateField(null); `p80` DateField(null);
- `velocity_low` / `velocity_high` PositiveIntegerField(null) — **the band, never the series**;
- `confidence` TextChoices `high | medium | low`;
- `unmodeled_dependency` BooleanField(default=False).

A row is written per reforecast-on-close and per explicit refresh; the read returns the latest per milestone. A nightly purge keeps the latest-per-milestone + a 90-day window. **No per-team velocity series is ever stored** — only the derived band. That is the at-rest half of the velocity-privacy guarantee.

### §6 — Enterprise extension point (the seam #140/#141/#142 register against)

OSS ships one read-only seam: a `milestone_forecast_recomputed` Django signal fired inside the reforecast `transaction.on_commit()`, carrying `{project_id, milestone_id, cpm_finish, p50, p80, confidence, unmodeled_dependency}` — band-and-dates only, **no velocity series, no per-contributor data**. 

**Consent coupling (reconciled with the Unified Team-Signal Privacy Model ADR).** This forecast band is a team signal. Before an Enterprise consumer may aggregate it cross-team, the originating project's `ProjectSignalPrivacyPolicy.signal_visibility` for the relevant signal must be `PROGRAM_SHARED`. The OSS-side seam therefore composes with the privacy ADR's `get_shared_team_signals(project)` provider: the `milestone_forecast_recomputed` signal fires for OSS's own forecast-history needs unconditionally, but the **cross-team-eligible** projection of it is supplied only through the consent-respecting provider. OSS never aggregates; the Enterprise receiver must consult the consent record (it cannot read a non-consented project's band). This keeps a single consent boundary rather than two. Note the velocity signal's default audience is TEAM (preserving current any-member team-facing visibility) — so a team must explicitly opt the relevant signal up to `PROGRAM_SHARED` before any cross-team consumer sees even the band; nothing flows upward by default.

Enterprise #140/#141/#142 register receivers at 1.0. OSS ships the signal + the documented payload contract and **nothing** that aggregates across teams. The dependency is one-way; OSS never imports `trueppm_enterprise`.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: enrich existing `Sprint.target_milestone` FK with provenance + drift snapshot; promote/unbind endpoints; reforecast extends the existing close→rollup path; new `ForecastSnapshot`; read-only signal seam coupled to the unified consent record (chosen)** | Reuses the existing FK, pending-aware rollup, and close→broadcast skeleton; drift is visible not silent (solves Sarah); privacy enforced at payload + at rest + at the consent-gated seam; minimal new surface | Three new Sprint fields + one new model + one new signal; binding consistency (FK ⇔ provenance) must be written only through the endpoints |
| B: new `MilestoneBinding` join entity | Explicit binding object | The FK already enforces the correct cardinality; duplicates the rollup wiring + broadcast path for zero new capability; a join table does not make the binding more trustworthy — *visible drift* does. Rejected. |
| C: derive the milestone date silently from velocity on every scope change (no snapshot, no drift flag) | Always 'fresh' | This IS the silent drift Sarah said sends her back to her spreadsheet; no baseline to diff against. Rejected. |
| D: persist the full per-sprint velocity series on `ForecastSnapshot` | Enterprise gets raw throughput | Velocity-privacy hard-NO — storing the series at rest and shipping it via the signal is exactly the automatic velocity→PMO pipeline Morgan vetoed. Rejected. |
| E: ship the full CPM-aware feasibility check (#372) in 0.3 | No false confidence at all | #372 is a 0.5 engine; pulling it into 0.3 blows the budget and the #860 demo. Deferred per roadmap. |
| F: gate promote on the team sprint-lifecycle role (`>= ADMIN`) | Symmetric with activate/close | Promotion writes a schedule object — schedule-authoring territory (`>= SCHEDULER`), not sprint-composition territory; gating it on the team gate conflates the two boundaries. Rejected for `>= SCHEDULER`. |

## Consequences

**Easier**: the hybrid bridge becomes a real, durable, demo-able loop — promote a sprint to a milestone, close the sprint, watch the milestone's P50/P80 reforecast as a range with an honest confidence band. The PM gets a trustworthy, drift-visible binding. The forecast view (#487) and milestone chip (#550) read from one persisted snapshot. The Enterprise mirrors have a clean, privacy-safe, consent-gated seam.

**Harder**: a binding-consistency invariant (`target_milestone` FK ⇔ the three provenance fields) written only through promote/unbind; a new `ForecastSnapshot` path; the reforecast adds a step to the close drain; two confidence sources (MC and velocity band) with a fallback rule the UI must label.

**Risks**: (1) binding drift if a code path sets `target_milestone` directly — mitigated by routing all binding writes through the endpoints + a regression test asserting provenance is populated when the FK is set via the API. (2) forecast false-precision — mitigated by always rendering a range + band + caveat. (3) velocity leak — mitigated structurally: the band, not the series, on the broadcast, signal, and snapshot; the cross-team projection additionally gated by the unified consent record. (4) drf-spectacular enum collision on `ForecastBasis`/`ForecastConfidence` — pin via `ENUM_NAME_OVERRIDES` in the same MR. (5) MC unavailability below the 2-closed-sprint floor — mitigated by the velocity-band fallback + `basis`.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (single-project, single-team).
- **Affected packages**: api (3 Sprint fields, `ForecastSnapshot` model, promote/unbind + project-forecast endpoints, `reforecast_bound_milestone` service, rollup-payload additions, `milestone_forecast_updated` broadcast + `milestone_forecast_recomputed` signal coupled to the privacy provider), web (bridge banner with drift caveat, milestone rollup chip + scope-delta drawer, forecast view with range + confidence band + unmodeled-dependency caveat). scheduler: no engine change. Mobile: forecast web-first in 0.3; `ForecastSnapshot` not synced.
- **Migration required**: **yes** — `Sprint.milestone_bound_by` / `milestone_bound_at` / `binding_committed_snapshot` (nullable, additive; `Sprint` carries `HistoricalRecords` so run `makemigrations`, never hand-write) + the new `ForecastSnapshot`. Do not hard-code the projects-app migration number. Land AFTER the privacy and backlog model MRs to keep the migration graph linear (see MR plan).
- **API changes**: yes — `promote-to-milestone`, `unbind-milestone`, `GET projects/{id}/forecast/`; new Sprint serializer fields; rollup payload gains `binding_drifted`, `unmodeled_dependency`, `unmodeled_predecessor_ids`; new `milestone_forecast_updated` event; new structured error `sprint_already_bound`. Regenerate OpenAPI **after merging origin/main**; add `ENUM_NAME_OVERRIDES` for new enums.
- **OSS or Enterprise**: **OSS**. Enterprise observes `milestone_forecast_recomputed` via the consent-gated provider for cross-team aggregation (#140/#141/#142, 1.0) and never receives the velocity series.
- **Coordinate with**: #408 (rollup — extend), #411 (agile-aware MC — P50/P80 source w/ fallback), #485 (velocity band source — preserve project-scoped gate), #388 (this ADR creates `ForecastSnapshot`), ADR-0102 (inherit pending exclusion), ADR-0094 (#866 bridge banner host), ADR-0088 (G2/G3 boundary precedents), and the **Unified Team-Signal Privacy Model ADR** (the consent record gating the upward band; the velocity signal defaults to TEAM so nothing flows upward without explicit opt-in).
- **Testing** (three-layer, same MR): pytest — promote binds + writes provenance + snapshot; promote-to-different-milestone is 409; promote-identical idempotent; unbind clears provenance; reforecast-on-close writes a `ForecastSnapshot` with range + confidence + basis; unmodeled-dependency flag fires for an out-of-sprint predecessor; **the broadcast and signal carry NO velocity series** (privacy test); `GET projects/{id}/forecast/` project-member-gated, no cross-project fan-in; promote requires `>= SCHEDULER`. vitest — banner drift caveat, forecast range + band rendering, unmodeled caveat. Playwright — golden path (promote → chip shows binding → close → reforecasts to a range) + unmodeled-dependency caveat path.

### Durable Execution
1. **Broker-down**: promote/unbind are synchronous DB writes — no durability gap. The reforecast's CPM recompute rides `enqueue_recalculate` (ScheduleRequest outbox + drain); a broker outage leaves a PENDING row picked up within 30s. Broadcast + signal best-effort on commit.
2. **Drain task**: none new — reuses `drain_schedule_queue` and the board-broadcast channel. The `ForecastSnapshot` write is synchronous inside the reforecast.
3. **Orphan window**: N/A for the synchronous binding write; the CPM recompute reuses the existing path's coalescing.
4. **Service layer**: `promote_sprint_to_milestone`, `unbind_sprint_milestone`, `reforecast_bound_milestone` (new); CPM via `enqueue_recalculate`; no bare `.delay()`.
5. **API response**: promote/unbind return synchronous `200`/`201`; recompute + broadcast + signal fire-and-forget.
6. **Outbox cleanup**: reuses ScheduleRequest retention; `ForecastSnapshot` rows append-only with a nightly latest-per-milestone + 90-day purge.
7. **Idempotency**: promote on an already-bound (same) milestone is a no-op `200`; a different milestone is 409. The reforecast is a pure function of current state; a duplicate run writes one more append-only row, deduped on read by latest-per-milestone.
8. **Dead-letter / failure**: a failed CPM recompute falls to the ScheduleRequest retry/drain; a failed broadcast self-heals on next board load (binding, provenance, latest snapshot are read from the DB). The reforecast never blocks or reverts the close.

## Decisions resolved at acceptance

The four sign-off choices were confirmed at their proposed defaults when §3/§5 landed in #860 (2026-06-05):

1. **Promote-to-milestone RBAC → `role >= Role.SCHEDULER` (confirmed).** Kept the schedule-authoring rung (Resource Manager and up, which includes the PM). Promotion writes a *schedule* object, not a sprint-composition change, so it stays distinct from the team sprint-lifecycle gate (`>= ADMIN`). Shipped this way in #931.
2. **MC fallback → velocity-band-only acceptable (confirmed); #860 does NOT block on #411.** The reforecast ships with `basis=velocity_band` and the graceful-fallback derivation in §3.2; #411's agile-aware Monte Carlo upgrades `basis` to `monte_carlo` when it lands. The snapshot records the path so the UI labels confidence honestly. The #860 demo runs on the band today.
3. **Binding-drift granularity → committed-points equality (confirmed).** A points-equality check (snapshot vs current accepted points) is sufficient for Sarah's trust signal; the rarer equal-point task swap is not worth the noisier task-set diff. Shipped in the rollup payload (#931).
4. **ForecastSnapshot retention → latest-per-milestone + 90 days (confirmed).** The nightly purge keeps the latest row per milestone plus a 90-day window — enough for the "P50 moved across the last K sprints" narrative without unbounded growth. (The model and read path ship in #860; the nightly purge job itself is tracked as #952.)

## Erratum E1 — Contract additions for the promote dialog (#928, 2026-06-03)

§1/§2 (the binding model + promote/unbind endpoints) shipped in #931 (commit `9262f67d2`). While building the DA-02 promote dialog three contract gaps surfaced where the shipped frontend needs more than §2 specifies. §3/§5 (reforecast-on-close + the persisted `ForecastSnapshot`) remain unbuilt and deferred (#388/#411/#487/#550). This erratum locks the contract for the three **read/light-write** additions in #928 so they can ship ahead of the §3/§5 storage layer. None of these add a model or a migration.

**E1.1 — Dry-run reforecast preview.** `GET /api/v1/sprints/{id}/reforecast-preview/?milestone_id=<uuid>` (`milestone_id` **optional**). Computed live, **persists nothing** (no `ForecastSnapshot`). Until #411's agile-aware Monte Carlo lands the preview is **velocity-band only** — `basis` is always `"velocity_band"`. Response JSON (snake_case, the DRF convention; the `useReforecastPreview` hook maps to its camelCase `ReforecastPreview` type):

```jsonc
{
  "basis": "velocity_band",          // string; "monte_carlo" reserved for #411. Plain CharField — NOT a TextChoices enum, to avoid a drf-spectacular enum-name collision (project memory: drf_enum_name_collision).
  "cpm_finish": "YYYY-MM-DD|null",   // the milestone's current CPM early_finish (deterministic spine). Create-mode (no milestone_id): the sprint finish_date.
  "p50": "YYYY-MM-DD|null",          // anchored on cpm_finish.
  "p80": "YYYY-MM-DD|null",          // cpm_finish + 0.6 × the 1-σ slow-pace day penalty.
  "p95": "YYYY-MM-DD|null",          // cpm_finish + the full 1-σ slow-pace day penalty.
  "velocity_low": 21,                // int|null — the team-pace band (avg − 1σ) from velocity_summary. The band, NEVER the per-sprint series.
  "velocity_high": 27,               // int|null — avg + 1σ.
  "unmodeled_dependency": false,     // §4 cheap predecessor heuristic, computed live.
  "unmodeled_predecessor_ids": []    // list[uuid] for the drawer caveat.
}
```

- **Field-name decision (A):** the band is `velocity_low`/`velocity_high` at the API layer — matching the (unbuilt) `ForecastSnapshot.velocity_low/high` columns so the on-close reforecast can reuse one serializer later. The hook relabels them `teamPaceLow/High` for the VoC "team pace" framing; the privacy line is at the payload, not the label.
- **`p95` decision (B):** the preview returns `p95` even though `ForecastSnapshot` (§5) stores only `p50`/`p80` — the preview is computed-not-stored, so the extra percentile costs no column. **Band→percentile derivation** (coarse, velocity-band fallback; the true percentiles arrive with #411 MC): let `avg = rolling_avg_points`, `sprint_days = (finish − start).days`, `remaining = current_committed_points(sprint)`. The 1-σ slow-pace day penalty is `remaining × (sprint_days/velocity_low − sprint_days/avg)`. `p50 = cpm_finish`; `p80 = cpm_finish + round(0.6 × penalty)`; `p95 = cpm_finish + penalty`. Below the 2-closed-sprint floor (`velocity_low/high` null) the band collapses: `p50 = p80 = p95 = cpm_finish`, `velocity_low = velocity_high = null`. Monotonic by construction (`p50 ≤ p80 ≤ p95`).
- **Privacy:** the preview emits only the band + dates — never the per-sprint `completed_points` series — consistent with §3's velocity-privacy guarantee.

**E1.2 — Create overrides (D).** `POST /sprints/{id}/promote-to-milestone/` accepts two **optional** fields on the create (`{}`) path: `name` (≤255 chars; blank/absent → the existing goal-derived default) and `target_date` (ISO date; absent → the existing `sprint.finish_date`). The created milestone's `planned_start` is set to `target_date`. **Any valid date is accepted** — a PM may set an aspirational target earlier or later than the sprint finish; `planned_start` is a start-no-earlier-than floor that CPM and the existing project-start guard (#868) already reconcile, so no extra floor check is added here. Both fields are **ignored** on the bind-existing (`{milestone_id}`) path. Idempotency, 409, and the synchronous-write/deferred-recompute semantics of §2 are unchanged.

**E1.3 — Milestones list (F).** `GET /api/v1/projects/{id}/milestones/?unbound=<bool>` — a dedicated lightweight view (ADR §5 already names this path), **not** a `TaskViewSet` overload. Returns a slim list `{id, name, wbs_path, early_finish, is_bound}` ordered by `early_finish, name`; `is_bound` is a single `Exists` subquery (a milestone is bound when any non-deleted sprint targets it — no N+1). `?unbound=true` filters to `is_bound=false`; omitted/false returns all milestones with the flag.

**E1.4 — RBAC (C).** Both new GETs are read-only and carry no schedule write: `[IsAuthenticated, IsProjectMember, IsProjectNotArchived]` (any project member, matching the §5 forecast-read posture and `ProjectVelocityView`). Promote/unbind stay `>= SCHEDULER` per §2. The preview is sprint-scoped; `milestone_id`, when supplied, is validated to the **same project** (404 otherwise) — no cross-project read.

**E1.5 — Durability.** Both GETs are pure reads (no async, no broadcast — N/A). The create-override path inherits §2's durability verbatim (synchronous FK/provenance write; `enqueue_recalculate` + `milestone_rollup_updated`/`sprint_updated` broadcast deferred in `transaction.on_commit()`); overrides only change the new milestone's `name`/`planned_start` before that existing flow.
