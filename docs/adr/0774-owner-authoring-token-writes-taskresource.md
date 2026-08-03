# ADR-0774: The `@owner` authoring token writes `TaskResource`, at task-content authority

## Status

Accepted — 2026-08-02, for #2718 (0.4). First implemented child of the Project Designer
epic #2739. Depends on ADR-0773 for the authoring role boundary; consumed by #2722
(the rest of the inline token set) and #2723 (the batch contract).

## Context

TruePPM carries two assignment axes on a task, and only one of them is real to the
capacity engine:

- **`TaskResource`** (`resources/models.py:155`) — FK task + FK resource + `units`.
  The formal assignment. `units` is a fraction of full capacity (`1.0` = 100%,
  `max_digits=4, decimal_places=2`).
- **`Task.assignee`** — a nullable FK to `AUTH_USER_MODEL`. No units, no calendar, no
  link to `Resource`. ADR-0025 calls it the quick-assign field.

Every per-person capacity number in the product sums `TaskResource.units` and never
reads `Task.assignee`: `resources/utilization.py:400-430` (`if not assignments:
continue`, then `hrs * assignment.units` at `:534`), `projects/views.py:2516`
(`resource_allocation`), `:2629` (heatmap), `programs/program_views.py:1410`,
`sprints/services.py:272` (sprint capacity), `resources/views.py:650`
(`_check_overallocation`), `projects/views.py:9759` (attention feed). The exclusion is
stated outright in `utilization.py`'s module docstring.

**So a task carrying only an `assignee` contributes zero load, forever, silently.**
Nothing reconciles the two axes and no view shows the discrepancy.
`assignee_is_overallocated` (`views.py:3746`) looks like the dual-path detector and is
not — it joins on `task__assignee_id` but still sums only `TaskResource.units`, so a
bare-assignee task can never trip it. (The delete/edit halves of the product also
disagree about which axis "assignee" means; that is filed separately as #2747.)

The Project Designer introduces three fast new ways to assign work — the `@ana` inline
token during row entry, the Owner mapping target in spreadsheet import, and the seeded
landing's "give N tasks an owner" action. Each has an obvious-looking implementation
(`Task.assignee = user`) that is silently wrong, and the fastest new path to assign work
would both zero out capacity *and*, because contributor views filter on the resource
path, fail to put the work in front of the person.

This ADR fixes the contract once, before the surfaces that consume it are built.

## Decision

### 1. Inline owner authoring writes `TaskResource`. There is no `Task.assignee` path.

Every Designer authoring surface that expresses "this person owns this row" resolves to
a `Resource` and writes a `TaskResource` row with explicit `units`. `Task.assignee` is
never written by a Designer surface. This ADR does not migrate existing `assignee` data
or decide the field's long-term fate (#2747, #1356) — it only stops the new paths adding
to the problem.

### 2. The server primitive is a write-only `owners` field on `TaskSerializer`

```jsonc
POST /api/v1/tasks/          // or PATCH /api/v1/tasks/{id}/
{
  "name": "Draft the migration plan",
  "owners": [ { "resource": "<uuid>", "units": "0.5" } ]
}
```

`owners` is **write-only**; the existing read-only `assignments` field
(`TaskAssignmentSerializer`) remains the read projection. One field per direction, so
neither has to serve two masters.

**Why a field on the task write and not a second round-trip to `/task-resources/`.**
The token is authored *as part of composing the row*. Splitting it into `POST /tasks/`
followed by `POST /task-resources/` makes the assignment a separate act that can fail
on its own after the row has already committed — in a keyboard-fast grid that surfaces
as a row that looks saved and silently carries no owner, which is the exact failure mode
this ADR exists to close. Riding the task write also means the assignment inherits the
task write's transaction and its CPM re-trigger for free. It does **not** inherit
everything: the task write's own `task_updated` broadcast is not sufficient, which §4
addresses.

**Units are a fraction on the wire**, matching `TaskResource.units` and
`TaskResourceSerializer` exactly (range `[0.01, 2.0]`, the same bounds
`TaskResourceSerializer.validate_units` enforces). The `@ana:50` token's *percent* is a
presentation form that exists only inside the web token parser; the mutation layer
divides by 100 before it reaches the API. Two representations of allocation in one
codebase is a standing trap — the boundary is named here so it stays in one place.

### 3. Resolution is scoped to the project's roster, not the global library

`owners[].resource` must name a `Resource` present in the destination project's
`ProjectResource` roster (`is_deleted=False`). An id outside it is a validation error on
the field, not a silent drop and not a match-or-create.

This is the property `docs/specs/data-interchange.spec.md` §5.3 asserts and the
spreadsheet importer does not honor — `msproject/importer.py:271` resolves against
`Resource.objects.all()`, a workspace-global library, by lowercased display name. That
divergence is #2485 (0.5) and is deliberately **not** resolved here: it is a behavior
change for an existing shipped path with a real migration-persona cost. What this ADR
does is refuse to add a fourth caller to it. The new field takes ids, never free text,
so there is no name-collision surface to reach across projects with.

The **client** resolves `@ana` → `resourceId` against the same roster it already loads
for the grid (`useProjectResourcePool`), which is why the wire format is an id.

### 4. An inline owner is indistinguishable, downstream, from a drawer assignment

`apply_task_owners` also writes the ADR-0394 `TaskActivityEvent` audit row and fires the
`assignment_created` / `assignment_updated` board event, exactly as
`TaskResourceViewSet` does. Neither is incidental:

- **Audit.** Without the activity row, an owner set by token is absent from the task's
  activity feed while the same assignment made in the drawer is present — a plan whose
  ownership history depends on which affordance the author happened to use.
- **Real-time.** Riding the task write alone would broadcast only `task_updated`, which
  invalidates task queries but **not** the allocation timeline or the heat map —
  `useProjectWebSocket` refreshes those on `assignment_*` events only
  (`useProjectWebSocket.ts`, the `assignment_created | assignment_updated |
  assignment_deleted | roster_changed` handler). A colleague watching capacity would
  keep seeing a stale zero. That is this ADR's own complaint reappearing over the wire,
  so the event is part of the contract, not a nicety.

Re-committing an unchanged row emits neither: a repeat write at the same units is not an
ownership change and must not read as one in the audit trail.

### 5. Upsert, not replace-set

`owners` is applied with `update_or_create` on the `(task, resource)` unique constraint:
naming a resource already assigned updates its `units`; naming a new one adds it.
Owners **not** mentioned are left alone.

An `@ana` token means "Ana owns this", not "Ana is now the only person on this row". A
replace-set would make a single-token edit silently delete a co-assignee written by
someone else — the lost-update race the label field's docstring
(`serializers.py`, `labels`) already calls out as the reason label writes stay on
attach/detach endpoints. **Removal is not expressible through `owners`** and stays on
`DELETE /task-resources/{id}/`.

### 6. Authority: an inline owner rides the authority of the task write that carries it

**If you may write the row, you may say who owns it.** `owners` adds no permission class
and no new predicate. It is validated and applied inside `TaskSerializer.create` /
`.update`, so it is gated by exactly what already gates the surrounding task write:
`IsProjectMemberWrite` on create, `IsProjectMemberWriteOrOwn` → `can_user_edit_task` on
update.

This is the ADR-0773 §3 rule — *a batch is authorized at the authority of the single-row
act* — applied one level down: an owner authored as part of composing a row is part of
the row's content, so it takes the row's bar.

**`POST /task-resources/` keeps its Resource-Manager floor** (`Scheduler+`, enforced in
`TaskResourceViewSet.perform_create`). Two doors, two bars, and the difference is not an
inconsistency to be flattened:

| | Act | Authority | Why |
|---|---|---|---|
| `owners` on a task write | *Compose a row, including who owns it* | task-content bar (Member+, own rows; Admin+ any) | ADR-0773 §2: Author mode's floor is Member, and raising the Designer above the modal it replaces would be a regression dressed as hardening |
| `POST /task-resources/` | *Manage allocation across the roster* | Resource Manager (Scheduler+) | The resource-management axis; a Scheduler's whole role. Unchanged. |

Consequences of taking the row's bar, stated rather than discovered later:

- **A Member may set an owner only on a row they may already edit** —
  `can_user_edit_task` requires `assignee_id == request.user.pk` for a Member, so a
  Member can author an owner on their own rows and on rows they create in the same
  request, and not on a colleague's. That is the Designer's `◐ own-assigned` cell in
  ADR-0773 §1, unchanged.
- **A Scheduler can pass this field on create and not on update.** That asymmetry is
  inherited, not introduced: `TaskViewSet.create` gates on `IsProjectMemberWrite`
  (admits Scheduler) while `update` reaches `can_user_edit_task`, which refuses
  Scheduler task content (`access/permissions.py:160-162`). ADR-0773 §2 names it and
  resolves it with `can_user_author_plan`, which is #2719's work. **When
  `can_user_author_plan` lands, `owners` needs no change** — it will inherit the
  corrected bar the same way it inherits the current one. That is the point of adding no
  predicate of its own.

### 7. An unresolvable token commits the row and stays visible

A `@name` that matches no roster member is **not** stripped, **not** silently dropped,
and **not** a commit failure. The literal text stays in the task name, the row commits,
and the token renders with an amber underline and an `Unresolved owner` accessible
description; the row joins the surface's unresolved count.

Losing the row's other content to punish an unmatched name is the worse failure in a
keyboard-fast grid, and a silently dropped token is the failure this whole ADR is about.
Resolution failure is therefore a *visible, correctable* state, not an error.

### 8. Token grammar (the `@owner` slice only)

```
@<name>            → units 1.0  (100%)
@<name>:<percent>  → units percent/100, clamped to [0.01, 2.0]
```

`<name>` matches `[A-Za-z0-9._'-]+` plus single interior spaces up to the longest roster
match, case-insensitively. The token is removed from the committed task name on a
successful resolve. The remaining tokens in the designer set (`#5d`, `>2.3`, `!`,
`~mode`, `[Phase]`, `/`) are #2722 and are deliberately out of scope — this ADR fixes the
one with a data-integrity landmine under it, so the rest can be built on a settled
contract.

## Consequences

- The three Designer surfaces named in #2718 have exactly one way to express ownership,
  and it is the one the capacity engine reads. The spreadsheet importer already writes
  `TaskResource` (`msproject/importer.py:553-572`) and is now covered by a regression
  test asserting the Owner column produces non-zero utilization.
- Every `owners` write auto-rosters via `ensure_project_resource`, so an assigned person
  cannot be invisible in Team → Roster / Allocation / Heatmap (#241).
- The web token parser owns the only percent↔fraction conversion in the client. A second
  one appearing anywhere is a bug.
- `docs/api/openapi.json` gains a write-only `owners` array on the task write bodies.
- **`POST /projects/{pk}/tasks/bulk/` inherits the field for free**, because
  `_bulk_create_task` (`projects/views.py:7684`) routes `create` ops through
  `TaskSerializer`. That is deliberate rather than incidental: it is what stops #2723's
  batch endpoint growing a second, divergent way to express ownership, and it is
  regression-tested here so the batch hardening cannot drop it.

### The axis split runs the other way for My Work — and this ADR does not close it

#2718's problem statement says contributor-facing views filter on the resource path.
They do not. `MeWorkView.get_queryset()` (`projects/views.py`) filters `assignee_id` and
reads `TaskResource` nowhere, so the split is:

| Surface | Reads |
|---|---|
| capacity, utilization, heat map, allocation, sprint capacity | `TaskResource.units` only |
| My Work (`GET /me/work/`) | `Task.assignee` only |

A task owned only through `owners` therefore reports correct capacity everywhere **and
does not appear in that person's own work list** — the mirror image of the defect this
ADR fixes, and it is not new: it is equally true of the board's Assignees editor and of
both importers, all of which write `TaskResource` alone.

It is left open here because both fixes are decisions rather than patches. Writing
`Task.assignee` alongside would also grant the person edit rights via
`can_user_edit_task`, making an `@ana` token an authorization change; unioning both axes
in `MeWorkView` touches a shipped endpoint whose docstring carries an explicit
sprint-sovereignty contract and whose partial covering index
(`0033_task_my_work_index`) is shaped for the `assignee_id` predicate. Filed as **#2750**,
next to #2747. Pinned meanwhile by a passing test that asserts the current behavior, so
the day either fix lands it fails loudly rather than drifting.

### What this ADR does not decide

- **The seeded-landing "give N tasks an owner" action.** The surface does not exist
  (#2731/#2733). It is bound by this contract when it is built; nothing is stubbed for
  it here.
- **#2485** — whether the shipped importer's global-library, match-or-create resolution
  is the spec's bug or the implementation's. 0.5.
- **The fate of `Task.assignee`** (#2747, #1356). Untouched.
- **A cap on `owners` length.** Reads as abuse/performance rather than authorization;
  it belongs with the batch endpoint's cap (#2723, ADR-0772).

## Acceptance criteria

- pytest: `owners` on create and on update produces `TaskResource` rows with the
  expected `units`, and the resource is auto-rostered.
- pytest: a project assigned only through `owners` reports non-zero utilization on the
  capacity and heatmap endpoints.
- pytest: a resource outside the project roster is a 400 on the field, and a Viewer is
  denied.
- pytest: `owners` upserts — a second write naming one resource does not remove a
  co-assignee.
- pytest: an inline owner writes an `assignee_added` activity row, a re-allocation writes
  an `assignee_units_changed` delta, and an unchanged re-commit writes neither.
- pytest: an inline owner broadcasts `assignment_created`, not only `task_updated`.
- vitest: `@ana:50` parses to units 50; an unmatched name leaves the literal text and
  flags the row unresolved.
- Playwright: type `@` in a build-mode row, pick a person, save, and the person appears
  on the resource heat map.

## Related ADRs

- **ADR-0773** — the 5-role authoring boundary this field inherits rather than restates.
- **ADR-0025** — records the two assignment axes.
- **ADR-0024** — no direct assignment on a summary task; mirrored by this field.
- **ADR-0028 / ADR-0033** — overallocation and skill-fit are soft warnings, never blocks.
- **ADR-0772** — client-minted row ids; the batch path this contract is carried into.
