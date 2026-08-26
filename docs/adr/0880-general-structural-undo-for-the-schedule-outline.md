# ADR-0880: General structural undo for the schedule outline

## Status
Accepted

## Context

Issue #2974 (part of #2946, surfaced by #2948) states the gap plainly: the session trail
records every structural act on the Schedule outline, and **nothing can reverse one**.
Issue #3006 is the same gap seen from one endpoint — `ungroup` soft-deletes its wrapper,
so "re-group to put it back" mints a new container id and loses the wrapper's name,
notes, labels, and its own dependency edges.

Today the outline has exactly two undo affordances, both narrow:

- **Delete** — `POST /tasks/{id}/restore/` behind a toast (`useRestoreTask`, #2078 / ADR-0494).
- **Template apply** — `POST /template-applications/{id}/undo/` (ADR-0789).

ADR-0810 added three more operation ledgers (`PasteManyOperation`,
`CascadeClassificationOperation`, and `CsvImportRequest`'s undo fields). **None of them
covers a structural act.** Indent, outdent, reparent, reorder, group and ungroup — the six
acts that actually shape the WBS — record nothing and reverse nothing.

**P3M layer:** Programs and Projects (single-project schedule authoring) — OSS.

### Research findings that shape this decision

**1. `wbs_path` is the *only* representation of parenthood.** There is no `parent_id`
column on `Task`. `structural_parent()` (`models.py:2371`) says so explicitly: *"Parenthood
in this tree is the ltree `wbs_path`, not a FK — there is no `parent_id` column to read."*
The `parent_id` the API returns is a derived `RawSQL` annotation (`views.py:3799`), not
storage. **This is what makes a general inverse possible at all**: the entire outline shape
is one string per row, so "restore the shape" is "restore N strings."

**2. Nothing enforces WBS integrity — at any layer.** Verified against the tree:
- No `UniqueConstraint` on `(project, wbs_path)`. `Task.Meta.constraints` carries exactly
  one constraint, on `(project, short_id)` (`models.py:3016`). Every migration touching
  `wbs_path` adds only the GiST index (`0001_initial.py:144`).
- `LtreeField` (`fields.py:8`) has no validators, no `clean()`. Postgres `ltree` enforces
  label syntax and nothing else — not uniqueness, not "every ancestor exists."
- No management command, no Django check, no test asserting no-orphans/no-duplicates
  against a live project. The only duplicate check in the tree is a *seed-fixture*
  validator (`seed/validation.py:480`) that never runs against the database.

Correctness is an emergent property of every write going through a small set of server
functions that always rewrite a **whole, self-consistent level** in one transaction.

**3. A duplicate `wbs_path` is not cosmetic — it silently corrupts the next write.**
`_subtree_snapshot` (`task_grouping.py:184`) buckets descendants into a
`dict[str, list[Task]]` **keyed by the root's path string**. Two roots sharing a path
collapse into one bucket. `_move_root` (`:218`) then rewrites those descendants once for
root A (mutating the in-memory instances *and* the DB), and a second time for root B using
a stale `old_path` offset — `str(descendant.wbs_path)[len(old_path):]` slices an
already-rewritten string at the wrong index and writes a garbled path. Meanwhile the
derived `parent_id` subquery is a `LIMIT 1` with **no `ORDER BY`** (`views.py:3799`), so
which twin a subtree hangs under flips nondeterministically between requests, and
`computeWbsCodes` (`utils/computeWbsCodes.ts:18`) renders the twins with *distinct*
contiguous display codes — cosmetically hiding the duplicate from the user.

A **gap** (1, 2, 4), by contrast, is harmless and self-healing: `_renumber_siblings`
(`views.py:7631`) and `rewrite_level` (`task_grouping.py:235`) both recompute numbering
with `enumerate(..., start=1)` over `order_by("wbs_path")` and ignore the stored numbers.
`staging_base`'s docstring says as much. **Gaps heal; duplicates corrupt.**

**4. An orphan is silently promoted to root.** A row at `1.2.1` with no row at `1.2`
resolves `parent_id = NULL`, and `computeWbsCodes` buckets it under the roots — it renders
flat, at top level, with no error and no signal. The user's subtree does not look broken;
it looks *moved*.

**5. `assert_graph_feasible()` is not the safety net it looks like.** It is wired into
`perform_group`/`perform_ungroup` only — not indent, outdent, reparent, reorder, or any
bare `wbs_path` write. And its own docstring (`task_grouping.py:361`) states that under
today's expansion rules neither operation changes any summary's leaf set, so **it cannot
fire today**. It is a tripwire for a future change, not live protection.

**6. `sync_structure_shadow_values()` is never called on indent/outdent/reparent/reorder.**
It runs only in `perform_create`, `perform_destroy`, and group/ungroup. A leaf that became
a phase by having a row *indented under it* never had its `own_status`/`own_estimate`
parked or its `structure_role` promoted. This is a pre-existing forward-path bug,
independent of undo.

**7. The house style against a polymorphic table is narrower than ADR-0810 implies.**
The cited docstring (`models.py:7484`, `ProgramExportJob`) argues against *"a discriminator
column [that] would leak nullability through the serializer, services, and tasks for no
gain."* The tree carries three healthy counter-examples where one table + a discriminator
+ an opaque JSON payload is the accepted shape: `AuditEvent` (`workspace/models.py:781`),
`TaskActivityEvent` (`projects/models.py:6673`), `WebhookDelivery`
(`webhooks/models.py:319`). No ADR states a project-wide rule; ADR-0219 decided it for
exports and ADR-0810 cited that decision as precedent. The operative distinction the
docstrings actually draw is: **a discriminator over rows that each need their own service
and undo logic is rejected; a discriminator over a homogeneous stream handled by one code
path is the norm.**

**8. Undo RBAC today is a pure role threshold, and it is already asymmetric.**
`_require_admin` (`batch_operation_views.py:46`) demands `Role.ADMIN`, reasoning: *"A plain
Member may have authored the paste/cascade under Author mode, but undoing it removes work
other collaborators may already be building on top of."* ADR-0773's matrix lists
paste-many as ✅ for Member — so a Member may *perform* it and may not *reverse* it. The
tree does contain "actor may act on their own record" precedents:
`IsProjectAdminOrSessionOwner` (`workshops/permissions.py:15`) and
`SignalCeilingProposalWithdrawView` (`signal_privacy_views.py:428`). Existing tests
(`test_batch_operations_undo.py`) only ever assert *a Member who is not the actor* gets
403; the actor-undoing-own case is not exercised.

**9. Multi-select indent fires N independent requests.** `TaskListRow.tsx:418` loops
`targets.forEach((id) => buildMode.indent(id))` — one gesture, N transactions, N trail
entries. Any per-request ledger inherits that fan-out.

## Decision

### 1. One `StructuralOperation` model, not six siblings

All six acts are the same operation type — *a WBS restructure* — and the undo is fully
**kind-agnostic**: one code path, no branching on `kind`. Per finding 7 this sits on the
accepted side of the house style, not the rejected one; ADR-0810's own consequence note
("revisit only if a fifth near-identical use case appears") is satisfied at six.

The payload fields are **not per-kind nullable columns**. They are the three universal ways
any structural act can change a row set — it can *move* rows, *add* rows, or *remove* rows:

| field | meaning |
|---|---|
| `shape_before` (JSON) | `{"<task id>": "<wbs_path>"}` — the affected shape before the act |
| `shape_after` (JSON) | `{"<task id>": "<wbs_path>"}` — the affected shape after the act |
| `created_task_ids` (array) | rows the act minted (group's container) |
| `deleted_task_ids` (array) | rows the act soft-deleted (ungroup's wrapper) |
| `removed_dependency_ids` (array) | edges the act removed (ungroup) |

An act that touches none of these is not structural. `kind` is descriptive — it feeds the
trail sentence and nothing else.

Plus: `id`, `project` FK, `applied_by` FK, `undone_by` FK (nullable — §4 permits a
different user to reverse, and `undone_at` alone records that it happened but not who did
it), `anchor_task_ids` (array — the rows the forward act explicitly gated on, see §4),
`status` (`SyncBatchOperationStatus`, reused), `undoable` (bool, see §7),
`created_at`, `undone_at`, `result_summary`. No `server_version` — this is a server-side
ledger, not a synced entity (matching `PasteManyOperation`).

### 2. 🔴 Undo is ALL-OR-NOTHING, and the precondition covers ALL FOUR dimensions

**Confirmed — the proposal's partial-undo path was wrong and is rejected.** Findings 2–4
establish that a partial `wbs_path` restore can produce a live duplicate, which corrupts
the *next* structural write (finding 3) with no signal at any layer. The existing
`_partition_touched` is safe for paste-many and cascade because their fields are
independent per row. `wbs_path` is a tree; its rows are not independent.

The guard is a **state-identity precondition**, not a version comparison. Undo proceeds
only if *everything the operation would write back* is still exactly as the operation left
it:

| dimension | precondition |
|---|---|
| `shape_after` | the live shape under the affected paths is **exactly** `shape_after` — same id set, same `wbs_path` each |
| `deleted_task_ids` | every row is still `is_deleted=True` and still carries the `wbs_path` the act left it at |
| `removed_dependency_ids` | every edge is still `is_deleted=True` |
| `created_task_ids` | every row is still live and its `server_version` is unchanged since the act |

Otherwise it refuses with `409` naming exactly what differs.

**The fourth-dimension coverage is load-bearing, not thoroughness.** The `threat-model`
gate's T1 caught that an earlier draft applied the precondition to `shape_*` only and then
used that guarantee to justify relaxing the role bar in §4 — but a soft-deleted row is
absent from both `shape_after` and the live shape, so the shape check matches *whatever
happened to it*. Undo would have restored a container and its CPM edges into a region
other collaborators had since worked in: precisely the hazard `_require_admin` exists for.
§4's argument is only valid because all four dimensions are covered here.

The shape half is deliberately *stricter and more precise* than `_partition_touched`:

- **Stricter** — `_partition_touched` compares `server_version` per row and skips the
  ones that moved. This compares the whole affected region and refuses if *anything*
  differs, including a row someone else **added** into the region. A row added under the
  restored parent is invisible to a per-row version check and is exactly what produces an
  orphan (finding 4).
- **More precise** — `server_version` bumps on *any* write, so renaming a task would block
  undoing an unrelated indent. `wbs_path` identity ignores field edits and reacts only to
  shape changes, which is the only thing undo actually disturbs.

Recording `shape_after` (and not only `shape_before`) is what makes this checkable.

### 2a. The refusal is machine-branchable, not just readable

A `409` carries a structured body, following the house precedent at `views.py:8635`
(`subtree_too_large`), which ships a branchable code beside the sentence *"for a client
that wants to branch without parsing the sentence"*:

```json
{ "code": "shape_changed",
  "detail": "Someone has moved rows here since — this can no longer be undone.",
  "changed": [ { "task_id": "…", "expected_path": "1.2", "actual_path": "1.3",
                 "change": "moved" | "added" | "removed" | "deleted" | "edited" } ] }
```

Other codes: `not_top_of_stack` (§8, carries `blocking_operation_id`), `too_large` (§7),
`already_undone` is **not** an error — it is an idempotent 200 (§3.1).

**`changed_by` is deliberately absent, and the ADR states why.** The `ai-review` gate
(finding 4) is right that the natural copy is *"Sam moved 2.3 since"*. The server cannot
supply it below Admin: `HistoryRecordSerializer.get_history_user` returns null for every
caller under `Role.ADMIN` (`apps/history/views.py:158`), and §4 exists specifically so a
**Member** can undo. Rather than carve a new exception into the history-actor redaction —
a privacy decision far outside this issue — the refusal names *what* changed and not
*who*. The user-facing copy must therefore be written without an actor. This is a stated
limitation, not an oversight.

### 3. Undo algorithm — identical for all six kinds

1. `select_for_update()` the operation row; return the recorded summary if already `UNDONE`
   (idempotent **200**, not an error — matching `undo_paste_many_operation`).
2. Refuse `409 too_large` if `undoable` is false (§7).
3. Refuse `409 not_top_of_stack` unless this is the newest `ACTIVE` operation in the
   project for `operation.applied_by` (§8).
4. Capture `graph_before = capture_graph_state(project_id)` — **before any write** (§7a).
5. Verify the four-dimension precondition (§2). Refuse `409 shape_changed` on mismatch.
6. Re-check authority on `anchor_task_ids` (§4).
7. Restore `deleted_task_ids` — the wrapper returns with its **original id, name, notes and
   labels**, because a soft delete retains them. **Exact ids only**, each asserted
   `project_id == operation.project_id`. **Do not call
   `cascade_task_children_restore()`** (§3a).
8. Restore `removed_dependency_ids`, skipping any edge whose predecessor or successor is
   not live, or that would collide on the `unique_dependency` constraint. Report the
   skipped edges in the response (§3b).
9. Write every `shape_before` path back.
10. Soft-delete `created_task_ids`.
11. Call `sync_structure_shadow_values()` on every row whose child set changed (§6).
12. Run `assert_graph_feasible(project_id, graph_before)` (§7a).
13. `transaction.on_commit()` → `_enqueue_recalculate` + `broadcast_board_event(project_id,
    "tasks_restructured", {})` — the same event the forward acts emit, so existing
    collaborator clients need no change.

Steps 2–12 are inside one `transaction.atomic()`. Nothing partial can commit.

#### 3a. 🔴 Undo must NOT use `cascade_task_children_restore()`

The forward restore path (`views.py:5477`) pairs `task.restore()` with
`cascade_task_children_restore(task)`, whose own docstring concedes that restoring a parent
*"may resurrect an earlier-deleted subtask — the same bounded, accepted tradeoff."* That
tradeoff was accepted for a user who explicitly clicked **Restore** on a task they deleted.
It is **not** acceptable for an undo of a *grouping*: `perform_ungroup`'s
`container_has_subtasks` guard filters `is_deleted=False` (`task_grouping.py:655`), so a
container carrying tombstoned subtasks ungroups cleanly — and cascading on undo would
silently resurrect rows the user deliberately deleted through an unrelated path.

Separately, `cascade_task_children_restore` (`models.py:1882`) filters on
`wbs_path__startswith` with **no `project_id` filter**, and `wbs_path` values are not
project-unique. Its sibling `cascade_project_children_restore` (`:1751`) *is* scoped, which
makes this an asymmetry rather than a decision. Undo restores exact ids only; the missing
filter on the existing restore path is filed separately.

#### 3b. 🔴 Dependency restore is guarded — the graph check cannot see a dangling edge

Both existing restore cascades guard edge restore on `predecessor__is_deleted=False,
successor__is_deleted=False` (`models.py:1906`). Step 8 must do the same, because
`capture_graph_state` (`task_grouping.py:305`) builds its edge list from tasks filtered
`is_deleted=False` — **an edge with a tombstoned endpoint is not in the graph the guard
validates**, so step 12 structurally cannot catch what step 8 wrote. A bulk
`.update(is_deleted=False)` also bypasses `DependencySerializer.validate`
(`serializers.py:6527`), which is where forward-path cycle detection actually lives.

### 4. Who may undo whose act

**You may undo your own act with the same authority the act required; undoing someone
else's requires `Role.ADMIN`+.**

`_require_admin`'s stated rationale is that undo *"removes work other collaborators may
already be building on top of."* Under §2 — **and only because §2 now covers all four
dimensions** — that hazard is structurally impossible: if anyone has touched anything the
undo would write, it **refuses** rather than reverting. The premise of the Admin bar does
not hold for this operation, so importing it wholesale would re-impose ADR-0773's existing
asymmetry (Member may indent; Member may not un-indent) with no safety left to justify it.

Concretely, at undo time:
- `IsAuthenticated`, `IsProjectMemberWrite`, `IsProjectPlanAuthor`, `IsProjectNotArchived`
  — the same class list the forward acts carry.
- `_require_wbs_restructure_permission(request, task)` re-run on **`anchor_task_ids`** —
  the rows the forward act itself gated on — against their *current* state.
- For rows in `created_task_ids` / `deleted_task_ids`, which undo deletes and restores
  rather than moves, `can_user_edit_task(request, task, method="DELETE")`, matching what
  `perform_ungroup` uses on the container (`task_grouping.py:671`). The default `"PATCH"`
  form admits the Product Owner facet on `EPIC`/`STORY` rows regardless of assignment
  (`permissions.py:180`); the delete-grade form does not, and a delete is what undo
  performs on that dimension.
- If `operation.applied_by_id != request.user.pk`, additionally require `Role.ADMIN`+.

**Why `anchor_task_ids` and not the whole region.** The forward endpoints gate on the one
*named* task — `TaskIndentView.post` checks `_require_wbs_restructure_permission` on the
indented row only (`views.py:7712`); descendants and renumbered siblings move unchecked.
Re-checking the *whole region* on undo would be **stricter than the forward act**, so a
Member who legally indented their own assigned task under a phase of colleague-assigned
rows could not reverse it — reintroducing exactly the asymmetry §4 exists to remove, one
layer down. Since undo is only reachable when the region is byte-identical to what the
actor produced (§2), re-checking rows the actor never needed authority over adds no safety.
`reorder` is the one endpoint that already gates every sibling (`views.py:7578`), so its
anchors are the full `ordered_ids` set — which is why the field is an array.

This follows `IsProjectAdminOrSessionOwner`'s established shape (Admin **or** the actor).
It does not change `_require_admin` for paste-many/cascade/import-fix — those keep their
existing gate, because their partial-undo semantics leave the original hazard intact.

### 5. Granularity — one request is one undo step; multi-select is N, and we say so

The #2955 / #2914 precedent is that a **group of four rows is one undo step**. One ledger
row per request satisfies that for all six endpoints: group, ungroup, reparent and reorder
each move many rows and each undo in one act. That constraint is met.

It is **not** met for multi-select indent/outdent, which fans one gesture into N requests
(finding 9). An earlier draft solved this with a client-minted `group_id` correlating the N
rows into one undo. **That mechanism is rejected.** The `threat-model` gate produced four
separate findings against it (T2, T3, T11, and the §4/§5 contradiction): the fan-out filter
contradicted §4 and would have produced a *silent partial undo* of a grouped gesture — the
exact corruption this ADR exists to prevent — and the token was unbounded in cardinality
and time, giving both a lock-holding DoS and a way for one member to poison another's undo.
A correlation token that widens a write's blast radius is not worth four security findings
to save N-1 keystrokes.

**The stated boundary:** a multi-select indent of N rows produces N undo steps. Repeated
⌘Z reverses them one at a time, newest first (§8), so the gesture is **fully** reversible —
it just takes N presses. This is a pre-existing client fan-out (`TaskListRow.tsx:418`), not
something this ADR introduces. If it proves annoying in use, the correct fix is a **batch
indent/outdent endpoint** — one request, one transaction, one ledger row, server-side
atomicity — not a client correlation token. Filed as follow-up.

### 6. `sync_structure_shadow_values()` — call it on undo, do not fix the forward path here

Undo calls it on every row whose child set changed. For group/ungroup this restores parity
(the forward acts call it). For indent/outdent/reparent/reorder the forward acts *do not*
call it (finding 6) — but calling it on undo is still correct, because it recomputes from
current `wbs_path` and converges on the true state rather than replaying a bug.

The forward-path omission is a **separate pre-existing defect** and is filed as its own
issue rather than fixed here; it changes behavior on paths this MR does not otherwise
touch, and bundling it would make the regression surface of an undo MR much larger.

### 7. 🔴 The recorded region is BOUNDED, and an oversized act is honestly non-undoable

An earlier draft claimed in Consequences that *"the row is small (two JSON maps over the
affected region, not the project)."* The `threat-model` gate's T7 showed that is false for
four of the six kinds. `MAX_GROUP_SELECTION = 500` (`task_grouping.py:49`) bounds group and
ungroup. Nothing bounds the others: `_get_descendants` (`views.py:7619`) has no limit, so
an `outdent` near the root pulls its whole descendant set *plus* every following sibling
it adopts; `reparent` of a top-level phase pulls descendants and both levels' siblings;
`reorder` is unbounded in level width. On a 50,000-task project a single reparent would
write two ~50,000-entry maps — megabytes, inside the hot write transaction, retained for
the full window.

**Decision:** `STRUCTURAL_OPERATION_MAX_REGION = 2000`. When the affected region exceeds
it, the ledger row is still written — with `undoable=False` and a `result_summary` reason —
and **the structural act itself still succeeds**. Undo of such a row refuses `409
too_large`. The trail renders it as a record with no control and an explicit
"too large to undo" note.

This is deliberately the honest-failure shape rather than the clever one: storing the
region prefix-derived (roots plus a rewrite rule, expanded at check time) would preserve
undo at every scale and is the better long-term answer, but it makes the §2 precondition a
recomputation rather than a comparison, which is a much larger correctness surface to get
right in the same MR that introduces the mechanism. Recorded as the upgrade path.

#### 7a. `assert_graph_feasible()` IS live on the undo path — the forward-path claim does not carry over

An earlier draft repeated the forward-path finding that this guard "cannot fire today" and
instructed that it be recorded as inert. **That is wrong for undo**, and shipping the note
would have put a documented "this check does nothing" beside the one call site where it is
load-bearing. The forward claim rests on group/ungroup not writing dependency edges;
**undo step 8 writes edges**. `graph_before` is therefore captured at step 4, before any
write, so the differential compares against the true pre-undo graph.

Its differential escape remains a real gap — if the project is *already* infeasible for an
unrelated reason, `_is_schedulable(before)` is `False` and undo commits regardless. That is why
§3b's per-edge validity guard is the primary control and this guard is the backstop, not
the reverse.

### 8. Undo depth — top-of-stack, server-enforced, deep by iteration

Repeated ⌘Z walks back through the trail, but **only the newest `ACTIVE` operation is
undoable at any moment**. Undoing it makes the next one newest, which then becomes
undoable. This is a deep undo built out of safe single steps.

An earlier draft claimed §2 enforced this "by construction". The `ai-review` gate's finding
2 correctly refuted it: for **disjoint regions** the shape check passes and an older
operation undoes out of order. The popover rendering one control is not enforcement — a
headless client is precisely the caller that will `POST` an older id directly.

So it is enforced on the server (step 3): refuse `409 not_top_of_stack`, naming the
blocking operation id. The stack is scoped **per actor** — the newest `ACTIVE` operation
for `operation.applied_by` — so ⌘Z means "undo *your* last structural act" and a
collaborator's unrelated act in a disjoint region does not block you. Safety still comes
from §2; this rule buys predictability, which is what makes the affordance honest.

### 8a. Undoability is a server fact, not a client derivation

`status` cannot answer "is this undoable" — `SyncBatchOperationStatus`' own docstring says
the only question it answers is *whether it has since been undone*. For this ledger,
undoability is a time-varying function of live shape (§2), stack position (§8), region size
(§7) and role (§4). An agent listing operations would otherwise see N rows all reading
`ACTIVE`, of which at most one is reversible.

The serializer therefore carries computed `is_undoable: bool` and
`undo_blocked_reason: "" | "shape_changed" | "not_top_of_stack" | "too_large" | "forbidden"
| "already_undone"`, evaluated server-side. The web trail renders its control off
`is_undoable` rather than deriving it, so the two clients cannot disagree.

### 8b. MCP exposure — deliberately not exposed in this MR

`packages/mcp` is read-only and exposure is opt-in per view via `McpReadableViewMixin`.
The structural ledger is **not** exposed. The reasoning is that a read-only agent cannot
act on an undo ledger, and exposing it would pull in `McpProjectScope` consent scoping
(ADR-0678) plus untrusted-content handling for `result_summary` (#2763) for read value that
`GET /tasks/` largely already provides. It is a reasonable future candidate — "what
restructures happened on this plan, in what order" is provenance an agent has no other
route to, since `TaskActivityEventType` has no structural member — and is recorded as such
rather than left silent.

### 8c. This ledger is not an audit record

`TRUEPPM_STRUCTURAL_OPERATION_RETENTION_DAYS` is a **purge horizon for a working undo
buffer**, not an audit retention policy. Stated explicitly because ADR-0112 RC1 names
retention policy as the Enterprise half of the audit split, and a later reader could
mistake this setting for an OSS implementation of it.

Two consequences follow and are accepted rather than fixed here: a **refused** undo is
persisted nowhere (the 409 is returned and forgotten), and an **accepted** undo's record
purges with the row. `undone_by` (§1) answers the attribution question §4 creates for as
long as the row lives. A durable structural verb —
`TaskActivityEventType.structural_undone`, or an `AuditEventType` member — is the right
long-term home and is filed as follow-up rather than bundled here.

Note also that `POST /structural-operations/{id}/undo/` joins the token-writable surface
(`tests/apps/access/token_write_surface.txt`, which already lists the two ADR-0810 undo
routes) and, like the other ~260 token-writable routes, writes no `AgentAction` row today —
`_record_mcp_agent_action` returns early for a `legacy:full` token
(`apps/access/permissions.py:1968`). Tracked under #2749; named here so the gap is not
rediscovered as a surprise.

### 8d. List scoping is tighter than the `PasteManyOperation` precedent

`PasteManyOperationViewSet.get_queryset` scopes to project membership with **no role floor**
(`batch_operation_views.py:73`), so a `Role.VIEWER` would read it. For the *move* dimension
that leaks nothing new — a Viewer already reads `GET /tasks/`. The new disclosure is
**historical**: `shape_before` preserves how work was organized before a reorg the live
tree no longer shows, `deleted_task_ids` names tombstoned rows the task surface hides, and
`applied_by` + `created_at` yields a per-member restructure timeline at a finer grain than
any surface a Viewer has today.

The queryset is therefore scoped to `applied_by=request.user` **OR** caller role
`>= Role.ADMIN` — mirroring §4's own authorization split. A caller who can neither undo an
operation nor see it in their own trail has no use for the row. The project scope for the
undo write derives from `operation.project_id`, **never** from a `?project=` query
parameter (which the copied viewset does accept for filtering the list).

### 9. Retention

A separate `TRUEPPM_STRUCTURAL_OPERATION_RETENTION_DAYS` (default **7**), purged by the
existing `purge_expired_batch_operations` task rather than a new one. Structural acts are
generated at a far higher rate than paste-many or cascade — an afternoon of outlining is
hundreds of rows, not a handful — so sharing the 30-day
`TRUEPPM_BATCH_OPERATION_RETENTION_DAYS` would accumulate an order of magnitude more rows
for a window nobody uses. The undo affordance is session-scoped (the trail caps at 10
entries); 7 days comfortably outlives any session while keeping the table small.

### 10. Scope boundary — what this does NOT undo

Stated here because an undo that silently fails to reverse something is worse than none.

| Act | Undoable | Why |
|---|---|---|
| indent, outdent, reparent, reorder, group, ungroup | **yes** | single server endpoint, one transaction, ledger row |
| delete | yes, **existing** mechanism | `POST /tasks/{id}/restore/` + its own toast; not migrated onto this ledger (ADR-0810 made the same call) |
| template apply, paste-many, cascade, import-fix | yes, **existing** mechanism | ADR-0810 ledgers, unchanged |
| **duplicate** (⌘D subtree) | **no** | no server endpoint — the client walks the tree and fires N creates (`ScheduleView.tsx:1995`). Needs a server-side duplicate endpoint first |
| **convert-to-milestone** | **no** | not a structural act — a plain `PATCH /tasks/{id}/ {duration: 0}`. It changes a field, not the tree |
| **single row create** (insert affordances) | **no** | goes through the generic `POST /tasks/`, shared with board, sprint and API clients. Recording a structural ledger row for every task create anywhere is far wider than this issue |

The cheatsheet and the trail must name this boundary rather than advertise ⌘Z generally.

### 11. #3006 is subsumed

`ungroup` records `deleted_task_ids=[container.id]` and `removed_dependency_ids`. Undo
restores the soft-deleted wrapper — **same id, name, notes, labels** — and its edges, then
puts the lifted rows back. That is precisely what #3006 asked for, and it needs *less* than
#3006 proposed: because the wrapper is soft-deleted rather than hard-deleted, its identity
fields do not need snapshotting at all. #3006 requires no separate `GroupOperation` model
and can close.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **One `StructuralOperation` ledger, kind-agnostic undo (chosen)** | One code path for six acts and every future one; a new structural act gets undo by recording a snapshot; matches the `AuditEvent`/`TaskActivityEvent` discriminator precedent | Departs from ADR-0810's stated sibling-model preference; needs the argument in finding 7 to be right |
| Six sibling models, one per act, per ADR-0810's letter | Literal consistency with `PasteManyOperation` | Six near-identical models and six near-identical undo functions — precisely the duplication ADR-0810 accepted "only until a fifth appears". The undo logic does not vary by kind, so the siblings would differ in name only |
| Partial undo reusing `_partition_touched` (the original proposal) | Reuses tested code; degrades gracefully | **Rejected — unsafe.** Restoring a subset of a tree's paths can mint a duplicate that corrupts the next `rewrite_level` (finding 3), or orphan a row someone added (finding 4). Nothing at any layer would detect it |
| Full plan-history checkpoint / snapshot-and-rollback (#2742's Amend path) | One mechanism for undo *and* Amend; arbitrary depth | A whole-project snapshot per indent is enormously heavier than the act; #2742 has not landed, so this would block #2974 on an unshipped dependency; and rollback would revert *other people's* concurrent edits, which the shape-identity refusal exists to prevent |
| Client-side inverse per gesture (Zustand command stack) | No migration; instant | Rejected by ADR-0810 for the same reasons and they still hold — diverges from every existing undo, lost on reload, and still needs a server call to persist. Worse here: the client cannot see whether a collaborator has touched the region, so it cannot make the §2 safety decision at all |
| Admin-only undo, importing `_require_admin` | Consistent with the existing ledgers | The rationale for that bar (undo removes others' work) is void under all-or-nothing (§4); it would leave a Member able to indent but not un-indent |
| Client-minted `group_id` correlating a multi-select gesture into one undo (in an earlier draft of this ADR) | One gesture = one ⌘Z even where the client fans out | **Rejected on four `threat-model` findings.** The fan-out filter contradicted §4 and produced a silent partial undo of a grouped gesture — the exact corruption §2 exists to prevent; the token was unbounded in cardinality and time (lock-holding DoS); and it let one member poison another's undo. A correlation token that widens a write's blast radius is not worth that to save N-1 keystrokes |
| Batch indent/outdent endpoints | Server-side atomicity for the multi-select gesture; one request, one row, no client token | The right long-term fix (§5) and filed as follow-up — but new endpoints with their own placement semantics and permission surface are a materially larger change than the mechanism this issue asks for |
| Prefix-derived `shape_*` storage instead of a region cap | Undo preserved at every scale; strictly smaller payload | Turns the §2 precondition from a comparison into a recomputation — a much larger correctness surface to get right in the same MR that introduces the mechanism. Recorded as the upgrade path (§7) |

## Consequences

- Six structural acts become reversible, and the mechanism is genuinely general: a future
  structural act gets undo by recording `shape_before`/`shape_after`, with no new inverse.
- #3006 closes without its own model.
- The session trail's disclaimer comes off and is replaced by an accurate boundary
  statement (§10) — not by a general "⌘Z undoes everything" claim.
- **Undo can refuse, and that is the design.** A collaborator touching the region makes the
  undo unavailable rather than destructive. This must be surfaced as a clear, specific
  message naming *what* changed — and, per §2a, **not who changed it**, because the server
  cannot supply the actor to a caller below Admin.
- Every structural act now writes a ledger row, so the six hottest write paths each gain
  one INSERT. The row is bounded at `STRUCTURAL_OPERATION_MAX_REGION` (§7); beyond that
  the act still succeeds and the row records itself non-undoable.
- Risk: the state-identity precondition is strict enough that undo will be unavailable more
  often than users expect on a busy project. Accepted — the alternative is silent
  corruption with no detector anywhere in the stack.
- **Multi-select indent/outdent of N rows is N undo steps.** Fully reversible, N presses.
  §5 explains why the correlation-token fix was rejected and what the right fix is.
- The forward-path `sync_structure_shadow_values()` omission (finding 6), the missing
  `project_id` filter in `cascade_task_children_restore` (§3a), and the absence of a
  durable structural audit verb (§8c) are all *recorded* rather than fixed. Each needs its
  own issue or it will be lost.

## Implementation Notes
- P3M layer: Programs and Projects (single-project schedule authoring)
- Affected packages: api, web
- Migration required: **yes** — one migration adding `StructuralOperation`
- API changes: **yes** —
  - the six existing structural endpoints gain `operation_id` in their response bodies
    (additive; no existing key changes shape)
  - `GET /api/v1/structural-operations/` (read-only list, project-scoped)
  - `POST /api/v1/structural-operations/{id}/undo/`
- OSS or Enterprise: **OSS** — single-project schedule authoring, no cross-program scope

### Durable Execution
1. **Broker-down behaviour:** N/A for the ledger row — all six acts write synchronously
   inside the request's `transaction.atomic()`, and the ledger row is written in that same
   transaction, so there is no broker-down window. The CPM recompute the acts already
   enqueue goes through `scheduling/services.py::enqueue_recalculate()` under
   `transaction.on_commit()`, unchanged by this ADR.
2. **Drain task:** N/A — no new asynchronous dispatch is introduced. Undo is synchronous.
3. **Orphan window:** N/A — follows from (1).
4. **Service layer:** new functions in
   `apps/projects/structural_operation_services.py`:
   `record_structural_operation()`, `undo_structural_operation()`,
   `capture_shape()` (the affected-region reader shared by record and undo),
   `assert_shape_unchanged()` (the §2 precondition). CPM recompute continues to route
   through `enqueue_recalculate()`.
5. **API response on best-effort dispatch:** synchronous. Undo returns `200` with
   `{"id", "status", "undo": {"restored": N, "created_removed": N, "deleted_restored": N,
   "dependencies_restored": N, "dependencies_skipped": N}}`, or `409` with the structured
   body in §2a. Never a partial success on the tree — there is no partial state to report.
   `dependencies_skipped` is the one honest exception (§3b): an edge whose other endpoint
   has since been deleted cannot be restored, and is reported rather than dropped silently.
6. **Outbox cleanup:** `purge_expired_batch_operations` (`apps/projects/tasks.py:1391`)
   gains `StructuralOperation`, governed by
   `TRUEPPM_STRUCTURAL_OPERATION_RETENTION_DAYS` (default 7, `None` disables). No new Beat
   entry — it runs on the existing schedule.
7. **Idempotency:** `undo_structural_operation()` takes `select_for_update()` on the
   operation row and returns the recorded summary unchanged if `status == UNDONE` — a
   double ⌘Z is a no-op, not an error, matching `undo_paste_many_operation`. The forward
   endpoints keep their existing `IdempotencyMixin`.
8. **Dead-letter / failure handling:** N/A — synchronous, no queue. A `409 shape_changed`
   is not a failure state; it is the designed refusal, and it is surfaced to the user as
   what changed and who changed it, not as an error.

## Design-gate findings incorporated

This ADR was revised before implementation on the `ai-review` and `threat-model` gates.
Recorded because the first draft was wrong in ways that would have shipped:

| Finding | Change |
|---|---|
| `threat-model` T1 | §2's precondition covered `shape_*` only, and §4's role relaxation was argued *from* it. Extended to all four dimensions — without this, §4 is unsound |
| `threat-model` T2 / `ai-review` 3 | The `group_id` fan-out filtered on `request.user` while §4 permitted cross-actor undo → **silent partial undo** of a grouped gesture, the exact corruption the ADR exists to prevent |
| `threat-model` T3, T11 | `group_id` unbounded in cardinality and time; usable to poison another member's undo |
| — (T2/T3/T11 together) | **`group_id` dropped entirely** (§5). Four security findings to save N-1 keystrokes is not a trade |
| `threat-model` T4 | Undo must not call `cascade_task_children_restore()` — it resurrects deliberately-deleted subtasks and is not project-scoped (§3a) |
| `threat-model` T5, T12 | Edge restore needs both-endpoints-live guarding; `assert_graph_feasible` is **not** inert on the undo path, and `before` must be captured pre-write (§3b, §7a) |
| `threat-model` T6 / `ai-review` 5 | `undone_by` added — §4 authorizes cross-actor undo and nothing recorded who did it (§1, §8c) |
| `threat-model` T7 | "The row is small" was false for 4 of 6 kinds. Region capped; oversized acts record themselves non-undoable (§7) |
| `threat-model` T8 | Re-checking the whole region was **stricter than the forward gate** and reintroduced the asymmetry §4 removes. Now gates `anchor_task_ids` (§4) |
| `threat-model` T9 | `method="DELETE"` on the delete/restore dimensions (§4) |
| `threat-model` T10 | List scoped actor-or-Admin, tighter than the `PasteManyOperation` precedent (§8d) |
| `ai-review` 1 | `is_undoable` / `undo_blocked_reason` are server facts, not a client derivation (§8a) |
| `ai-review` 2 | §8's top-of-stack claim was false for disjoint regions — now server-enforced (§8) |
| `ai-review` 4 | Structured, machine-branchable 409; and the *"who changed it"* copy the design promised is **unavailable below Admin**, so it was removed rather than faked (§2a) |
| `ai-review` 6, 7 | MCP exposure decided (not exposed, with reasons) and the ledger stated to be an undo buffer, not an audit record (§8b, §8c) |

## Notes for the implementer

- **Do not reuse `_partition_touched`** for this operation. It is right for paste-many and
  cascade and wrong here (§2). Say so in the new module's docstring, or the next reader
  will "unify" them.
- **Do not reuse `cascade_task_children_restore()`** for the same reason (§3a). Both
  warnings belong in the module docstring; both are "obvious" reuses that are wrong here.
- **`kind` must never be branched on** in the undo path. Pin it with per-kind round-trip
  tests that all assert through the same service function.
- `docs/adr/0810` is not superseded — its three ledgers keep their partial-undo semantics
  and their Admin gate. This ADR extends the family with a fourth member whose safety
  argument differs, and says why.

### Website index statistics

Adding this ADR breaks the hard-coded figures in
`packages/website/src/content/docs/architecture/decisions.md:16` and `:22`. Current text
reads *"333 numbered ADRs (spanning 0001–0845)"*, *"curates 60 of them"*, and *"512 numbers
are unused across 84 gap ranges."* Adding 0880 moves the count to **334**, the span to
**0001–0880**, and changes both gap figures. Run `scripts/check-adr-status.sh` and take the
numbers it reports rather than computing them by hand — the script verifies all four
against the tree, which is why they cannot silently drift.
