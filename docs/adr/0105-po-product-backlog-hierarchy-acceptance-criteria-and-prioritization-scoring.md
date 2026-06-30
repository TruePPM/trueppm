# ADR-0105: PO Product-Backlog Hierarchy, Acceptance Criteria, and Prioritization Scoring

> **Consolidated ADR.** This document merges two parallel 0.3 drafts of the same feature:
> the coordinated docs-batch design (`docs/adr-po-product-backlog-hierarchy-scoring`) and an
> implementation-led draft (`0105-product-backlog-and-scoring.md`, now removed). The merge
> direction was set by a focused VoC panel (Jordan 8 / Alex 8 / Morgan 7 / Priya 6, 2026-06-01):
> child-model acceptance criteria, distinct per-model scoring inputs, and a dual product/sprint
> order all won; a stored PO Definition-of-Ready signal is retained from the implementation draft.
>
> **Companion ADRs (0.3 agile-team batch):** ADR-0104 = Unified Team-Signal Privacy Model ·
> **ADR-0105 = this document** · ADR-0106 = Agile/Waterfall Bridge.

## Status
Accepted (2026-06-01) — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class AcceptanceCriterion)

## Context

The 0.3 agile-team release lands the **Product Owner** day-to-day surface (Jordan): a prioritized
product backlog with epic/story structure, a tickable Definition of Done, a Definition-of-Ready
signal, and a defensible prioritization order. Today the PO's home surface reads as a flat task
list — acceptance criteria is a freeform textarea, there is no epic/story type, epic→story
hierarchy exists only implicitly via WBS nesting, and priority is a single gut-feel drag order.
This is the cluster's beta-blocker (#731) and Jordan's #1 documented Jira complaint (#922).

This ADR is the **0.3 foundation that ADR-0099 (0.7 PO product-strategy surface) explicitly
depends on**: ADR-0099 §1 names `Task.type` (#363), the epic/initiative hierarchy parallel to
the WBS (#364), structured acceptance criteria (#493 made structured), and the Product Owner role
(#496) as 0.3 prerequisites. This ADR designs them as one coherent backlog layer plus the
prioritization-scoring framework (#922) and quick-inline-add (#921).

**P3M layer:** Programs and Projects / Operations — single-project, single-team backlog authoring.
**OSS.** Cross-program backlog aggregation, portfolio roadmaps, OKR rollup, and audited
requirements traceability are Enterprise (enterprise #140/#141/#142 at 1.0).

**VoC focused panel (2026-06-01), agile cohort:** Jordan/PO 8 🟢, Alex/SM 8 🟢, Morgan/Coach 7 🟢,
Priya/Team 6 🟡. Binding guardrails, encoded **structurally**:
- **Jordan hard-NO:** flat list with no hierarchy; learning CPM/WBS vocab to manage the backlog;
  the team's in-sprint reorder writing back into product-backlog priority.
- **Priya hard-NO:** the acceptance-criteria review trail surfaced as per-person attribution
  ("Priya met this at 3:42pm") — it must read as team-level criterion status, not individual tracking.
- **Morgan hard-NO:** PO ordering imposed on in-sprint execution (surveillance); any scoring /
  readiness / velocity signal auto-exposed to a PMO dashboard.
- **Alex 🟡:** "Ready" must be a coaching signal, not a hard lock that blocks the team from jointly
  pulling a story they've agreed is ready.

### What exists today (verified in-tree 2026-06-01)

- **No `Task.type`, no epic parent link, no acceptance-criteria model.** `Task`
  (`apps/projects/models.py`) carries `wbs_path` (ltree, no stored parent FK), `priority_rank`
  (nullable, lower=higher, drives board/backlog sort #105/#494), `sprint` FK, `sprint_pending`
  (ADR-0102), `story_points` (nullable), `status`. Epic/story vocabulary exists only as
  `BacklogItemType` on the program-level `BacklogItem` intake pool (ADR-0069) — not on `Task`.
- **The CPM feed is leaf-only by `wbs_path`** — a second hierarchy can sit parallel via a new FK
  with no engine impact (the ADR-0099 G1 lever). The existing `CommittedTaskManager` already
  excludes `BACKLOG` + `is_recurring`; an epic exclusion rides the same key.
- **No PO/SM Role ordinal.** Roles `VIEWER=0 / MEMBER=100 / SCHEDULER=200 / ADMIN=300 / OWNER=400`
  (`access/models.py`; ADMIN="Project Manager"). ADR-0078 (**Proposed**) models PO as a
  `TeamMembership.is_product_owner` facet orthogonal to the ordinal scale; ADR-0072 is the
  Enterprise role-ordinal extension point (a 6th ordinal would break it).
- **No `ProjectSettings` model** — per-project policy lives on `Project` (`methodology`,
  `agile_features`, `estimation_mode`), the home for `prioritization_model`.
- **`priority_rank` is the single ordering today** — there is no sprint-scoped order (the #365 gap).
- `Task` carries `HistoricalRecords`; the next migration is `0056`.

## Decision

### 1. Hierarchy — same `Task` tree, two orthogonal metadata axes (#363, #364)

Not a new entity. The existing `Task` tree plus two additive, nullable, sync-rideable fields:

- **`Task.type` — `CharField(choices=TaskType, default=TASK, db_index=True)`**. `TaskType`:
  `STORY | BUG | TASK | SPIKE | EPIC`. Drives card icon, default column visibility, report/burndown
  grouping, and the `?type=` filter — never data partitioning (every existing row migrates to
  `TASK`). Enterprise registers `FEATURE | CAPABILITY | INITIATIVE` at higher tiers via the slot
  system. `Spike` is plain metadata in 0.3 (distinct time-box/velocity-exclusion semantics deferred).
- **`Task.parent_epic` — `ForeignKey("self", SET_NULL, null=True, related_name="epic_children")`**.
  A `type=STORY` task points at a `type=EPIC` task. **Independent of `wbs_path`.** Epics nest one
  level only (Epic-of-Epics deferred). Validation: same-project `type=EPIC` target, no cycle.

**Epic→schedule rollup is CPM-authoritative and one-way (inherits ADR-0099 G1).** An epic's span and
progress are **query-time annotations** (`min(early_start)/max(early_finish)` + points/criteria
rollup over `epic_children`). **The scheduler never receives `parent_epic`**; the engine stays
leaf-only-by-`wbs_path`. Epics are excluded from CPM input and `CommittedTaskManager` exactly as
`is_recurring` templates are, asserted by test.

### 2. Acceptance criteria — first-class tickable child rows (VoC C1 → B; supersedes #493 rich-text)

**New `AcceptanceCriterion` model** (`apps/projects`, `VersionedModel`, UUID PK, `server_version`):
`task` FK (CASCADE); `text` (CharField); `met` (Boolean, default False); `position` (PositiveInteger,
stable manual ordering — drag to reorder); `met_by` (FK user, nullable) / `met_at` (nullable) — the
sprint-review pass/fail trail. Optional `given`/`when`/`then` (CharField, blank) so the DA-13 drawer
renders structured Given/When/Then where the team uses it.

- **Derived reads:** `criteria_met_count` / `criteria_total`, surfaced as the DA-10/DA-14 AC meter
  and a backlog-wide release-readiness count (ADR-0099 G3).
- **Decoupled from `percent_complete` and any CPM percent** — a story may be schedule-complete with
  unmet criteria and vice versa. Criteria drive sprint-review pass/fail and release-readiness, not
  the schedule (tying DoD to CPM percent would re-open the G1 boundary — rejected).
- **Review-trail privacy (VoC: Priya hard-NO + Morgan):** `met_by`/`met_at` are stored but surfaced
  as the **criterion's** team-level status with attribution available **only on drill-down inside
  the sprint/story context**. There is **no default per-person column**, and the trail and the
  readiness count are **never exposed on any PMO/portfolio rollup or cross-team report** — the same
  posture ADR-0104 encodes for velocity/pulse. Asserted by test.

*Why child rows, not JSON:* ordering, the per-item review trail, and the G3 readiness count all
need a queryable/indexable shape (VoC Jordan/Alex/Morgan all chose B).

### 3. Prioritization scoring (#922) — config on `Project`, distinct inputs on `Task`, one-shot auto-rank (VoC C2 → A)

- **`Project.prioritization_model` — `CharField(choices, default=NONE)`**: `NONE | WSJF | VALUE_EFFORT
  | RICE`. `NONE` hides the scoring column (pure manual drag) — the surface stays invisible until a
  PM/PO opts in. The established `Project`-as-policy-home pattern.
- **Distinct INPUT fields per model on `Task`** (nullable small fields — VoC C2 unanimous A,
  non-destructive/reversible): WSJF — `business_value`, `time_criticality`, `risk_reduction`,
  `job_size`; RICE — `reach`, `impact`, `confidence`, `effort`; value-effort — `value`,
  `effort_estimate`. Switching models preserves the inactive model's inputs untouched; switching
  back restores them exactly.
- **`prioritization_score`** is a **computed read-only `SerializerMethodField`** per the active model
  — never stored (avoids stale-score drift). Missing/zero denominator → null (unscored sorts last).
- **One-shot auto-rank `@action`** sorts `BACKLOG`-status, sprint-less, non-epic tasks by descending
  score and **writes the result into `priority_rank`** (manual rank as tiebreaker). **Manual drag
  always wins** — there is no persistent "auto-rank lock"; any later drag rewrites `priority_rank`.
  This is the PO's tool, not a live re-sort (VoC: auto-rank with manual override is the right balance).
  Iterated via `save()` (not `bulk_update`) so each row bumps `server_version` and writes
  `HistoricalTask`.
- **Score is a planning input, never a metric (Morgan/Priya, structural):** scoring fields and the
  `prioritization_score` projection appear only on the project-scoped backlog/grooming surface —
  **absent from every My Work / contributor queryset**, with **no program/PMO scoring-aggregation
  endpoint** in OSS. The velocity forecast (ADR-0106) reads `story_points`, never the score.

### 4. Definition of Ready — stored PO signal, advisory gate (retained from the impl draft; VoC-refined)

- **`Task.dor` — `CharField(choices=DorState, default=IDEA, db_index=True)`** — `IDEA | REFINE |
  READY`. Named `dor`, **not** `readiness`, to avoid colliding with `TaskSerializer`'s existing
  computed `readiness` field (the ADR-0057 board ReadinessChip, a different signal). This is the PO's
  **explicit stored intent**, set via *Mark ready* / *Send to refine* (DA-13).
- **Mark-ready is gated but advisory.** The PO may only set `dor=READY` when the story is estimated
  (`story_points` set) and **every acceptance criterion is met** (via §2's count) — a failing/pending
  criterion or an unestimated story returns 400 naming the unmet condition. But this is a gate on the
  PO's *Ready* action, **not** a hard lock on sprint intake: the team + PO may still jointly pull a
  not-yet-ready story into a sprint (the sprint-planning/scope path, ADR-0037/0102) — the ready-line
  (DA-10) and the DoR chip are coaching signals, not blockers (VoC: Alex/Morgan).
- **Criteria completion informs but does not auto-flip `dor`** (VoC: Jordan) — ticking the last
  criterion does not silently set READY; the PO retains the explicit Mark-ready action.

### 5. Dual backlog ordering (#365) and quick-add (#921) (VoC C3 → B, unanimous)

- **`Task.sprint_rank` — `PositiveIntegerField`, nullable**: sprint-scoped execution order, meaningful
  only when `sprint` is non-null. **Seeded from `priority_rank` order at sprint commit
  (PLANNED→ACTIVE)**; cleared on the live row at close (preserved on `HistoricalTask`); carry-over
  re-ranks on arrival. The standard Scrum dual-backlog rule: PO owns product-backlog `priority_rank`,
  the team owns within-sprint `sprint_rank`.
  - **Seeded-then-independent, one-way (VoC: Jordan hard-NO):** within-sprint reorder writes
    `sprint_rank` **only** — it can **never** write back to `priority_rank`. The product backlog is
    never mutated by in-sprint sequencing.
  - **Team-editable (VoC: Morgan):** reordering `sprint_rank` requires only `IsProjectMemberWrite`
    (Member+), **not** Scheduler/Admin — any team member arranges the sprint, or it goes dead in
    week two.
  - Reorders and mid-sprint scope changes write the existing ADR-0102 sprint-readable audit (visible
    at Sprint Review), distinguishing a team reorder from a PM/PO injection (VoC: Alex).
- **Quick inline story-add (#921):** title-only `<30s` inline create, commit-on-Enter, immediately
  accepting the next. Lands as `type=STORY`, `status=BACKLOG`, `sprint=NULL`, bottom `priority_rank`,
  **no required PM/CPM fields** (Priya hard-NO guard). Optional inline epic/type.

### 6. RBAC — PO is a Team facet, not a 6th Role ordinal (resolves #496)

Backlog authoring (set `type`, link `parent_epic`, edit acceptance criteria, configure scoring, run
auto-rank, split) is gated **`role >= Role.ADMIN OR TeamMembership.is_product_owner`** on the task's
project, via a single `can_manage_backlog` capability helper (the seam ADR-0099's PO role drops into).
**Interim:** ADR-0078/#496 (the `is_product_owner` facet) is Proposed and not yet in code, so 0.3
ships the **`role >= Role.ADMIN`-only** form of `can_manage_backlog` and wires the facet when the Team
entity lands — no migration churn at that point. *Why a facet not an ordinal:* a 6th OSS ordinal
breaks the ADR-0072 extension point; ADR-0101/0102 already state "PO/SM is a hat, not a stored role."

Within-sprint `sprint_rank` reorder is Member+ (§5). Reads require project membership. Scoring fields
are absent from contributor/My-Work and have no program endpoint.

### 7. The backlog feeds planning by READ only — zero sprint write-path (inherits ADR-0099 G2)

The backlog, scoring, auto-rank, and grooming surfaces expose **no `sprint` field** and can never set
`Task.sprint`. A story enters a sprint only through the existing sprint-planning / scope-change gate
(ADR-0037/0102), preserving sprint sovereignty. `sprint_rank` keeps planning order distinct from
product-backlog priority.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Same Task tree + `type` + `parent_epic` self-FK (chosen)** | One synced entity; epic tree rides sync free; CPM stays leaf-only (G1); zero WBS vocab for Jordan; matches ADR-0099 | Two coupled metadata axes on Task; one-level epic nesting |
| Separate `Epic`/`EpicLink` entity | "Clean" epic object | New sync surface; risks an epic getting a schedulable identity (G1 hazard) |
| **AcceptanceCriterion child rows (chosen, VoC C1=B)** | Ordering, review trail, queryable readiness count | A second model + nested CRUD; review-trail needs a privacy guard |
| AC as `JSONField` of `{text,met,status}` (the impl draft) | One column, simplest | No stable ordering, no per-item review trail, no cheap count; VoC chose against |
| **Distinct per-model scoring columns (chosen, VoC C2=A)** | Non-destructive/reversible model switch; queryable | ~10 nullable columns |
| Single `scoring_inputs` JSON blob (the impl draft) | Leaner schema | Stale/ambiguous inputs on model switch; VoC unanimous against |
| Stored `prioritization_score` | Cheaper reads | Stale-score drift (same reason ADR-0065 rejected a stored suggestion) |
| Persistent auto-rank "lock" toggle (the impl draft) | Enforces score order | Fights the manual override Jordan/Alex want; one-shot + manual-wins is cleaner |
| **`sprint_rank` dual order (chosen, VoC C3=B)** | Team owns in-sprint sequence; Scrum-correct | A second order field; needs seed-at-commit + Member-edit + one-way guard |
| Single shared order | Simplest | Collapses the Sprint backlog into a board-with-dates; Morgan/Alex/Priya hard-NO |
| Derived-only readiness (the sibling draft) | No stored field | Can't represent the PO's explicit Send-to-refine intent; DA-13 needs it |
| PO as a 6th Role ordinal (#496 literal) | Single concept | Breaks ADR-0072; contradicts ADR-0078/0101/0102 |
| Backlog action sets `Task.sprint` | One-step add-to-sprint | Violates ADR-0099 G2 / sprint sovereignty |

## Consequences

- **Easier:** Jordan runs a real PO backlog — typed epics/stories, a tickable DoD with a review trail,
  a reversible WSJF/RICE order, and a PO-owned Ready signal — without a second tool and without WBS
  vocab; the team owns its in-sprint order; ADR-0099 gets its 0.3 foundation; auto-rank reuses the
  existing `priority_rank` plumbing so every downstream consumer is unchanged.
- **Harder:** `Task` grows several agile fields + an AcceptanceCriterion model (mitigated: all
  additive/nullable/synced, gated behind `agile_features`/`prioritization_model=NONE`); the epic
  rollup adds query cost (mitigated by the ltree index + the reused `percent_complete` annotation
  pattern); onboarding gains concepts (mitigated by hiding the surface when off).
- **Risks:** (1) the epic tree drifting toward a schedulable identity breaches G1 — mitigated: the
  scheduler never ingests `parent_epic`, test-asserted. (2) the AC review trail or readiness/score
  leaking to a My-Work/PMO surface breaches the privacy posture — mitigated: scoped to the authoring/
  sprint surface, no aggregation endpoint, no per-person column, test-asserted. (3) `TaskType` /
  `PrioritizationModel` / `DorState` enums hit the drf-spectacular enum-name collision — pinned via
  `ENUM_NAME_OVERRIDES` in the same MR. (4) the PO-facet gate depends on ADR-0078 (Proposed) — interim
  `role >= ADMIN`-only ships and the facet wires in later.

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations (single-project, single-team). **OSS.**
- **Affected packages:** api (`Task.type`/`parent_epic`/`sprint_rank` + per-model scoring fields + `dor`,
  `AcceptanceCriterion` model, `Project.prioritization_model`, epic-rollup annotation, one-shot
  auto-rank `@action`, quick-add defaults, serializers, `can_manage_backlog` RBAC), web (grooming /
  scoring / story-drawer / epic-rollup surfaces, inline quick-add). **No scheduler change.**
- **Migration required:** **yes** — `0056`, additive only (`Task.type` default `task`, `parent_epic`
  nullable SET_NULL, `sprint_rank` nullable, per-model scoring columns nullable, `dor` default `idea`,
  `Project.prioritization_model` default `NONE`, `AcceptanceCriterion`). `Task` carries
  `HistoricalRecords` and `AcceptanceCriterion` extends `VersionedModel` — run `makemigrations` (never
  hand-write); do not hard-code the number. No NOT-NULL-without-default, no destructive ops.
- **API changes:** yes — `TaskSerializer` gains `type`/`parent_epic`/`sprint_rank`/`dor` + per-model
  scoring inputs (writable) and read-only `prioritization_score`/`criteria_met_count`/`criteria_total`/
  `dor_blockers`/epic-rollup; nested `AcceptanceCriterion` CRUD; `Project.prioritization_model`; `?type=`
  / `?parent_epic=` filters; one-shot auto-rank `@action` (synchronous 200). Regenerate OpenAPI **after
  merging origin/main**; add `ENUM_NAME_OVERRIDES` for `TaskType` / `PrioritizationModel` / `DorState`.
- **OSS or Enterprise:** **OSS**. No `trueppm_enterprise` import. Enterprise registers higher type
  tiers via the slot system and consumes cross-program rollups (enterprise #140/#141/#142) against the
  OSS read endpoints; OSS ships no cross-program/PMO aggregation.
- **Coordinate with:** ADR-0099 (its declared 0.3 foundation — keep `type`/`parent_epic`/structured-AC
  shapes compatible with `Task.target_release`), ADR-0078 (the `is_product_owner` facet — shared with
  ADR-0104's PO read tier), ADR-0069 (program `BacklogItem` stays the intake pool), ADR-0072 (no new
  ordinal), ADR-0101/0102 (no new sprint write-path; `sprint_rank` reorder writes the existing audit),
  ADR-0106 (the forecast reads `story_points`, not the score).
- **RBAC:** authoring requires `can_manage_backlog` (`role >= ADMIN OR is_product_owner`; interim
  ADMIN-only); `sprint_rank` reorder Member+; reads require membership; scoring/AC-trail absent from
  contributor/My-Work and PMO. All mutations fire `broadcast_board_event()` via `transaction.on_commit()`.
- **Testing (three-layer, same MR):** pytest — `type`/`parent_epic` CRUD + same-project/EPIC/cycle
  validation; epic rollup is a read annotation the scheduler never ingests (G1); `AcceptanceCriterion`
  ordering + met-count + **review-trail not on My-Work/no aggregation endpoint** (privacy); scoring
  per-model math + non-destructive model switch + auto-rank writes `priority_rank` + manual drag wins;
  `dor` Mark-ready gate (advisory) + no auto-flip; `sprint_rank` seeded-at-commit + Member-editable +
  never writes `priority_rank`; backlog exposes no `sprint` field (G2); `can_manage_backlog` gate.
  vitest — epic grouping, AC checklist, scoring columns + auto-rank, inline quick-add, sprint reorder.
  Playwright — PO golden path (epic → stories → tick criteria → score → auto-rank → manual override) +
  empty-backlog + rapid multi-add + sprint reorder.

### Durable Execution
1. **Broker-down:** every operation (type/parent_epic/criteria/scoring/dor/sprint_rank writes and the
   auto-rank reorder) is a **synchronous DB write** with `server_version` bump and
   `broadcast_board_event()` deferred via `transaction.on_commit()`. No async dispatch on any write
   path. The only downstream async (a CPM recompute if a synced CPM-input field changes) continues
   through `scheduling/services.py::enqueue_recalculate()` — unchanged.
2. **Drain task:** none new.
3. **Orphan window:** N/A — no new outbox.
4. **Service layer:** `product_backlog_services.py` — `auto_rank(project, by)` (compute + write
   `priority_rank` in one transaction), `mark_ready`/`send_to_refine`, `split_story`,
   `seed_sprint_rank(sprint)` at commit. No bare `.delay()`; CPM via `enqueue_recalculate()`.
5. **API response:** all endpoints synchronous 200/201; auto-rank returns the reordered backlog.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** auto-rank is idempotent (pure function of current scores); Mark-ready idempotent;
   criteria/type/link/sprint_rank writes use `server_version` optimistic concurrency; quick-add uses
   the HTTP Idempotency-Key (ADR-0170).
8. **Dead-letter / failure:** synchronous writes surface failures directly; the deferred board
   broadcast falls to existing best-effort handling and self-heals on the next board load.

## Decisions pending sign-off
1. **Interim PO gate** = `role >= ADMIN`-only until ADR-0078/#496 land the facet. Confirmed by VoC
   (no persona requires the facet in 0.3; all require the ADMIN-or-PO authoring boundary).
2. **Spike** is non-partitioning metadata in 0.3 (no time-box / velocity-exclusion); distinct
   done-semantics deferred.

## Tracking
Wave-1 api: #363 #364 #493 #922 (+ #365 sprint_rank). Wave-2 web: #494 #921 #731 (+ DA-11/13/14).
Supersedes the parallel `docs/adr-po-product-backlog-hierarchy-scoring` draft and the implementation
draft `0105-product-backlog-and-scoring.md` (removed).
