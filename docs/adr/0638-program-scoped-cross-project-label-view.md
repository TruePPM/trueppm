# ADR-0638: Program-scoped cross-project "tasks with label X"

- **Status:** Accepted
- **Date:** 2026-07-26
- **Issues:** #2333 (this ADR), #2332 (label-filter umbrella)
- **Extends / amends:** ADR-0400 (task labels), ADR-0620 (label filter beyond the
  Board), ADR-0401 (findability — amended, see Decision 6), ADR-0120 (cross-project
  reads within a program — the access model is reused verbatim)

## Context

Labels are **project-scoped**: `Label.project` FK with `unique(project, name)`, a
curated colored catalog per project (ADR-0400). That is the right model for a
label *catalog* — but it means the question a program manager actually asks,
"show me everything tagged `security-review` across this program", has no answer.
The Board facet only gathers labels present on that one board's cards, and
ADR-0620 extended filtering to three more views while leaving all four
single-project.

There is no workspace-wide task search — ADR-0401 recorded its absence
deliberately. So this is the first cross-project task *query* in the product, and
the shape it takes sets the precedent for every one after it.

**P3M layer:** Programs and Projects. A program manager coordinating related
projects is the OSS adoption unit; a portfolio manager comparing programs is not.

## Decision 1 — the program is a path segment, never a query parameter

```
GET /api/v1/programs/{program_pk}/label-tasks/?label=<name>
```

**Rejected:** `GET /api/v1/tasks/?label=<name>&program=<id>`.

The rejection is the whole point of this ADR, so it is worth stating precisely.
`TaskViewSet` inherits `ProjectScopedViewSet`, which filters every queryset to the
caller's `ProjectMembership` rows. It is tempting to conclude that a label filter
on `TaskViewSet` is therefore "already safe" and just needs an optional `?program=`.
It is safe — and it is still wrong:

> Membership scoping is a **security** boundary. It is not the **product**
> boundary.

A user who belongs to projects in five different programs, calling an unscoped
`?label=` query, receives a **cross-program aggregation**. Every row is one they
are entitled to see, so nothing leaks — but the result set is the
portfolio-shaped view that belongs to `trueppm-enterprise`, shipped in the
community edition by accident, and it silently creates the workspace-wide task
search ADR-0401 says does not exist.

A query parameter can be omitted. A path segment cannot. Nesting under
`programs/{program_pk}/` makes the constraint unforgeable rather than
conventional: there is no request expressible against this endpoint that means
"across all my programs". One future `required=False` cannot regress it.

This also matches the established route convention — `programs/<program_pk>/`
already nests `backlog-items`, `ceremonies`, `assets`, `api-tokens` and
`phase-gate-config`.

**OSS non-goals**, recorded so a later slice does not drift across the line:
read-only; exactly one program; no health/RAG overlay; no cross-program rollup;
no per-project aggregate scoring; no saved or scheduled delivery of the view.

## Decision 2 — access reuses ADR-0120 D5 exactly: program membership admits, project membership reveals

Program membership and project membership are **different sets**. A program member
is not automatically a member of every project in that program. The naive readings
are both wrong:

- gate on `IsProgramMember` alone → leaks tasks from projects the caller cannot read;
- gate on `ProjectMembership` alone → a program lead with no project rows sees an
  empty view and concludes the feature is broken.

ADR-0120 D5 already settled this shape for the program schedule: `IsProgramMember`
admits the caller to the program-level read, and a `can_access_project` predicate
governs what is revealed per member project. This ADR reuses that model rather
than inventing a second one.

Concretely:

- `permission_classes = [IsAuthenticated, IsProgramMember]` — enforced in
  `has_permission` before the queryset runs, so a non-member gets 403 rather than
  an empty 200.
- The task queryset is restricted to member projects the caller can read
  (`ProjectMembership`, `is_deleted=False`) — the same predicate
  `ProjectScopedViewSet` applies.
- **Withholding is disclosed, never silent.** The response envelope carries
  `withheld_project_count`: the number of the program's projects that were
  excluded because the caller lacks membership. A program manager seeing
  "3 tasks · 2 projects not shown" understands the list is partial; a bare list of
  3 is a wrong answer presented as a complete one. This mirrors D5's reasoning
  that a partial view must announce itself.

## Decision 3 — labels match by name, case-insensitively, and the group carries no single color

`unique(project, name)` means the *same* name in three projects is three rows with
three ids and possibly three different colors. Matching therefore cannot use ids.

- **Match on name, case-insensitively** (`name__iexact`). A PM who typed
  `Security-Review` in one project and `security-review` in another has one
  concept, not two, and telling them otherwise is a bug report waiting to happen.
  Labels are curated and short (`max_length=50`), so the collision risk that would
  normally argue for case-sensitivity does not apply.
- **A name present in only one project of the program is still valid.** Rejecting
  it would make the filter's legal values depend on how widely a label happens to
  have spread, which is unpredictable to the user. It returns that project's tasks.
- **The group has no single color.** Colors are per-project and equally valid;
  picking one project's color to represent all of them asserts a canonical answer
  that does not exist. Each task row therefore renders its *own* project's label
  chip with that project's color — the pill a user already recognises from that
  project. The filter control itself renders the name in a neutral token, not in
  any one project's hue.
- Soft-deleted labels never match: every label read is filtered
  `is_deleted=False`, per the established `Prefetch` pattern.

## Decision 4 — a dedicated read-only viewset, and a service function that takes project ids

This does **not** ride `TaskViewSet`. That viewset is a full `ModelViewSet` whose
`get_queryset` already carries eleven query-parameter filters and whose permission
stack (`IsProjectMemberWrite`, `IsProjectNotArchived`) is project-shaped, not
program-shaped. Bolting a program-nested, read-only, differently-permissioned
route onto it would make the most security-sensitive queryset in the codebase
harder to reason about for no gain.

Instead: a read-only `ProgramLabelTaskViewSet` (list only), backed by service
functions in a dedicated `apps/projects/program_label_services.py` — mirroring the
existing `backlog_services.py`, rather than growing the 8,000-line `services.py`:

```python
def tasks_by_label_name(
    *, project_ids: Iterable[UUID], label_name: str
) -> QuerySet[Task]: ...
```

Taking an explicit `project_ids` iterable — rather than a `Program` — is the
extension point enterprise-check asked for: `trueppm-enterprise` can call the same
function with a portfolio's project set to build the cross-program view, and the
OSS package never learns that portfolios exist.

## Decision 5 — the program label catalog is one aggregate query, and the response carries the project inline

**Catalog for the picker.** There is no program-level label catalog. Synthesizing
it per project is the obvious N+1. One query instead:

```python
Label.objects.filter(project_id__in=readable, is_deleted=False)
     .annotate(name_key=Lower("name"))
     .values("name_key")
     .annotate(project_count=Count("project", distinct=True), display_name=Min("name"))
     .order_by("name_key")
```

Grouping is keyed on the **lowercased** name, and must be: the task filter matches
with `iexact`, so grouping the catalog by exact name would list `Security-Review`
and `security-review` as two entries returning byte-identical result sets — the
picker would contradict the filter. The displayed spelling is the
alphabetically-first original, so one concept yields one entry that still reads the
way a human typed it.

Exposed as `GET /api/v1/programs/{program_pk}/label-catalog/`. Counts are of
*projects carrying the name*, not of tasks — a task count would require joining
the whole task table to render a picker and is the kind of read that looks free at
5 projects and is not at 50. This deliberately differs from ADR-0620 Decision 2,
where per-label counts are computed client-side over already-loaded rows; here
there is no single loaded row set to count over.

**Task rows.** Cross-project results are meaningless without saying which project
each row belongs to, so the serializer includes a compact
`project: {id, name, code}` object. `code` is included because it is what appears
in a task's short reference and is how PMs actually disambiguate two similarly
named projects.

**N+1 strategy** — every one of these is load-bearing at 50 projects:

```python
qs.select_related("project")
  .prefetch_related(Prefetch("labels", queryset=Label.objects.filter(is_deleted=False)))
```

**Ordering and pagination.** The viewset sets `filter_backends = []`. The project
enables DRF's `OrderingFilter` globally, and inheriting it would let `?ordering=-name`
override the ordering below — which is not cosmetic: the UI groups rows by project
and assumes they arrive grouped, and `name` is not unique, so ordering by it alone is
not a total order and page boundaries can then skip or repeat rows. Ordering is
`(project.name, wbs_path)` — grouping by
project first, because the user's mental model is "which project is this in", and
`wbs_path` keeps each project's rows in plan order rather than creation order. The
ordering is total and stable, which matters: a non-deterministic order across
projects makes cursor pagination silently skip rows. Standard page-number
pagination applies.

**Scale guard.** Unlike the program schedule this runs no CPM, so
`MAX_PROGRAM_TASKS` (5,000) does not apply — pagination bounds the response. The
label-catalog query is the one to watch; it is indexed by `project` and returns at
most a few hundred names.

## Decision 6 — ADR-0401 is amended, not contradicted

ADR-0401 recorded that no workspace-wide task-search endpoint exists. That
constraint stands. It is amended to read:

> There is no **workspace-wide** task search. **Program-scoped** cross-project
> task reads are permitted, and must carry the program as a **path segment** so
> the scope cannot be widened by omitting a parameter.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Program in path + name matching (chosen)** | Boundary is structural; reuses ADR-0120 access model and existing route convention | New viewset; name-matching semantics must be documented for users |
| `?program=` filter on `TaskViewSet` | No new route; reuses `?labels=` plumbing | Boundary depends on a validator; one `required=False` ships the Enterprise view; grows the highest-risk queryset in the codebase |
| Promote `Label` to program- or workspace-scope | One id per label; no name matching | Breaking data migration across every existing project; destroys per-project curation, which is ADR-0400's actual point; forces one color where teams legitimately differ |
| Denormalize a `label_name` column onto `Task` | Fastest query | Duplicated state to keep in sync on every rename; a rename becomes a bulk write; the M2M already answers this |

## Consequences

**Easier.** The program manager's most common question gets a real answer. The
`tasks_by_label_name` service is the seam Enterprise needs for the portfolio
version, so that feature does not require re-opening OSS code. The path-segment
rule gives every future cross-project read an unambiguous precedent.

**Harder.** A second label-filter concept now exists (id-based within a project,
name-based across a program), and the difference must be explained in docs or it
will read as an inconsistency. The program label catalog is a genuinely new read
with its own performance profile.

**Risks.** The main one is scope creep toward the Enterprise line — the natural
next asks are "show me all programs" and "add health colors", both explicitly
out of bounds here. The `withheld_project_count` field is a partial-visibility
disclosure, and its copy must not imply the user can request access from this
view (that is a membership flow, not a filter).

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** api, web
- **Migration required:** **no** — no model changes; this is entirely read-side
- **API changes:** yes — two new read-only endpoints:
  - `GET /api/v1/programs/{program_pk}/label-tasks/?label=<name>` (paginated task list)
  - `GET /api/v1/programs/{program_pk}/label-catalog/` (distinct names + project counts)
- **OSS or Enterprise:** **OSS** (`trueppm-suite`), per the enterprise-check on #2333

### Durable Execution

1. **Broker-down behaviour:** N/A — both endpoints are pure reads with no async
   side effects. Nothing is dispatched, so there is no durability gap to close.
2. **Drain task:** N/A — no async work is enqueued.
3. **Orphan window:** N/A — no outbox rows are written.
4. **Service layer:** new module `apps/projects/program_label_services.py` — `tasks_by_label_name(*, project_ids, label_name)`,
   and `program_label_catalog(*, project_ids)` for the picker. Both take explicit
   project-id iterables so Enterprise can reuse them with a portfolio's set.
5. **API response on best-effort dispatch:** N/A — responses are synchronous 200s
   with a standard paginated envelope; there is no queued work to report.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** N/A for writes (there are none). Both endpoints are GETs and
   therefore naturally idempotent; repeated calls with identical parameters return
   identical results modulo concurrent task edits.
8. **Dead-letter / failure handling:** N/A — no task execution. Request-level
   failures follow the standard DRF path: a non-member receives 403 from
   `IsProgramMember`, an unknown `program_pk` receives 404, and a missing or empty
   `label` parameter receives a 400 with a field error rather than silently
   returning the program's entire task set (the fail-closed default matters here —
   an ignored filter would turn this into the unbounded program task dump this ADR
   is otherwise careful not to build).
