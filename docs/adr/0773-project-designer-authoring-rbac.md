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

### Endpoint → class map

| Endpoint | Issue | `permission_classes` | Per-row gate in body |
|---|---|---|---|
| `POST /projects/{pk}/tasks/bulk/` | #2723 | `IsAuthenticated, IsProjectMemberWrite, IsProjectPlanAuthor, IsProjectNotArchived` | `can_user_edit_task` on every update; `_require_wbs_restructure_permission` on any op that moves a row |
| subtree classification cascade | #2735 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | none — Admin edits any row |
| template apply / seed | #2729 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | — |
| delete untouched seeded rows | #2731 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | server recomputes the set from `seeded_at`/`edited_at` (#2730) |
| import into existing project | #2732 | `IsAuthenticated, IsProjectAdmin, IsProjectNotArchived` | already the shipped floor |
| import creates project | #2710 | `IsAuthenticated` | — |

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
