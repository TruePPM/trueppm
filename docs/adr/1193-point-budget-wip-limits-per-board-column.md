# ADR-1193: A Board Column Gets a Second WIP Axis — a Point Budget Beside its Card Count

## Status

Proposed (2026-09-18). Resolves #275. Extends ADR-0039 (board column config: color and
WIP limit) and the lane model introduced in #2967.

> **Implementation status (2026-09-18):** **no code ships with this ADR.** Verified
> 2026-09-18 against `main`: `packages/api/src/trueppm_api/apps/projects/models.py`
> (`BoardColumnConfig`, line 4812), `serializers.py` (`_validate_board_column`, line 8090),
> `services.py` (`annotate_wip_breach`, line 5461), `views.py` (`BoardColumnConfigView`,
> line 11718), and `packages/web/src/features/board/{wipBreach.ts,wip.ts,BoardSettingsPanel.tsx}`
> carry **only** the count axis. There is no `point_limit`, no `weight_limit`, and no
> point sum anywhere in the board tree. This ADR settles the design so the implementer
> meets the record instead of re-deriving it.

## Context

**P3M layer: Programs and Projects → OSS.** A board column config is a
`OneToOneField(Project)` row (`models.py:4812`) describing how one team renders and
paces one project's board. It aggregates nothing across projects and governs nothing at
the org level, so by CLAUDE.md's Two-Repo classification test — *"Would a PM or program
manager need this to run their program?"* — it is squarely OSS. The delivery lead tuning
flow on their own board is the whole user. There is no cross-program rollup, no policy,
no compliance evidence, and therefore nothing that belongs in `trueppm-enterprise`. This
ships in `trueppm-suite` under Apache 2.0.

### The gap

TruePPM has one WIP axis: **cards**. `BoardColumnConfig.columns[].wip_limit` is a
positive int or null, validated by `_require_positive_int_or_none`
(`serializers.py:8035`), annotated with a live count and a three-band verdict by
`annotate_wip_breach` (`services.py:5461`), rendered by `WipBadge` / `WipBreachChip` /
`WipTrendArrow` (`boardView/columnHeaderParts.tsx`), and checked client-side before a
drop by `wipBreachInfo` (`features/board/wipBreach.ts`, 32 lines, count-only).

A pure card count is a poor load signal. Five 1-point cleanups trip the same limit as
five 8-point features. TruePPM already holds the size datum the count axis ignores:
`Task.story_points` (`models.py:3341`, `PositiveSmallIntegerField(null=True, blank=True)`,
ADR-0037 Q1), available on every project since #1961 and already rendered as a pill on
the card face (`features/board/card/CardFullBody.tsx:71-80`). Visiban — the comparable
tool this issue benchmarks against — maintains a *separate* `Card.weight` field to do
this. We do not need one.

Weighted/size-based WIP (CONWIP) is an established hybrid Scrum-Kanban practice and is
**not natively supported by mainstream tools**; unresolved Atlassian Community requests
ask for exactly this on Jira boards. That is the differentiator here: we can ship it
without adding a field, because `story_points` already exists.

### Forces

1. **`weight` is a taken word in this codebase, and it already means something precise.**
   ADR-0108 §1 defines a per-leaf `weight` as a *delivery-mode-aware rollup coefficient* —
   `waterfall → duration`, `scrum → COALESCE(story_points, duration)`, `kanban → 1`,
   `milestone → 0` — implemented as raw SQL in the `percent_complete_rollup` annotation
   (`views.py:4520-4550`). #1961 says so in as many words: *"'weight' is **not** a stored
   field — it is a derived rollup coefficient."* A second, different `weight` on the same
   `Task`, read by a different subsystem, with a different null rule, is a naming
   collision that will cost someone a debugging session.

2. **The house name for a points budget already exists.** `Sprint.capacity_points`
   (`models.py:5212`, ADR-0073) is *"no points-based planning target set"* when null —
   the exact sentinel semantics this feature needs. `Sprint.wip_limit` (`models.py:5221`,
   #546) sits immediately beside it and is explicitly documented as *"NOT a flow engine —
   per-column WIP limits (`BoardColumnConfig.wip_limit`) … are separate."*

3. **Enforcement is advisory by standing decision, in three places.** ADR-0036 (hybrid PM
   philosophy): WIP limits are *"warnings by default, not hard blocks (can be hardened
   per project)."* ADR-0039: *"The API does **not** reject `PATCH /tasks/{id}/` mutations
   that would push a column over its limit."* `annotate_wip_breach`'s own docstring:
   *"The verdict is **passive** … the API still does not reject breaching mutations
   (ADR-0039 / ADR-0130 D2)."* Nothing server-side enforces WIP today; grep confirms zero
   WIP references on any task-write path.

4. **Who may set the limit and who may move the number it measures are different roles.**
   `BoardColumnConfigView.get_permissions` (`views.py:11740`) gates PUT at
   `IsProjectScheduler` (`Role.SCHEDULER`, ordinal 200) and GET at `IsProjectMember`
   (VIEWER+). But `story_points` is an ordinary `Task` field written through
   `TaskViewSet.partial_update` at MEMBER+. **A Member can change the weight; only a
   Scheduler can change the budget.** That asymmetry is harmless for an advisory signal
   and fatal for a hard block — see Decision 1.

5. **An aggregate of story points is never a T-shirt label.** ADR-0510/ADR-0418, encoded
   in `packages/web/src/lib/storyPoints.ts:13-15`: *"Aggregates (sprint velocity, Epic
   rollup totals, burndown axes) render the raw integer + ' pts' on EVERY scale — you
   cannot average T-shirt labels."* `EstimationScale` is `fibonacci | linear | tshirt`
   and is a display projection over a stored integer, never a second stored value.

6. **Three different things in this tree are called a "lane" or a "swimlane."** They must
   not be conflated, and #331's body already conflates two of them:
   - **Row swimlanes** — `features/board/grouping.ts`, `groupBy` ∈ `phase | assignee |
     epic`. Client-only rendering grouping (#324, #364). *Team grouping never shipped* —
     `grouping.ts:15-18` says it needs a `task.team` API field that does not exist.
   - **Column lanes** — `columns[].lanes = [{key, label, wip_limit}]` (#2967), persisted,
     ≤ `MAX_LANES_PER_COLUMN` (6), keys unique project-wide, stored on `Task.board_lane`.
     These already carry their own count-based `wip_limit`.
   - `Task.board_lane` — the key naming which *column lane* a card sits in.

7. **The board-config wire contract is free-form in the OpenAPI schema.** Both
   `BoardColumnConfigSerializer.columns` (`serializers.py:8177`) and
   `BoardColumnConfigResponseSerializer.columns` (`views.py:908`) are
   `ListField(child=DictField())`. The column object is therefore declared as
   `{type: object}` — one of the 46 free-form operations #3652 names, where the e2e schema
   guard checks nothing. Adding keys to a column produces **no OpenAPI diff at all**.

## Decision

Add **one nullable integer key per column**, a *point budget*, beside the existing card
count limit. Six decisions follow.

### D1 — Enforcement stays advisory: the same confirm-to-proceed dialog, never a 409

The point axis inherits the count axis's posture exactly. The server annotates a passive
verdict; the client warns before a drop and lets the user proceed. We **reject** adopting
Visiban's heavier machinery (`enforce_wip_limits` / `enforce_wip_hard` /
`enforce_weight_limits` board toggles, a server-side 409 on `move_card()`, and a
board-admin `force=true` override) **in this ADR**, on four grounds:

1. It would make the *derived, optional* signal harder than the *primary* one. A card
   count is a fact about the board; a point sum is an estimate about the cards, and on a
   project that never estimates it degenerates (D3). Blocking on the weaker number while
   the stronger one only warns is backwards.
2. Force 4: a hard block keyed on `story_points` is **self-defeating under our own RBAC**.
   `story_points` is MEMBER+-writable. Any member blocked by a point budget can edit their
   own card's estimate down and walk through it — in one PATCH, with no audit consequence.
   A gate a blockee can open is not a gate.
3. Hardening is a decision about **both** axes and belongs to neither. ADR-0036 already
   reserves *"can be hardened per project"*; the right shape is a single project-level
   enforcement mode governing count and points together, not a toggle smuggled in beside
   the second axis.
4. ADR-0039 already scoped a blocking mode as *"additive / out of v1 scope."* Nothing has
   changed that judgement.

**Consequence for RBAC: no new decision is needed.** Reads stay `IsProjectMember`
(VIEWER+); writes stay `IsProjectScheduler` (SCHEDULER+). Because nothing is blocked
server-side, there is no override role to define, no `force` parameter to authorize, and
no new permission class. If a future ADR hardens enforcement, *that* ADR owns the
override role — and it must resolve force 4 first.

Hardening is deferred to a new issue (see **On Acceptance**), not to #331.

### D2 — The key is `point_limit`, and it lives in the same `columns[]` JSON blob

**Name.** `point_limit`, not `weight_limit`. `weight` is ADR-0108's rollup coefficient
(force 1) and #1961 explicitly records that the user-facing estimate is story points, not
weight. `point_limit` pairs cleanly with the count axis at every surface — *"at most 5
cards, at most 20 points"* — and matches `Sprint.capacity_points`'s noun-last house style
(force 2). The feature keeps its issue-title framing ("weight-based WIP"); the *field*
does not borrow a word that already has a different referent one module away.

**Location.** A sibling key inside the existing `columns[]` JSON, not a new structure:

```jsonc
{
  "status":             "IN_PROGRESS",   // canonical TaskStatus, immutable
  "label":              "In Progress",   // ≤ 32 chars
  "visible":            true,
  "color":              "#3B82F6",       // "#RRGGBB" or null
  "wip_limit":          5,               // positive int or null — CARD count ceiling
  "point_limit":        null,            // positive int or null — STORY-POINT ceiling  ← new
  "age_threshold_days": null,
  "lanes":              []               // [{key, label, wip_limit}] (#2967)
}
```

Reasons, in order of weight:

- `columns` is a `JSONField(default=list)` (`models.py:4846`) — **no migration**, and
  `makemigrations --check` stays green because model state does not move.
- The PUT is a **full-array replace** under `select_for_update()` (`views.py:11791`). A
  second structure would need its own concurrency story against the same row, and the
  `notify_board_config_change` baseline diff (ADR-1174) reads exactly one `old_columns`
  list. Two structures means two baselines and two race windows.
- ADR-1050 (`Proposed`) will carry `columns[]` forward to configurable statuses. A sibling
  structure would have to be ported twice.
- `_require_positive_int_or_none` (`serializers.py:8035`) is reusable **verbatim**,
  including its `bool`-is-an-`int` guard.
- The seed round-trip already enumerates per-column keys in exactly two places
  (`seed/exporter.py:873`, `seed/importer.py:1934`), so the round-trip costs one literal
  in each.

### D3 — A card's weight is `story_points ?? 1` — an unestimated card is never free

The sum over a column is `Σ COALESCE(story_points, 1)`, matching Visiban's `Card.weight`
default of 1.

The alternative — `?? 0` — is rejected because it makes the budget *unreachable* on the
exact board that most needs it: a column holding thirty unestimated cards would read
`0/20 pts`, a limit that can never trip, presented as if it were live. A limit that
cannot fire is worse than no limit, because the reader believes it is protected.

State the consequence honestly rather than hiding it: **on a project that estimates
nothing, the point axis degenerates into the count axis** (every card weighs 1, so
`point_limit` behaves exactly like a second `wip_limit`). That is self-explanatory at the
surface and costs nothing. It is also the same *documented-approximation* posture
ADR-0108 took for mixed-mode subtrees, whose alternative D — converting story points to
days through a velocity factor — was rejected there for coupling a read path to
team-private, sprint-scoped data. **We do not resurrect that conversion here.** A column
budget is denominated in story points, full stop. A board mixing `delivery_mode` values
sums points across modes in the cards' native unit, exactly as ADR-0108 §1 does, and the
settings help text says so.

`remaining_points` (`models.py:3347`) is explicitly **not** the basis. WIP measures what is
*in flight*, not what is *left*; a nearly-finished 8-pointer occupies the column just as
much as a fresh one. Using remaining work would let progress silently delete load — the
same defect class already recorded against the utilization surface.

### D4 — Server owns the standing verdict; client owns the prospective one

This mirrors the existing split exactly and is consistent with ADR-0599's API-first
boundary, where a client-side *preview* is explicitly carved out and the server always has
the last word.

**Server** — `annotate_wip_breach()` (`services.py:5461`) gains a point sum and a second
verdict, computed in the **same single grouped query** it already runs (the perf-check
constraint its docstring names):

```python
raw = (
    Task.objects.filter(project_id=project_id, is_deleted=False)
    .values_list("status", "board_lane")
    .annotate(
        n=Count("id"),
        pts=Sum(Coalesce("story_points", Value(1), output_field=IntegerField())),
    )
    .values_list("status", "board_lane", "n", "pts")
)
```

Each column entry in the GET response gains `current_points: int` and
`point_breach: "ok" | "at" | "over" | null` from a new `_point_breach()` helper that is
`_wip_breach()`'s three-band logic applied to the point pair. `ON_HOLD` folds into
`BACKLOG` through the existing `_fold_status()`; the unconfigured-lane orphan still lands
on the column's first lane through the existing `_annotate_lane_breach()` resolution.

**Client** — a `pointBreachInfo()` beside `wipBreachInfo()` in
`features/board/wipBreach.ts`, computing the *prospective* breach for a pending drop
(`current + (card.storyPoints ?? 1) > limit`). This must stay client-side: it answers a
question about a move that has not happened, at drag speed, and the server cannot be
asked mid-drag. Banding reuses `wip.ts`'s `wipState()` — do **not** write a fourth
three-band implementation; the module's own docstring already forbids it (*"Reuse
`wipState()` … so the bands never drift between surfaces"*).

The count and point breaches are computed independently and either alone triggers the
dialog. `WipLimitConfirmDialog` is extended to name **which** ceiling was hit, and to name
both when both are; it is never shown twice for one drop.

### D5 — Per-lane and per-swimlane point limits are explicitly deferred

`point_limit` ships on **columns only**. Neither `columns[].lanes[]` (#2967 column lanes)
nor the `groupBy` row swimlanes of #324/#331 get one in this ADR.

- **Column lanes (#2967).** Additive and cheap later — same helper, same annotate loop.
  Deferred on UI density, not architecture: up to 6 lanes × 5 columns is 30 numeric inputs
  in `BoardSettingsPanel` today, and doubling that before anyone has asked for a column
  budget is speculative. The data shape makes the deferral free: a `lanes[].point_limit`
  added later is another `_require_positive_int_or_none` call and another key in
  `_validate_board_lanes`'s normalized dict.
- **Row swimlanes (#331, milestone 0.5, `release::stretch`).** Deferred **to #331**, which
  owns that axis. Two corrections must be written onto #331 before anyone implements it,
  because its body predates this ADR and carries two false premises verified against
  `main` on 2026-09-18:
  1. *"respect existing `Board.enforce_wip_hard` flag"* — **there is no such flag, and no
     `Board` model.** `enforce_wip_hard`, `enforce_wip_limits` and `enforce_weight` match
     nothing anywhere in `packages/` or `docs/`. Board configuration is
     `BoardColumnConfig` on `Project`. D1 above is the standing answer: enforcement is
     advisory, and hardening is a separate, not-yet-filed decision.
  2. *"when grouping by assignee or team"* — **team grouping never shipped.** `groupBy` is
     `phase | assignee | epic` (`grouping.ts:5-18`); team is blocked on a `task.team` API
     field that does not exist.

  #331 must also state which lane concept it means. Its proposed key
  `(column_id, swimlane_grouping, swimlane_key)` is the *row swimlane*, which is a
  client-side grouping with no persisted identity — a materially harder problem than
  #2967's column lanes, and the reason it should not be bundled here.

### D6 — Both limits default to null; the settings panel teaches instead of seeding

`point_limit` defaults to `null` on **all five** columns in `_DEFAULT_COLUMNS`
(`serializers.py:7969`) — including `IN_PROGRESS` and `REVIEW`, which carry seeded *count*
defaults of 5 and 3.

This asymmetry is deliberate and must not be "fixed" for consistency. A seeded count of 5
is defensible as a generic stand-in for the canonical *2-3 items per person* heuristic on
a 2-3 person team. A seeded point number is not defensible at all: it is meaningless
without knowing the project's `EstimationScale` (a `13` is mid-range on Fibonacci and
off-scale on T-shirt) and its velocity. Canonical Kanban guidance is also explicit that
**not every column needs a limit** — Done typically does not — which reinforces null as
the right resting state and per-column tuning as the right workflow.

The research goes into **help text**, not into defaults. In `BoardSettingsPanel`'s column
row:

- Card limit: *"A common starting point is team size × 1.5, or 2-3 items per person. Tune
  it from what the column actually sustains."*
- Point limit: *"Start from the points this stage actually completed in a recent week or
  sprint, then tune. Leave it off for stages you do not want to pace — Done usually."*
- One further sentence, shown once per panel, not once per column: *"Unsized cards count
  as 1 point."*

Three web invariants bind this copy and are non-optional:
- **Rule 400** — a `FieldRow`'s `help` popover is editor-only. A read-only Member sees
  `readOnly={!canConfigureBoard}` (`boardView/BoardCardOverlays.tsx:101`) and still needs
  to know what the number means, so these facts go in `hint`, not `help`.
- **Rule 363** — at most one teaching surface renders per column. The per-column sentences
  above are the one; the "unsized cards count as 1" line is panel-level.
- **Rule 293** — 12px running prose under `features/settings/` carries a
  `max-w-[440px]`–`max-w-[480px]` measure cap.

**Display unit.** The column header and every aggregate render the raw integer + `" pts"`
on **every** `EstimationScale`, per force 5 — never `formatStoryPoints`, which is
single-item only and would print a T-shirt size for a sum. The settings input is a plain
integer field identical to the `wip_limit` input, never a T-shirt picker.

**Header density is a real constraint and is handed to `ux-design`, not decided here.**
The column header already carries, left to right: status dot, label, board-wide count,
`WipTrendArrow`, `WipBreachChip`, `WipBadge`, collapse button, resize handle. A point
badge is a ninth element in a `flex-nowrap` strip. Rule 290 (a growable fixed-height
chrome strip gets an explicit overflow rule — it scrolls, it never pushes its neighbours),
rule 343 (a measured concession ladder), and rule 120 (colour is paired with a non-colour
signal) all apply, and the known failure mode is a `min-w-0` on a crowded `flex-nowrap`
toolbar collapsing a control to zero width. The likely shape is a combined
`5 · 18 pts` readout rather than a second chip, but `ux-design` decides, with a measured
narrow-viewport pass.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A: `point_limit` sibling key in `columns[]`, advisory, `story_points ?? 1` (chosen)** | No migration; reuses `_require_positive_int_or_none`, `annotate_wip_breach`'s single grouped query, `wipState`, and the existing confirm dialog; one PUT baseline for ADR-1174's diff; ADR-1050-forward; consistent with three standing advisory decisions | Adds a ninth element to a crowded column header; degenerates to the count axis on unestimated projects; the wire contract change is invisible to every schema gate (force 7) |
| B: new `Task.weight` field (the issue's *original*, now-superseded ask) | Independent of agile chrome; no null case | Duplicates `story_points` outright; needs a migration and a backfill; two size fields on one row is precisely what #1961 closed; user must maintain both |
| C: name it `weight_limit` (the candidate design's proposal) | Matches Visiban and the issue title verbatim | Collides head-on with ADR-0108's delivery-mode `weight` coefficient and with #1961's explicit *"weight is not a stored field"*; two different `weight`s on one `Task`, read by two subsystems, with different null rules |
| D: separate `BoardColumnPointBudget` model/table | Queryable, indexable, auditable per-column | A migration for a nullable int; a second row to lock alongside `BoardColumnConfig`'s `select_for_update`; two baselines for the ADR-1174 notice diff; must be ported again under ADR-1050 — all cost, no reader that needs it |
| E: hard block, server-side 409 + board-admin `force=true` (Visiban's model) | Symmetric with Visiban; a limit that actually holds | Defeated by our own RBAC — `story_points` is MEMBER+-writable, so a blockee edits their estimate down and walks through (force 4); contradicts ADR-0036, ADR-0039 and ADR-0130 D2; hardens the derived axis while the primary one only warns |
| F: `story_points ?? 0` for unestimated cards | Arithmetically pure; no invented number | Makes the budget unreachable on unestimated boards — `0/20 pts` forever — presenting a dead limit as a live one; strictly worse than no limit |
| G: `remaining_points` as the basis | Tracks live burndown; matches the sprint panel | WIP is what is in flight, not what is left; progress would silently delete load, the exact defect already recorded against the utilization surface |
| H: normalize points↔days so mixed-mode columns sum one unit | Dimensionally pure across `delivery_mode` | Needs a velocity conversion factor that is team-private and sprint-scoped; ADR-0108 evaluated and rejected this as its alternative D for coupling a read path to velocity |
| I: ship per-column **and** per-lane (#2967) point limits together | One pass over `_validate_board_lanes` and `_annotate_lane_breach` | Doubles `BoardSettingsPanel`'s numeric inputs to ~60 before anyone has asked; additive later at near-zero cost (D5) |

## Consequences

**Easier**

- A delivery lead can pace a column by *load* instead of by *card count* — the signal a
  count-only limit structurally cannot give — with no new field to maintain and no data
  entry beyond estimates the team may already keep.
- The count axis is untouched. Every existing board, saved view, seed file and spec keeps
  working with `point_limit` absent and read as null.
- No migration, so `api:migration-check`, `api:migration-constraint-safety` and the
  0.5 squash are all unaffected.
- The server-side verdict extends a function that already runs one grouped query, so the
  perf profile of `GET /projects/{pk}/board-config/` does not change shape.
- Positions TruePPM against a gap mainstream tools leave open (multiple unresolved Jira
  community requests for exactly this).

**Harder**

- The column header gains a ninth element in a `flex-nowrap` strip (D6) — a measured
  narrow-viewport pass is now mandatory, not optional.
- Two ceilings mean two ways to breach and a dialog that must say *which*, without firing
  twice for one drop (D4).
- `wipBreach.ts`, `wip.ts`, `columnHeaderParts.tsx`, `BoardColumnHeaderRow.tsx`,
  `ColumnStub` and `BoardSettingsPanel` each grow a parallel reading. Every one is a place
  the two axes can drift.
- The seed round-trip gains a key in two enumerations that are easy to miss
  (`seed/exporter.py:873`, `seed/importer.py:1934`) and fail silently — a seed exports a
  board whose point budgets vanish, on a green pipeline.

**Risks**

- 🔴 **The wire-contract change is invisible to every gate we own.** Both board-config
  serializers are `ListField(child=DictField())`, so `docs/api/openapi.json` declares the
  column object as free-form `{type: object}` — one of #3652's 46 unguarded operations.
  Regenerating the schema will produce an **empty diff**, `api:schema-drift` will pass,
  and the e2e schema guard will validate nothing about the new keys. A mock that returns
  `point_limit: "5"` or omits `current_points` fails no spec by name. **Mitigation:** the
  pytest layer is the only real guard — `test_board_config.py` and
  `test_serializer_validation_units.py` must cover `point_limit` type/range/null and the
  unknown-key drop explicitly, and Playwright fixtures must be updated by hand. Declaring
  a nested column serializer would close this properly but also tightens the PUT contract
  for every existing client; that is a separate change, tracked under #3652.
- 🟡 **PUT is a full replace and unknown keys are dropped silently**
  (`serializers.py:8173`). A client that round-trips GET → PUT is safe. A client that
  constructs `columns[]` from its own model and omits `point_limit` **nulls every point
  budget on the board**, with a 200 and no warning. This hazard already exists for
  `color`, `age_threshold_days` and `lanes`; the new key widens it. `BoardSettingsPanel`
  round-trips and is therefore safe.
- 🟡 **The two axes can disagree about a card.** `current_count` counts rows;
  `current_points` sums `COALESCE(story_points, 1)` over the same rows. They are consistent
  by construction today, but any future filter applied to one and not the other (a
  `sprint_pending` exclusion, a `delivery_mode` filter) makes the header state two facts
  about different denominators. Compute both in the one query, from the one row set —
  which is what D4 specifies — and pin that with a test.
- 🟡 **A Member can move the number a Scheduler budgeted against** (force 4). Accepted:
  the signal is advisory, so the worst case is a misleading badge, not a bypassed control.
  This becomes blocking if D1 is ever reversed.
- 🟢 A project that estimates nothing sees a second axis that behaves identically to the
  first. Self-explanatory, documented in the help text, and the reason `?? 1` beats `?? 0`.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** api, web, website (docs). Not scheduler, not wasm-scheduler, not
  mobile, not helm.
- **Migration required:** **no.** `BoardColumnConfig.columns` is
  `models.JSONField(default=list)` (`models.py:4846`); the change is validation and
  read-annotation only, and model state does not move, so `makemigrations --check` stays
  green.
- **API changes:** yes — additive, and see the 🔴 risk above.
  - `PUT /api/v1/projects/{pk}/board-config/` accepts `point_limit` per column: positive
    int or `null`, via `_require_positive_int_or_none(point_limit, "point_limit")` in
    `_validate_board_column` (`serializers.py:8090`), added to the normalized return dict.
    Bool rejection comes free with the helper. Omitted → `null`.
  - `GET /api/v1/projects/{pk}/board-config/` returns two new per-column computed keys,
    `current_points` (int) and `point_breach` (`"ok" | "at" | "over" | null`), alongside
    today's `current_count` and `breach`. Lane entries are unchanged this release (D5).
  - RBAC unchanged: GET `IsProjectMember` + `IsProjectNotArchived`; PUT
    `IsProjectScheduler` + `IsProjectNotArchived` (`views.py:11740`).
  - No new endpoint, no new `@action`, no new WebSocket event type. A point-budget edit
    rides the existing `board_config_updated` broadcast (`views.py:11803`).
  - **`docs/api/openapi.json`:** run `scripts/export-openapi.sh` after merging
    `origin/main` (per CLAUDE.md's sequence — the pre-commit `openapi-schema` hook does
    this automatically on any `packages/api/src/` change) and **expect an empty diff**, for
    the free-form reason in force 7. An empty diff here is the correct outcome, not a
    missed regenerate. `docs/api/` prose still needs the new keys documented — that is the
    `api-docs` gate's job.
- **OSS or Enterprise:** **OSS** (`trueppm/trueppm-suite`, Apache 2.0). One project, one
  team, one board. No cross-program aggregation, no org policy, no compliance evidence.
  `make enterprise-boundary-check` is unaffected — nothing here imports or extends
  `trueppm_enterprise`.

**Files this touches** (verified to exist on `main`, 2026-09-18):

| Layer | File | Change |
|---|---|---|
| model docstring | `packages/api/src/trueppm_api/apps/projects/models.py:4826` | document `point_limit` in the `columns` JSON schema block |
| validation | `packages/api/src/trueppm_api/apps/projects/serializers.py:8090` | `_validate_board_column` reads + normalizes `point_limit` |
| defaults | `packages/api/src/trueppm_api/apps/projects/serializers.py:7969` | `point_limit: None` on all five `_DEFAULT_COLUMNS` entries |
| docstring | `packages/api/src/trueppm_api/apps/projects/serializers.py:8155` | `BoardColumnConfigSerializer`'s optional-metadata list |
| annotation | `packages/api/src/trueppm_api/apps/projects/services.py:5461` | `annotate_wip_breach` sums points in the same query; new `_point_breach()` beside `_wip_breach()` |
| seed export | `packages/api/src/trueppm_api/apps/projects/seed/exporter.py:873` | add to the `("color", "wip_limit", "age_threshold_days")` key tuple |
| seed import | `packages/api/src/trueppm_api/apps/projects/seed/importer.py:1934` | add to the per-column dict |
| seed schema | `packages/api/src/trueppm_api/apps/projects/schemas/seed_v2.json` | declare the key |
| drop guard | `packages/web/src/features/board/wipBreach.ts` | `pointBreachInfo()` beside `wipBreachInfo()` |
| dialog | `packages/web/src/features/board/WipLimitConfirmDialog.tsx` | name which ceiling was hit; never fire twice for one drop |
| header | `packages/web/src/features/board/boardView/columnHeaderParts.tsx` | point readout + `ColumnStub` narrow form |
| header row | `packages/web/src/features/board/boardView/BoardColumnHeaderRow.tsx` | thread the point pair; extend `headerAriaLabel` |
| settings | `packages/web/src/features/board/BoardSettingsPanel.tsx` | point input + `hint` copy (rules 400 / 363 / 293) |
| types | `packages/web/src/types/index.ts` | `pointLimit` / `currentPoints` / `pointBreach` on the board-column type (**not** `api/types.ts` — the domain `Task` type lives here) |
| docs | `packages/website/src/content/docs/features/board.md` | column-header and settings sections; `documentedFor: "0.4"` today — a 0.5 feature needs `documentedFor: "0.5"` + a `:::note[Ships in 0.5]` callout, or the declaration-coverage ratchet reds `docs:version-accuracy` |

**Tests required in the same MR** (all three layers; CLAUDE.md admits no exception):

- **pytest** — extend `packages/api/tests/apps/projects/test_board_config.py`,
  `test_serializer_validation_units.py`, `test_services_units.py`: `point_limit` accepts a
  positive int and `null`; rejects `0`, negatives, `True`, floats and strings; is dropped
  when unknown-shaped; `current_points` / `point_breach` are correct across the three
  bands; a `story_points=None` card contributes exactly 1; `ON_HOLD` folds into `BACKLOG`
  in the point sum too; and — pinning the 🟡 above — the count and point sums are taken
  over the **same** row set. Assert the query count does not increase.
  *Do not* extend `test_sprint_views.py`: its 35 `wip_limit` hits are `Sprint.wip_limit`
  (#546), a different field.
- **vitest** — `wipBreach.test.ts` (new `pointBreachInfo` cases, including a card with
  `storyPoints: null` weighing 1), `wip.test.ts` (banding reuse, no fourth
  implementation), `BoardSettingsPanel.test.tsx` (input, clear, `readOnly`, hint copy),
  `WipLimitConfirmDialog.test.tsx` (each ceiling alone, and both at once, exactly once).
- **Playwright** — extend `packages/web/e2e/wave10-wip-overload.spec.ts` with a
  point-breach golden path plus one empty/error state, and check
  `project-workflow-settings.spec.ts` for the settings surface. **Grep
  `packages/web/e2e/` for the header strings before committing** — `WipBadge`'s
  `{count}/{limit} — over WIP limit`, the breach-chip `data-testid="wip-breach-chip"`, and
  the stub's `6/5` form are all asserted as literals somewhere, and `web:e2e` is the most
  common CI failure precisely because those live in a separate tree. Run the affected spec
  locally before pushing.

**Gate chain this feature takes** (CLAUDE.md fast-path: *new user-visible feature, full
stack* — this is **not** the settings-sub-page row; it adds a new interaction pattern to
the board, not a form bound to an existing serializer):

`voice-of-customer` → `architect` (this ADR) → **`ai-review`** → `ux-design` → implement →
batched parallel pre-MR cluster (`regression-check`, `security-review`, `rbac-check`,
`perf-check`, `broadcast-check`; **`migration-check` is `n/a`** — no `models.py` change) →
`ux-review` → `test-scaffold` → `changelog` → `/mr`. Plus `docs-writer` and `api-docs`.

- **`ai-review` is in scope and must run before implementation.** This adds a
  server-computed value (`current_points`, `point_breach`) that an MCP client reading
  `GET /board-config/` will consume — `BoardColumnConfigView` is `McpReadableViewMixin`
  with `mcp_scope = McpScope.PATH`.
- **`threat-model` is `n/a`** — no new authentication path, no changed authorization
  boundary (D1), no external data ingress, no sync-protocol change, no new OSS↔Enterprise
  extension point.
- **`enterprise-check` is `n/a`** — the classification is not unclear; see the Context
  section's P3M ruling.
- **`voice-of-customer` was NOT run before this ADR.** The issue body carries VoC material
  sourced from the 2026-05-04 board panel, but that panel evaluated #324/#331 (swimlane
  grouping and per-lane WIP), **not** a point budget. Flagged to the user rather than
  quietly skipped — see **Open questions**.

### Durable Execution

1. **Broker-down behaviour:** **N/A — this feature dispatches nothing.** Verified, not
   assumed. `BoardColumnConfigView.put` (`views.py:11770-11818`) is fully synchronous: a
   `select_for_update()` read, an `update_or_create`, a `transaction.on_commit`
   WebSocket broadcast, and a `notify_board_config_change()` call. The broadcast is
   fire-and-forget presence chrome — a lost frame costs a stale badge until the next poll,
   which is the existing accepted behaviour for every board event. The notice path is
   already durable (ADR-1174's `ConfigNoticeRequest` outbox) and a `point_limit` edit
   **produces no notice at all**: `diff_board_config` returns early unless a lane was
   removed or a column hidden (`config_notice.py:689-691`). Separately, the card-move path
   (`TaskViewSet.partial_update` → `_defer_task_update_broadcasts`, `views.py:5396`)
   already enqueues `enqueue_recalculate` under `transaction.on_commit` because `status`
   is not in `_NON_SCHEDULE_TASK_FIELDS`; this feature adds nothing to that path and does
   not change what it enqueues.
2. **Drain task:** **reuses existing, unchanged.** ADR-1174's
   `projects.drain_config_notice_requests` continues to cover config notices. No new
   category of async work is introduced, so by the checklist's own rule no new Beat drain
   is warranted.
3. **Orphan window:** **N/A** — no new outbox rows are written, so there is nothing for a
   drain to race with an in-flight commit over.
4. **Service layer:** extends `annotate_wip_breach()` in
   `packages/api/src/trueppm_api/apps/projects/services.py:5461`, plus a new private
   `_point_breach()` beside `_wip_breach()` (`services.py:5520`). **No new dispatch
   function is needed** because there is no new dispatch. The CPM path continues to go
   through `scheduling/services.py::enqueue_recalculate()` via the existing
   `_enqueue_recalculate` alias — never `recalculate_schedule.delay()` directly.
5. **API response on best-effort dispatch:** **N/A** — both endpoints answer
   synchronously with `200`. `GET` returns the annotated column list; `PUT` returns the
   validated payload. Nothing here returns `202 {"queued": true}`.
6. **Outbox cleanup:** **N/A** — no rows added. ADR-1174's
   `projects.purge_old_config_notice_requests` retention is unaffected.
7. **Idempotency:** no new Celery task exists to be idempotent. The endpoints themselves
   are: `PUT` is a whole-array replace performed under `select_for_update()` on the
   `BoardColumnConfig` row, so replaying the same body converges to the same state, and
   the view already carries `IdempotencyMixin`. `GET` is a pure read. The only pre-existing
   async on the adjacent write path, `enqueue_recalculate`, is idempotent by its own
   contract (ADR-0027 incremental recompute) and this change does not touch it.
8. **Dead-letter / failure handling:** **N/A** — no task, so no `max_retries`, no backoff,
   no DLQ. The two failure modes that do exist are handled by existing behaviour: a
   dropped WebSocket frame leaves a stale badge until the client's next read (accepted for
   every board event), and a `PUT` that loses the `select_for_update` race is
   last-writer-wins on the config row (accepted since ADR-0039; the ADR-1174 notice path
   is what cares about the baseline, and it is not triggered by a limit edit).

### On Acceptance

<!-- Complete when this ADR's Status moves to Accepted — not before. -->
- [ ] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1193`
- [ ] Any issue carrying pre-ADR scope rewritten — **title and body** — led by a dated
      correction note. Record the count, including zero.
- [ ] **#275** rewritten: its "Candidate design" section proposes `weight_limit`; D2 renames
      it to `point_limit`. Lead with a dated correction note; do not edit silently.
- [ ] **#331** corrected per D5 — the non-existent `Board.enforce_wip_hard` flag, and the
      never-shipped team grouping. #331 keeps its `release::stretch` label and its
      milestone; only its false premises change.
- [ ] **New issue filed** for the deferred enforcement-hardening decision (a single
      project-level mode governing *both* axes, per D1 and ADR-0036's "can be hardened per
      project"). It must resolve force 4 — that `story_points` is MEMBER+-writable while
      the budget is SCHEDULER+-writable — before proposing any block. Ask the user which
      `release::` label applies; do not infer one.
- [ ] Optional follow-up noted against **#3652**: declaring a nested board-column
      serializer would bring these keys under the e2e schema guard. Not required by this
      ADR.

## Open questions

- 🔴 **`voice-of-customer` has not been run for this feature.** CLAUDE.md requires it
  before `architect` on any new user-visible feature. The VoC material quoted in #275
  belongs to the 2026-05-04 board panel, which scored swimlane grouping (#324) and
  per-lane WIP (#331) — **not** a point budget, and not the `?? 1` degenerate case on
  unestimated projects, which is the assumption a panel would most usefully attack. Either
  run it against D3/D6 before implementation, or record the skip explicitly in the MR's
  `## Gates` section as `skipped`. Do not let this ADR's existence stand in for it.
- 🟡 **Confirm the `point_limit` rename** (D2). Renaming is one literal today and a
  migration of every seed file, spec and doc page later. The alternative — `weight_limit`,
  as #275 proposes — collides with ADR-0108's rollup coefficient.
- 🟡 **`release::` label for the deferred hardening issue** is the user's call, per
  CLAUDE.md's milestone-commitment rule. Do not infer it.
