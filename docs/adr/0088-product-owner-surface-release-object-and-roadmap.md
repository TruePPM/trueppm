# ADR-0088: Product Owner Surface — Release Object, Roadmap, Forecast, and Light Requirements

## Status
Proposed

## Context

The 0.7 milestone lands the **Product Owner** persona (Jordan): a PO running a whole small
product on TruePPM, "strategy → delivery on one surface — roadmap → backlog → sprint → ship."

The agile *execution* tooling the PO needs day-to-day already lands in 0.3 as **task types in
the unified data model**, not a separate system: task-type taxonomy (#363, Story/Bug/Task/Spike/Epic),
an epic/initiative hierarchy *parallel* to the WBS (#364), the dual backlog (ADR-0069), acceptance
criteria (#493), and the Product Owner role (#496). 0.7 adds the **product-strategy layer above
execution** — the roadmap, the release line, release-level forecasting, and the thin requirements
fields a PO needs to answer "what ships when, and is it ready?"

**P3M layer:** Programs and Projects (single product). This is **OSS** — Jordan is always an OSS
persona; a PO must be able to run one product without Enterprise. Cross-program roadmaps, portfolio
OKR rollup, bidirectional enterprise connectors, and audited/immutable requirements traceability are
**Enterprise** and are out of scope here.

This surface was VoC-validated (focused panel): Jordan/PO **8🟢 champion**, Alex/SM 7🟡, Morgan/Coach
6🟡, Priya/Team 5🟡, Marcus/PMO 5🟡, Sarah/PM 4🟡 (not her release — tolerable only if it cannot touch
her schedule). The panel imposed four binding guardrails (G1–G4 below), which this ADR encodes
**structurally** rather than by policy.

### What exists today (research)
- **No `Task.type`, no Epic model, no Release/FixVersion** exist yet. "Epic" exists only as a
  `BacklogItemType` enum on the program-level `BacklogItem` (intake pool). Task type + epic hierarchy
  arrive in 0.3 (#363/#364) — 0.7 **depends on them**.
- **Task hierarchy is pure PostgreSQL `ltree` (`wbs_path`)** with a GiST index and no stored parent FK.
  A second hierarchy can sit *parallel* via a new FK without touching `wbs_path` — there is no conflict.
- **Summary tasks have no own CPM date.** `expand_summary_dependencies()` strips them and the engine
  runs CPM on leaves only; a summary's span is a min/max of children (annotated on read, e.g.
  `percent_complete_rollup`). This is the lever for G1.
- Roles: `VIEWER=0 / MEMBER=100 / SCHEDULER=200 / ADMIN=300 / OWNER=400`. The PO role (#496) lands in 0.3.
- Velocity = rolling 6-sprint average of `completed_points / working_days` (ADR-0065). Sprint forecast = #487.
- `TaskLink` (ADR-0049, providers `gitlab`/`github`/`generic`) already stores PR/MR/issue links — this
  is the **derived** traceability source for G4 (no new linking).

## Decision

### 1. The object model — Release vs Sprint vs Milestone

Three **orthogonal** objects; a story can participate in all three at once:

| Object | What it is | Owns | Existing? |
|--------|-----------|------|-----------|
| **Sprint** | a *time-box* (state machine, capacity, velocity) | *when* work happens | yes (ADR-0037) |
| **Milestone** | a *Task with `is_milestone=True`* | a single *schedule date* on the CPM line | yes |
| **Release** | a *value-grouping toward a ship* | *what ships together* + a target date | **new (this ADR)** |

A story lives in a **Sprint** (time), belongs to an **Epic** that targets a **Release** (value), and
rolls up to the **schedule** (dates). The Release reuses the ADR-0074 pattern — an optional
`target_milestone` FK lets its date converge with the CPM schedule.

**New `Release` model** (`apps/projects`, `VersionedModel`, UUID PK, `server_version`; no
`HistoricalRecords` — consistent with `BacklogItem`, and audit history is an Enterprise concern):

- `project` FK (CASCADE) — Release is **project-scoped** for 0.7 (single product). Program-level
  release grouping is a clean future OSS extension (single program); cross-program is Enterprise.
- `short_id` (shares `Project.object_sequence`; `REL-` is display-only)
- `name`, `description`
- `status`: `PLANNED` / `COMMITTED` / `RELEASED` / `CANCELLED`
- `roadmap_horizon`: `NOW` / `NEXT` / `LATER` / `UNSCHEDULED` (the now/next/later column)
- `target_date` DateField (nullable) — the PO's commitment
- `target_milestone` FK → Task (SET_NULL, nullable) — optional CPM anchor (ADR-0074 pattern)
- `committed_at`, `released_at`, `created_by`

**Epic→Release link:** add `Task.target_release` FK (Release, SET_NULL, nullable) — meaningful on
epics (Task `type=EPIC`). Stories inherit their release via their epic. Dragging an epic on the
roadmap sets `target_release` + `roadmap_horizon`.

### 2. The four guardrails (encoded structurally)

**G1 — Epic→schedule rollup is CPM-authoritative and one-way.** An epic's dates are a **query-time
annotation** = `min(early_start)` / `max(early_finish)` over its member stories' CPM dates (the same
mechanism as `percent_complete_rollup`). The scheduler **never receives epics or releases as nodes**,
so there is no code path by which the roadmap can write a CPM date — the guarantee is structural, not
a policy. WBS task labels remain PM-owned (no "Epic: X" relabeling of WBS rows). The whole surface is
gated by the existing `Project.agile_features` flag, so a pure-waterfall project (Sarah) never sees it.
When a CPM recompute shifts a release's `max(early_finish)` past its `target_date`, a notification is
emitted via the **existing** CPM-recompute → notification path.

**G2 — The release layer has zero write-path into an active sprint.** Roadmap and Release endpoints
expose **no `sprint` field** (the same structural pattern as ADR-0071's promote endpoint omitting
`sprint_id`). Assigning an epic to a release, or moving a roadmap horizon, can never set `Task.sprint`.
A story still enters a sprint only through the existing sprint-planning / scope-change gate
(ADR-0037/0073), preserving sprint sovereignty (ADR-0068/0069/0071).

**G3 — Forecast and readiness are team-pull-only.** Release forecast (P50/P80) and release-readiness
(% meeting DoD) are **project-scoped, member-gated reads**. There is **no program/PMO aggregation
endpoint** in OSS, and the data is not auto-embeddable in any cross-project dashboard. Reuses the 0.3
velocity-visibility gate. Forecast surfaces **wide visible confidence intervals**, labeled a rough
range — velocity must never be re-derivable as a management commitment gauge (Morgan's hard-NO,
identical to the 0.3 velocity-privacy gate).

**G4 — Light requirements management = fields on existing Tasks, not a requirements module.**
- **BUILD (OSS):** `Task.product_brief` (rich text PRD, on epics); structured `Task.acceptance_criteria`
  (a checklist of `{text, met}` items — extends #493 from free text on stories); optional
  `Task.linked_objective` (free-text, on epics — **not** an OKR entity). A **derived, read-only**
  objective→epic→story→PR view computed over existing `TaskLink` rows — auto-derived from the git/PR
  link a contributor already creates (zero manual linking — Priya), fully optional, never a sprint-entry gate.
- **DO NOT BUILD (OSS):** a separate `Requirement` entity, requirement IDs, a traceability *matrix*,
  requirement-version baselines, or compliance/audit export.
- **Enterprise:** the audited, immutable, access-controlled traceability chain with approval workflow.
  Building "light traceability" in OSS would cannibalize the Enterprise RM upsell (Marcus, decisive):
  a SOC 2 auditor cares whether the record is immutable and auditable — none of which OSS provides or claims.

### 3. Other decisions
- **#367 (Release/fix-version object)** is absorbed by this ADR's `Release` model and moves to 0.7.
- **Roadmap now/next/later** maps to `Release.roadmap_horizon`; the timeline view orders releases by
  `target_date`. The **read-only shareable** roadmap is a **0.6** deliverable — 0.7 is the *editable*
  authoring surface; do not duplicate.
- **planned→committed gate** is **advisory**, not a hard block: warn (overridable) if P80 > `target_date`.
  A hard gate tips toward control (Morgan).
- **Velocity-trend chart** (last 6–8 sprints with the P50/P80 band) ships on the forecast view (Jordan,
  for credibility).
- **Naming/onboarding:** Release, Sprint, and Milestone render on **visually separate swim lanes**; a
  one-screen glossary explains the three (handled at ux-design).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Release as a distinct object (chosen)** | Clean separation of value/time/date axes; matches how POs think; reuses ADR-0074 anchor | One new model + migration |
| Reuse `Milestone` (a Task) as the release | No new model | Conflates a *date* with a *value-grouping*; a release spans many milestones — overloading breaks the schedule semantics |
| Reuse program `BacklogItem` as the release | Already has epic/story types | Backlog items are an *intake pool*, not the in-project release line; project-scoped releases would have to live above a program object — wrong layer |
| Epic→schedule rollup as a stored CPM date | Simpler reads | **Violates G1** — gives the engine a node it would schedule independently, creating a PO write-path into Sarah's dates. Rejected outright. |
| Full requirements module (Requirement entity + matrix) | "Complete" RM | Pulls toward Jama/DOORS + the compliance anti-personas; cannibalizes Enterprise upsell; every persona flagged it. Rejected. |

## Consequences

- **Easier:** a PO answers "what ships when, and is it ready?" without a second tool (Aha!/Linear); the
  hybrid bridge gets a value axis on top of the time/date axes; the OSS/Enterprise RM line is now explicit.
- **Harder:** three sibling objects (Release/Sprint/Milestone) raise the onboarding bar — mitigated by
  separate swim lanes + a glossary. The epic→schedule rollup annotation adds query cost on large projects
  (mitigated by the existing ltree GiST index + the same annotation pattern already used for `percent_complete`).
- **Risks:** (1) horizon/lane UI could let conflation creep back in — ux-design must keep lanes distinct.
  (2) The derived traceability view must stay read-only and unexported, or it drifts toward the Enterprise
  boundary — enforced by *not* building an export endpoint in OSS.

## Implementation Notes
- **P3M layer:** Programs and Projects (single product).
- **Affected packages:** api (Release model, serializers, viewsets, rollup annotation, forecast service),
  scheduler (no engine change — rollup is a Django-side annotation; the engine stays leaf-only), web
  (roadmap, forecast view, readiness view, light-RM fields).
- **Migration required:** yes — `Release` model; `Task.target_release` FK; `Task.product_brief`,
  `Task.linked_objective`; structured `Task.acceptance_criteria` (extends #493). All additive/nullable;
  `Release` extends `VersionedModel` (`server_version`). Depends on 0.3 migrations adding `Task.type` and
  the epic hierarchy (#363/#364).
- **API changes:** yes — project-nested `Release` CRUD; roadmap read (`/projects/{id}/roadmap/`);
  release forecast (`/releases/{id}/forecast/`); release readiness (`/releases/{id}/readiness/`); epic→release
  assignment via `Task` PATCH. No `sprint` write-path on any of these (G2).
- **OSS or Enterprise:** **OSS.** Boundary verified — cross-program roadmap, portfolio OKR rollup,
  bidirectional connectors, and audited traceability are Enterprise.

### Durable Execution
1. **Broker-down behaviour:** Release CRUD is a synchronous DB write (`server_version` bump,
   `broadcast_board_event()` deferred via `transaction.on_commit()`). No async dispatch on the write path,
   so no outbox gap. The one async side-effect — the release-slip notification (G1) — rides the **existing**
   notification outbox (`notifications/services.py::enqueue_notifications`, ADR-0049), which already uses
   the transactional-outbox pattern.
2. **Drain task:** None new. The release-slip notification reuses the existing notification drain; no new
   category of async work is introduced.
3. **Orphan window:** N/A — no new outbox table. The reused notification outbox keeps its 5-minute window.
4. **Service layer:** new `release_services.py` (`compute_release_forecast()`, `compute_release_readiness()`,
   `check_release_slip(project)` invoked from the existing post-CPM-recompute hook). CPM itself continues
   through `scheduling/services.py::enqueue_recalculate()` unchanged.
5. **API response on best-effort dispatch:** Release CRUD is synchronous (`200`/`201` with the row).
   Forecast and readiness are **reads** (`200`). No `{"queued": true}` paths.
6. **Outbox cleanup:** N/A — no new outbox. Reused notification rows follow the existing nightly purge.
7. **Idempotency:** Release writes use `server_version` optimistic concurrency (existing `VersionedModel`
   convention). The release-slip notification is deduped on `(release_id, target_date)` crossing so a
   repeated CPM recompute that leaves the release still-slipped does not re-notify.
8. **Dead-letter / failure handling:** the release-slip notification reuses the existing notification
   DLQ + retry/alert. Forecast/readiness reads have no failure-queue (a failed read returns an error to
   the caller). Release CRUD failures surface synchronously to the client.

## Tracking

Epic **#758** (milestone 0.7), children:

| Issue | Scope | Guardrail |
|-------|-------|-----------|
| #367 | Release object + project-nested CRUD + RBAC (moved into 0.7; this ADR supersedes its scope) | — |
| #759 | Editable product roadmap — now/next/later + timeline, drag epics between horizons | — |
| #760 | Release-level forecast — P50/P80 + CPM-anchored date + velocity-trend chart | G3 |
| #761 | Epic→schedule rollup — derived read-only date annotation + release-slip notification | G1 |
| #762 | Release readiness view — % meeting acceptance criteria/DoD + advisory commit warning | G3 |
| #763 | Light requirements fields — product_brief + structured AC + linked_objective + derived PR traceability | G4 |

**Depends on 0.3:** `Task.type` taxonomy (#363), epic/initiative hierarchy (#364), acceptance criteria (#493 — to be made structured), Product Owner role (#496).
