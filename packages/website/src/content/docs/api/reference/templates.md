---
title: "Project templates and import API"
description: "Project templates, import templates, and import provenance."
documentedFor: "0.4"
---

## Project templates

:::note[Ships in 0.4]
These endpoints ship in **TruePPM 0.4**. `v0.3.0-alpha.3` (the latest release) has
no template system — the collection does not exist.
:::

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/project-templates/` | Gallery (filter: `?program=`) |
| POST | `/api/v1/project-templates/publish/` | Freeze a project's shape as a template |
| POST | `/api/v1/project-templates/{id}/apply/` | Apply to a project — returns `202` |
| GET | `/api/v1/template-applications/` | Adoption records (filter: `?project=`) |
| POST | `/api/v1/template-applications/{id}/undo/` | Reverse one application |

Both writes take a JSON body. `publish` requires `project` and `name`; `apply`
requires `project`:

```json
// POST /api/v1/project-templates/publish/
{
  "project": "<uuid>",           // required — the project to freeze
  "name": "House shape",         // required — trimmed, truncated at 200 chars
  "description": "…",            // optional — truncated at 2000 chars
  "source_kind": "workspace",    // optional — provenance chip, defaults to workspace
  "new_version": true            // optional — publish v(n+1) instead of getting a 409
}

// POST /api/v1/project-templates/{id}/apply/
{"project": "<uuid>"}            // required — the project to seed
```

`name` and `description` are **truncated**, not rejected, when they exceed their
limits. `new_version` is read permissively: `true`, `"true"` and `"1"` all enable
it, anything else is false. Publishing under a name that already exists in the
pool you can see returns **`409`** with `code: name_taken` and a `next_version` —
resend with `new_version: true` to extend that template's chain.

`apply` returns **`202 {"queued": true, "application": "<uuid>"}`** — not a task id.
Dispatch is best-effort behind a transactional outbox, so there may be no Celery id
yet (or ever, for a delivery the drain re-dispatches). The **application id** is the
durable handle: it exists the moment the request commits, and `GET
/api/v1/template-applications/{id}/` reports `pending` → `running` → `success` /
`failed`.

The gallery does **not** publish the `structure` document. A gallery reader is a
wider audience than the source project's members, so a whole project's shape
(task names included) must not ride a list endpoint. `task_count` is the server's
count off the frozen document, so it cannot disagree with what apply will write.

`provenance` is the display chip. `source_kind` is stored, so every reader agrees
on `workspace` and `community`; **Yours** is resolved per reader, because it is the
only tier that depends on who is asking.

Publishing and applying both require **Project Manager (Admin)** or above on the
project in question (ADR-0773). Reading the gallery requires only authentication.

**Apply and undo are refused on an archived project** with a `403`, at every role
including Owner — archiving makes a plan read-only, and that is a property of the
plan rather than of the caller. Reads are unaffected: you can still list
applications and poll one on an archived project. **Publishing from an archived
project still works**, because extracting a template reads the source plan and
writes nothing into it. Unarchive the target project first, then re-apply.

**A `failed` application never leaves partial rows.** The claim and the
materialization share one transaction, so any failure rolls the whole seed back —
there is no half-applied state for a client to detect or clean up, `undo` has
nothing to reverse, and `created_task_ids` stays empty. Poll for `error_detail`
and surface it; that is the whole recovery surface.

Because apply is asynchronous, a project archived *after* a `202` is refused at
seeding time rather than at request time: the application lands on
`status: "failed"` with `error_detail` naming the archived project, and no rows
are written. Poll `GET /api/v1/template-applications/{id}/` for it — there is no
second `403` to catch, because the request that would have carried one already
returned.

Apply is rate-limited on the shared `seed_import` throttle scope — the same bound
the seed and spreadsheet import paths carry.

### Phase rollup locks

A **phase** is a non-subtask task with at least one *structural* (non-subtask)
child. A phase is a pure rollup: its status, estimate, assignee, percent-complete,
and logged time are all computed from its children and cannot be set directly. The
task serializer exposes a read-only computed boolean, `is_phase`, alongside the
existing `is_summary`:

- `is_summary` — the task has **any** direct WBS child (including drawer subtasks).
- `is_phase` — the task has at least one direct child that is **not** a subtask.

The distinction matters: a leaf broken into drawer subtasks is `is_summary: true`
but `is_phase: false`, and stays fully writable. Only a task with real structural
children is a phase.

Writing a rolled-up attribute directly onto a phase returns `400` with a stable
error code. Each lock fires **only when the request actually changes the locked
attribute** — a `PATCH` that omits the field, or re-sends its current value, still
succeeds.

| Write to a phase | Error code |
|---|---|
| `percent_complete` | `summary_rollup_locked` |
| `status` | `phase_status_rollup_locked` |
| `optimistic_duration` / `most_likely_duration` / `pessimistic_duration` | `phase_estimate_rollup_locked` |
| `assignee` | `assignee_on_phase` |
| logging time against a phase (see [Time tracking](/api/reference/resources/#time-tracking)) | `time_log_on_phase` |

Phase → phase dependencies, baselines, and Monte Carlo are **not** restricted —
those are derived/aggregate, not direct writes of leaf-owned values.

### Grouping and ungrouping

:::note[Ships in 0.4]
`tasks/group/` and `tasks/ungroup/` ship in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the
latest release) neither route exists; structure a flat list top-down with
`tasks/{id}/indent/` and `tasks/{id}/reparent/` instead, one row at a time.
:::

Indent requires the phase to already exist, so a flat list can only become structured
from the top down. These two endpoints are the missing primitive: they let a planner
type the work, look at it, select it, and *then* wrap it.

`POST /api/v1/projects/{id}/tasks/group/` takes `{ "task_ids": [...], "name": "..." }`
and creates a phase at the position of the first selected row, moving the selection —
and everything beneath it — inside. `name` is optional; omit it and the phase gets a
placeholder, because the design names the phase last.

**The server may wrap fewer rows than you sent, and says so.** Two rules apply, in
order: any row whose own *ancestor* is also in the selection is skipped (you cannot
wrap a phase together with the work inside it), and the phase is then created on the
parent shared by *most* of what remains. Every skipped row comes back in `left_alone`
with a `reason` of `ancestor_selected` (plus the `ancestor_id` that covered it) or
`different_parent`. Clients are expected to surface this — a group that silently
wrapped four of your six rows reads as a defect.

`POST /api/v1/projects/{id}/tasks/ungroup/` takes `{ "task_id": "..." }` and does the
reverse: the phase's rows move up one level into its position, and the wrapper is
soft-deleted. **Only the wrapper goes** — the lifted rows keep their ids, dependency
edges, resource assignments and estimates, because nothing about them changes except
their WBS path. Dependency edges attached to the *wrapper itself* go with it, as they
do for any deleted task, and are listed in `removed_dependency_ids` rather than
disappearing silently. A phase carrying drawer subtasks is refused with
`container_has_subtasks` instead, since dissolving it would delete them.

**Each endpoint is one transaction, and that is the reason it exists.** Composing
either from repeated `tasks/{id}/reparent/` calls is N+1 un-transacted requests whose
partial failure strands a half-made phase with some rows moved and some not. Here a
rejection at any point — including the dependency-graph check that runs over the
resulting tree — leaves the plan exactly as it was. That also makes the pair mutually
reversible: ungrouping a phase you just created restores the previous layout in one
request. The reverse is not lossless, because ungroup deletes the wrapper row.

Both require plan-authoring authority on the project, and per-row edit authority on
every row that moves — so a Team Member may wrap their own assigned rows but not a
colleague's, and one row they cannot touch refuses the whole operation rather than
applying part of it.

### Batch task writes

`POST /api/v1/projects/{id}/tasks/bulk/` applies many task writes in one request.
It is the endpoint behind paste-many, import, and agent-authored drafting.

:::note[Ships in 0.4]
The `207` contract described in this section — per-row `applied` / `rejected` /
`skipped`, client-minted `id` on a `create`, the `dependencies` bucket, and the
500-operation cap — ships in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the latest
release) this endpoint returns **`200`** with `{created, updated, deleted}`,
applies the whole batch or none of it, mints every task id server-side, accepts no
dependency edges, and enforces no size limit.
:::

**Rows apply independently, and the response is `207`** — not `200`. One
unparseable row out of 38 does not discard the other 37. Every operation is
reported in exactly one of three buckets:

```json
{
  "applied":  [{ "index": 0, "id": "…", "op": "create", "outcome": "created", "task": { } }],
  "rejected": [{ "index": 7, "id": null, "code": "malformed_id", "message": "…" }],
  "skipped":  [{ "index": 9, "id": "…", "code": "tombstoned", "message": "…" }],
  "dependencies": { "applied": [], "rejected": [] },
  "capabilities_denied": [],
  "operation_id": "7c2e…9f",
  "can_undo": true
}
```

`index` — the zero-based position of the operation in the request's `operations`
array — is the correlation handle, **not** `id`. A row rejected because its id
could not be parsed has no usable id to echo back, and a `create` may legitimately
omit one.

`skipped` is a documented no-op, never a failure: a `create` whose id matches a
deleted row, or a classification that crossed a milestone gate.

**`code` is a closed set, and the schema publishes it.** It is emitted as the
`TaskBulkRefusalCodeEnum` component, so a generated client types it as a union
rather than as `string` and you can branch on it without reading our source. The
"Retry" column is the distinction the enum exists to let you make.

| `code` | Meaning | Retry? |
|---|---|---|
| `malformed_id` | `id` was not a UUID. Reported before any database query runs | Never — the row is wrong |
| `id_unavailable` | The id cannot be used. Deliberately non-asserting — it does **not** reveal whether the id exists in a project you cannot see | Never |
| `not_found` | No such task in this project | Never |
| `forbidden` | Your role does not permit this row's operation | Only after a role change |
| `invalid` | The row body failed validation | Never — fix the row |
| `conflict` | A database constraint rejected the row | Yes — it may be a lost race |
| `cyclic_dependency` / `self_reference` | The edge would make the schedule infeasible | Never |
| `unresolved_endpoint` | An edge endpoint is not a live task in scope | Yes — the endpoint may exist later |
| `tombstoned` | A `create` whose id matches a deleted row here. A `skipped` no-op, not a failure | No — same request, same non-answer |
| `milestone_gate` | A cascade crossed a milestone, which is a gate rather than a failure. Also a `skipped` no-op | No |

The structural-undo surface publishes its own separate set as
`StructuralUndoBlockedReasonEnum` (`undo_blocked_reason` on a
`StructuralOperation`, and `code` in the `409` from `POST .../undo/`). Its values
are `already_undone`, `too_large`, `not_top_of_stack`, `shape_changed`,
`forbidden` — plus the **empty string**, which means the operation *is* undoable
and is the value you will see most often.

#### Undoing a batch

Two fields govern the undo, and they answer different questions — read **both**
before offering an Undo control. This is the same pair the classification cascade
publishes, and it works the same way.

| Field | Answers | `null` / `false` means |
|---|---|---|
| `operation_id` | Is there a ledger row to reverse? | The batch created no rows, so nothing was recorded |
| `can_undo` | May **this caller** reverse it? | Your role is below Project Manager on this project |

`POST /api/v1/paste-many-operations/{operation_id}/undo/` reverses the batch's
creates, and it requires **Project Manager or above** — a strictly higher floor than
this endpoint admits. So a Team Member can receive a `207` here, with a real
`operation_id`, and still be refused the undo. `can_undo` is that answer, computed
from the same rule the undo endpoint enforces; read it rather than comparing role
ordinals yourself.

`can_undo` is an **authority** answer only. It does not report the archived-project
refusal (see [Undoing a cascade](#undoing-a-cascade) below), and it does not promise
the ledger row still exists: batch operations are purged after the deployment's
`TRUEPPM_BATCH_OPERATION_RETENTION_DAYS` window, after which the undo is a `404`.

#### What an undo reports back

Every `undo` action returns its ledger row **plus an `undo` object** carrying what
the reversal actually did. Read it: an undo deliberately leaves behind rows a person
has edited since the batch wrote them, so a non-zero "kept" count means the plan
still carries part of what you asked to remove.

| Endpoint | `undo` keys |
|---|---|
| `POST /api/v1/paste-many-operations/{id}/undo/` | `deleted`, `kept` |
| `POST /api/v1/cascade-classification-operations/{id}/undo/` | `reverted`, `kept` |
| `POST /api/v1/template-applications/{id}/undo/` | `deleted`, `kept` |
| `POST /api/v1/structural-operations/{id}/undo/` | `restored`, `created_removed`, `deleted_restored`, `dependencies_restored`, `dependencies_skipped` |

The structural undo is all-or-nothing, so its counts always describe a completed
reversal — a refusal is a `409` with no summary at all. A non-zero
`dependencies_skipped` there means an edge could not be re-created because its other
end no longer exists, so the restored graph is **incomplete** and the user has links
to redraw.

#### Client-minted ids

A `create` may carry its own `id`, and the server takes that UUID as the primary
key verbatim — it is never remapped. This matches the offline sync push, so a row
authored in the planner, pulled to a phone, edited offline, and pushed back travels
under one id the whole way. Omit `id` and the server mints one.

A `create` whose `id` already exists in this project is **not** a duplicate and not
an error: it applies as an in-place edit (`"outcome": "updated"`) under the stricter
edit permission, and never creates a second row.

#### Declaring where rows came from

An optional top-level `origin` names how the rows this batch **creates** were
produced, which the server records on each created row's `source_kind` (the same
provenance column `GET`/history responses expose elsewhere). Omit it and rows
record as hand-authored (`source_kind: "hand"`) — the endpoint's own default,
unchanged. The only value accepted today is `"paste"`, for a client submitting a
pasted block of rows:

```json
{
  "operations": [{ "op": "create", "data": { "name": "Survey", "duration": 3 } }],
  "origin": "paste"
}
```

An unrecognized `origin` is a `400` — it is validated against a closed set, not
free text. `origin` has no effect on `update`/`delete` ops or on a `create` whose
`id` resolves to an existing row (that applies as an edit, and an edit never
rewrites the row's original provenance).

#### Dependencies

An optional `dependencies.created` bucket writes edges after every task row exists,
so an edge may name a task whose `create` appears **later** in `operations`:

```json
{
  "operations": [
    { "op": "create", "id": "3f1c…a1", "data": { "name": "Survey", "duration": 3 } },
    { "op": "create", "id": "9b40…c7", "data": { "name": "Design", "duration": 5 } }
  ],
  "dependencies": {
    "created": [{ "predecessor": "3f1c…a1", "successor": "9b40…c7", "dep_type": "FS", "lag": 0 }]
  }
}
```

Edges name plain task UUIDs — there is no positional or by-name reference syntax.
Every edge is checked against the dependency-graph guard before any of them is
written; a detected cycle refuses the edges on the cycle path and leaves the task
rows applied.

##### Two permission floors in one request

**Writing edges needs a higher role than writing rows**, and this is the one part
of the endpoint that is easy to get wrong when provisioning a service account. The
check is per edge, so a Team Member's task rows still apply while only their edge
rows are refused — a partial success, not an error.

| Role | Task rows | Dependency edges |
|---|---|---|
| Team Member | ✅ | ❌ `forbidden` per edge |
| **Resource Manager** | ❌ **`403` on the whole request** | ❌ |
| Admin | ✅ | ✅ |
| Owner | ✅ | ✅ |

Read that middle row carefully. The edge check names the Resource Manager band, but
[who may create a task](/api/reference/tasks/#who-may-create-a-task) *excludes* that band from this
endpoint entirely — so a Resource Manager token is refused outright and never
reaches the edge gate its own role appears in. **A service account that writes
dependencies *through this endpoint* must be Project Manager or above.**

**That is a property of this endpoint, not of the role.** A Resource Manager *may*
author dependency edges — see [`POST /api/v1/dependencies/`](#dependencies), which
gates on `IsProjectScheduler` and admits the band. The two rules do not nest: task
content admits Team Member, Admin and Owner and excludes Resource Manager, while
dependency edges admit Resource Manager, Admin and Owner and exclude Team Member
(ADR-0773 §7). Each admits exactly the band the other refuses. This endpoint writes
both in one request and so applies the stricter of the two at the door, which is why
the band that may draw an edge cannot draw one *here*.

When a caller's role cannot author edges at all, the response says so once, at the
top level, rather than leaving you to infer it from N rejected edges:

```json
{ "capabilities_denied": ["dependencies"] }
```

It is `[]` whenever every capability the request used was available — including a
batch that carried no edges, which is not the same claim as "this caller could have
written them". The per-edge `dependencies.rejected` entries are unchanged and still
present; `capabilities_denied` explains them, it does not replace them.

#### Limits and replay

- At most **500 operations** and **500 dependency edges** per request.
- Send an `Idempotency-Key` header. A byte-identical replay returns the stored
  `207` with `Idempotent-Replay: true` and performs no writes at all — see
  [Idempotency](/api/idempotency/).
- Whenever any row commits, the schedule is recalculated and a
  `tasks_bulk_mutated` event is broadcast carrying only the ids that actually
  changed.

Authoring the plan requires Team Member or above. The **Resource Manager** role is
excluded: it sits above Team Member in the role order but cannot edit task content,
so it could otherwise create rows it was then unable to change. Read
`can_author` on the project resource rather than comparing role ordinals yourself.

### Subtree classification

`PATCH /api/v1/projects/{id}/tasks/classification/` declares how a subtree is
governed and how it is delivered, in one call.

:::note[Ships in 0.4]
This endpoint ships in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the latest release)
`governance_class` and `delivery_mode` exist on the task resource but can only be
set one row at a time through `PATCH /api/v1/tasks/{id}/`, and
`parent_governance_inherited` cannot be set at all.
:::

**These are two orthogonal fields, not one choice.**

| Field | Values | Means | Inherit bit |
|---|---|---|---|
| `governance_class` | `gated` · `flow` · `hybrid` | declares how the subtree is governed | **yes** (`parent_governance_inherited`) |
| `delivery_mode` | `waterfall` · `scrum` · `kanban` · `milestone` | how work is executed, estimated, rolled up | no |

The two are not read to the same depth, and it matters if you are integrating.
`delivery_mode` changes what the server computes — rollup, Monte Carlo sampling,
schedule presentation. `governance_class` is stored, inherited, cascaded and
returned faithfully, but only one thing branches on its value today: the `gates`
count in a project template's structure. Set it to describe your plan; do not
expect a different rollup or forecast because a subtree is `gated`.

`scrum` and `kanban` are not interchangeable: a `scrum` node rolls up from
story-point burndown and samples the team velocity distribution in Monte Carlo, a
`kanban` node rolls up from item throughput. Send whichever the team actually runs.

```json
{
  "subtree": "3f1c…a1",
  "cascade": true,
  "governance_class": "gated",
  "delivery_mode": "scrum",
  "preserve_governance_overrides": true,
  "skip_milestones": true
}
```

`subtree` is **required** — the generated OpenAPI schema marks every `PATCH` body
field optional, which under-declares it. Supply `governance_class`,
`delivery_mode`, or both — a request naming neither is a `400`. `cascade: false` classifies the named task alone; otherwise the server
resolves the subtree from the WBS and the caller sends no row list. A cascade
cannot set `delivery_mode` to `milestone` — converting a task into a gate also has
to zero its duration, so that stays a single `PATCH` on the task.

The response is `200`, and it reports each axis separately:

```json
{
  "subtree": "3f1c…a1",
  "matched": 24,
  "rows_written": 21,
  "governance":    { "requested": "gated", "applied": 21, "unchanged": 0,
                     "overrides_kept": 1,    "has_inherit_bit": true },
  "delivery_mode": { "requested": "scrum", "applied": 21, "unchanged": 0,
                     "overrides_kept": null, "has_inherit_bit": false },
  "skipped": [
    { "id": "9b40…c7", "code": "milestone_gate",
      "axes": ["governance_class", "delivery_mode"], "message": "…" }
  ],
  "operation_id": "7c2e…9f",
  "can_undo": true
}
```

`overrides_kept` is `null` on `delivery_mode` — **not `0`**. Only
`governance_class` carries an inherit bit, so only it can have an override; zero
would claim the data had none, where the truth is that the axis cannot have one.
An axis you did not send is absent from the response entirely.

**Three counts, three different questions — do not derive one from another.**
`matched` is how many rows the subtree resolved; `rows_written` is how many of
them were saved; each axis's `applied` is how many rows that *axis* changed.
Summing the two `applied` values does not give you `rows_written`: a row changed
on both axes is counted twice, and a milestone withheld on one axis but written on
the other appears in only one of the two totals. `applied` also says nothing about
columns — a governance write sets `governance_class` and
`parent_governance_inherited` together. If you want "how many tasks did this
change", read `rows_written`.

#### What survives a cascade

- **Explicit governance overrides.** A descendant that declared its own governance
  (`parent_governance_inherited: false`) keeps it, and is counted in
  `overrides_kept`. Send `preserve_governance_overrides: false` to overwrite it.
  The override is governance-only: that row still receives the cascaded
  `delivery_mode`.
- **Milestones.** A milestone's `delivery_mode` is **never** rewritten, under any
  request. `is_milestone`, `delivery_mode: "milestone"` and `duration: 0` are three
  encodings of one fact, and a cascade that broke them would dissolve every gate in
  the phase. `skip_milestones` governs the *governance* axis on those rows only:
  leave it `true` and a milestone is untouched; send `false` and it takes the
  governance class but still keeps its delivery mode. Either way it appears in
  `skipped` with the axes that were withheld.

The subtree root itself is written with `parent_governance_inherited: false` —
declaring a subtree's governance is what breaking inheritance means — and its
cascaded descendants with `true`.

#### Limits and errors

- At most **2000** resolved tasks. A larger subtree is a `400` with code
  `subtree_too_large` and the matched count; it is never truncated.
- **Permission is all-or-nothing.** If you cannot edit every row in the subtree the
  whole request is `403` and nothing is written. Unlike batch task writes, a
  partially applied cascade would leave the plan asserting a split that is not
  true.
- A project whose dependency graph is already cyclic is a `400` (`cyclic_dependency`)
  — the cascade triggers a recalculation, and an infeasible graph is refused before
  the schedule engine sees it. `detail` names the tasks in the loop by WBS code and
  name; `offending` carries their ids. See
  [Errors and status codes](/api/errors/#400--refused-writes).
- Re-sending an identical request writes nothing: rows already at the requested
  values report under `unchanged`, and no recalculation or broadcast is triggered.
- When something does change, the schedule is recalculated and a
  `tasks_bulk_mutated` event carries the ids that changed.

Authoring requires Team Member or above, with the same Resource Manager exclusion
as batch task writes.

#### Undoing a cascade

Two fields on the response govern the undo, and they answer different questions —
read **both** before offering an undo affordance.

| Field | Answers | `null` / `false` means |
|---|---|---|
| `operation_id` | Is there a ledger row to reverse? | The cascade changed nothing, so nothing was recorded |
| `can_undo` | May **this caller** reverse one? | Your role is below Admin on this project |

`POST /api/v1/cascade-classification-operations/{operation_id}/undo/` reverses the
cascade, and it requires **Project Manager or above** — a strictly higher floor than the Team
Member the apply above admits. So a Member can receive a `200` here, with a real
`operation_id`, and still be refused the undo. `can_undo` is that answer, computed
from the same rule the undo endpoint enforces; read it rather than comparing role
ordinals yourself, exactly as with `can_author` on the project resource.

`can_undo` answers the **role** question only. Both batch undos —
`POST /api/v1/cascade-classification-operations/{operation_id}/undo/` and
`POST /api/v1/paste-many-operations/{operation_id}/undo/` — are separately refused
with a `403` once the project is **archived**, at every role including Owner.
Archiving makes a plan read-only; that is a property of the plan, not of the
caller, so no role clears it, and `can_undo` does not report it. Reading a ledger
row on an archived project still works — unarchive the project to undo.

#### Knowing before you apply

`can_undo` rides the apply response, so it arrives *after* the irreversible act. To
tell a caller **before** they commit a cascade that they will not be able to reverse
it, read `can_undo_batch_operations` on the **project** resource
(`GET /api/v1/projects/{id}/`, and on project list rows). It is the same predicate as
`can_undo`, on a payload you already hold.

| Read | When | To |
|---|---|---|
| `Project.can_undo_batch_operations` | Before the write | Disclose that the act will not be reversible by this caller |
| `can_undo` on the apply response | After the write | Decide whether to offer an Undo control |

Same caveats as `can_undo`: it is a **role** answer only, so it does not report the
archived-project refusal, and it does not tell you whether any *particular* operation
is still reversible — that is `operation_id`. Its scope is the batch-operation ledgers
(cascade classification and paste-many). It does **not** answer for structural
operations, whose undo rule is *actor-or-Admin* rather than a role floor: the person
who applied one may reverse their own even below Admin.

## Import templates

`GET /api/v1/import-templates/csv/` serves the same downloadable CSV template
used by the in-app import wizard, for scripted use — see
[CSV import](/features/csv-import-export/#download-the-template).

## Import provenance

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/projects/{project_pk}/imports/` | Member+ | Recent imports for the project, newest first — who imported what, when, the outcome, and what the import did not carry over. |

Page-number paginated (`{count, next, previous, results}`; `page`, `page_size`,
default 50, max 200). Each row carries `id`, `filename`, `status`
(`pending` / `dispatched` / `done` / `dead`), `creates_project`, `requested_at`,
`initiated_by` (integer user id), `initiated_by_username` (null once that user is
deleted), `task_count` (null until the import worker writes its summary), and
`warnings`.

Readable while the project is archived — it is a read-only provenance surface, so
unlike most project routes it is not gated on `IsProjectNotArchived`.

Rows are purged after `TRUEPPM_IMPORT_RETENTION_DAYS` (**default 7**), so this is a
recent-activity view rather than durable audit history. Full field semantics and the
warning-marker contract are on
[MS Project import & export](/features/msproject-import-export/#list-recent-imports-project-history).
