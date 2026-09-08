# ADR-1118: Resource Allocation Endpoints Cap at a Resource Boundary Rather Than Paginate

## Status

Accepted (2026-09-07)

## Context

P3M layer: **Programs and Projects** (OSS). `resource-contention` aggregates across the
member projects of *one* program, which is within-program visibility — it does not move
upward toward Portfolio, so no boundary question arises.

Three read endpoints in the resource cluster return unbounded result sets (#3576):

- `GET /projects/{id}/resource-allocation/` (`projects/views.py`) — every live
  `TaskResource` row in the project.
- `GET /programs/{id}/resource-contention/` (`projects/program_views.py`) — the same,
  across every member project of the program.
- `GET /projects/{id}/utilization/` (`projects/utilization.py`) — a per-resource,
  per-working-day load map.

Four forces:

1. **The sort is the expensive half of the query, and it is avoidable.** Both allocation
   endpoints end in `.order_by("resource__name", …)`. `resources_resource.name` is two
   joins from `resources_task_resource`, so Postgres must materialize the entire joined
   set and sort it on a text column from the far table. There is no `LIMIT` to let it
   stop early, and no index can serve the key — a composite index cannot span two tables.

2. **The window does not bound the result, and must not be made to.** Tasks with null
   CPM dates are deliberately retained so the client can render its "Unscheduled"
   section. Narrowing `start`/`end` therefore cannot cap the row count, and "fix" it by
   dropping undated rows is off the table: the unscheduled tray is the feature.

3. **Overallocation detection is client-side by ADR-0031.** The client receives every
   span a resource holds and sums daily units against `max_units` itself. This is the
   constraint that decides the shape question below: any envelope that can hand a client
   *part* of a resource's spans makes that resource's verdict silently wrong — not
   missing, wrong, and wrong in the safe-looking direction (under-reported load).

4. **The envelope has many consumers.** Fourteen web components read
   `resources[].tasks[]`; seventeen Playwright specs mock these URLs with a bare
   `{resources: []}` object; a second, hook-bypassing `useQuery` in `HeatmapCellDrawer`
   reads the same endpoint for a single resource in a single week.

The `utilization` endpoint has two further, separable defects: `unassigned_task_count`
ships a Python set as a literal `NOT IN (…)`, and the payload repeats each task UUID once
per working day of its span.

## Decision

**1. Do not paginate `resource-allocation` or `resource-contention`. Cap them at a
resource boundary and disclose the cut.**

Fetch `_ALLOCATION_ASSIGNMENT_LIMIT + 1` assignment rows ordered by `resource_id`, then
**drop the trailing partial resource group**, so every resource in the response carries
*all* of its in-window spans. Return two additive fields:

```jsonc
{
  "project_id": "…", "window_start": "…", "window_end": "…",
  "resources": [ … ],
  "resource_count": 42,   // resources in scope, before the cap
  "truncated": false      // true when the cap dropped whole resources
}
```

The boundary rule is the whole point, not an implementation detail: it is what keeps
ADR-0031's client-side verdict *exact* for every resource that is returned. A resource is
either wholly present and correctly judged, or wholly absent and visibly counted in
`resource_count`. There is no partially-present resource, so there is no silently
under-reported load.

`_ALLOCATION_ASSIGNMENT_LIMIT = 20000`, module-level in `projects/views.py` and imported
by `program_views.py`. `MC_TASK_CAP` is 5,000 tasks; at the ~1.5 assignments per task the
issue measures that is ~7,500 rows, and a heavily-staffed project at 3 per task is
~15,000. The cap is set clear of all of those on purpose, so a project inside the
documented envelope is never truncated. Tests monkeypatch it rather than build 20,000
rows, following `_TASK_TRASH_LIMIT`.

**Be honest about what the cap does and does not buy.** It bounds the *pathological*
case, not the supported one: a 5,000-task project still returns a multi-MB body, because
20,000 rows is above its row count by design. What this ADR removes from the supported
case is the *unbounded sort* — decision 2 below — not the payload size. Bounding the
payload requires windowing or pagination, and every option that does so is rejected in
the table below. That half of #3576 is therefore explicitly deferred, not solved — filed
as #3594 with the rejected options and their reasons, so the next person meets the record
instead of re-deriving it.

**2. Sort in Python after a covering fetch; add no index.**

`order_by("resource_id", "_span_start")` — both local to the already-filtered join — and
re-sort the grouped resources by `name` in Python at the end, and each resource's task
list by span start. The emitted JSON is **byte-identical** to today's for any response
that is not truncated: same resource order, same task order within a resource. This is
the issue's own "sort in Python after a covering fetch" alternative, and it is preferred
over its "add an index" alternative because no single index can serve a sort key that
lives in a different table from the rows being sorted.

**3. `unassigned_task_count` uses `~Exists`, not a literal `NOT IN`.**

```python
.exclude(Exists(TaskResource.objects.filter(task=OuterRef("pk"))))
```

This also removes the accumulation loop that built the Python set from the *day
expansion*, which fixes a latent correctness bug: a task whose assignments produce no
working day inside the window (a span falling entirely across non-working days) is
counted as *unassigned* today, though it plainly has an assignment. `~Exists` answers the
question the field name asks.

**4. The per-day task-UUID list keeps its shape. The size fix is deferred, not dropped.**

`UtilizationDayEntry.tasks: string[]` has two live consumers — `LoadTooltip` and
`ResourceOverallocationDrawer`, both of which render the ids as a "contributing tasks"
list. No day-range shape preserves both without a client rework, and the endpoint's
default window is already capped at ±8 weeks (`_DEFAULT_WINDOW_WEEKS`), so the ~6×
inflation the issue cites occurs only on an explicit "Fit to project" request the user
deliberately made. Reshaping it is a real breaking change whose only benefit is bytes;
it is filed as #3594 rather than bundled into a perf fix.

**5. `truncated` is not reachable from MCP, and that is a recorded non-goal for 0.4.**

The disclosure contract this ADR adds exists so a client can tell a complete roster from
a cut one — and the client class 0.4 is built around, the read-only MCP server, cannot
see it. `packages/mcp/src/trueppm_mcp/tools.py` hand-authors one function per API call
and has **no** tool for `resource-allocation`, `resource-contention`, or `utilization`;
an MCP client cannot ask "who is overallocated" at all, let alone learn that the answer
was capped. Both responses are also declared `OpenApiTypes.OBJECT`, so a schema-driven
client gets no typed knowledge of the new fields either — they exist in the
`@extend_schema` prose and in `api/reference.md`, nowhere machine-readable. Adding an MCP
tool is out of scope for a perf fix and is filed as **#3595**, which also carries the
question of whether these two endpoints should get real response serializers. Writing
this down is the point: the gap was invisible until the `ai-review` gate looked for it,
and an unrecorded gap is indistinguishable from an oversight.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Cap at a resource boundary + `truncated` (chosen)** | Bounds the payload; keeps every returned resource's ADR-0031 verdict exact; additive fields only, so 17 e2e mocks and 14 components keep working; matches the house `_TASK_TRASH_LIMIT` precedent | A truncated response is a partial picture — mitigated by `resource_count` + a client notice, but it is still a cut |
| B. DRF `PageNumberPagination` by assignment | Standard envelope; free `count` | Breaks ADR-0031 outright — a resource split across a page boundary is judged on half its spans, and under-reports load. Envelope change breaks every consumer and mock |
| C. Paginate by resource (cursor over `Resource`) | Preserves the ADR-0031 verdict | The client has no paging UI for this view and would immediately re-implement `fetchAllPagesParallel` — the exact antipattern #2277 is open against. Same envelope break as B for no gain over A |
| D. Cap the `start`/`end` window and 400 beyond it | Trivial | Does not work: undated tasks are deliberately retained, so the window does not bound the row count (force 2). Would also regress "Fit to project" |
| E. Add an index serving `(task.project_id) → resource.name` | No code change to the grouping | Not expressible — the sort key is in `resources_resource`, the rows are in `resources_task_resource`. Postgres cannot index across the join. Also costs a migration, and 22 concurrent worktrees make migration numbers a live collision surface |
| F. Reshape `utilization` days to task day-ranges | Largest byte saving | Breaks `LoadTooltip` and `ResourceOverallocationDrawer`; benefit is bytes on a window already capped at ±8 weeks. Deferred, not rejected |

## Consequences

**Easier**

- The allocation query stops sorting a multi-thousand-row join on a far-table text column,
  and stops without a `LIMIT`.
- `unassigned_task_count` becomes one indexable `NOT EXISTS` subquery instead of an
  O(N) literal that also grew the SQL text ~40 bytes per task.
- The endpoints acquire a stated ceiling, so a future regression has something to fail
  against — three query-count tests, each varying the number of underlying rows.

**Harder**

- Two more fields for every client of these endpoints to understand, and a truncation
  notice to render on `ResourceView` and `ProgramResourcesPage`. A client that ignores
  `truncated` shows a complete-looking but partial roster.
- The Python re-sort moves ordering out of the database, so ordering is now asserted by
  tests rather than guaranteed by the query. The existing `test_response_shape` and the
  new query-count tests carry that.

**Risks**

- `resource_count` costs a second query (`COUNT(DISTINCT resource_id)`) — but only on the
  truncated path. When nothing was cut, the number of grouped resources *is* the count,
  so the common request pays nothing for the field. This is why the query-count tests
  assert a constant count on the untruncated path: adding an unconditional aggregate here
  would have made every allocation read one query more expensive to buy a field that is
  redundant 100% of the time in practice.
- **The cap's arithmetic is per project, but `resource_contention` reuses it per
  program.** A program of six well-staffed projects can reach 20,000 rows without any
  single member being pathological. This is a deliberate simplification — one constant,
  one meaning — and the disclosure is the same either way. Split the constant if it
  starts firing on real programs; do not raise it blindly.
- The cap value is a judgment call, and it is set toward "never fires" on purpose. Set
  too low it truncates real projects — the Resources view would degrade first for exactly
  the large project that needs it most. 20,000 clears a 5,000-task project at 3
  assignments per task, so anything that trips it is already outside the supported
  envelope. The cost of that choice is that the cap does nothing for response size on a
  supported project.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: **api**, **web**
- Migration required: **no** — the chosen sort strategy needs no index (option E rejected)
- API changes: **yes, additive only.** `resource_count: int` and `truncated: bool` added
  to the `resource-allocation` and `resource-contention` response objects. No field is
  removed, renamed, or retyped; ordering is unchanged. Additive per ADR-0208's change
  classes, so no deprecation window is required.
- OSS or Enterprise: **OSS** (`trueppm-suite`). `resource-contention` is within-program
  visibility; cross-program leveling and the portfolio heat map remain Enterprise.

### Durable Execution

1. Broker-down behaviour: **N/A** — all three are read-only `GET` endpoints with no
   async side effects. Nothing is dispatched, so there is nothing to lose.
2. Drain task: **N/A** — no async work is enqueued.
3. Orphan window: **N/A** — no outbox rows are written.
4. Service layer: **N/A** for dispatch. The shared read helper is
   `projects/views.py::_resolve_allocation_window`, already used by both endpoints so the
   window semantics cannot drift; the new cap helper joins it there for the same reason.
5. API response on best-effort dispatch: **N/A** — synchronous `200`, or the existing
   `409` (schedule not computed) / `400` (bad window).
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: reads are naturally idempotent. The cap is deterministic given a fixed
   database state: rows are ordered by `resource_id` before the slice, so the same
   request truncates at the same resource boundary every time rather than returning a
   different arbitrary subset per call.
8. Dead-letter / failure handling: **N/A** — no task to fail. A truncated read is not a
   failure; it is reported in-band via `truncated` and `resource_count`.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1118`
- [x] Any issue carrying pre-ADR scope rewritten — **title and body** — led by a dated
      correction note. **Count: 0** — this ADR is written alongside the branch that
      implements it, so no issue predates it. #3576 proposed four fixes; this ADR adopts
      three and defers the fourth (option F) to a follow-up, which is recorded in the MR
      rather than by rewriting #3576.
