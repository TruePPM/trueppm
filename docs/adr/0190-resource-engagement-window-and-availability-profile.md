# ADR-0190: Resource Engagement Window and Availability Profile (Contractor Keystone, Phase 1)

## Status
Accepted (2026-06-30). Phase 1 of a larger two-axis "worker as actor" model
(`actor_kind` human|agent × `engagement` employee|contractor|usage_based); the
AI-agent layer (Phase 2/3) is out of scope here and reuses this phase's window
machinery (date-cliff → token/$ budget-cliff). Numbered 0190 because 0185–0189 are
claimed by in-flight worktrees (0185 time-tracking/mobile, 0186 MCP, 0187 SSO,
0188 schedule-PDF) and an untracked 0189 (multi-tenancy).

## Context

**P3M layer:** Programs and Projects / Operations → **OSS** (confirmed by `enterprise-check`,
2026-06-30: single-project, SCHEDULER+ role, no governance/audit, passes the adoption test).

**Problem.** TruePPM cannot express that a resource is available only for a bounded period
(a contractor engagement) or at reduced/ramping capacity on a project. "Contractor" is
detected today *only* by string convention (`"contractor" in job_role/role_title`, ADR-0042).
Two Voice-of-Customer panels were run:

- **Contractor panel** (avg 6.5/10, zero unconditional blockers): **6 of 8 personas named
  "engagement end-date cliff + roll-off warning" as the #1 ask** — the keystone. The reframe
  (David, Alex): generalize "contractor" into an **availability profile** that also serves
  parental leave, part-time, and onboarding.
- **Dignity/surveillance constraints** (Agile Coach 🔴, Team Member 🔴): employment status
  must be a back-office attribute, **never on team surfaces**, must not branch the
  contributor's UX, and field naming must stay neutral.

**As-built forces (from codebase research):**
- **The CPM engine is resource-agnostic.** `scheduling/tasks.py::recalculate_schedule`
  passes only tasks/dependencies/calendars to `trueppm_scheduler.engine.schedule()`.
  Resources (`TaskResource`, `max_units`, availability) are a **post-CPM overlay**
  (`utilization.py`). A true hard CPM constraint = resource-constrained scheduling /
  leveling, a major engine change that is largely **Enterprise** (cross-program leveling,
  ADR-0030). → Phase 1 cannot make `engaged_to` a hard CPM constraint; it is a **warning overlay**.
- Three established **non-blocking** warning patterns exist: inline `warnings[]` on a
  mutation (ADR-0028 over-allocation, ADR-0033 skill-mismatch); the post-CPM
  `CrossProjectSlipConflict` model + acknowledge endpoint + WS event (ADR-0120);
  client-side detection (ADR-0031). **No blocking validation exists anywhere in the
  resource domain** — a hard block would be the first.
- `ProjectResource` (ADR-0033) is the per-project roster join (`VersionedModel`;
  `role_title`, `units_override`; `roster_changed` broadcast already wired; soft-delete
  per ADR-0034). `WorkspaceMembership.availability_percent` + effective window already
  exists as a **workspace-global** baseline (#542) but is **consumed by nothing** today.

## Decision

1. **Carry the engagement window + availability profile on `ProjectResource`** (per-project),
   not `WorkspaceMembership` (which stays the global person baseline). New fields:
   - `engaged_from: DateField(null=True, blank=True)` — null = no start bound
   - `engaged_to: DateField(null=True, blank=True)` — null = open-ended
   - `availability_percent: PositiveSmallIntegerField(default=100, validators=[Min(0), Max(100)])`
   - `ramp_state: CharField(choices=ramping|full|winding_down, default=full)` — advisory label only
   - `Meta.indexes += Index(fields=["project", "engaged_to"], condition=Q(is_deleted=False), name="projres_engaged_to_idx")`

2. **No employment-type field in Phase 1.** "External/contractor" is expressed *entirely* as
   "has an engagement end date." There is no flag to stigmatize; the fields live on the
   SCHEDULER+ roster, invisible to the contributor. This is the structural answer to the
   dignity/surveillance 🔴s. **The ADR-0042 `contractor_count` metric is redefined** as
   "resources with an `engaged_to` set", retiring the brittle `job_role` string match.

3. **The "cliff" is a non-blocking warning overlay** (honest to the resource-agnostic engine):
   - **Assignment-time warning** — reuse the ADR-0028/0033 `warnings[]` channel on
     `TaskResource` POST/PATCH. When an assignment's CPM window (`task.early_start..early_finish`)
     falls outside `[engaged_from, engaged_to]`:
     `{"code": "engagement_window_exceeded", "detail": "...", "resource_id", "task_id", "engaged_to"}`.
     The save proceeds.
   - **Standing roll-off signal** — computed on read in `GET /projects/{id}/resources/summary/`:
     resources whose `engaged_to` is within 45/14 days *and* who hold tasks scheduled at/after
     that date → `{resource_id, engaged_to, days_remaining, tasks_at_risk}`. Surfaced as a
     roster/heatmap banner (SCHEDULER+ only).

4. **Effective capacity composition (overlay only, never CPM):**
   `effective_pct = min(WorkspaceMembership.availability_percent, ProjectResource.availability_percent) × effective_max_units`,
   treated as **0 outside `[engaged_from, engaged_to]`**. This wires the long-dormant
   `WorkspaceMembership.availability_percent` into the utilization overlay for the first time.

5. **OSS/Enterprise seam.** The engagement *window* is OSS. The deferred *rate/cost/vendor*
   layer attaches at existing Enterprise extension slots (ADR-0034 `resources_page.create_form_extension`
   "cost center"; ADR-0033 `resource-detail-skills-extension`) plus one new roster-detail slot
   `roster_detail.engagement_extension` for the Enterprise rate/SOW panel. Per the
   no-premature-upsell rule this slot renders **empty** in OSS. No cost field enters OSS.

6. **Reuse `roster_changed`** broadcast (already fired on `ProjectResource` writes). No new
   WS event in core Phase 1.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Window on `ProjectResource`** (chosen) | per-project matches contractor reality (a contractor on 2 projects has 2 windows); reuses roster RBAC/broadcast/sync/soft-delete | overlay must compose two availability sources |
| B. Window on `WorkspaceMembership` | single home; extends existing `availability_*` | wrong scope — engagement is per-project, not per-person; can't model two concurrent engagements |
| C. New `EngagementWindow` model | clean separation | over-modeled — `ProjectResource` already *is* the per-project join; adds a sync surface for no gain |
| D. Hard CPM constraint / resource leveling | a true enforced cliff | massive scheduler change; leveling is largely Enterprise (ADR-0030); VoC need is "warn me", not "refuse"; would be the first blocking resource validation, risking contributor friction |

## Consequences

- **Easier:** roll-off risk visible *before* the cliff; availability generalizes to
  leave/part-time/onboarding; the dormant `WorkspaceMembership.availability_percent` finally
  feeds the overlay; the agent layer (Phase 2) reuses window → budget-cliff machinery.
- **Harder:** the utilization/heatmap overlay now composes two availability sources + a date
  window; the heatmap must visually distinguish "outside engagement window" (0 capacity) from
  "0% allocated".
- **Risks:** (a) the cliff is advisory, not enforced — a PM *can* still assign past `engaged_to`
  by design; document the expectation. (b) ramp is a single value + label, not a time-varying
  curve (deferred to Phase 2). (c) Phase-1 roll-off is computed-on-read — a PM must *look* at the
  heatmap (Phase 1.5 adds a proactive Beat-driven notification). (d) mobile WatermelonDB schema
  migration required (`ProjectResource` syncs).

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations.
- **Affected packages:** `api`, `web`, `mobile` (sync schema). **Not `scheduler`** — explicit
  non-change; the engine stays resource-agnostic.
- **Migration required:** yes — one migration on `apps/resources`, 4 new `ProjectResource`
  fields (all nullable or defaulted → safe, mirrors the `WorkspaceMembership` 0014 precedent) +
  one partial B-tree index. Batch `makemigrations` once; follow with `ruff check --fix && ruff format`.
- **API changes:** yes — `ProjectResourceSerializer` gains the 4 fields (writes SCHEDULER+ via
  `CanAssignResource`); `TaskResource` POST/PATCH emits `engagement_window_exceeded`;
  `resources/summary` gains the roll-off block. Regenerate `docs/api/openapi.json`.
- **OSS or Enterprise:** **OSS** (confirmed by `enterprise-check`). Enterprise rate/cost attaches
  at the extension slots above.
- **Sync (ADR-0142):** `ProjectResource` is `VersionedModel`; new fields advance `server_version`
  automatically. Confirm the `last_sync_version` receiver covers `ProjectResource` and extend the
  sync-conformance test.

### Durable Execution
1. **Broker-down behaviour:** N/A — engagement-window edits do **not** enqueue CPM recalc (the
   scheduler ignores resource availability), and `roster_changed` broadcast is best-effort
   (recovered by the client's next sync pull). No outbox row needed.
2. **Drain task:** N/A in core Phase 1. (A Phase-1.5 proactive roll-off notifier would add one
   Beat scan, reusing existing notification infra.)
3. **Orphan window:** N/A — no outbox.
4. **Service layer:** `ProjectResource` writes go through the existing viewset/serializer; **no**
   `enqueue_recalculate` call (justified: CPM is resource-agnostic). Roll-off detection is a new
   read helper in `apps/resources/services.py`, called by the `resources/summary` action.
5. **API response on best-effort dispatch:** synchronous 200/201 with a non-blocking `warnings[]`;
   roll-off via the summary GET. No `{"queued": true}`.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** PATCH edits are idempotent; roll-off is a pure read with no persisted state.
8. **Dead-letter / failure handling:** N/A — no async work in core Phase 1.

## Resolved Decisions (2026-06-30)
1. **Enforcement → non-blocking warning.** Assigning a resource to a task scheduled past
   `engaged_to` emits a `warnings[]` entry; the save proceeds. No hard block.
2. **Roll-off delivery → computed-on-read.** The roster/heatmap surfaces the 45/14-day banner
   from `resources/summary`; no Beat task or new WS event in Phase 1.
3. **Ramp → single `availability_percent` + advisory `ramp_state` label.** Time-varying ramp
   curves deferred to Phase 2.
4. **`contractor_count` → redefined** as "resources with an `engaged_to` set"; the `job_role`
   string match is retired.

## Follow-on scope (explicitly deferred)
- **Phase 1.5:** proactive Beat-driven roll-off notification + WS event.
- **Phase 2:** time-varying ramp curves; the AI-agent actor layer (reuses window → budget-cliff).
- **Enterprise:** rate / cost / vendor / SOW layer at the extension slots; cross-project and
  cross-program roll-off and leveling.
