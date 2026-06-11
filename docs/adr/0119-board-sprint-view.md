# ADR-0119: Board sprint view

## Status
Accepted

## Context
The Kanban board (`BoardView`) always shows every committed task in the project.
When a team runs sprints, that's too noisy — they want to focus the board on the
tasks committed to the current (or a past) sprint (#429). The backend already
supports the filter: `GET /tasks/?sprint=<uuid>` (ADR-0037 Q5), and
`PATCH /tasks/{id}/` with a `sprint_id` for an ACTIVE sprint auto-records a
scope injection (`sprint_pending=True`, ADR-0102). This ADR covers the **web**
decisions to surface that as a board view.

P3M layer: Programs and Projects (single project, board). OSS.

## Decision

1. **Sprint scope is a `?sprint=` URL param** — a distinct, shareable axis from
   the `?view=` saved views (ADR-0191/#191). It is *not* folded into
   `BoardViewConfig`: a saved view is a bundle of column/sort/filter prefs, while
   sprint scope is a single shareable dimension that mirrors the backend
   `?sprint=` contract. Absent param = Project view (all committed tasks).

2. **Filter client-side, not via a new fetch.** `useScheduleTasks` is shared with
   the Gantt, which must always load every task; it already fetches the full task
   list and the board already applies client-side filters (My tasks, At risk,
   critical path). The sprint filter is applied the same way in `BoardView` —
   committed tasks whose `sprintId` ≠ the selected sprint are dropped from the
   phase columns. This avoids cache fragmentation (`['tasks', projectId]` stays a
   single entry) and an extra round trip. The backend `?sprint=` filter remains
   the contract for API/mobile/MCP consumers.

3. **The backlog band is unaffected.** In sprint view the phase columns scope to
   the sprint, but the backlog rail still shows sprint-less tasks — it is the
   intake source you drag from to pull work into the sprint.

4. **The filter dropdown offers ACTIVE + PLANNED + COMPLETED** (CANCELLED
   omitted). Viewing a *closed* sprint's board is a legitimate retrospective
   read. This **diverges from ADR-0059's sprint-*assignment* selector**, which
   excludes COMPLETED — different use case: filtering a view vs. assigning work.

5. **Drag-to-assign in PLANNED/ACTIVE sprint views.** Dropping a card into a phase
   while scoped to a PLANNED or ACTIVE sprint it isn't yet in sends `sprint_id` on
   the existing `PATCH /tasks/{id}/`. The backend flags `sprint_pending` for an
   ACTIVE sprint (post-activation injection, ADR-0102); a PLANNED link is part of
   the commitment baseline with no pending gate. A COMPLETED sprint view is
   **read-only for assignment** — we never back-date scope into a closed sprint.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Fold sprint into `BoardViewConfig` saved views | one persistence mechanism | conflates a shareable scope with a pref bundle; backend already speaks `?sprint=` |
| Server-side `?sprint=` fetch with sprint in the query key | smaller payloads | fragments the shared tasks cache, extra fetch; the full list is already loaded for the Gantt |
| Exclude COMPLETED from the filter (mirror ADR-0059) | consistency with the assignment selector | blocks the retrospective "look at last sprint's board" use case #429 explicitly wants |

## Consequences
- **Easier:** a sprint-scoped, shareable board link; drag-to-pull-into-sprint
  reuses the existing scope-injection gate; no new endpoint.
- **Harder:** two "blocked"-style nuances now coexist on the board axis — the
  filter shows COMPLETED (read-only) while assignment does not; documented here.
- **Risks:** none structural — pure client wiring over an existing backend filter.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web only
- Migration required: no
- API changes: no (reuses `?sprint=` filter + `PATCH sprint_id`)
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A — the drag-assign is a synchronous `PATCH`; the
   scope-injection record is written in the same request (ADR-0102 path).
2. Drain task: N/A.
3. Orphan window: N/A.
4. Service layer: reuses `maybe_record_scope_injection` (existing).
5. API response on best-effort dispatch: N/A — synchronous PATCH returns the task.
6. Outbox cleanup: N/A.
7. Idempotency: re-dropping a card already in the sprint sends the same
   `sprint_id`; the scope-injection service no-ops when the sprint link is
   unchanged (it only records on a sprint change).
8. Dead-letter / failure handling: a failed PATCH surfaces the existing board
   mutation error toast; the card reverts on cache invalidation. No new path.
