# ADR-0772: Task row ids are client-minted UUIDs, and `client_id` is that id — not a second name for it

## Status

Proposed — 2026-08-02, for #2726 (0.4). Gates #2723; child of epic #2739.

**Depends on ADR-0773 (#2719).** The replay guarantee in Decision §5 is conditional on
ADR-0773's `can_user_author_plan` predicate excluding `Role.SCHEDULER` from plan
authoring. Landing this ADR first would publish an idempotency guarantee that is false
for Schedulers — see *Why layer 2 is bounded* under Decision §5. Required order:
**ADR-0773 → ADR-0772 → #2723.** Both ADRs land in the same MR so the interaction is
reviewable in one place.

**`threat-model` gate: run 2026-08-02.** Accepting a caller-supplied primary key is a
trust-boundary change, the named trigger for the gate. It identified 12 threats, of
which 10 required changes to this ADR — all absorbed. Four materially changed the
design and are worth naming here, because each was a defect in an earlier revision
rather than a refinement of it:

1. **Client-minted ids are now scoped to `Task` only.** An earlier revision minted a
   `Dependency.id` in its own example while all four guards covered tasks alone.
2. **Dependency ops are gated at `IsProjectScheduler` and written through
   `DependencySerializer`.** Accepting edges under the batch view's `IsProjectMemberWrite`
   floor would have dropped dependency authoring one role and bypassed four controls.
3. **The `id_collision` reject code is collapsed to a non-asserting `id_unavailable`.**
   As drafted it would have re-opened **#359** — a closed security finding — at higher
   bandwidth than the shipped sync path leaks.
4. **The layer-2 replay guarantee is bounded, not universal.** An earlier revision
   claimed it held for every role once #2719 landed. It does not hold for a Member on
   an unassigned row, which is the common Designer case.

Two factual corrections also came from the gate: this endpoint has **no** batch size
cap (an earlier revision cited one), and 207 partial application **requires per-row
savepoints**, which neither this view nor `sync.upload` uses today.

Full analysis: `2726-threat-model.md` (STRIDE matrix, 12 threats, SOC 2 mapping).

## Context

The Project Designer (epic #2739) commits rows locally and reconciles with the
server. Case 07 goes further: a self-hosted install goes offline mid-session, the
Designer keeps a local edit journal, and replays it on reconnect. #2726 asks
whether that requires **client-minted task UUIDs**, or whether ids are
**server-assigned** with `client_id` as a per-request correlation token that dies
with the response.

The two answers produce different endpoints, which is why this blocks #2723.

### The question is already answered in shipped code

The offline sync push path has accepted caller-supplied primary keys since ADR-0082.
It is not a proposal or a partial implementation — it is the only way a `created`
row can land:

- `packages/api/src/trueppm_api/apps/sync/upload.py:285-287` — a created row
  **must** carry an `id`:
  `raise ValidationError({"tasks.created": "Each created row requires an 'id'."})`
- `packages/api/src/trueppm_api/apps/sync/upload.py:332` — the load-bearing line.
  The client's UUID becomes the Django primary key verbatim:
  ```python
  task = ser.save(id=row_id)
  ```
  There is no fresh-UUID branch and no remap. `result.created` echoes the same id
  back (`upload.py:337`), which is why the protocol needs no correlation map at all.
- `packages/api/src/trueppm_api/apps/projects/models.py:272` — the model that makes
  it possible: `id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)`.
- ADR-0710 §1 ("UUID primary keys, not auto-increment integers", `docs/adr/0710-versioned-model.md:70-86`)
  states the rationale, and at `0710:173` weighs the alternative this issue re-raises:
  *"Server-assigned integer + client temp-id reconciliation … would require every
  offline-created row to carry a temporary local id reconciled to a server id on next
  sync, adding a mapping layer the current design has no need for."*

  **Read that citation precisely.** ADR-0710 is explicitly a *retroactive* ADR
  (`0710:1,4-6`), and its alternatives table is prefaced as *"the alternatives a
  reviewer would naturally raise … not as alternatives this codebase's history shows
  were actually discussed and rejected"*. So ADR-0710 is **not** a prior deliberate
  decision that binds this one, and this ADR does not lean on it as precedent. It is
  corroborating reasoning. The load-bearing evidence is the shipped code above —
  `upload.py:285-287` requiring `id` and `upload.py:332` passing it to the PK — which
  is stronger than any ADR text, because it is what actually runs.
- ADR-0082 binds the wire shape (`docs/adr/0082-mobile-sync-upload-batch-atomicity.md:54,156`):
  `"created": [ { "id": "<client-uuid>", … } ]` → `Task.objects.create(id=<client uuid>, …)`.

So the platform already has one write path whose identity model is client-minted.
The only open question is whether the Designer's batch endpoint agrees with it or
forks from it.

### What does *not* exist today

- **No `client_id` anywhere in the API.** A repo-wide grep for `client_id` in
  `packages/api/src/` returns only OIDC relying-party config
  (`apps/sso/serializers.py:109`, ADR-0187). There is no per-row correlation token
  to preserve compatibility with; #2723 would be introducing the name, not keeping it.
- **No id remapping.** No `id_map` / `server_id` / temp-id table exists in the API
  or the mobile package. The client id *is* the server id.
- **No mobile client.** `packages/mobile/` is a bare React Native scaffold.
  WatermelonDB is not installed (`packages/mobile/package.json:19-31`);
  `src/db/schema.ts:2-3` and `src/sync/index.ts:2-3` are self-described *"EMPTY
  TYPED BOUNDARY"* files, filled by #41. So the *client* half of client-minted ids
  is unwritten — but the server half enforcing it is production code with tests
  (`packages/api/tests/apps/sync/test_sync_upload.py:186-199`).
- **`TaskBulkView` has no per-row identity for creates.**
  `packages/api/src/trueppm_api/apps/projects/views.py:7529` already carries
  `IdempotencyMixin` and locks its targets in one `select_for_update()`
  (`views.py:7823`). But `TaskBulkItemSerializer.id`
  (`apps/projects/serializers.py:5077-5084`) is required only for `update`/`delete`;
  a `create` op carries no id in and gets a server-minted one back
  (`_bulk_create_task`, `views.py:7684-7696`). Idempotency is whole-request only —
  `IdempotencyMixin` keys on `(user, Idempotency-Key)` plus a sha256 of method +
  path + raw body (`apps/idempotency/mixins.py:95,208-226`) and replays the entire
  stored response (`mixins.py:129-140`). There is nothing at row granularity.
- **`TaskSerializer` will not accept an `id` from the payload.** `VersionedModel.id`
  is `editable=False`, so DRF renders it read-only; the sync path injects it as an
  explicit `save(id=…)` kwarg, and `_STRIPPED_ROW_KEYS`
  (`apps/sync/upload.py:68`) removes `id`, `project`, and `wbs_path` from the row
  body before it ever reaches the serializer.

### The server still assigns WBS, and that is unchanged

The design brief's *"each row carries a client id; the server assigns the WBS"* is
already the shipped split. `wbs_path` is fully read-only on `TaskSerializer`
(ADR-0743 §1) and is stripped from sync rows (`upload.py:68`); `short_id` is
server-allocated from `Project.object_sequence` (ADR-0016;
`apps/projects/models.py:2194`, `editable=False`). A client minting the
primary key does not gain any authority over placement, ordering, or the
human-readable id.

**P3M layer:** Programs and Projects — single-project authoring and the offline
replay of one member's edits. **OSS** (`trueppm-suite`); no cross-program surface,
no Enterprise boundary implicated.

## Decision

**Task row ids are client-minted UUIDs. `POST /api/v1/projects/{pk}/tasks/bulk/`
accepts the caller's UUID as the primary key on a `create` op under the field name
`id`; the server never remaps it, and `client_id` is not introduced as a separate
correlation token.**

Five clauses follow from that sentence.

### 1. The field is `id`, not `client_id`

#2723 and epic #2739 both say "surface `client_id`". This ADR renames it. Under a
client-minted primary key the client id *is* the id, and a second name for the same
value is precisely how the identity model forks: one endpoint calls it `id`
(sync upload), one calls it `client_id` (batch), and the next reader has to
discover they are the same UUID. `TaskBulkItemSerializer` already declares
`id = serializers.UUIDField(required=False, allow_null=True)`
(`apps/projects/serializers.py:5077`); the change is to stop rejecting it on
`create` rather than to add a field.

`client_id` is reserved and must not be added to this endpoint. The name is also
already taken in this codebase by the OIDC relying-party id, which is a second
reason not to overload it.

### 2. `id` is optional on `create`; `index` is the correlation handle

- If `id` is present it becomes the primary key.
- If `id` is absent the server mints one and returns it. This keeps today's
  callers working (`useTaskMutations.ts:544` sends delete ops only, but an agent or
  script may already send create ops with no id).
- **Every entry in the 207 response — applied, rejected, and skipped — carries the
  zero-based `index` of its op in the request `operations` array.** `index` is the
  correlation handle, not `id`: a row rejected because its `id` is unparseable has
  no usable id, and a row that omitted one has none to echo. `id` is identity;
  `index` is correlation. Both are always present on a response entry (`id` is
  `null` only when a malformed create was rejected before an id could be resolved).

A create op with **no** `id` and **no** `Idempotency-Key` is not replay-safe and
will duplicate on retry. That is the caller's choice, and it is stated here so it
is a choice rather than a surprise. The Designer always mints.

### 3. Intra-batch dependencies are expressed by UUID — never positionally, never by name

This is the property the decision buys, and the reason it is worth the trust-boundary
cost. Because a Designer row's UUID is real before the row has ever reached the
server, an edge inside the same batch names both endpoints as plain task UUIDs, with
no reference syntax of any kind:

```jsonc
{
  "operations": [
    { "op": "create", "id": "3f1c…a1", "data": { "name": "Survey", "duration": 3 } },
    { "op": "create", "id": "9b40…c7", "data": { "name": "Design",  "duration": 5 } }
  ],
  "dependencies": {
    "created": [
      { "predecessor": "3f1c…a1", "successor": "9b40…c7",
        "dep_type": "FS", "lag": 0 }
    ]
  }
}
```

**Client-minted ids are scoped to `Task` only. `Dependency.id` is server-minted.**
`Dependency` is also a `VersionedModel` with a UUID PK (`apps/projects/models.py:3024`),
so an earlier revision of this ADR minted one in the example above. That was a mistake:
all four guards in *Security* below are written about task ids, and none of them would
have covered a caller-supplied `Dependency.id`. The forward-reference benefit this
section exists to buy needs client-minted **task** ids and nothing else, so the
trust-boundary surface is kept to the one model that requires it. An `id` supplied on
a dependency row is rejected, not ignored.

- **Forward references are legal.** An edge may name a task whose `create` op appears
  *later* in `operations`. Under server-assigned ids this is the case that forces a
  positional or by-name reference scheme; here it needs nothing.
- **Dependency ops are gated at `IsProjectScheduler`, checked per-op, and written
  through `DependencySerializer`.** The batch view's floor is `IsProjectMemberWrite`
  (`views.py:7554`), one role *below* `DependencyViewSet`'s `IsProjectScheduler`
  (`views.py:6157`). Accepting edges under the batch view's own gate would silently
  hand dependency authoring to Member. Checking per-op rather than per-request keeps
  the useful behavior: a Member's task ops apply, and only their edge ops reject.

  Writing through `DependencySerializer` rather than a direct `Dependency.objects`
  write is not a style preference — the serializer carries the ADR-0120 D2 consent
  gate, the cross-**program** rejection, the merged-program cycle check, and the span
  guard. A direct write re-implements four controls, which is the same failure mode
  ADR-0743 §4 warns about and the same one guard 4 catches for tasks.
- Apply is two-phase inside the existing single `transaction.atomic()`:
  **phase 1** materializes every task row (this is today's
  `_apply_bulk_operations`, `views.py:7806`); **phase 2** applies edges, after every
  node in the batch exists.
- Endpoints of an edge must resolve to a live task **in the URL-scoped project**
  (or a sibling project of the same Program, per ADR-0120 D1 — the existing
  `DependencySerializer` rule, `apps/projects/serializers.py:5610-5622`, is
  unchanged). An unresolvable endpoint rejects that edge row only.
- Positional references (`{"predecessor_index": 3}`) and name references
  (`{"predecessor_name": "Survey"}`) are **rejected as design options**, not merely
  unimplemented. Both are ambiguous under partial application: with per-row 207, op
  3 may not have been applied, and names are not unique.

### 4. `validate_task_graph` runs before any edge is written, over the union graph

`validate_task_graph` (`apps/scheduling/graph_guard.py:64`) is called today only by
the MS Project and Jira importers (`apps/msproject/tasks.py:147`,
`apps/jiraimport/tasks.py:116`). The batch endpoint must call it in phase 2, over
**existing persisted edges ∪ batch edges**, with the `children_map` built from the
post-phase-1 node set so summary→leaf logical cycles are caught the way the
interactive `DependencySerializer._check_no_cycle` path catches them
(`serializers.py:5871`).

A detected cycle rejects **the edge rows on the reported cycle path**, with
`code: "cyclic_dependency"` and the `offending` path in the message. It does **not**
reject the task rows already applied in phase 1, and it does not roll back the
batch. This is what keeps "one unparseable row out of 38 must not discard the other
37" true without weakening the guard: the guard is absolute over what gets written,
and what it refuses to write is exactly the edges that would close the cycle.

**Phase 2 is skipped entirely when the batch carries no dependency ops.** The union
graph is built from every persisted edge in the project, so its cost scales with
project size, not batch size — running it for a paste-many of 38 rows that creates no
edges would make the common case pay for the rare one. A batch with an empty
`dependencies` bucket cannot introduce a cycle, so there is nothing to check.

**`InvalidScheduleInput` is not a cycle and must not be reported as one.**
`validate_task_graph` can raise rather than return a cycle path — a malformed or
unresolvable graph input. That is a `400` on the batch as a whole, with
`code: "invalid_graph_input"`, not a per-edge `cyclic_dependency` rejection: there is
no identified cycle path, so there is no principled subset of edges to reject.

### 5. Replay semantics — `Idempotency-Key` is the guarantee; row replay is best-effort

**Layer 1 — request replay (`Idempotency-Key`).** The Designer sends one key per
batch. A byte-identical replay returns the stored 207 verbatim with
`Idempotent-Replay: true` and performs **zero** database writes, **zero**
`server_version` bumps, and **zero** broadcasts (`apps/idempotency/mixins.py:129-140`).
Reusing the key with a different body is a 422 (`mixins.py:38-44,124-125`). This
already works on `TaskBulkView`; the only new obligation is that a 207 body is
storable, which it is (status < 500, JSON-renderable — `mixins.py:183-206`).

**Layer 1 is the replay guarantee this ADR makes.** The Designer sends a key on every
batch, including every offline-journal replay. Nothing below weakens it, and nothing
below is needed for the acceptance criterion in #2723 to pass.

**Layer 2 — row replay (structural, no key needed) — is best-effort, and is
explicitly NOT universal.** Without a key — or with a new key over an overlapping
batch — the batch re-applies by id. A `create` op whose `id` already exists **in this
project** is not a duplicate and not an error. It applies as an **in-place edit
under the stricter PATCH permission** (`can_user_edit_task`), exactly as
`sync.upload._apply_created_row` does (`upload.py:299-322`), and is reported as
`applied` with `outcome: "updated"`. No second task is ever created.

**Where layer 2 does not hold, and why that is accepted rather than fixed here.**
Because the repeat create is routed through the *edit* bar while the original passed
the *create* bar, it succeeds only for callers who may edit the row: Admin and above,
and a Member on a row assigned to themselves. It **fails for a Member on an unassigned
row**, which is the common Designer case. See the blocking note below for why, and for
the two alternatives that were considered and deferred.

This is a deliberate scope choice, not an oversight: the two candidate fixes both
widen a permission predicate, and widening `can_user_edit_task` is #2719's decision to
make on its own merits — not something this ADR should force through a replay
requirement. Clients get a complete, universal replay guarantee today via
`Idempotency-Key`; layer 2 remains a convenience that degrades to a `403` rather than
to data corruption.

Response `outcome` vocabulary on `applied[]`: `created` | `updated` | `unchanged`.
`skipped[]` is a documented no-op, never a failure — it carries the tombstone case
below and the milestone-cascade case #2723 already specifies. `rejected[]` carries
`{index, id, code, message}`.

**Residual cost, stated rather than hidden:** a keyless replay of identical content
still runs a serializer save, so it bumps `server_version` and `sync_seq` and emits
`task_updated`. It does not create a duplicate row, which is the property that
matters, but it is not free. Send the `Idempotency-Key`.

#### Why layer 2 is bounded — the two roles the create and edit bars disagree on

Layer 2 routes a repeat `create` through the **edit** permission, while the original
`create` passed the **create** bar. Those two bars disagree for **two** roles, not one.

**Scheduler.** `IsProjectMemberWrite` admits any role ≥ `Role.MEMBER`, which includes
`Role.SCHEDULER` (`apps/access/permissions.py:299`), but `can_user_edit_task` returns
`False` for `Role.SCHEDULER` outright (`:161-162`). So a Scheduler's first batch
succeeds and a byte-identical replay **403s**. This one #2719 does fix, by excluding
Scheduler from plan authoring via `can_user_author_plan`.

**Member — and this is the one that matters.** `can_user_edit_task`'s Member branch
(`apps/access/permissions.py:165-167`) is:

```python
if role == Role.MEMBER:
    assignee_id = getattr(task, "assignee_id", None)
    return assignee_id is not None and assignee_id == request.user.pk
```

A Member may edit only a task **assigned to them**. So a Member who creates an
**unassigned** task — which is the dominant Designer and paste-many case, since rows
are authored as structure before anyone is staffed to them — gets `False` on replay.
The byte-identical replay **403s for Member too**, and `can_user_author_plan` does
nothing about it: the Member is legitimately an author, the row is simply not theirs
to edit yet.

**An earlier revision of this ADR claimed the bars disagree "for exactly one role"
and that #2719 makes layer 2 hold universally. That was wrong.** Layer 2 as specified
is not replay-safe for the single most common authoring path in the feature it exists
to serve.

**Resolution — option 3 of three considered.**

1. *Route an unchanged repeat-create through the create bar.* The caller demonstrably
   had the right to create this exact row, so replaying it changes nothing. Rejected
   for now: "unchanged" is hard to define against server-computed fields, and getting
   it slightly wrong turns a permission check into a bypass.
2. *Grant the row's creator edit rights on their own unassigned rows.* Arguably correct
   independent of replay — a Member who authors structure should be able to correct it.
   Deferred deliberately: it widens `can_user_edit_task` for every caller, which is
   **#2719's matrix decision**, and it should be taken there on its own merits rather
   than smuggled in as a replay fix. Recorded on #2719 as a question the matrix should
   answer.
3. **Chosen: bound the layer-2 claim.** `Idempotency-Key` is the replay guarantee;
   structural row replay is a documented best-effort convenience that degrades to
   `403`, never to a duplicate row or a corrupted plan. This costs the "safe by
   construction" phrasing an earlier revision advertised, which the `threat-model` gate
   showed was never true.

**Landing order is unchanged — ADR-0773 → ADR-0772 → #2723 — but for a different reason
than originally stated.** ADR-0773 is required because the Scheduler case is a live authoring
defect (a Scheduler can create a task they cannot then edit or delete), not because it
rescues the replay guarantee. It never could have: the Member case is outside its
reach.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Client-minted UUID as the primary key** (chosen) | Matches shipped `sync.upload` and ADR-0710/0082 exactly — one identity model across both write paths. Intra-batch and cross-batch references work with no reference syntax. Replay-safety is structural. No mapping layer, no correlation table. | The API accepts a caller-supplied primary key: a trust-boundary change requiring the four guards in *Security* below. |
| **Server-assigned id + per-request `client_id` correlation token** | The PK stays server-owned; no id-forgery surface at all on the batch endpoint. | Contradicts shipped behavior: `upload.py:332` already takes the client's UUID as the PK, so the platform would have two identity models for two write paths on the same table. Offline rows could not reference each other until they land, forcing positional or by-name intra-batch dependencies — both ambiguous under per-row 207 partial application (see §3). A local journal replayed after reconnect (case 07) would need a temp-id→server-id map maintained across sessions — the mapping layer ADR-0710:173 rejected. Rejected. |
| **Client-minted id, but as a *separate* `client_id` field distinct from the PK** | Keeps the PK server-owned while giving the client a stable handle. | This is a mapping layer with a friendlier name: the server must persist `client_id`, index it, scope it, and resolve it on every subsequent reference — including references from a *later* batch. It also gives a `Task` two identities and two uniqueness questions. Rejected. |
| **Require UUIDv4 specifically, and reject other versions** | Superficially narrows the id space a caller can choose. | Not a security control. Version bits are self-asserted; an attacker sets them. The boundary that matters is project scope (§Security 2), which holds for any well-formed UUID. Adding the check would also diverge from `sync.upload`, which accepts any parseable UUID (`apps/sync/serializers.py:38-44`). Rejected — well-formedness is validated, version is not. |

## Consequences

### Sync protocol

- **No protocol change.** `POST /api/v1/projects/{pk}/sync/` keeps its shape,
  its `client_batch_id` envelope, and its `created`-bucket upsert. This ADR aligns a
  second endpoint with the sync path's existing identity model rather than changing
  the sync path.
- A row authored in the Designer and a row authored on mobile are now
  indistinguishable to the server, which is the point: a task created in the
  Designer, pulled to a phone, edited offline, and pushed back travels under one id
  the whole way.
- The batch endpoint stays **REST**, not a second sync surface. `WRITABLE_COLLECTIONS`
  on the sync push remains `frozenset({"tasks"})` (`upload.py:51`) and is not widened here.

### Conflict model

- **A `create` has no conflict base**, so the whole `base_version` question is
  inapplicable to the op the Designer runs most. Conflict handling attaches only to
  `update` ops and to the create-into-an-existing-id branch.
- **The batch endpoint must take its conflict base from an explicit per-row
  `base_version` and must NOT implement a batch-level watermark fallback.** This is
  a deliberate divergence from `sync.upload._row_base_version`
  (`upload.py:131-152`) and it is how this ADR interacts with #2499 — see below.
- Absent `base_version`, an `update` is plain last-writer-wins, and the response
  says so rather than implying a guard ran.

### Security — a client-mintable primary key is a trust-boundary change

The batch endpoint must reproduce all four guards the sync upload already
implements. None of them is optional, and each has a named failure it prevents.

1. **Well-formedness, before any ORM query.** Every `id` in the batch is validated
   as a parseable UUID up front. This is not cosmetic: an unparseable id reaching
   `Task.objects.filter(pk__in=…)` raises a Django-core `ValidationError`/`ValueError`
   at query build that DRF does not catch — a 500 (#1730). Mirror
   `apps/sync/serializers.py:38-44,540-554`. Under 207 this becomes a **per-row
   reject** with `code: "malformed_id"` and `id: null`, correlated by `index`.
2. **Cross-project collision → per-row reject, never a silent foreign-row mutation.**
   This is the IDOR (#887). The existing-row fetch must be **project-scoped**
   (`upload.py:214-243`); ids absent from that fetch are then probed
   project-unscoped *only* to distinguish a genuine foreign row from a fresh id
   (`_cross_project_created_ids`, `upload.py:246-266`). Without the scoping, a
   caller could mint an id that collides with a task in a project they cannot see
   and mutate it using their role on the **URL** project. In `sync.upload` this
   aborts the request with a 409 `SyncIdCollision` (`upload.py:78-94,288-289`);
   under 207 it must instead be a **per-row reject**. The whole-request 409 is not
   carried over: it would let one foreign id discard 37 good rows.

   **The reject code must be a non-asserting `id_unavailable` — not `id_collision`.**
   An earlier revision of this ADR specified `id_collision`, which would have reversed
   a closed security finding. **#359** (closed, `security`) was filed precisely so a
   foreign UUID is indistinguishable from a permission failure, and its rationale is
   still carried in the code in two places: *"a non-member submitting a foreign UUID
   always gets 403 regardless of whether the two UUIDs share a project — preventing
   membership inference from the error code (ADR-0055 / #359 hardening)"*
   (`apps/projects/serializers.py:5700-5708, 5818-5828`).

   A code that says *this id exists in a project you cannot see* is an existence
   oracle, and 207 makes it worse than the shipped sync path: sync aborts the request,
   so a caller learns one bit per request, while per-row rejection yields **N bits per
   request**. The sibling path in this same view already gets this right —
   `_lock_bulk_targets` reports foreign and nonexistent ids identically.

   Collapsing costs the client nothing: the remedy is *mint a new UUID and retry* in
   both cases, so the distinction was never actionable. Exploitability is genuinely
   low — task UUIDs are not enumerable, so the oracle only confirms ids the caller
   already holds — but #359 was decided on exactly those "near-zero exploitability"
   grounds and closed anyway. Re-opening it silently, at higher bandwidth, is not a
   decision this ADR gets to make by omission.
3. **Tombstone resurrection is impossible, and is reported as `skipped`.** A create
   whose id matches a soft-deleted row in this project is skipped — not applied, not
   rejected, no `server_version` bump, no broadcast (`upload.py:290-298`, #1730).
   `is_deleted` is not writable, so the row could not be resurrected even without the
   guard; the guard exists so the re-create branch does not run a full serializer save
   on a dead row and emit a spurious `task_updated`. Note tombstones are a soft-delete
   flag on `VersionedModel` (`apps/projects/models.py:278`), not a separate table, and
   they are retained on a grace window (ADR-0197) — a reaped tombstone's id becomes
   freshly mintable, which is correct and harmless.
4. **Privilege boundary on the upsert branch — the trap worth naming.** The create
   bar is `role >= MEMBER` (`IsProjectMemberWrite`); the edit bar is stricter
   (`can_user_edit_task`, ADR-0133: Admin+ edits any task, a Member only their own).
   A create-with-an-existing-id is an **edit**, so it must be checked against the
   edit bar, not the create bar (`upload.py:302-303`). Getting this backwards turns
   a client-mintable id into a privilege-escalation primitive: a Member mints the
   id of a task assigned to someone else and rewrites it as a "create".

Two further rules, carried over verbatim:

- **`project` is always injected from the URL, never read from the row**
  (`upload.py:329`). A push can never create into a different project.
- **`id`, `project`, and `wbs_path` are stripped from the row body**
  (`_STRIPPED_ROW_KEYS`, `upload.py:68`) and `id` reaches the model *only* as an
  explicit `save(id=…)` kwarg. **Do not make `id` writable on `TaskSerializer` to
  achieve this.** `TaskSerializer` is shared by the plain REST create
  (`POST /api/v1/projects/{id}/tasks/`), the sync upload, and this endpoint; making
  the field writable would silently hand a caller-supplied PK to every one of them.
  ADR-0743 §4 is the precedent — one declaration covers REST and sync, and the way
  enforcement drifted apart before was re-stating the rule in one place and not the
  other.

Three further requirements the 207 contract introduces, none of which the sync path
needs because it aborts wholesale:

- **Per-row savepoints.** A database-level reject — an `IntegrityError` from a
  constraint the serializer did not catch — poisons the enclosing transaction, and any
  subsequent query raises `TransactionManagementError`. Per-row continuation is
  therefore impossible inside a single flat `atomic()`: each row must be applied inside
  its own savepoint (`transaction.atomic(savepoint=True)`) so one row's failure rolls
  back only that row. Neither `sync.upload` nor `TaskBulkView` does this today because
  both abort the whole batch; this is genuinely new territory, not a refactor. The
  precedent for savepoint use in this view is its own `IdempotencyMixin`.
- **Create-op ids join the lock set.** `_lock_bulk_targets` (`views.py:7846`) currently
  locks only update and delete targets in its `select_for_update()`. Under the upsert
  branch a create id may resolve to an existing row, so create ids are known up front
  and must be locked with the rest — otherwise the existence check and the write are a
  TOCTOU window, and two concurrent batches minting the same id can interleave.
- **A batch size cap.** See *What this ADR does not decide* — the number is #2723's to
  set, but the cap is required, not optional.

**Accepted residual risks**, stated so they are decisions rather than oversights:

- **Id squatting within the caller's own project.** A member may mint an id that a
  future legitimate row would have used; the later minter then gets an in-place edit
  or a per-row `id_unavailable`. Severity is low — the squatter can already create
  tasks in that project — and the batch cap plus the existing per-user throttles bound
  the volume. No further mitigation.

  **Correction to an earlier revision:** this paragraph previously cited a "500-row
  batch cap" on this endpoint. **No such cap exists.**
  `TaskBulkSerializer.operations` is `ListField(child=…, min_length=1)` with **no
  `max_length`** (`apps/projects/serializers.py:5095-5098`), and `TaskBulkView`
  declares no `throttle_classes`. The 500 cap is `sync/upload.py:75` — sync-path only.
  The real bounds today are `DATA_UPLOAD_MAX_MEMORY_SIZE` (100 MB) and the global
  per-user throttle. This risk is accepted *conditional on the cap being added*.
- **Tombstone existence within the caller's own project.** Guard 3 reports a create
  against a soft-deleted id as `skipped`, which tells the caller that id once existed
  here. Accepted rather than mitigated: the caller is already a project member and can
  see the project's task list, so this reveals nothing they could not otherwise learn.
  Named here because an earlier revision described the skip as informationally inert,
  which is not quite true.
- **Unguessability is not a permission boundary and is not relied on.** Project scope
  (guard 2) plus the edit-permission check (guard 4) are the boundary; a caller who
  guesses a valid id still cannot reach a row outside their project or edit one they
  lack rights to.
- **UUID *version* is not validated.** Rejecting non-v4 UUIDs was considered and
  declined: version bits are self-asserted by the caller and therefore prove nothing,
  project scope is the real boundary, and enforcing it here would diverge from the
  sync path for no security gain.

### Interaction with #2499 (inert upload conflict guard)

**Neutral by construction, and this ADR contains the defect rather than spreading it.**

#2499 is that `_row_base_version` (`apps/sync/upload.py:131-152`) falls back to the
batch's `last_pulled_at` when a row omits `base_version`, and `_evaluate_conflict`
(`apps/sync/conflict.py:147`) then computes `instance.server_version <= base_version`
and returns "no conflict". Post-ADR-0686 the defect is *worse* than the issue text
says: `last_pulled_at` is now `Project.last_sync_version`
(`apps/sync/views.py:709-725`), so line 147 compares a `server_version` against a
`sync_seq` — two unrelated number lines, not merely a mis-scaled aggregate. The
downstream arithmetic is what pins it: `gap = current - base_version` slices exactly
that many `HistoricalRecords` rows (`conflict.py:85-94`), which is valid only on a
per-row save counter.

Consequences for this decision:

- **This ADR does not depend on #2499 being fixed.** A `create` has no base version,
  so the Designer's dominant op never touches the broken path.
- **This ADR must not port the defect.** The batch endpoint takes its conflict base
  from an explicit per-row `base_version` only (Decision §Conflict model). Adding a
  `last_pulled_at`-style fallback would replicate #2499 in a new endpoint, in the
  same release, after it was already documented.
- **Client-minted ids make #2499 more consequential over time without causing it.**
  More offline authoring means more `update` ops replayed from stale bases, which is
  exactly the population the inert guard silently last-writer-wins. #2499 is
  milestoned 0.5; that remains right, and this ADR does not move it.

### Interaction with #2512 (`MeWorkView` `MAX(server_version)` cursor)

**No interaction. Neutral.** #2512 is not in the sync app at all — it is
`server_version_high_water = queryset.aggregate(Max("server_version"))`
in `MeWorkView` (`apps/projects/views.py:14023-14026`), a per-user cross-project
*read* cursor published in the docstring (`views.py:13819`), `docs/api/openapi.json:6272`,
and `packages/web/src/hooks/useMyWork.ts:236`. Nothing filters on it yet
(no `?since=` is parsed), so it is a bad published contract rather than data loss.
Row identity does not touch it in either direction.

One instruction follows for #2723 and the Designer: **do not adopt
`server_version_high_water` as a cursor.** It instructs a client to do the #2491
thing, which is why #2512 exists.

### Other

- **Mobile #41 must call WatermelonDB's `setGenerator`.** WatermelonDB's default
  `randomId()` does not produce UUIDs, and `apps/sync/serializers.py:540-554` will
  400 the entire batch. Nothing in ADR-0026, ADR-0082, or ADR-0191 says so.
  Restating it here because this ADR makes "the client mints a parseable UUID" a
  platform-wide obligation, not a mobile detail.
- **`SyncEngine.push` returns `Promise<void>`** (`packages/mobile/src/sync/index.ts:51`),
  which cannot carry back the per-row `server_version` or the `conflicts` array the
  server returns. That boundary needs widening before it is implemented against.
- Existing callers are unaffected: `useBulkDeleteTasks`
  (`packages/web/src/hooks/useTaskMutations.ts:535-548`) sends delete ops only.
- The response status changes from 200 to 207, and the body from
  `{created, updated, deleted}` to `{applied, rejected, skipped}`. That is #2723's
  change, not this one, but it is a breaking change to a published endpoint and
  belongs in the same MR as the `api-docs` regeneration.

## Implementation Notes

- **P3M layer:** Programs and Projects (OSS).
- **Affected packages:** `api` (the batch endpoint), `web` (Designer), `mobile`
  (#41 must honor the same rule). Not `scheduler`, not `helm`.
- **Migration required:** no. `VersionedModel.id` already is a client-generatable
  UUID PK; no model or index changes.
- **API changes:** yes — `POST /api/v1/projects/{pk}/tasks/bulk/` accepts `id` on
  `create`, gains a `dependencies` bucket, and returns 207. Regenerate
  `docs/api/openapi.json` via `scripts/export-openapi.sh` after merging `origin/main`.
- **OSS or Enterprise:** OSS (`trueppm-suite`). Single-project authoring; no
  cross-program or governance surface.
- **Reuse, do not re-derive.** The four guards, the tombstone skip, the
  project-scoped bulk fetch, and the upsert-under-PATCH-permission branch all exist
  in `apps/sync/upload.py:214-338`. #2723 should extract them into a shared helper
  rather than write a second implementation that can drift — ADR-0743 §4 is the
  standing rule and the reason it exists.
- `_enqueue_recalculate` and `broadcast_board_event` still fire once per request,
  after commit, over the *applied* set (`views.py:7609-7616`) — a partial 207 must
  not broadcast ids it rejected.

### Durable Execution

1. **Broker-down behaviour:** unchanged. The write commits; `_enqueue_recalculate`
   is deferred with `transaction.on_commit()` and a broker outage delays the CPM
   recompute, not the authoring write.
2. **Drain task:** none introduced.
3. **Orphan window:** phase 1 and phase 2 share one `transaction.atomic()`, so a
   crash between them cannot leave tasks without their batch's edges.
4. **Service layer:** the shared guard helper extracted from `apps/sync/upload.py`;
   `validate_task_graph` from `apps/scheduling/graph_guard.py`.
5. **API response on best-effort dispatch:** 207 reports what was *persisted*. It
   never reports scheduling results, which arrive later over the board WebSocket.
6. **Outbox cleanup:** unchanged; no new outbox rows.
7. **Idempotency:** two layers, both specified in Decision §5 — `Idempotency-Key`
   at the request level (`IdempotencyMixin`, ADR-0170), upsert-by-client-id at the
   row level. The row layer is the one that survives a client that lost its key.
8. **Dead-letter / failure handling:** a rejected row is returned to the caller in
   `rejected[]`, not queued or retried server-side. The Designer's local journal is
   the retry buffer.

## What this ADR does not decide

- **Whether the plain REST create (`POST /api/v1/projects/{id}/tasks/`) accepts a
  client `id`.** It does not today (`id` is read-only on `TaskSerializer`) and this
  ADR does not change that. Genuinely undecided in `docs/adr/`; leave it that way
  until something needs it.
- **The rest of #2723's contract** — the `rejected[]` error-code vocabulary, the
  milestone-cascade `skipped` shape, and whether `dependencies` ships in the same MR
  as `operations`. This ADR fixes identity and the reference model; #2723 owns the
  rest.
- **The batch size cap's *value*, and whether task and dependency ops share one
  budget.** That a cap is **required** is decided here (see *Security*); the number is
  #2723's. Two anchors: `sync/upload.py:75` uses 500, and a cap materially below the
  largest realistic paste-many would make the feature feel arbitrary. It must also be
  enforced in the serializer (`max_length` on `operations`), not only documented — the
  absence of one today is exactly how the ADR came to assert a cap that did not exist.
- **Agent attribution for batch writes.** A `legacy:full` token authoring through this
  endpoint produces **no `AgentAction` row at all** — `record_agent_action` has two
  call sites and neither is on this path. This ADR's decision to accept a
  caller-supplied PK neither creates that gap nor closes it. Tracked as **#2749**
  (0.5).

  **This is not an MCP concern in 0.4, and #2723 does not breach the read-only
  guarantee.** MCP write access is blocked at the *authentication* layer, not
  per-endpoint: `TaskBulkView` does not override `authentication_classes`
  (`views.py:7529`), so it inherits `OwnerScopedApiTokenAuthentication`
  (`settings/base.py:1216`), which rejects any token that is not `is_personal` **and**
  carrying `legacy:full` (`authentication.py:267-269`). An `mcp:read` token fails
  authentication before any permission class runs, and MCP's read surface is the
  explicitly-marked `McpReadableViewMixin` viewsets. So this endpoint requires no new
  gate to stay unreachable from MCP in 0.4.

  The audit gap binds at the moment agents can genuinely write, which under the
  **0.4 read-only / 0.5 read-write** MCP policy is 0.5 — where it pairs naturally with
  the write-scope taxonomy, since there is currently neither a scope meaning "may
  write" nor an audit row when a write happens. #2720's ordering constraint is
  therefore satisfied in 0.4 by MCP being read-only.
- **The fix for #2499.** Named, bounded, and explicitly not ported. Still 0.5.
- **The fix for #2512.** Untouched. Still 0.5.
- **Widening the sync push writable surface** beyond `tasks`
  (`upload.py:51`). Unrelated route, unrelated decision.
- **The Designer's local edit journal format, its replay ordering, and the
  conflicting-rows review branch** (case 07 / #2725). This ADR guarantees the
  journal *can* be replayed by id; it does not say how the journal is stored or how
  the review branch is presented.
- **Tombstone retention length** (ADR-0197) and whether a reaped id should be
  permanently burned. Current behavior — a reaped id is freshly mintable — is
  accepted as correct and not revisited.

## Related ADRs

- **ADR-0773** — the Project Designer authoring RBAC matrix. Hard predecessor: it
  supplies `can_user_author_plan`, without which this ADR's replay semantics are
  role-dependent in a way the endpoint cannot express.
- **ADR-0710** — `VersionedModel`; §1 is the original client-generatable-UUID
  decision this ADR extends from the sync path to the batch path.
- **ADR-0082** — Mobile sync upload batch atomicity; binds the
  upsert-on-client-id wire contract this ADR mirrors.
- **ADR-0686** — the delta cursor is `sync_seq`, not `server_version`; why
  `last_pulled_at` and a row's `server_version` are different number lines.
- **ADR-0217** — field-level conflict merge and `X-Base-Version`; the per-row
  conflict base this ADR requires the batch endpoint to use explicitly.
- **ADR-0170** — `Idempotency-Key`; replay layer 1.
- **ADR-0743** — one declaration covers REST *and* sync; the rule against
  re-stating a guard in two places.
- **ADR-0133** — `can_user_edit_task`; the edit bar guard 4 depends on.
- **ADR-0197** — tombstone retention window.
- **ADR-0016** — `short_id`; the other, server-allocated identifier.
- **ADR-0120 D1** — same-Program cross-project dependency edges.
