# ADR-0105: PO Product-Backlog Hierarchy, Acceptance Criteria, and Prioritization Scoring

> **Companion ADRs (0.3 agile-team architecture batch).** ADR-0104 = Unified Team-Signal Privacy Model · ADR-0105 = PO Product-Backlog Hierarchy & Scoring · ADR-0106 = Agile/Waterfall Bridge. Where this ADR refers to "the Privacy ADR", "the Backlog ADR", or "the Bridge ADR" it means 0104 / 0105 / 0106 respectively. **ADR-0105** is this document.

## Status
Proposed

## Context

The 0.3 agile-team release lands the **Product Owner** day-to-day surface (Jordan): a prioritized product backlog with epic/story structure, a tickable Definition of Done, and a defensible prioritization order. Today the PO's home surface reads as a flat task list — acceptance criteria is a freeform textarea, there is no epic/story type designation, epic→story hierarchy exists only implicitly via WBS nesting, and priority is a single gut-feel drag order. This is the cluster's beta-blocker (#731) and Jordan's #1 documented complaint about Jira (#922).

This ADR is the **0.3 foundation that ADR-0088 (0.7 PO product-strategy surface) explicitly depends on**: ADR-0088 §1 lists `Task.type` (#363), the epic/initiative hierarchy parallel to the WBS (#364), structured acceptance criteria (#493 made structured), and the Product Owner role (#496) as 0.3 prerequisites. This ADR designs and reconciles them as one coherent backlog layer, plus the prioritization-scoring framework (#922) and quick-inline-add (#921).

**P3M layer:** Programs and Projects / Operations — single-project, single-team backlog authoring. **OSS**. Cross-program backlog aggregation, portfolio roadmaps, OKR rollup, and audited requirements traceability are Enterprise (already filed: enterprise #140/#141/#142 at milestone 1.0).

**VoC (focused panel, 2026-05-31):** Jordan/PO 9/10 champion; Alex/SM 8, Morgan/Coach 8 (#921 quick-add). Binding guardrails, encoded **structurally**:
- **Jordan hard-NO:** a flat task list with no epic/story hierarchy; being forced to learn CPM/WBS vocabulary to manage the backlog.
- **Priya hard-NO:** PM/CPM vocabulary leaking into the contributor create/work surfaces.
- **Morgan 🟡 (velocity-privacy posture):** the prioritization score must stay PO-owned and never become a PM lever or an upward productivity metric — the same posture the Unified Team-Signal Privacy Model ADR encodes for velocity/pulse.

### What exists today (verified in-tree 2026-05-31)

- **No `Task.type` field, no epic parent link, no acceptance-criteria model.** `Task` (`apps/projects/models.py:792`) carries `wbs_path` (ltree, no stored parent FK), `priority_rank` (`PositiveIntegerField`, nullable, lower=higher — line 913, drives board/backlog sort #105/#494), `sprint` FK, `sprint_pending` (line 951, ADR-0102), `story_points` (line 954, nullable, optional), `status`. The only epic/story vocabulary anywhere is `BacklogItemType` on the **program-level** `BacklogItem` intake pool (ADR-0069) — *not* on `Task`.
- **The CPM feed is leaf-only by `wbs_path`** — summary tasks have no own CPM date; spans are min/max annotations. A second hierarchy can sit parallel via a new FK with no engine impact (the ADR-0088 G1 lever).
- **No PO/SM Role ordinal.** Roles are `VIEWER=0 / MEMBER=100 / SCHEDULER=200 / ADMIN=300 / OWNER=400` (`access/models.py`; ADMIN="Project Manager", SCHEDULER="Resource Manager"). "PO" is an agile *hat*: ADR-0078 (`0078-team-entity-oss.md`, **Proposed** — `TeamMembership`/`is_product_owner` not yet in code) models it as a `TeamMembership.is_product_owner` facet orthogonal to the ordinal scale. ADR-0072 is the extension point Enterprise registers custom ordinals against — a 6th ordinal would break it.
- **No `ProjectSettings` model.** Per-project policy lives on `Project` (`methodology`, `agile_features`, `estimation_mode`) — the home for `prioritization_model`.
- **`priority_rank` is the single ordering today** — there is no sprint-scoped order (the #365 gap).

### Forces

1. **Jordan must own the backlog in agile vocabulary, with zero WBS exposure.** Epic/story framing must be pure metadata on the existing row.
2. **The epic tree must never write a CPM date** (the ADR-0088 G1 boundary).
3. **The prioritization score is a planning input, not a metric** — PO-owned, project-scoped, no upward aggregation, no leak into the contributor surface (Morgan/Priya); same posture as the privacy ADR.
4. **The backlog feeds planning by being read, never by writing sprint membership** (sprint sovereignty, ADR-0101/0102).
5. **Reuse, don't reinvent**: `priority_rank`, the summary-rollup annotation, `Project`-as-policy-home, and the `is_product_owner` facet.

## Decision

### 1. Hierarchy model — same `Task` tree, two orthogonal metadata axes

Not a new entity. The existing `Task` tree plus two additive, nullable, sync-rideable fields:

- **`Task.type` — `CharField(choices=TaskType, default=TASK, db_index=True)`** (#363). `TaskType`: `STORY | BUG | TASK | SPIKE | EPIC`. Type drives card icon, default column visibility, report/burndown grouping, and the `?type=` list filter — **never data partitioning** (every existing row migrates cleanly to `TASK`). Enterprise registers `FEATURE | CAPABILITY | INITIATIVE` at higher tiers via the slot system.
- **`Task.parent_epic` — `ForeignKey("self", SET_NULL, null=True, related_name="epic_children")`** (#364). A task (typically `type=STORY`) points at a `type=EPIC` task. **Independent of `wbs_path`**. Epics nest **one level only** (Epic-of-Epics deferred). Validation: `parent_epic` must reference a same-project `type=EPIC` task and may not create a cycle.

**Why same-tree + self-FK:** `Task` is already a `VersionedModel`, so both fields ride `server_version` sync to the 0.4 mobile client for free; a join table would need its own sync surface. Board and Schedule keep plain Task vocabulary (ADR-0069's "same item, different framing") — Jordan never sees WBS terms.

**Epic→schedule rollup is CPM-authoritative and one-way (inherits ADR-0088 G1).** An epic's date span and progress are **query-time annotations** — `min(early_start)/max(early_finish)` and a points/criteria rollup over its `epic_children`, computed with the same mechanism as `percent_complete_rollup`. **The scheduler never receives `parent_epic` as input**; the engine stays leaf-only-by-`wbs_path`. There is no code path by which the epic tree writes a CPM date. Board grouping gains a "by epic" option; the Schedule view shows epic swimlanes when grouping by epic.

### 2. Acceptance criteria — structured tickable child rows (supersedes #493's rich-text design)

**New `AcceptanceCriterion` model** (`apps/projects`, `VersionedModel`, UUID PK, `server_version`):
- `task` FK (CASCADE); `text` (CharField); `met` (BooleanField, default False); `position` (PositiveIntegerField, stable manual ordering); `met_by`/`met_at` (nullable, the sprint-review pass/fail trail).

**Done-state of a story** = all its criteria `met` (derived reads `criteria_met_count`/`criteria_total`). **Acceptance criteria are decoupled from `percent_complete` and from any CPM percent** — a story may be schedule-complete with unmet criteria and vice versa. Criteria drive sprint-review pass/fail and release-readiness (ADR-0088 G4/G3), **not** the schedule. Tying DoD to the CPM percent would leak acceptance state into the engine and re-open the G1 boundary — rejected.

*Why child rows, not a `JSONField`:* ordering, per-item history (the review trail), and the G3 release-readiness count all need a queryable/indexable shape.

### 3. Prioritization scoring (#922) — config on `Project`, inputs on `Task`, auto-rank into `priority_rank`

- **`Project.prioritization_model` — `CharField(choices, default=NONE)`**: `NONE | WSJF | VALUE_EFFORT | RICE`. The established `Project`-as-policy-home pattern (there is no `ProjectSettings`). `NONE` hides the column; pure manual drag.
- **Score INPUT fields on `Task`** (nullable small fields). To avoid stale-input ambiguity when a project switches models mid-stream, each model gets **distinct** fields: WSJF — `business_value`, `time_criticality`, `risk_reduction`, `job_size`; RICE — `reach`, `impact`, `confidence`, `effort`; value-effort — `value`, `effort_estimate`.
- **`prioritization_score`** is a **computed read-only `SerializerMethodField`** derived per the active model. **Never stored** — avoids stale-score drift (the same reason ADR-0065 rejected a stored `velocity_suggested_duration`).
- **Auto-rank `@action`** sorts the project's `BACKLOG`-status tasks by descending `prioritization_score` and **writes the result into `priority_rank`**. One-shot PO-invoked sort, **not** a live re-sort. **Manual drag wins**: any subsequent drag writes `priority_rank` directly and persists.

*Why compose into `priority_rank`:* the field already exists and drives the board/backlog sort (#105/#494) and the #365 sprint-commit rank seeding — auto-rank-into-`priority_rank` means every downstream consumer needs zero change.

**Score is a planning input, never a metric (Morgan/Priya guardrail, encoded structurally, identical posture to the privacy ADR):** scoring fields and the `prioritization_score` projection appear **only** on the project-scoped backlog/grooming authoring surface. They are **absent from every My Work / contributor queryset** and there is **no program/PMO scoring-aggregation endpoint** in OSS. Crucially, the velocity forecast (Agile/Waterfall Bridge ADR) reads `story_points`, NOT `prioritization_score` — scoring never reaches the forecast, My-Work, or any upward surface.

### 4. Dual backlog ordering (#365) and quick-add (#921)

- **`Task.sprint_rank` — `PositiveIntegerField`, nullable** (#365): sprint-scoped execution order, meaningful only when `sprint` is non-null. Reorders inside a sprint write `sprint_rank`; product-backlog reorders write `priority_rank`. `sprint_rank` is seeded from `priority_rank` order at sprint commit (PLANNED→ACTIVE) and cleared on the live row at close (preserved on `HistoricalTask`). Carry-over re-ranks on arrival (no rank inheritance). This is the standard Scrum dual-backlog rule.
- **Quick inline story-add (#921):** a title-only `<30s` inline create, committing on Enter and immediately accepting the next. Lands as a `STORY` with `status=BACKLOG`, `sprint=NULL`, at bottom `priority_rank`, **no required PM/CPM fields** (Priya hard-NO guard). Optional inline epic/type assignment.

### 5. RBAC — PO is a Team facet, not a 6th Role ordinal (resolves #496)

#496's "named Product Owner role" is satisfied via the **`TeamMembership.is_product_owner` facet (ADR-0078)** — orthogonal to the 5 Role ordinals — **not** a 6th ordinal. Backlog authoring (set `type`, link `parent_epic`, edit acceptance criteria, configure scoring, run auto-rank) is gated as **`role >= Role.ADMIN OR TeamMembership.is_product_owner`** on the task's project. Members and Viewers read only.

*Why a facet:* ADR-0072 is the role-ordinals extension point Enterprise registers custom high-ordinal roles against; a 6th OSS ordinal would break it. ADR-0101/0102 both state "PO/SM is a hat, not a stored role." The facet appears in the role-assignment UI and carries the distinct permission bit #496 wants. The existing sprint-scope accept/reject gate (ADR-0102, `role >= ADMIN`) is unchanged — this ADR adds **no** new sprint write-path.

**Cross-ADR consistency:** the same `is_product_owner` facet is the read-side tier mapping in the Unified Team-Signal Privacy Model ADR (a PO reads team signals at the PM tier / `TEAM_SM_PM`). Both ADRs consult one facet. **Interim:** if ADR-0078/#496 slips past this cluster, both ADRs ship an interim `role >= Role.ADMIN`-only gate and wire the facet when the Team entity lands.

### 6. The backlog feeds planning by READ only — zero sprint write-path (inherits ADR-0088 G2)

The backlog, scoring, auto-rank, and grooming surfaces expose **no `sprint` field** and can never set `Task.sprint`. A story enters a sprint only through the existing sprint-planning / scope-change gate (ADR-0037/0102), preserving sprint sovereignty. The sprint-planning one-view flow (#495) and the velocity forecast consume the backlog — `story_points`, epic rollup, acceptance-criteria readiness — as **reads**. #365's separate `sprint_rank` keeps planning order distinct from product-backlog priority.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Same Task tree + `type` + `parent_epic` self-FK (chosen)** | One synced entity; epic tree rides sync free; CPM stays leaf-only (G1 holds structurally); zero WBS vocabulary for Jordan; matches ADR-0088's committed direction | Two coupled metadata axes on Task; one-level epic-nesting limit |
| Separate `Epic`/`EpicLink` join entity | "Clean" epic object | New `VersionedModel` + delta wiring + a second sync surface; risks an epic getting its own schedulable identity (G1 hazard) |
| Reuse program `BacklogItem` as the in-project hierarchy | No new fields | `BacklogItem` is a program-level *intake pool* (ADR-0069), wrong layer and lifecycle |
| Rich-text acceptance criteria (original #493) | Simplest | Not tickable; can't drive the G3 readiness count or the review trail; #731 explicitly asks to replace it |
| Acceptance criteria as a `JSONField` of `{text,met}` | One column | No stable ordering, no per-item history, no cheap count at scale |
| Stored `prioritization_score` column | Cheaper reads | Stale-score drift as inputs change (same reason ADR-0065 rejected a stored Task suggestion field) |
| Auto-rank as a live re-sort | No explicit action | Fights the manual drag (Jordan's override); a backlog that silently reorders is worse than no scoring |
| Overload shared score input columns across models | Leaner schema | Stale inputs from the prior model when a project switches mid-stream; ambiguous. Rejected for per-model distinct fields. |
| PO as a 6th Role ordinal (#496 literal) | Single concept | Breaks the ADR-0072 ordinals extension point; contradicts ADR-0078/0101/0102 |
| Backlog/scoring action sets `Task.sprint` | One-step add-to-sprint | Violates ADR-0088 G2 / sprint sovereignty. Rejected outright |

## Consequences

- **Easier:** Jordan runs a real PO backlog — typed epics/stories, a tickable DoD, a defensible WSJF/RICE order — without a second tool and without WBS vocabulary; the 0.7 PO-strategy surface (ADR-0088) gets the 0.3 foundation it depends on; auto-rank-into-`priority_rank` reuses the existing ordering plumbing.
- **Harder:** `Task` grows several agile-facing fields (mitigated: all additive/nullable/synced, gated behind `agile_features`/`prioritization_model`); the epic rollup annotation adds query cost on large projects (mitigated by the existing ltree GiST index and the reused `percent_complete` annotation); onboarding gains epic/story/scoring concepts (mitigated by hiding the whole surface when `prioritization_model=NONE` and `agile_features` off).
- **Risks:** (1) the epic tree drifting toward a schedulable identity would breach G1 — mitigated by the scheduler never ingesting `parent_epic` and a test asserting it. (2) Scoring leaking into a My Work/PMO surface would breach the privacy posture (shared with the privacy ADR) — mitigated by scoping scoring fields to the authoring queryset and shipping no aggregation endpoint, with a test. (3) `Task.type` and `PrioritizationModel` enums hit the drf-spectacular enum-name collision — pin via `ENUM_NAME_OVERRIDES` in the same MR. (4) the PO-facet gate depends on ADR-0078 (Proposed); if #496/ADR-0078 slips, an interim `role >= ADMIN`-only gate ships and the facet is wired when the Team entity lands.

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations (single-project, single-team).
- **Affected packages:** api (`Task.type`/`parent_epic`/`sprint_rank`/scoring-input fields, `AcceptanceCriterion` model, `Project.prioritization_model`, epic-rollup annotation, auto-rank `@action`, quick-add defaults, serializers, RBAC gate), web (backlog/grooming view, epic grouping, acceptance-criteria checklist, scoring columns + auto-rank, inline quick-add). **No scheduler change.**
- **Migration required:** **yes** — `Task.type`, `Task.parent_epic`, `Task.sprint_rank`, the per-model scoring-input fields (all nullable), `Project.prioritization_model` (default `NONE`), and `AcceptanceCriterion`. All additive/nullable/defaulted. `Task` carries `HistoricalRecords` and `AcceptanceCriterion` extends `VersionedModel` — run `makemigrations` (never hand-write). Do not hard-code the migration number. Land this MR SECOND (after privacy, before bridge) to keep the migration graph linear.
- **API changes:** yes — `Task.type`/`parent_epic`/`sprint_rank` and scoring inputs on `TaskSerializer`; read-only `prioritization_score`, `criteria_met_count`/`criteria_total`, and epic-rollup annotations; `AcceptanceCriterion` nested CRUD; `Project.prioritization_model`; `?type=` and `?parent_epic=` list filters; an auto-rank `@action` (synchronous `200`). Regenerate OpenAPI **after merging origin/main**; add `ENUM_NAME_OVERRIDES` for `TaskType` and `PrioritizationModel`.
- **OSS or Enterprise:** **OSS**. Enterprise registers the higher type tiers via the slot system and consumes cross-program backlog/score rollups (enterprise #140/#141/#142) against the OSS read endpoints; OSS ships **no** cross-program/PMO aggregation and never imports `trueppm_enterprise`.
- **Coordinate with:** ADR-0088 (this is its declared 0.3 foundation — keep `type`/`parent_epic`/structured-AC field shapes compatible with `Task.target_release`), ADR-0078 (the `is_product_owner` facet this gates on — shared with the privacy ADR's PO tier), ADR-0069 (program `BacklogItem` stays the intake pool), ADR-0072 (do not add a Role ordinal), ADR-0101/0102 (no new sprint write-path), and the **Agile/Waterfall Bridge ADR** (the forecast reads `story_points`, not scoring).
- **RBAC:** backlog authoring requires `role >= Role.ADMIN OR TeamMembership.is_product_owner`; reads require project membership; scoring fields absent from contributor/My Work and have no program endpoint. All mutations fire `broadcast_board_event()` via `transaction.on_commit()`.
- **Testing (three-layer, same MR):** pytest — `type`/`parent_epic` CRUD + same-project/EPIC-target/cycle validation; epic rollup is a read annotation the scheduler never ingests (G1); `AcceptanceCriterion` ordering + met-count; scoring per-model math + auto-rank writes `priority_rank` + manual drag wins; **scoring fields absent from the My Work queryset and no program aggregation endpoint** (privacy guard); the backlog exposes **no `sprint` field** (G2); PO-facet gate (a non-admin PO can author; a non-PO member cannot). vitest — epic grouping, acceptance-criteria checklist, scoring columns + auto-rank selector, inline quick-add. Playwright — PO golden path (create epic → add stories → tick criteria → score → auto-rank → manual override) + empty-backlog state + a rapid multi-add-during-grooming path.

### Durable Execution
1. **Broker-down:** every operation — type/parent_epic/criteria/scoring writes and the auto-rank reorder — is a **synchronous DB write** with `server_version` bump and `broadcast_board_event()` deferred via `transaction.on_commit()`. No async dispatch on any write path. The only downstream async (a CPM recompute, if a synced field that is a CPM input later changes) continues through `scheduling/services.py::enqueue_recalculate()` — unchanged.
2. **Drain task:** none new.
3. **Orphan window:** N/A — no new outbox table.
4. **Service layer:** auto-rank goes through `auto_rank_backlog(project, by)` (computes scores + writes `priority_rank` in one transaction); criteria/epic-link mutations are ordinary serializer writes. No bare `.delay()`; CPM continues through `enqueue_recalculate()`.
5. **API response:** all endpoints synchronous `200`/`201`; auto-rank returns the reordered backlog.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** auto-rank is idempotent (a pure function of current scores); criteria/type/link writes use `server_version` optimistic concurrency.
8. **Dead-letter / failure:** synchronous writes surface failures directly; the deferred board broadcast falls to existing broadcast failure handling and self-heals on the next board load (state read from the DB).

## Decisions pending your sign-off

This ADR is **Proposed**. The following choices encode a defensible default but are flagged for review at MR time:

1. **Interim PO authoring gate.** PO backlog-authoring authority is `role >= Role.ADMIN OR is_product_owner`; until ADR-0078/#496 land the facet, ship `role >= Role.ADMIN`-only and wire the facet later. Confirm.
2. **Spike completion semantics.** #363 names `Spike` with 'different completion semantics', but this ADR treats `type` as non-partitioning metadata (icon/grouping/filter) and does **not** special-case Spike (time-box, velocity-exclusion) in 0.3. Confirm Spike distinct done-semantics defers past 0.3.
