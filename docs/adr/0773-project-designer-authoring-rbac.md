# ADR-0773: Who may author a plan — the 5-role boundary for the Project Designer

## Status

Accepted — status corrected 2026-08-03 when #2723 implemented it (verified:
`can_user_author_plan` and `IsProjectPlanAuthor` in `apps/access/permissions.py`, and
`ProjectSerializer.can_author`, all ship in !1891). Originally proposed 2026-08-02 for
#2719 (0.4). Cross-cutting prerequisite for the Project Designer epics #2739 / #2740 /
#2741, and a hard predecessor of ADR-0772 and #2723.

## Context

The Project Designer package assumes edit rights throughout and never names the 5-role
RBAC boundary (Owner / Admin / Scheduler / Member / Viewer) at authoring time. The
design states that Author is the default "where you have edit rights" and that Read
mode covers "a viewer role", but the floor is never stated. Two independent evaluation
lenses stopped at the same silence.

This has to be answered before Epic A or B is implemented, because it decides the
permission surface of the batch endpoint (#2723) and the default state of the
Read/Author toggle.

The decision below is grounded in what the code does today, not in what the design
assumes. Where the two disagree, the gap is named — several of them turned out to be
defects rather than open questions, and are filed as such.

## Decision

### 1. The role × capability matrix

Roles are the post-#2489 ordinals: Viewer 1, Member 100, Scheduler 200, Admin 300,
Owner 400. `◐` means allowed but gated per row, not per request.

| Capability | Viewer | Member | Scheduler | Admin | Owner |
|---|---|---|---|---|---|
| Read mode (Designer, read-only) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Enter Author mode | ❌ | ✅ | ❌ | ✅ | ✅ |
| Create one new row | ❌ | ✅ | ❌ | ✅ | ✅ |
| Edit one existing row | ❌ | ◐ own-assigned | ❌ | ✅ | ✅ |
| Delete one existing row | ❌ | ◐ own-assigned | ❌ | ✅ | ✅ |
| Paste-many (N creates) | ❌ | ✅ | ❌ | ✅ | ✅ |
| Paste-many that also updates existing rows | ❌ | ◐ per row | ❌ | ✅ | ✅ |
| Reorder / reparent / indent / outdent (WBS) | ❌ | ◐ per row | ❌ | ✅ | ✅ |
| Cascade classification over a subtree | ❌ | ❌ | ❌ | ✅ | ✅ |
| Apply a template | ❌ | ❌ | ❌ | ✅ | ✅ |
| Import into an existing project | ❌ | ❌ | ❌ | ✅ | ✅ |
| Import that **creates** a project | ✅¹ | ✅¹ | ✅¹ | ✅¹ | ✅¹ |
| Bulk-delete untouched seeded rows | ❌ | ❌ | ❌ | ✅ | ✅ |
| Publish / commit the plan (0.5 draft lifecycle) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Author a dependency edge (drag-to-link, picker) | ❌ | ❌ | ✅ | ✅ | ✅ |²

² The one row whose column pattern is not a prefix of the others, and the reason
§7 exists. Every other capability here is task content; this one is a different
server permission (`IsProjectScheduler`) that admits the band task content excludes
and excludes the band task content admits. Added 2026-08-28 (#3053) — the row was
missing when this ADR was written, which is how a client gate came to front both.

¹ Not a project-scoped capability — no project exists yet. Any authenticated user may
create a project and becomes its Owner. The row exists only so the matrix does not read
as if #2710 needs a floor. Precedent:
`CreateProjectFromMsProjectView.permission_classes = [IsAuthenticated]`
(`apps/msproject/views.py:228`).

### 2. The floor is Member — and it is not an ordinal test

`IsProjectMemberWrite` (Member+) is already the floor on every task write path in the
product: `TaskViewSet` (`apps/projects/views.py:4512`), `TaskBulkView` (`:7555`),
`TaskReorderView` (`:6931`), `TaskIndentView` (`:7110`), `TaskOutdentView` (`:7212`),
`TaskReparentView` (`:7436`). Raising the Designer above that would make Author mode
stricter than the modal it replaces — a regression dressed as hardening. And
`Project.default_member_role` defaults to MEMBER deliberately (ADR-0363 §2), so the
default collaborator lands in Author mode, which is the adoption-first answer.

Author mode for a Member is honest because the **cells** are gated, not the mode: they
may add rows and edit their own. That is the `◐` column, and it is what
`can_user_edit_task` already returns.

#### Scheduler is excluded, and this is why a plain `role >= 100` is wrong

`Role.SCHEDULER` (200) is ordinally *above* Member, but `can_user_edit_task` refuses it
task content outright:

```python
# apps/access/permissions.py:160-162
# Resource Manager (2): cannot edit task content (only resource assignment).
if role == Role.SCHEDULER:
    return False
```

while `IsProjectMemberWrite` admits it (`role >= Role.MEMBER`, `:299`).

**The consequence on `main` today: a Scheduler can create a task and then cannot edit
or delete the task they just created.** `TaskViewSet.create` gates on
`IsProjectMemberWrite` (`views.py:4524-4525`); `update`/`destroy` gate on
`IsProjectMemberWriteOrOwn` (`:4522-4523`) → `can_user_edit_task` → `False`. The bulk
path splits the same way: `_bulk_create_task` (`:7684`) applies no per-op check,
`_bulk_update_task` (`:7711`) applies `can_user_edit_task`.

That is survivable in a modal — one task, one 403. In a keyboard-fast row grid it is a
trap: the Scheduler types eight rows, they commit, and every subsequent keystroke 403s.
Author mode is therefore **deny** for Scheduler, and the predicate must say so
explicitly rather than let it emerge from a `>=` comparison.

### 3. Two thresholds for bulk, not one

> A batch is authorized **row by row at the authority of the single-row act**, plus a
> **batch-level floor** for any operation whose meaning is not the sum of its rows.

**Row-multiplying acts stay at the single-row floor, gated per row.** A Member pasting
30 rows performs 30 acts each of which they were individually allowed; raising it would
be security theater with a real adoption cost. Per-row gating is the established answer
to "many writes in one request" here — #1548 has `_bulk_update_task` call
`can_user_edit_task` per row so a Member cannot bulk-edit a colleague's task
(`views.py:7699-7725`), and #1771 has `_require_wbs_restructure_permission`
(`:7074-7087`) gate indent/outdent/reparent *and* reorder at per-row authority, applied
to every supplied sibling (`:6991-6992`).

**Structure-defining acts are Admin.** Cascade over a subtree, template apply,
import-into-project, and seeded-delete are not the sum of their rows. This is not an
invention — it is the floor the product already uses:

| Existing surface | Floor | Cite |
|---|---|---|
| MS Project import into a project | `IsProjectAdmin` | `apps/msproject/views.py:161` |
| Jira import into a project | `IsProjectAdmin` | `apps/jiraimport/views.py:108` |
| Phase create / update / destroy | `IsProjectAdmin` | `apps/projects/views.py:11224-11226` |
| Structural backlog acts | Admin, or PO facet | `access/permissions.py:449-459`, ADR-0105 |

A cascade necessarily writes rows the caller does not individually own — that is what
"cascade" means — and the field it writes carries an inheritance bit
(`parent_governance_inherited`, #2741) that re-decides rollup semantics for every
descendant. A template apply seeds root-level rows, which **are** Phases, and Phase
creation is already Admin. Putting either at Member+ would make `PhaseViewSet`'s Admin
gate decorative.

### 4. Bulk-deleting seeded structure: Admin, and the server computes the set

"Delete untouched rows (19)" removes work in bulk seven days after creation. It is
Admin, and **the server recomputes the untouched set from provenance**
(`seeded_at`/`edited_at`, #2730) rather than accepting a client-supplied ID list.

Accepting an ID list would make the endpoint arbitrary bulk-delete wearing a friendly
label: the affordance's safety comes entirely from "these rows were never touched", and
only the server can assert that. This creates a hard dependency — **#2730 must precede
#2731**, or the delete affordance has no provenance to derive from and necessarily
falls back to the list this ADR forbids.

### 5. Agent authority: both layers, with a clean division

> **Token scope decides verbs and surface. Live `ProjectMembership` decides rows and
> fields, re-read every request.**

An agent authoring through these endpoints must never exceed the role of the human who
provisioned it. On `TaskBulkView` this holds **by construction** today: the view does
not override `authentication_classes` (`views.py:7529`), so it inherits
`OwnerScopedApiTokenAuthentication` (`settings/base.py:1216`), which requires
`is_personal` + `legacy:full` (`authentication.py:267-269`) and resolves `request.user`
to the token's owner — whose live role is then read per request.

Two binding constraints follow, and they are the actionable part of this section:

- **No Designer endpoint may declare `authentication_classes = [ProjectApiTokenAuthentication]`.**
  That class's permission stack carries no role check at all — `TaskSyncView` gates on
  `IsAuthenticated, IsTokenForProject, TokenHasScope(legacy:full)` (`views.py:14794-14806`)
  and never consults the minter's `ProjectMembership`. See #2661.
- **No Designer endpoint may declare `authentication_classes` at all.** Inheriting the
  default is what keeps an `mcp:read` token out: it fails *authentication* before any
  permission class runs, which is how the 0.4 read-only MCP guarantee is enforced.

### 6. Viewer cannot reach an authoring endpoint — but the reason is fragile

Confirmed by reading the code: a Viewer is denied. The denial rests on the in-body
`check_object_permissions(request, project)` call (`views.py:7561` and the four sibling
views), **not** on the declared permission class, which is a no-op on these routes —
see #2745. No test covers it (#2719 G2), which is why the acceptance criteria below
require one.

Separately, and worth stating because the design has not accounted for it: **a Viewer
cannot open the project WebSocket at all.** `ProjectConsumer` closes with 4003 when
`role < Role.MEMBER`, intentionally since 0.3 (ADR-0184 §3). So Read mode for a Viewer
is a polling snapshot, never live. Any Designer copy implying live collaboration in
Read mode is wrong for the one role Read mode exists for.

### 7. Dependency edges are a second, non-nested band (#3053, 2026-08-28)

The matrix above is entirely about **task content**, and §2's `can_user_author_plan`
answers exactly that question. Dependency **edges** are governed by a different class,
and the two rules do not nest:

| | server gate | rule | admits | excludes |
|---|---|---|---|---|
| Task content | `IsProjectPlanAuthor` | `role >= MEMBER` minus the 200–299 band | Member, Admin, Owner | **Scheduler** |
| Dependency edges | `IsProjectScheduler` | `role >= SCHEDULER` | Scheduler, Admin, Owner | **Member** |

Each admits exactly one band the other refuses. That is not a subtlety — it is the
reason a single client boolean cannot express both, and it is what #3053 was: the
Designer derived one `readOnly` from `can_author` and gated every mutation on it, so
canvas drag-to-link resolved as task content. A Scheduler lost a gesture the server
answers 200, and a Member was offered one the server answers 403.

**Decision: a Scheduler may author dependencies. `DependencyViewSet` is not narrowed.**
The server already returns 200 for the band, the published RBAC matrix
(`packages/website/src/content/docs/administration/rbac.md`)
already promises `Create/edit dependencies ✓`, and the role's own description is
"assigns resources and edits dependencies". Narrowing it to match the task-content gate
would be a breaking permission change for anyone who staffed the role as documented —
and it would be made as a side effect of a client bug, which is the wrong way to decide
a permission.

The client mirrors this with a second resolver, `canAuthorDependencies` in
`packages/web/src/lib/roles.ts`, kept beside `canAuthorPlan` so the two rules are read
together rather than one being rediscovered later.

**Where the floor actually lives, because it is not where you would look.**
`POST /api/v1/dependencies/` is a **flat** route with no `project_pk`, so
`IsProjectScheduler.has_permission` takes its `return True` fail-open branch — the open
**#2745** class named in "Defects this surfaced" below — and `has_object_permission`
does not run on a create. The floor survives because
`DependencySerializer.validate` → `_authorize_same_project_edge` calls
`check_object_permissions` on **both** endpoint tasks, which does reach
`has_object_permission`. It is a real gate in an unexpected place, so it is pinned by
outcome rather than by mechanism in
`tests/apps/access/test_rbac.py::TestDependencyAuthoringBand` — those assertions keep
holding if #2745 moves enforcement back up to the view.

**The affordance is withheld, not swallowed.** A refused reader does not get the
rest-state link handle, the crosshair, or an armed gesture: `GanttEngine.setLinkAuthoring`
declines to arm, so no `create-link` is emitted at all. Painting a grab point for a drag
that is silently dropped is the false affordance §(d) and #2949 already ruled against,
and it is worse on a canvas — the user aims at a mark, nothing happens, and their next
guess is that the product is broken.

**Still open, and tracked.** Five client surfaces mutate dependency edges; #3053 split
one of them. The other four resolve the question on the task-content gate or on nothing:

| Surface | gate today | filed |
|---|---|---|
| Outline row menu `Add dependency…` | `canEditTaskRow` (task content) | #3142 |
| Outline Links-cell picker chip | same `authoring` | #3142 |
| Task drawer `DependenciesTab` (incl. **delete**) | none at all — a Viewer reaches it | #3143 |
| Board `TaskFormModal` predecessors editor | `isReadOnly`, whose assignee predicate never reads the current user | #3143 |

They are #3053's consequences rather than #3034's regression, which is why they are
filed rather than carried in here — but note the denominator, because "the dependency
gate is fixed" is true of one surface out of five. There is also no mechanized guard
against the class recurring: "a client boolean fronts two server permissions" is a
semantic judgement, and the crossing invariant in `lib/roles.test.ts` pins the two
resolvers, not their consumers.

## Permission classes

### Reuse as-is

| Class / helper | Location | Guards |
|---|---|---|
| `IsProjectMember` | `access/permissions.py:261` | Read mode; every GET |
| `IsProjectMemberWrite` | `access/permissions.py:288` | row create floor on the batch endpoint |
| `IsProjectMemberWriteOrOwn` | `access/permissions.py:323` | single-row PATCH/DELETE (unchanged) |
| `IsProjectAdmin` | `access/permissions.py:427` | cascade, template apply, import, seeded-delete |
| `IsProjectNotArchived` | `access/permissions.py:889` | every write |
| `can_user_edit_task(request, task, *, method)` | `access/permissions.py:116` | per-row gate inside the batch |
| `_require_wbs_restructure_permission(request, task)` | `projects/views.py:7074` | per-row gate for any reorder/reparent |

**Do not mint an `IsProjectStructureAdmin` synonym for `IsProjectAdmin`.** A second name
for the same rule is pure ceremony, and both `rbac-check` and the OpenAPI security
surface read better with one class used consistently.

### Must be written

**(a) `can_user_author_plan(request, project) -> bool`** — new, in
`apps/access/permissions.py` beside `can_user_edit_task`. Follows the ADR-0133 "one
rule, called twice" pattern: it backs both the endpoint gate and a declarative
serializer field, so the web toggle reads a server fact and cannot drift.

```
role >= Role.MEMBER and not (Role.SCHEDULER <= role < Role.ADMIN)
```

**Band-range form, not `role == Role.SCHEDULER`**, so an Enterprise custom role
registered in the 201–299 resource-management band inherits the same exclusion. Fails
closed on absent auth, membership, or project, like every sibling predicate.

**(b) `IsProjectPlanAuthor(BasePermission)`** — the declarative wrapper on (a). Goes on
the batch endpoint alongside `IsProjectMemberWrite`, per ADR-0184's additive doctrine:
the permission class is defense-in-depth and OpenAPI-visible, while the in-body per-row
checks stay authoritative.

**(c) The `_project_pk_from_view` fix (#2745).** Without it, (b) is a no-op on
`<pk>`-routed views — which is every task-authoring `APIView`. This is what makes
ADR-0184's doctrine true on these five views rather than aspirational.

**(d) `ProjectSerializer.can_author` (read-only bool)** — the web gate.
`packages/web/src/features/schedule/buildMode/` currently contains **zero** role
references across its 12 components. The Designer must not fix that by importing
`ROLE_MEMBER` and writing `role >= ROLE_MEMBER` in the toggle: that reproduces the
Scheduler bug on the client, where nothing will catch it. Consume the server field.

> **Amended 2026-08-25 (#3034) — §(d) is wired, and `TaskViewSet.create` joins the map.**
>
> The warning above was not heeded, and the predicted failure is exactly what shipped:
> `ScheduleView.tsx` derived its Read/Author gate from `canEditTask(currentRole)` —
> `role >= ROLE_MEMBER` — and `can_author` had **zero** readers anywhere in the client.
> A Scheduler was offered the whole authoring apparatus. Both surfaces that render the
> Designer's rows (`ScheduleView`, `GridView`) now read `can_author` through one
> resolver, `canAuthorPlan` in `packages/web/src/lib/roles.ts`.
>
> The same issue settled the open half of the split this ADR described but did not fix:
> **`TaskViewSet.create` now carries `IsProjectPlanAuthor`** alongside
> `IsProjectMemberWrite`. Context above documents the asymmetry — create admits the
> Scheduler band, update/destroy refuses it, so the row commits and every subsequent
> keystroke 403s — as a live consequence rather than a decision, which left the client
> as the only thing standing between a Scheduler and a half-authored plan. It is now
> refused at its source. This removes no capability the band actually had: it could
> never edit or delete the row it created, and resource assignment runs through the
> `TaskResource` endpoints.

> **Amended 2026-08-30 (#3129) — the commit row is enforced; it was not.**
>
> The matrix row **"Publish / commit the plan (0.5 draft lifecycle)"** reads
> ❌ ❌ ❌ ✅ ✅ — Admin and Owner only. `ProjectCommitView` shipped at
> `IsProjectScheduler`, one band below, so the endpoint admitted a role this ADR
> excludes. It is now `IsProjectAdmin`.
>
> This is the same failure shape as the §(d) amendment above — a decided matrix row
> and a lower floor in the code — but it arrived by a different route, and the
> difference is worth recording. §(d) was a *client* re-derivation of a server fact.
> This one was server-side and carried its own justification: a comment claiming
> commit sits at the schedule-write floor because it has "a notification fan-out".
> No fan-out exists. `commit_project()` writes no notification row and registers no
> `on_commit` hook, and `commit_moment.py`'s module docstring separately claimed two
> acts of four ("commits the sprints in range", "tells the people who have work in
> it") that have no code path either. **A permission floor was argued down from a
> capability the module had only ever described.** Both claims are removed, and the
> response field `notified_resource_count` — which asserted a delivery in the
> published OpenAPI `help_text` — is renamed `assigned_resource_count` and documented
> as the audience the commit concerns rather than a record of anyone being told.
>
> Nothing about commit argues for the lower of the two floors. Since #3127 made
> `lifecycle` read-only it is the only legal `draft -> active` transition, and it is
> one-way: `commit_project()` refuses a project that is already active, so the anchor
> can neither be re-laid nor withdrawn. It also performs, in one transaction, exactly
> the two acts `BaselineViewSet.create` and `BaselineActivateView` already gate at
> `IsProjectAdmin` individually — so the Scheduler floor was a lower-privileged route
> to writes the Admin floor is supposed to hold.
>
> Why nothing caught it: no test exercised `Role.SCHEDULER` on `/commit/`. The suite
> covered Owner (200) and Member (403), which brackets the disputed boundary without
> touching it, so the floor could have been moved in either direction and stayed
> green. `TestTheRoleFloor` in `tests/apps/projects/test_commit_moment.py` now
> parametrizes all five roles.

### Endpoint → class map

| Endpoint | Issue | `permission_classes` | Per-row gate in body |
|---|---|---|---|
| `POST /projects/{pk}/commit/` | #3129 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | none — the lookup is membership-scoped so a non-member 404s uniformly, matching `/archive/` |
| `POST /projects/{pk}/tasks/` | #3034 | `IsAuthenticated, IsProjectMemberWrite, IsProjectPlanAuthor, IsProjectNotArchived` | `can_user_edit_task` on update/destroy via `IsProjectMemberWriteOrOwn` (unchanged) |
| `POST /projects/{pk}/tasks/bulk/` | #2723 | `IsAuthenticated, IsProjectMemberWrite, IsProjectPlanAuthor, IsProjectNotArchived` | `can_user_edit_task` on every update; `_require_wbs_restructure_permission` on any op that moves a row |
| subtree classification cascade | #2735 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | none — Admin edits any row |
| template apply / seed | #2729 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | — |
| delete untouched seeded rows | #2731 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | server recomputes the set from `seeded_at`/`edited_at` (#2730) |
| import into existing project | #2732 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | already the shipped floor |
| import creates project | #2710 | `IsAuthenticated` | — |
| `POST /dependencies/` (flat) | #3053 | `IsAuthenticated, IsProjectScheduler, IsProjectNotArchived` | the floor is enforced by `DependencySerializer._authorize_same_project_edge`, not by the classes — the flat route has no `project_pk`, so `has_permission` fails open (#2745) and `has_object_permission` never runs on a create. See §7 |

## Consequences

### Defects this surfaced, filed separately

Writing the matrix against the code found five things that are wrong today, independent
of the Designer. They are filed rather than fixed here:

- **#2745** — `_project_pk_from_view` fails open, so project-scoped permission classes
  silently no-op on `<pk>` routes. Root cause behind #2508 and #2551.
- **#2746** — `TaskBulkView` partially commits a rejected batch and then skips CPM
  recalculation and the board broadcast.
- **#2747** — delete-rights and edit-rights disagree about what "assignee" means
  (`TaskResource` vs `Task.assignee`).
- **#2748** — three role-floor inconsistencies: bulk create bypasses `PhaseViewSet`'s
  Admin floor; CSV import is Scheduler while MSP and Jira are Admin; `can_user_edit_task`
  denies the Enterprise 101–199 band that `can_user_write_estimates` admits.
- **#2749** — agent-authored batch writes produce no `AgentAction` row (0.5; the
  prerequisite for read-write MCP).

The Scheduler create-then-cannot-edit asymmetry is not filed separately: it is resolved
by `can_user_author_plan` above.

### Relationship to ADR-0772

ADR-0772 (client-minted task row ids) routes a repeat `create` through the **edit**
bar while the original passed the **create** bar, so the two bars disagreeing is not
merely untidy — it makes replay behavior role-dependent. This ADR closes the Scheduler
half of that. It does **not** close the Member half: a Member creating an *unassigned*
task still fails the edit bar, because `can_user_edit_task` requires
`assignee_id == request.user.pk`. ADR-0772 responds by bounding its own replay claim
rather than widening this predicate, and the question of whether a creator should be
able to edit their own unassigned rows is recorded on #2719 as one the matrix should
answer in a follow-up.

**Landing order: this ADR → ADR-0772 → #2723.**

### What this ADR does not decide

- **Whether a Member may edit their own unassigned rows.** Named above; deliberately
  left open because it widens `can_user_edit_task` for every caller and deserves its
  own decision rather than being carried in as a replay fix.
- **Whether the Product Owner facet grants Author mode.** The PO facet already produces
  a partially-editable grid (`can_user_edit_task`'s EPIC/STORY branch), which the
  Designer has never been asked to render. Needs a UX answer before an RBAC one.
- **Whether Author mode is the default for a Member, or opt-in.** Depends on the
  #2731/#2733 landing decision; it changes the first frame every new collaborator sees.
- **The floor for template *authoring*** (as distinct from applying one) — needs
  `enterprise-check` on #2729 first, since getting it wrong means moving a model
  between repos.
- **A batch size cap.** Reads as performance and abuse rather than authorization; it is
  required (see ADR-0772) but its value belongs to #2723.

## Acceptance criteria

- pytest: a Viewer is denied by `has_permission` — not only by the in-body object check
  — on each of the five task-authoring routes. No such test exists today.
- pytest: a Scheduler cannot enter Author mode, and `can_user_author_plan` returns
  `False` for every ordinal in 200–299.
- pytest: a Member may paste-many, and each row is gated individually.
- pytest: a Member is denied cascade, template apply, import-into-project, and
  seeded-delete.
- pytest: `ProjectSerializer.can_author` agrees with `can_user_author_plan` for all five
  roles.
- pytest: `POST /dependencies/` refuses a Member and a Viewer and accepts a Scheduler,
  asserted as an outcome so it survives #2745 moving where the floor is enforced (§7).
- vitest: `canAuthorDependencies` and `canAuthorPlan` each admit one band the other
  refuses, so no future "simplification" can collapse them back into one flag (§7).
- `rbac-check` runs against the endpoint → class map above.

## Related ADRs

- **ADR-0772** — client-minted task row ids; depends on this ADR for its replay claim.
- **ADR-0133** — the "one rule, called twice" predicate pattern `can_user_author_plan`
  follows.
- **ADR-0184** — RBAC defense-in-depth; §3 is the Viewer WebSocket rule, and its
  additive doctrine is why `IsProjectPlanAuthor` sits *alongside* `IsProjectMemberWrite`.
- **ADR-0363** — `Project.default_member_role` is MEMBER, which is why the floor is
  adoption-first.
- **ADR-0072** — the role band contract that #2748 item 3 turns on.
- **ADR-0105** — structural backlog acts at Admin or the PO facet.
