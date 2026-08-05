# ADR-0790: Subtree Classification Cascade — Two Orthogonal Axes, One Call

## Status

Accepted — 2026-08-04, implemented by #2735 in the same MR (verified: the route, the
`ClassificationSpec` service contract, the axis-specific milestone gate, and the
`overrides_kept: null` response clause all ship in
`apps/projects/task_classification.py`, covered by
`tests/apps/projects/test_task_classification_cascade.py`). For 0.4, child of epic
#2741 (Project Designer — declaring the hybrid split).

Depends on ADR-0036 (which introduced `GovernanceClass` and `DeliveryMode`) and
ADR-0773 (the plan-authoring role band this endpoint sits behind). Sibling of
ADR-0772, which governs the *other* task batch write path.

## Context

TruePPM's differentiator is that hybrid is **one plan**: agile and waterfall work live
on the same task tree, and two per-task fields govern how each subtree rolls up.

| Field | Values | Means | Inherit bit |
|---|---|---|---|
| `Task.governance_class` | `gated` · `flow` · `hybrid` | which overlay governs the subtree | **yes** — `Task.parent_governance_inherited` |
| `Task.delivery_mode` | `waterfall` · `scrum` · `kanban` · `milestone` | how work is executed, estimated, rolled up | no |

Both have existed since ADR-0036 (#407). Neither has ever been settable across more
than one row at a time. Declaring a hybrid split today means PATCHing every row in a
phase by hand, which is why the promise of "no reconciliation between two tools" is
kept in the database and broken in the workflow.

Four forces shape the design.

**The two axes are not one choice.** `scrum` and `kanban` are not interchangeable —
the rollup engine reads point burndown for one and item throughput for the other
(`services.py:4955`), and the agile-aware Monte Carlo samples the team velocity
distribution only for `SCRUM` (`scheduling/services.py:516`). Collapsing governance
and delivery into a single "Gated / Sprint-driven" toggle mis-tags every Kanban team.

**The milestone invariant is coupled and load-bearing.** `is_milestone = True ⟺
delivery_mode = 'milestone' ⟺ duration = 0` is normalized on every write path by
`TaskSerializer._reconcile_milestone_signals` (`serializers.py:3580`). A cascade that
wrote `delivery_mode = 'scrum'` across a phase would silently *un-milestone* every gate
inside it — dissolving the structure the plan depends on, and taking the rollup SQL
(which keys on `delivery_mode`) with it. The existing paste-many path already treats
this as a gate rather than a failure: `task_bulk.CODE_MILESTONE_GATE`.

**`parent_governance_inherited` has no writer.** The field ships with `default=True`,
is declared read-only on `TaskSerializer` (`serializers.py:3289`), and — per that
field's own comment — "nothing in the API reads it". So the inherit bit is presently
inert: every row in every project reports `True`, and no override can exist because
nothing can create one. Whatever writes it first defines what it means.

**A subtree write is not a row list.** ADR-0772 §2 makes `index` — the caller's
zero-based position in `operations` — the correlation handle for
`POST /projects/{pk}/tasks/bulk/`, precisely because a row rejected for an unparseable
id has no id to echo back. A cascade names *one* thing (a subtree root) and the server
resolves the set. Cascade-touched rows have no caller-supplied index, so they cannot be
correlated in that contract.

**P3M layer**: Programs and Projects — single-project plan authoring. Nothing here
aggregates across projects, so no part of it approaches the Enterprise line.

## Decision

**A new endpoint, `PATCH /api/v1/projects/{pk}/tasks/classification/`, applies the two
classification axes across a task subtree in one call. The two axes are applied
independently; explicit governance overrides survive by default; milestones never have
their delivery mode rewritten.**

Eight clauses follow.

### 1. A separate route, not a bucket on `tasks/bulk/`

`tasks/bulk/` is a per-row 207 contract keyed by caller-supplied `index`. Folding the
cascade into it would put rows the caller never enumerated into `applied` / `skipped`,
which either breaks the `index` correlation guarantee or forces a second, differently
correlated bucket inside a response whose whole design is "one bucket vocabulary, one
handle". A cascade is also a genuinely different operation: the caller sends one
declaration and the server resolves the row set from `wbs_path`.

`PATCH`, not `POST`: this mutates existing rows only, creates nothing, and re-sending
the same body converges on the same state (see §7). The issue writes the route as
`PATCH /tasks:batch`; the colon form is a Google-AIP convention that appears nowhere in
this tree, so the path is spelled the Django way. That is a spelling divergence from the
issue text and nothing more.

One known cost of the verb: drf-spectacular emits a `Patched…Request` component for
every `PATCH` body (`COMPONENT_SPLIT_PATCH`, on by default and global), which declares
all fields optional. `subtree` is in fact required, so the generated schema
under-declares it — a declared-vs-actual gap of the kind #2515 exists to catch. It is
accepted here rather than worked around: every `PATCH` in this API carries the same
Patched wrapper, the alternative levers are a global setting change or a hand-written
request schema that would immediately drift, and the runtime behaviour is an
unambiguous 400. `docs/api/reference.md` states the requirement in prose.

Response is **200**, not 207. Every outcome the endpoint reports — a kept override, a
skipped milestone — is a documented semantic of a *successful* cascade, not a per-row
failure. There are no partial failures left to report, because §6 makes permission
all-or-nothing.

### 2. Request body

```json
{
  "subtree": "<task uuid>",
  "cascade": true,
  "governance_class": "gated",
  "delivery_mode": "scrum",
  "preserve_governance_overrides": true,
  "skip_milestones": true
}
```

- `subtree` (required) — the root. Must be a live task in this project.
- `cascade` (default `true`) — `false` classifies the root alone. Descendants are
  every live task whose `wbs_path` is prefixed by the root's, matching the containment
  test the rest of the codebase uses (`serializers.py:4279`).
- `governance_class`, `delivery_mode` — each optional, **at least one required**. A
  400 on neither: a call that declares nothing is a client bug, not a no-op worth
  reporting. `delivery_mode: "milestone"` is rejected — a cascade that converts a
  phase into a gate is not a classification, and §4 exists to prevent exactly that
  conversion in the other direction.
- `preserve_governance_overrides` (default `true`) — §3.
- `skip_milestones` (default `true`) — §4.

### 3. The inherit bit gets its first writer, and it means "explicit"

`parent_governance_inherited` records whether a node takes its governance from its
parent or declares its own. This endpoint establishes the rule:

- **The subtree root is a declaration point.** When `governance_class` is supplied, the
  root is written with `parent_governance_inherited = False`. Declaring a subtree's
  governance *is* breaking inheritance from whatever sits above it.
- **Cascaded descendants inherit.** They are written with
  `parent_governance_inherited = True`.
- **A descendant already at `False` is an explicit override.** With
  `preserve_governance_overrides = true` (the default) its `governance_class` is left
  untouched and counted in `governance.overrides_kept`. With `false` it is overwritten
  and its bit reset to `True`, because it is no longer an override.

That default is what makes cascading safe to try: a planner who has hand-tuned one
compliance branch inside an otherwise agile phase can re-declare the phase without
losing the branch, and the response tells them how many survived.

**The override rule is governance-only.** `delivery_mode` has no inherit bit, so an
override in the governance sense does not exist for it; a preserved-governance row
still receives the cascaded delivery mode. The two axes are orthogonal, and the
response says so explicitly (§5).

The field stays **read-only on `TaskSerializer`**. This endpoint writes it directly,
which preserves the reason it was closed to clients in the first place: a client-supplied
value can contradict `governance_class`, and the field is in
`_HISTORY_DIFF_DISPLAY_EXCLUDED` so a client write leaves no audit row.

### 4. Milestones: the invariant is not caller-overridable

A milestone row inside the subtree is **never** written with a non-milestone
`delivery_mode`, under any request. That is not a policy the caller can waive; it is the
`is_milestone ⟺ delivery_mode ⟺ duration = 0` coupling, and waiving it produces a row
the rollup SQL and the CPM engine disagree about.

`skip_milestones` therefore controls the *other* axis:

| `skip_milestones` | `governance_class` on a milestone | `delivery_mode` on a milestone | Reported as |
|---|---|---|---|
| `true` (default) | not written | not written | `skipped`, `axes: ["governance_class", "delivery_mode"]` |
| `false` | written (counted in `governance.applied`) | **never** written | `skipped`, `axes: ["delivery_mode"]` |

The skip is **axis-specific**, not whole-row: a `skipped` entry names which axes were
withheld from that row, so `skip_milestones: false` reports honestly that the gate took
its governance and kept its delivery mode. A whole-row skip flag could not express that.

Governance on a gate is invariant-safe — a milestone can legitimately sit under a
`gated` or a `flow` overlay; that is what the overlay *is*. Delivery mode on a gate is
not. Rejecting `skip_milestones: false` outright was considered and dropped: a field
that only accepts one value should not be in the contract.

### 5. The response must not imply a count it cannot compute

```json
{
  "subtree": "<uuid>",
  "matched": 24,
  "governance": {
    "requested": "gated",
    "applied": 21,
    "unchanged": 0,
    "overrides_kept": 1,
    "has_inherit_bit": true
  },
  "delivery_mode": {
    "requested": "scrum",
    "applied": 21,
    "unchanged": 0,
    "overrides_kept": null,
    "has_inherit_bit": false
  },
  "skipped": [
    {
      "id": "<uuid>",
      "code": "milestone_gate",
      "axes": ["governance_class", "delivery_mode"],
      "message": "..."
    }
  ]
}
```

`overrides_kept` is `null` on the `delivery_mode` axis, paired with
`has_inherit_bit: false`. **Not `0`** — zero reads as "there were none", which is a
claim about the data. `null` states that the count is not computable on this axis,
which is a claim about the model, and it is the true one. An axis the request omitted is
absent from the response entirely.

`unchanged` counts rows already at the requested value, which §7 does not re-save.
`applied` counts rows actually written, so a repeated cascade reports
`applied: 0, unchanged: 21` rather than claiming 21 fresh writes.

### 6. Permission is all-or-nothing

`IsAuthenticated`, `IsProjectMemberWrite`, `IsProjectPlanAuthor` (ADR-0773) and
`IsProjectNotArchived`, with `check_object_permissions(request, project)` called
explicitly in the body — `_project_pk_from_view` reads only `project_pk`, so on a
`projects/<pk>/…` route `has_permission` cannot resolve the project and falls through
(#2745). Per ADR-0773 §3, `can_user_author_plan` is a project-level capability and
`can_user_edit_task` remains authoritative per row, so the latter is applied to every
resolved row.

**If any resolved row fails `can_user_edit_task`, the whole request is 403.** This
diverges deliberately from `tasks/bulk/`, where one bad row out of 38 must not discard
the other 37. There, the caller typed 38 things. Here they declared *one* thing about a
subtree, and applying it to the 60% of rows they happen to be assigned leaves the plan
asserting a split that is not true — worse than refusing. The 403 names the count of
un-editable rows so the client can explain why; it names no ids, and needs no
membership-inference hedging because every row is in a project the caller is already a
member of.

### 7. Idempotent by change detection, *and* by the key header

Rows already at the requested value are **not saved**. That makes a repeated identical
cascade a true no-op: no `server_version` bump, no `sync_seq` consumption, no history
row, no CPM enqueue, no broadcast.

That property alone was initially judged sufficient to skip `IdempotencyMixin` — the
mixin exists to stop replayed *creates* from minting second rows, and this endpoint
creates nothing. **That reasoning was right about the mechanism and wrong about the
conclusion.** The codebase already settled this question in the other direction:
`ProjectShareLinkRevokeView` is a naturally-idempotent soft-revoke and still opts in,
"like every other unsafe-method TruePPM view", and `tests/apps/idempotency/
test_idempotency.py::test_every_unsafe_view_has_idempotency_mixin` enforces it — the
exemptions on record are token-principal endpoints, importers with their own dedup, and
SSO callbacks, none of which describes plan authoring.

So the view carries the mixin. Two reasons beyond conforming to the rule: natural
idempotence is a property of *this* implementation and could be lost by a later change,
whereas the `Idempotency-Key` contract is a promise to the caller; and a replay under
the mixin costs zero queries rather than a subtree lock plus a full classification pass.

Every write that does happen goes through `Task.save()`, one row at a time — **never**
`QuerySet.update()`. `server_version` is the optimistic-lock token and the arithmetic
`apps/sync/conflict.py` slices field-level merges with (exactly `current - base_version`
history rows), and `sync_seq` is the delta-pull cursor; both advance only inside
`VersionedModel.save()`, which also writes the 1:1 `HistoricalRecords` row. A bulk
`update()` would leave every offline client permanently unable to see the
classification — the #2491 failure class exactly.

Per-row saves make the write cost linear, so the subtree is capped at
`TASK_CLASSIFY_MAX_SUBTREE = 2000` resolved rows and a larger subtree is a 400 naming
the count and the cap. Deliberately *not* shared with
`TASK_BULK_MAX_OPERATIONS = 500`: that cap bounds rows a human typed into a grid, this
one bounds rows a server resolved from one click, and 500 is below a realistic top-level
phase.

### 8. The graph guard runs, and why that is not ceremony

`validate_task_graph` (ADR-0259) runs over the project's dependency edges before the
write, and an infeasible graph is a 400.

This endpoint creates no edges, so the guard cannot reject anything *it* did. It is here
because the cascade calls `enqueue_recalculate`, and ADR-0259's rule is that the guard
runs before a bulk write and before recalculation. That rule is non-vacuous today:
`apps/seed/importer.py` still bypasses the guard (**#2589, open**), and project
templates seed dependency edges through that path — so a cyclic graph can genuinely
exist in a project, and a cascade is very often the first authoring act after a template
apply. Catching it here surfaces a 400 the planner can act on instead of a CPM worker
crash they cannot see.

Project-scoped rather than subtree-scoped, because a cycle can leave the subtree and
re-enter it, and because `enqueue_recalculate`'s own scope is the project.

**It runs only when a write is actually pending.** The guard reads every task row and
every edge in the project, so its cost scales with project size rather than subtree
size. Classification is therefore computed in memory first (§7's change detection is
what makes that possible) and the guard runs only if that pass found something to
write — otherwise a repeated identical cascade would pay a full project scan to write
nothing. A no-op cascade over a project that already holds a cyclic graph is a 200: it
enqueues no recalculation, so there is nothing for the guard to protect.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. New `PATCH …/tasks/classification/` route (chosen)** | Subtree semantics stated once; 200 + summary matches an operation with no per-row failures; no strain on ADR-0772's `index` contract | A second task-batch write path to keep in step with the first |
| B. A `classification` bucket on `POST …/tasks/bulk/` | One batch endpoint; reuses savepoints, locking, broadcast | Puts server-resolved rows into a 207 keyed by caller `index`; forces either a broken correlation guarantee or a second bucket vocabulary in one response |
| C. Client expands the subtree and sends N `update` ops to `tasks/bulk/` | Zero new server surface | Override preservation and the milestone gate become client logic, so every client re-implements them and an agent/MCP caller gets neither; N-row payload for one declaration; `TASK_BULK_MAX_OPERATIONS = 500` caps the subtree at a value chosen for typing, not for phases |
| D. `skip_milestones: false` also writes `delivery_mode` | Flag means the obvious thing | Dissolves gates; produces rows the rollup SQL and CPM disagree about; the invariant is not the caller's to waive |
| E. Reject `skip_milestones: false` with 400 | Invariant safe by construction | A boolean that accepts one value should not be in the contract |
| F. Per-row `forbidden` skips instead of an all-or-nothing 403 | Consistent with `tasks/bulk/` vocabulary | Leaves the plan asserting a subtree split that is true of some rows and false of others — the declaration becomes a lie |
| G. `overrides_kept: 0` on the delivery axis | Symmetric response shape | States "there were no overrides" (a claim about data) where the truth is "the model cannot have one" (a claim about the model) |
| H. `QuerySet.update()` for the cascade | One statement, no row cap needed | Skips `server_version` / `sync_seq` / history — the classification never reaches an offline client (#2491 class) |

## Consequences

**Easier.** Declaring a hybrid split becomes one call instead of N hand PATCHes, which
is the whole point of epic #2741. `parent_governance_inherited` acquires a writer and a
meaning, so the inherit bit stops being an inert column. An agent or MCP caller gets the
override-preservation and milestone-gate semantics for free, rather than having to
re-derive them — the "human and agent principals are governed identically" claim holds
on this path by construction.

**Harder.** There are now two task-batch write paths (`tasks/bulk/` and
`tasks/classification/`) with deliberately different failure doctrines — per-row 207
partial application vs. all-or-nothing permission. A future reader will find that
asymmetry surprising; §1 and §6 exist so they find the reason with it. The milestone
coupling is now enforced in a third place (model normalization, serializer
reconciliation, and this endpoint's own gate), so a change to the invariant has three
call sites to update.

**Risks.**

- *The cascade is invisible without #2737.* Epic #2741 says the feature "ships whole or
  not at all": a cascade with no gutter, chip, `MIXED` parent or bar texture is a popover
  whose result a planner cannot see. This ADR lands the API half only; the epic tracks
  the coupling.
- *`parent_governance_inherited = False` on the root is a new fact in old data.* Every
  existing row is `True`, so the first cascade in a project is also the first override
  that project has ever had. Nothing reads the field yet outside this endpoint, so the
  blast radius is confined until #2737 renders it.
- *2000 is a guess.* It is well above any phase subtree observed in the seed and
  template data, and the failure mode is a clear 400 rather than a truncated write, but
  the number has no measurement behind it.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (new view, serializers, service module, URL). No
  `scheduler`, `web`, `mobile` or `helm` change in this issue; the popover is #2736.
- **Migration required**: **no.** Both fields, the inherit bit, and their indexes ship
  in ADR-0036's migration. This endpoint only writes columns that already exist.
- **API changes**: yes — one new route,
  `PATCH /api/v1/projects/{pk}/tasks/classification/`. `docs/api/openapi.json` is
  regenerated; `docs/api/` and `docs/features/` gain the endpoint and the semantics.
- **OSS or Enterprise**: **OSS.** Single-project plan authoring. A PM declaring the
  hybrid split inside their own program needs this to run that program; nothing here
  aggregates across programs or adds org-level policy.

### Durable Execution

1. **Broker-down behaviour**: No direct `.delay()`. CPM recalculation goes through
   `scheduling/services.py::enqueue_recalculate()`, which already writes its
   `ScheduleRequest` row inside the caller's transaction and drains separately, so a
   broker outage at dispatch loses nothing. The board broadcast is registered with
   `transaction.on_commit()` and is best-effort by design — a dropped WebSocket frame
   costs a client a refetch, and the authoritative state is in Postgres.
2. **Drain task**: None new. Reuses the existing schedule-request drain behind
   `enqueue_recalculate` — the semantics match exactly, because what this endpoint needs
   dispatched *is* a project recalculation, identical to the one every other task write
   path enqueues.
3. **Orphan window**: N/A for this endpoint — it introduces no outbox category of its
   own. The inherited schedule-request drain keeps its existing 10-minute filter.
4. **Service layer**: New —
   `apps/projects/task_classification.py::cascade_task_classification()`. It holds
   subtree resolution, override preservation, the milestone gate, and change detection,
   so the view stays request/response only and an MCP or management-command caller can
   reach identical semantics without going through DRF.
5. **API response on best-effort dispatch**: Synchronous **200** with the applied /
   skipped summary. The row writes are committed before the response; only the
   recalculation and the broadcast are deferred, and neither is something the caller
   waits on. No `{"queued": true}` — the classification itself is not queued.
6. **Outbox cleanup**: N/A — no new outbox rows. `ScheduleRequest` rows created via
   `enqueue_recalculate` are purged on the existing nightly 7-day schedule.
7. **Idempotency**: Two layers. `IdempotencyMixin` (ADR-0170) gives the caller the
   standard `Idempotency-Key` replay contract, as on every other unsafe-method view.
   Underneath it, change detection (§7) makes the operation idempotent even without a
   key — a row already at the requested value is not written, so a replayed request
   writes nothing, bumps no version, and enqueues nothing. The state-level key is
   effectively `(task_id, governance_class, delivery_mode)` compared against current
   state under `select_for_update`, which also closes the read-then-write window
   against a concurrent cascade on an overlapping subtree.
8. **Dead-letter / failure handling**: N/A at this layer. The endpoint's own writes are
   synchronous inside one `transaction.atomic()` — they either commit or roll back
   whole, with no partial state to dead-letter. The recalculation it enqueues inherits
   `enqueue_recalculate`'s existing retry limit and DEAD-status handling on the
   `ScheduleRequest` row, which a planner can re-trigger by making any further edit.
