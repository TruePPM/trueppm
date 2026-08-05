# ADR-0799: Seeded landing — where a template apply lands, and what the banner is allowed to claim

## Status
Accepted

## Context

#2729 (ADR-0789) and #2730 (ADR-0786) built the data layer: a template apply writes
rows with provenance (`source_kind`, `seeded_at`, `edited_at`), and
`Task.objects.untouched_seeded(project)` is already the single, reused predicate for
"a machine wrote this and nobody has touched it since." Neither ADR designed what
happens the moment the apply is fired — today `NewProjectModal`'s `handleSubmit` calls
`useApplyTemplate().mutate(...)` fire-and-forget and navigates to
`/projects/:id/overview` regardless of `way`, exactly like a blank project. The
template's application id is captured nowhere past that mutation call. #2731 closes
that gap: the plan the user just committed to should be the first thing they see, not
an empty Overview they have to leave to find it.

Three design questions the issue does not resolve on its own, confirmed by an ADR
sweep before writing this one (no existing ADR — 0789, 0786, 0773, 0790, 0791 —
designs any of the three):

1. **Where does a template-way creation land, and does it vary by methodology?**
   ADR-0789 says apply "does not wait"; it never names a destination route.
2. **Is there a reusable bulk-delete for "Delete untouched rows (N)"?** No. Confirmed
   by direct grep: `TaskBulkView` (`tasks/bulk/`) takes explicit per-row IDs only, and
   ADR-0689's trash/restore is single-row. ADR-0786's own docstring on
   `untouched_seeded()` names this exact call site ("B4's bulk delete") as not yet
   built. ADR-0773 §4 already settled the RBAC question for it — Admin+, and **the
   server computes the set, never a client-supplied ID list** — but not the endpoint
   shape.
3. **Does the "Next strip" derivation rule need to be nailed down now?** The issue
   describes it as replacing "a static checklist" with something "derived from the
   plan" — a heuristic that will get compared against, and probably extended by,
   whatever #2734 (agile/backlog landing) does next.

## Decision

### 1. Landing routes on methodology, not on "way"

A template-way creation navigates to `/projects/:id/schedule?templateApplication=<id>`
**only when the applied template's methodology is `WATERFALL` or `HYBRID`**. When it is
`AGILE`, the existing `/projects/:id/overview` fallback is kept — #2734 owns replacing
that fallback with a backlog landing; this ADR does not build it, and does not want a
half-built agile branch guessed into existence here.

`CreatedProjectIntent` (the existing `#2710` vehicle for "what the user asked for at
the moment of commitment") gains two optional fields:

```ts
export interface CreatedProjectIntent {
  importCsv?: boolean;
  /** #2731: the application to show progress for and poll on arrival. */
  templateApplicationId?: string;
  /** #2731: gates the schedule-landing branch below to WATERFALL/HYBRID. */
  methodology?: Methodology;
}
```

`NewProjectModal` fills both from data it already has (`applyTemplate`'s `202` response
body and `derived.methodology`) — no new request. `handleSubmit` moves the
`onCreated(...)` call for the template way inside `applyTemplate.mutate`'s
`onSuccess`/`onError` callbacks instead of firing it unconditionally right after
`mutate()`. This still does not block on **seeding** (that stays async, rows arrive
over the board WebSocket as before) — it only waits on the `202` **dispatch**
response, which is a same-request round trip, not a Celery job. On dispatch failure the
existing toast fires and the user still lands, without an application id to poll —
the schedule renders its normal empty/first-run state, and the `SeedBanner` mounted
there is unaffected because it independently gates on the query param being both
present *and* resolving to a real application (§4).

Both call sites that own `onCreated` (`CreateDispatcher.tsx`, `Sidebar.tsx`) gain one
more branch, ahead of the existing `importCsv` branch (the two are mutually exclusive —
`way` is `'template' | 'blank' | 'import'`):

```
intent?.templateApplicationId && intent.methodology !== 'AGILE'
  → /projects/:id/schedule?templateApplication=<id>
intent?.importCsv
  → /projects/:id/schedule?import=csv
else
  → /projects/:id/overview
```

This mirrors the `?import=csv` / `?task=` / `?focus=` / `?cp=` convention `ScheduleView`
already reads via `useSearchParams` — no new state-passing mechanism.

### 2. `result_summary` gets a stable, documented shape

`TemplateApplication.result_summary` currently stores only `{"tasks_created": N}`
(`template_tasks.py:112`). The seed banner needs milestone and dependency counts too
("rows · milestones · dependencies · scheduled on `<calendar>`" per the issue). Rather
than have the frontend re-derive these by filtering the full task list (a second,
driftable definition of the same counts the server already knows at write time),
`materialize_structure` (`project_templates.py`) is changed to return a small result
object instead of a bare `list[uuid.UUID]`:

```python
@dataclass(frozen=True)
class MaterializeResult:
    task_ids: list[uuid.UUID]
    milestones_created: int
    dependencies_created: int
```

`apply_template` (`template_tasks.py`) writes:

```python
application.result_summary = {
    "tasks_created": len(result.task_ids),
    "milestones_created": result.milestones_created,
    "dependencies_created": result.dependencies_created,
}
```

Counts come from the rows/edges the function already built in memory (`sum(r.is_milestone
for r in rows)`, `len(edges)`) — no extra query. This is additive to the JSONField; no
migration. The "scheduled on `<calendar>`" clause is **not** stored here — it is a
project-level fact (`Project.effective_calendar.name`, ADR-0441), already exposed via
`ProjectDetailSerializer` and already read by `ScheduleView` (`blankProjectFacts`,
#2733's `calendarName`) — re-fetching it into `result_summary` would create a second,
staler copy of a fact that can change independently of the application (e.g. a calendar
swap after apply).

### 3. Bulk-delete gets one new action, matching ADR-0773 §4 exactly

A new `TaskViewSet` action, `detail=False` (the viewset is registered top-level, not
project-nested — same shape as the existing `trash` action it sits beside):

```
POST /api/v1/tasks/delete-untouched-seeded/
Body: {"project": "<uuid>"}
→ 200 {"deleted": N}
```

- **The server computes the set** via `Task.objects.untouched_seeded(project)` —
  never a client-supplied ID list, per ADR-0773 §4's explicit prohibition. The request
  carries only the project id.
- **RBAC is a manual role check, not the declared permission class alone.**
  `IsProjectAdmin.has_permission` resolves `project_pk` from `view.kwargs`, which is
  only populated for project-nested routes (`/projects/<project_pk>/...`).
  `TaskViewSet` is registered top-level (`router.register(r"tasks", ...)`), so for this
  `detail=False` action `view.kwargs` never carries a `project_pk` and `IsProjectAdmin`
  would silently no-op to "permitted" — exactly the gap `trash`'s own docstring works
  around by re-deriving `can_restore` per row instead of trusting the permission class.
  The action therefore reads `project` from the request body and calls
  `_membership_role(request, project.pk)` directly, rejecting anything under
  `Role.ADMIN` — the same explicit pattern `template_views.py::_require_project_admin`
  already uses for `publish`/`apply`. `IsProjectNotArchived.has_permission` has the
  identical route-shape blind spot (it also resolves `project_pk` from
  `view.kwargs` and returns `True` unconditionally when there is none), so the
  action checks `project.is_archived` explicitly too, right after the role
  check — a destructive sweep is exactly the wrong place to lean on a class that
  cannot see the project this request names. Both classes stay declared in
  `permission_classes` for the requests where they *can* resolve (any other
  action on this viewset), but this action does not depend on either for its own
  safety.
- **Soft-delete only, no explicit cascade.** Unlike `restore` (which must cascade
  because `trash` collapses subtrees to their roots for *display*), every row in
  `untouched_seeded(project)`'s result set is independently eligible — a child that a
  person has since edited is excluded by its own `edited_at`, exactly the same
  partial-subtree outcome `undo_template_application` already produces and that
  ADR-0786 §4 already accepts ("leaving a row behind is disappointing, deleting a
  sentence somebody wrote is not recoverable"). No new cascade logic is introduced;
  each row is soft-deleted independently in one `transaction.atomic()` block.
- A successful sweep enqueues one `enqueue_recalculate(project_id)` (existing service,
  never a bare `.delay()`) and one deferred `broadcast_board_event(..., "tasks_restructured",
  {})` via `transaction.on_commit`, mirroring `restore`.

### 4. The Next-strip derivation rule is fixed here, not left to drift

Three signal types, computed by one pure function
(`packages/web/src/features/schedule/deriveNextStripSuggestions.ts`) over data the
Schedule page has already loaded — no new request:

| Signal | Predicate |
|---|---|
| Unowned tasks | leaf (`!isSummary`), non-milestone, `isUntouchedSeed`, `assignees.length === 0` |
| Unconfirmed gates | `isMilestone && isUntouchedSeed` |
| Undeclared branches | top-level (`isSummary`, WBS depth 1) `isUntouchedSeed` task whose descendant subtree has zero entries in the unfiltered dependency-link set (`links`, keyed by `sourceId`/`targetId`) |

All three are scoped to `isUntouchedSeed` rows on purpose — the strip is about *this
plan, freshly seeded*, not a general project-health lint that would duplicate other
surfaces (Board's stale-task nudge, the reconcile strip). A row a person has since
edited has already been looked at and drops out of every signal, the same way it drops
out of the tick mark and the delete sweep — one provenance predicate, three consumers,
never three re-derivations.

The strip renders nothing when every count is zero (issue: "disappears when there is
nothing worth suggesting") and is capped to the same idle-collapse / `role="status"`
sr-only-first grammar as `ScheduleReconcileStrip`. Suggestion order is fixed
(unowned → unconfirmed gates → undeclared branches) rather than re-sorted by count —
stable order across renders matters more than value-ranking three numbers a user reads
in under a second. A future suggestion type is a new row in this table and a new
predicate function, not a new derivation mechanism.

### Design source disclosure

`DesignSync` (the Claude Design handoff tool referenced by the issue for case 02) was
not available in this session — confirmed via `ToolSearch` with three different query
shapes, all returning no match. This ADR and the implementation it authorizes are
therefore built from the issue text and the shipped precedent components only (the
same disclosure pattern MR !1910 used for #2728); no design-case copy is quoted
verbatim anywhere in code, tests, or docs. Banner and strip copy in the implementation
is original, written to the issue's stated tone ("Rename, delete, rearrange — none of
it is load-bearing") rather than assumed to match unseen mockup text.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Derive milestone/dependency counts client-side from the full task list | No server change | Re-derives a count the server already computed once at write time; a second definition that can silently disagree (the exact class of bug ADR-0786 §3 was written to prevent for "untouched") |
| Accept a client-supplied task-ID list for bulk delete | Simpler endpoint, reuses `TaskBulkView` shape | Directly forbidden by ADR-0773 §4 — the affordance's safety is entirely "the server asserts these were never touched" |
| Gate bulk-delete via `IsProjectAdmin` alone in `permission_classes` | Declarative, matches ADR-0773's literal wording | Silently no-ops on this top-level (non-project-nested) route — `view.kwargs` never carries `project_pk`, so the check passes unconditionally regardless of role |
| Let #2734 (agile landing) also decide the routing branch point | One less moving part in this ADR | Blocks #2731 on an unrelated issue's design; the `Methodology !== 'AGILE'` guard is a two-line, easily-revisited placeholder that unblocks both issues to proceed independently |
| Score/rank Next-strip suggestions by count | Surfaces the "biggest" gap first | Adds a second thing (a ranking rule) to get right and test, for three numbers a user reads in under a second; fixed order is simpler and just as legible |

## Consequences

- Template-way creation on a waterfall/hybrid template lands the user on the schedule
  they just committed to, with the banner and Next strip explaining what happened and
  how to undo it — closing the "empty Overview" gap #2731 exists to fix.
- `result_summary`'s shape is now part of what the frontend depends on; a future
  change to `materialize_structure`'s return type must keep `milestones_created` /
  `dependencies_created` or update both call sites (`template_tasks.py`,
  `packages/web/src/hooks/useProjectTemplates.ts`'s `TemplateApplication` interface).
- `untouched_seeded()` gains its fourth real caller (delete), exactly as ADR-0786's
  docstring anticipated — no drift, no new predicate.
- Agile-methodology template applies keep landing on Overview until #2734 ships; this
  is a known, intentional gap, not an oversight — the extension point is the single
  `methodology !== 'AGILE'` condition in two files.

## Implementation Notes
- P3M layer: Programs and Projects (OSS) — single-project landing and schedule UI.
- Affected packages: api (views.py, template_tasks.py, project_templates.py), web
  (shell/NewProjectModal.tsx, CreateDispatcher.tsx, Sidebar.tsx, features/schedule/).
- Migration required: no — `result_summary` is an existing JSONField; no schema change.
- API changes: yes — new `POST /api/v1/tasks/delete-untouched-seeded/` action;
  `TemplateApplication.result_summary`'s value shape gains two keys (additive, no
  breaking change to existing consumers, which already treat it as an opaque dict).
- OSS or Enterprise: OSS — single-project schedule landing, no cross-project scope.

### Durable Execution
1. Broker-down behaviour: N/A for the new bulk-delete action (synchronous request/
   response, bounded by `untouched_seeded()`'s own 7-day/project scope — no queue).
   The apply path it lands on already has its outbox story from ADR-0789 §Durable
   Execution; this ADR does not change it.
2. Drain task: N/A — no new async work; the delete action's only deferred step is the
   existing `enqueue_recalculate` service call, whose own durability is ADR-0784's.
3. Orphan window: N/A — no new outbox rows.
4. Service layer: reuses `scheduling/services.py::enqueue_recalculate` (never a bare
   `.delay()`) and `sync/broadcast.py::broadcast_board_event`, both existing.
5. API response on best-effort dispatch: the delete action returns `200 {"deleted": N}`
   synchronously — the soft-deletes themselves commit in the request; only the
   follow-on CPM recalculation is deferred, and that deferral already returns `202`
   from its own enqueue path, unaffected by this ADR.
6. Outbox cleanup: N/A — no new outbox table.
7. Idempotency: the delete action is naturally idempotent — a second call re-derives
   `untouched_seeded(project)`, which returns an empty (or smaller) set once the first
   call's rows are soft-deleted (`is_deleted=False` is part of the manager's filter).
8. Dead-letter / failure handling: N/A — synchronous, no retry queue; a mid-sweep
   exception rolls back the whole `transaction.atomic()` block, leaving every row
   untouched rather than partially deleted.
