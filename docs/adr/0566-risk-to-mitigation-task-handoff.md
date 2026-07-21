# ADR-0566: Risk-to-Mitigation-Task Handoff in the Risk Register

## Status
Accepted

## Context
`Risk.tasks` has been a first-class Risk↔Task many-to-many link since ADR-0010, and
the `RiskSerializer.tasks` field is a writable `PrimaryKeyRelatedField(many=True)` that
accepts task UUIDs on POST/PATCH (validated: max 10, same-project). Read responses
serialize `tasks` to a list of task-UUID strings, and the web `Risk` type already
declares `tasks: string[]`.

Despite this, **no risk surface in the web app reads, renders, or edits the field**:
`RiskForm.tsx` hardcodes `tasks: []` on every create/update, and `RiskDetailView`
(in `RiskDrawer.tsx`) never renders linked tasks. The consequence (issue #2156, HIGH):
the core PM loop — risk → response → tracked work → status — dead-ends at the register.
A "Mitigating" risk with an overdue mitigation date (which the register loudly badges)
has no link to the work that mitigates it and no affordance to create that work.
"Mitigating" is an unverifiable label.

**P3M layer**: Programs and Projects (single-project risk register). Loved most by the
PM (Sarah) and Scrum Master (Alex) per the VoC panel — OSS-correct. Cross-project /
portfolio rollup of risk-linked-task status is explicitly Enterprise and out of scope.

This is a **frontend-only** change: the API contract already supports everything needed.
No new endpoint, serializer field, permission, or migration.

## Decision
Surface the existing `Risk.tasks` link in three places, all in `packages/web`:

1. **"Linked tasks" section in `RiskDetailView`** (read + navigate). Resolve each linked
   task UUID to a full `Task` object via `useScheduleTasks(projectId)` (which returns the
   project's `Task[]`), and render each as a button that opens the task in the app-wide
   task drawer via `taskDrawerStore.openTask(task, projectId)` (ADR-0138). Because
   `TaskDetailDrawer` requires a **full `Task` object** and there is no fetch-by-id hook
   (ADR-0138), `useScheduleTasks` is the correct resolution source — it gives us both the
   display name/status *and* the object the drawer needs, from one query. Opening a linked
   task **closes the risk drawer first**, then opens the task drawer, to avoid two stacked
   right-side drawers on desktop and two competing modal bottom-sheet focus traps on
   mobile (ADR-0437).

2. **Task picker in `RiskForm`** (attach/detach existing tasks). A search-and-select
   control seeded from the same project `Task[]`, letting the user attach up to 10
   existing, non-summary leaf tasks. On submit the form sends the **full desired id
   array** as `tasks` — because DRF `ModelSerializer.update` **replaces** the M2M set
   (confirmed: no custom `update`, and `perform_update` diffs old vs new to log
   `risk_linked`/`risk_unlinked`). Sending a partial array would silently unlink tasks.
   The picker is reachable only in create/edit mode, already gated by `canEditRisk`
   (Member+).

3. **One-click "Create mitigation task"** in `RiskDetailView` (create + link). Gated on
   `canEditTask(role) && canEditRisk(role)` (both Member+). It:
   - `POST /tasks/` with `{ project, name }` where `name` is derived from the risk title
     (`Mitigate: <title>`, truncated to the 512-char `Task.name` limit). **No `sprint`**
     (task lands sprint-less in the backlog) and **no `assignee`** (stays unassigned).
   - On success, `PATCH` the risk with `tasks = [...risk.tasks, newTaskId]` — including
     the existing ids, since PATCH replaces the set.
   - Shows an inline confirmation that names the outcome explicitly ("added to the
     backlog, unscheduled"); the new task then appears in the Linked tasks list. It does
     **not** auto-open the task drawer (no focus hijack) and does **not** notify anyone.

### VoC constraints honored
- **Sprint boundary (Alex + Jordan + Morgan, ADR-0131)**: created task has no sprint and
  is never injected into an active sprint. Verified server-side: omitting `sprint` leaves
  the task sprint-less by default.
- **No unrequested work (Priya)**: `POST /tasks/` fires no assignee notification on create
  (the `task.assigned` notification lives only in `perform_update`'s old/new diff), and we
  omit `assignee`, so the task is unassigned. No push, no auto-assignment.
- **Explicit backlog/unscheduled outcome (Morgan/Alex)**: the create confirmation names
  the unscheduled backlog state; the Linked tasks row shows the task's status.

### Unresolved / deleted linked tasks
A linked UUID that is not present in the loaded `Task[]` (soft-deleted — the `/tasks/`
list excludes deleted rows server-side — or otherwise absent) renders as a **muted,
non-interactive "Unavailable task" chip**, never an object-access crash. The component
must tolerate `tasksById.get(id) === undefined`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Resolve linked-task names via a new per-id fetch (`GET /tasks/{id}/`) or a new nested serializer | Smaller payload; works when the task isn't in the loaded list | New backend surface (escalates gate chain); N requests for N links; still needs a full `Task` for the drawer. Rejected — `useScheduleTasks` already returns full objects |
| Put the task picker and "Create mitigation task" both in `RiskForm` | One editing surface | "Create + link" needs a saved risk id; in create mode the risk has none. Rejected — create-task lives in the detail view of a saved risk |
| Send only added task ids on PATCH (append semantics) | Smaller diff | DRF replaces the M2M set — a partial array silently unlinks the omitted tasks. Rejected as a data-loss bug |
| Auto-open the new mitigation task drawer after create | Immediately editable | Focus hijack; jarring on mobile stacked sheets. Rejected — inline confirmation + list row instead |
| Multi-step "Create mitigation task" dialog (name/duration/date) | More control up front | Contradicts the issue's one-click framing; the task drawer already offers full editing after create. Rejected |

## Consequences
- **Easier**: the risk→work→status loop is navigable and verifiable; a PM can create and
  track mitigation work without leaving the register; "Mitigating" is backed by real,
  linkable tasks.
- **Harder**: `RiskDetailView` and `RiskForm` now depend on the project task list
  (`useScheduleTasks`), adding one query when the risk drawer is open. Gated to when the
  drawer is open so it stays inert otherwise.
- **Risks**: (a) PATCH replace-semantics data loss if a code path ever sends a partial
  `tasks` array — mitigated by always composing the full desired set and covering it with
  a unit test; (b) stacked-drawer focus conflicts on mobile — mitigated by closing the
  risk drawer before opening the task drawer; (c) an unresolved linked id crashing the
  section — mitigated by the "Unavailable task" fallback and a test for it.

## Implementation Notes
- **P3M layer**: Programs and Projects (single project).
- **Affected packages**: web only.
- **Migration required**: no.
- **API changes**: none. Uses existing `POST/PATCH /projects/{id}/risks/`,
  `POST /tasks/`, and `GET` task list. Confirmed the API already validates count (≤10)
  and same-project, and already emits `risk_linked`/`risk_unlinked` audit events and the
  `risk_updated` / `task_created` board broadcasts server-side (ADR-0207) — this change
  adds no write path and therefore requires no broadcast-check.
- **OSS or Enterprise**: OSS (`trueppm-suite`). `grep -r trueppm_enterprise packages/web/src`
  returns only an unrelated comment; no boundary crossing.

### Durable Execution
1. **Broker-down behaviour**: N/A for the new client code. It calls existing endpoints.
   Their server-side side effects (CPM recalculate on task create, board broadcasts) already
   use the established `transaction.on_commit` + outbox/enqueue patterns and are unchanged.
2. **Drain task**: N/A — no new async work introduced by this change.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: N/A on the client; the existing `POST /tasks/` path already routes CPM
   recalculation through `scheduling/services.py::enqueue_recalculate` server-side.
5. **API response on best-effort dispatch**: N/A — the client consumes existing synchronous
   REST responses (created risk / created task JSON).
6. **Outbox cleanup**: N/A — no new outbox usage.
7. **Idempotency**: The "Create mitigation task" flow is two calls (create task, then PATCH
   risk). A retry of the PATCH is idempotent because it sends the full desired set (re-linking
   an already-linked task is a no-op set-replace). A duplicated task-create would create a
   second task; the button is disabled while the mutation is pending to prevent double-submit.
8. **Dead-letter / failure handling**: If task-create succeeds but the follow-up risk PATCH
   fails, the task exists but is unlinked; the UI surfaces the PATCH error and the user can
   retry the link from the task picker (the task is now attachable). No orphaned durable state
   — a stray unlinked task is a normal backlog task, not a broken record.
