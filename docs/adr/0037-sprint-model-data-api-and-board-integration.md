# ADR-0037: Sprint Model — Data, API, and Board Integration

## Status
Proposed

## Context

ADR-0036 established the philosophy: TruePPM is the hybrid PM tool that bridges
Gantt-driven traditional PM with sprint-driven agile delivery, on the same project,
in the same data model. Sprints are first-class OSS features, not a separate project
type. Voice-of-Customer Persona 6 (Alex Rivera, Scrum Master, 2026-04-28) scored
TruePPM 3/10 against agile use cases with three blocking gaps: no sprint container,
no velocity, no burndown.

This ADR resolves the data model, API surface, board integration, and durable
execution patterns required to ship the v1 sprint feature. It does **not** design
the v1.1 CPM-feedback mechanism (deferred per ADR-0036), but ensures the data model
does not foreclose it.

### Research findings

A Phase 1 research pass (parallel agents, 2026-04-28) surfaced facts that adjust
some assumptions in ADR-0036:

- **Phase is not a model.** ADR-0036's "Phase → Milestone → Sprint → Task" decomposition
  is aspirational. In code, phases are conceptual only — there is no `Phase` model,
  no `phase` field on `Task`. The board's "phase rows" are derived from summary task
  hierarchy (ADR-0024, proposed). The actual decomposition the data model can support
  today is: **Project → (Sprints, Tasks)** with `Task.is_milestone=True` flagging
  milestones and an optional `Sprint.target_milestone` link.

- **`Task.status` has 5 canonical values:** `BACKLOG`, `NOT_STARTED`, `IN_PROGRESS`,
  `REVIEW`, `COMPLETE`. (`ON_HOLD` is legacy; migration 0020 already moved rows.)
  Sprint task carry-over rules must use this exact vocabulary.

- **`story_points` does not exist.** ADR-0022 (Burn Charts, proposed) flagged this
  as a prerequisite. This ADR adds it.

- **`BoardColumnConfig.wip_limit` is frontend-only.** The Django model has no
  `wip_limit` field — it lives in `useBoardConfig.ts` defaults and is never
  persisted. Sprint feature does not strictly require server-side WIP limits in
  v1, but should be additive when ADR-0013 amendments land them.

- **No time-series snapshot pattern exists.** ADR-0022 proposes `BurnSnapshot` for
  project-scoped burndown but is not yet accepted. This ADR defines a sprint-scoped
  snapshot table independently rather than blocking on ADR-0022.

- **Outbox pattern is canonical.** `apps/scheduling/services.py` + `tasks.py` is the
  template. Sprint close uses this exact shape.

- **OSS boundary holds.** `grep -r "trueppm_enterprise" packages/` returns one
  comment-only hit. Sprint feature lands entirely in OSS.

## Decision

### Q1 — Sprint data model

**Sprint** is a new model in `apps/projects/`, alongside `Task` and `Risk`. It is
a project-scoped child entity following the `Risk` model pattern.

```python
class SprintState(models.TextChoices):
    PLANNED = "PLANNED", "Planned"
    ACTIVE = "ACTIVE", "Active"
    COMPLETED = "COMPLETED", "Completed"
    CANCELLED = "CANCELLED", "Cancelled"


class Sprint(VersionedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="sprints")
    short_id = models.CharField(max_length=8, editable=False)  # e.g. "SP-A1B2"
    name = models.CharField(max_length=255)
    goal = models.TextField(blank=True, default="")
    start_date = models.DateField()
    finish_date = models.DateField()
    state = models.CharField(
        max_length=12, choices=SprintState.choices,
        default=SprintState.PLANNED, db_index=True,
    )
    target_milestone = models.ForeignKey(
        Task, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="targeting_sprints",
        help_text="Optional milestone task this sprint progresses toward.",
    )
    # Snapshotted on activation (committed_*) and closure (completed_*)
    committed_points = models.PositiveIntegerField(null=True, blank=True)
    committed_task_count = models.PositiveIntegerField(null=True, blank=True)
    completed_points = models.PositiveIntegerField(null=True, blank=True)
    completed_task_count = models.PositiveIntegerField(null=True, blank=True)
    activated_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        related_name="created_sprints",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    history = HistoricalRecords(excluded_fields=["server_version", "deleted_version"])

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_sprint_short_id_per_project",
            ),
            models.CheckConstraint(
                check=models.Q(finish_date__gt=models.F("start_date")),
                name="sprint_finish_after_start",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "state"], name="sprint_project_state_idx"),
            models.Index(fields=["project", "start_date"]),
        ]
```

**Sprint backlog as ForeignKey on Task, not a through table.** A task can be in
exactly one sprint at a time (matches Jira/Linear semantics). Carry-over moves
the FK; historical sprint membership is reconstructable from `HistoricalTask`.
A through table would over-engineer the common case.

```python
# Added to Task model:
sprint = models.ForeignKey(
    "Sprint", on_delete=models.SET_NULL, null=True, blank=True,
    related_name="tasks", db_index=True,
)
story_points = models.PositiveSmallIntegerField(null=True, blank=True)
```

Rationale:
- `VersionedModel` so sprints sync to mobile via the existing delta-sync.
- Project-scoped FK (CASCADE) matches `Risk`/`Task` — RBAC resolves through `project`.
- `short_id` follows the existing `_next_short_id` pattern. Prefix `SP-` is a
  serializer/UI concern; the stored value is 8-char hex.
- `target_milestone` is optional and nullable — single-team Scrum projects without
  formal milestones leave it null. The link enables ADR-0036's milestone-progress-from-
  sprint-completion narrative when it's wired in v1.1.
- `committed_*` and `completed_*` are stored, not computed. The math is:
  **on activation** snapshot `committed_points = sum(story_points)` and
  `committed_task_count = count(tasks)`. **on close** snapshot `completed_*` from
  tasks where `status=COMPLETE`. Stored values survive history retention
  (90-day cap) and avoid recompute cost.

**Amendment (VoC 2026-04-28): `Project.agile_features_enabled` gate**

Add a new field to `Project`:

```python
agile_features = models.BooleanField(default=False)
```

When `False`, the frontend suppresses: the `/sprints` route, the board sprint filter
toggle, story_points columns in the task list, and the sprint header banner. The API
endpoints remain active regardless — the gate is a UI/UX concern, not an access
control. Auto-set to `True` for projects created from the "Software Delivery"
project template. User-overridable via Project Settings.

Rationale: Sarah (PM, construction) must never see sprint UI artifacts in her
Gantt-first workflow. VoC score risk: if sprint chrome bleeds into non-agile
projects, traditional PM users will perceive the tool as "too software-y" and
trust erodes. The gate prevents that without restricting teams that want the feature.

### Q2 — Sprint state machine

**Transitions:**
```
       create                  activate                 close
PLANNED ────▶ PLANNED  ─────────────────▶ ACTIVE ──────────────▶ COMPLETED
   │                                         │
   └────▶ CANCELLED (only from PLANNED)      └────▶ CANCELLED (rare; admin only)
```

**Single active sprint per project (soft constraint).** Enforced at the API layer
on activation: if another sprint in the same project is `ACTIVE`, return 409 with
the conflicting sprint ID. Rationale: pure Scrum is one-team-one-sprint; until
TruePPM models teams, project = team boundary. Multiple-active is a v1.1 question
tied to a future Team model.

**Amendment (VoC 2026-04-28): non-blocking capacity check on activation**

On `POST /api/sprints/{id}/activate/`, after snapshotting `committed_*` but before
returning, run a capacity check using existing resource allocation data
(ADR-0031 `TaskResource` units + calendar). For each team member with tasks in
the sprint, sum their committed work hours across the sprint window and compare to
their available capacity (allocation units × working days). If any member is
over-allocated, include a non-blocking `warnings` array in the 200 response:

```json
{
  "id": "...",
  "state": "ACTIVE",
  "committed_points": 47,
  "warnings": [
    {
      "type": "over_capacity",
      "member_id": "...",
      "member_name": "Aisha K.",
      "committed_hours": 84,
      "available_hours": 60,
      "suggested_commitment_points": 34
    }
  ]
}
```

Activation succeeds regardless (200, not 422). The warning surfaces to Alex so he
can make an informed decision before the sprint starts. This closes the gap David
(Resource Manager) identified: sprint capacity was a number typed in a field,
disconnected from actual resource availability.

**Carry-over on close.** `POST /api/sprints/{id}/close/` accepts:
```json
{ "carry_over_to": "<sprint-id> | \"backlog\" | \"none\"" }
```
- `<sprint-id>` — incomplete tasks (status ∈ {BACKLOG, NOT_STARTED, IN_PROGRESS,
  REVIEW}) are reassigned to that sprint
- `"backlog"` (default) — incomplete tasks have `sprint=null`, `status=BACKLOG`
- `"none"` — incomplete tasks remain attached to the closed sprint (for retro
  fidelity); they are excluded from velocity but visible in sprint reports

`completed_*` is computed before any carry-over moves happen. Velocity is
**always** the count of tasks that completed *within the sprint window*, not the
final state of carry-over targets.

**Scrum Guide alignment** *(Scrum Guide 2020 © Ken Schwaber and Jeff Sutherland,
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/))*: The Guide states
that incomplete Sprint Backlog items "return to the Product Backlog for future
consideration." This makes
`"backlog"` the canonically correct default — re-selection for a future sprint
is a Product Owner prioritization decision, not an automatic carry-forward.
Offering `<sprint-id>` as an option is a convenience feature beyond what the
Guide prescribes, but it is common real-world practice and explicitly opt-in.

### Q3 — Velocity storage

**Snapshotted on the Sprint model at close, not computed on the fly.** Reason:
`HistoricalTask` has 90-day retention; sprints older than that would lose
velocity if computed from history. Per-sprint snapshot is one row already on
the `Sprint` table — no additional model.

**Granularity — both story points and task count.** The serializer returns:
```json
{
  "committed_points": 47, "completed_points": 42,
  "committed_task_count": 18, "completed_task_count": 16,
  "completion_ratio_points": 0.894, "completion_ratio_tasks": 0.889
}
```
A task with `story_points=null` does not contribute to point velocity but does
contribute to task-count velocity. The frontend velocity chart defaults to
points if any sprint in the project has non-null `committed_points`; falls back
to task count otherwise.

**Amendment (VoC 2026-04-28): velocity standard deviation and forecast range**

`GET /api/projects/{project_id}/velocity/` response includes standard deviation
fields alongside each data point and as a rolling summary:

```json
{
  "sprints": [...],
  "rolling_avg_points": 38.5,
  "rolling_stdev_points": 6.2,
  "forecast_range_low": 32,
  "forecast_range_high": 45,
  "rolling_avg_tasks": 14.1,
  "rolling_stdev_tasks": 2.4
}
```

The frontend renders the forecast range as a shaded area around the rolling
average line on the velocity chart. Sprint forecast reads
`forecast_range_low` and `forecast_range_high` to present "5–8 sprints
remaining" rather than a false-precision point estimate. Rationale: Alex's VoC
suggestion — stakeholders trust a range more than a single number, and the
spread naturally feeds the sprint forecast view without additional computation.

**Terminology note:** "velocity confidence band" is not an industry-standard term;
"forecast range" is preferred. Velocity itself is XP-origin (not in the Scrum
Guide 2020) but is real-world standard practice. The Guide mentions burndown/burn-up
in a single sentence as optional forecasting tools — neither is required by the
framework. TruePPM surfaces them as practice-layer tools, not Scrum mandates.

### Q4 — Burndown data

**New model `SprintBurnSnapshot`** in `apps/projects/`:

```python
class SprintBurnSnapshot(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sprint = models.ForeignKey(Sprint, on_delete=models.CASCADE, related_name="burn_snapshots")
    snapshot_date = models.DateField()
    remaining_points = models.PositiveIntegerField()
    remaining_task_count = models.PositiveIntegerField()
    completed_points = models.PositiveIntegerField()
    completed_task_count = models.PositiveIntegerField()
    scope_change_points = models.IntegerField(default=0)  # signed: scope added (+) or removed (-)
    scope_change_task_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["sprint", "snapshot_date"],
                name="unique_sprint_snapshot_per_day",
            ),
        ]
        indexes = [
            models.Index(fields=["sprint", "snapshot_date"]),
        ]
```

This is its own model rather than extending ADR-0022's `BurnSnapshot` because:
- ADR-0022 is Proposed, not Accepted; blocking sprint v1 on it is not warranted
- Sprint snapshots are sprint-bounded (only exist between activation and close+30d
  retention); ADR-0022's project-scoped snapshots have different lifecycle
- Schema convergence is a follow-up: when ADR-0022 lands, a future ADR can decide
  whether to merge schemas. Two narrow tables today is acceptable.

**Snapshot writes happen in three places:**

1. **On activation** (synchronous): write a row for `start_date - 1` (the "ideal
   line origin") with `remaining_points = committed_points`, `completed = 0`.
2. **Nightly Beat at 01:00 UTC** (`update_sprint_burndown_snapshots`):
   for every active sprint, write/upsert yesterday's row.
3. **On `task_status_changed` signal** (synchronous): if the task is in an active
   sprint, upsert today's row. Update is fast (single-row write keyed on
   `(sprint, today)` unique constraint); no outbox needed.

**Burndown API output** computes the ideal line client-side from
`committed_points` and date range. Server returns only actual data points.

### Q5 — API surface

**New routes** (under `apps/projects/views.py`, registered via existing project router):

| Method + Path | Purpose |
|---------------|---------|
| `GET /api/projects/{project_id}/sprints/` | List sprints (filterable by `state`) |
| `POST /api/projects/{project_id}/sprints/` | Create sprint (always lands in PLANNED) |
| `GET /api/sprints/{id}/` | Sprint detail with snapshot fields |
| `PATCH /api/sprints/{id}/` | Update name/goal/dates (only when PLANNED) |
| `DELETE /api/sprints/{id}/` | Soft-delete (only when PLANNED or CANCELLED) |
| `POST /api/sprints/{id}/activate/` | Transition PLANNED → ACTIVE; snapshots committed_* |
| `POST /api/sprints/{id}/close/` | Async transition ACTIVE → COMPLETED; returns 202 `{queued: true}` |
| `POST /api/sprints/{id}/cancel/` | Transition PLANNED → CANCELLED |
| `GET /api/sprints/{id}/burndown/` | Burndown data points + sprint metadata |
| `GET /api/projects/{project_id}/velocity/` | Velocity series across closed sprints |

**Modified endpoints:**
- `Task` POST/PATCH: accept `sprint` (UUID) and `story_points` (int) fields
- `Task` GET list: support `?sprint=<id>` and `?sprint=none` (sprint-less = backlog)
- `Task` serializer: add `sprint` and `story_points` to fields list

**Permissions:** sprint endpoints use the following existing permission classes,
resolved via the sprint's `project_id`:

| Operation | Permission class | Minimum role |
|-----------|-----------------|--------------|
| List sprints, view burndown, view velocity | `IsProjectMember` | VIEWER (0+) |
| Create sprint, update sprint, cancel sprint | `IsProjectMemberWrite` | MEMBER (1+) |
| Activate sprint, close sprint | `IsProjectMemberWrite` | MEMBER (1+) |
| Delete sprint (PLANNED only) | `IsProjectAdmin` | ADMIN (3+) |

**Note:** `IsProjectEditor` referenced in an earlier draft of this ADR does not
exist in `apps/access/permissions.py` and must not be used. The intent — "any
engaged project participant can manage sprint ceremonies" — maps to
`IsProjectMemberWrite` (MEMBER 1+). This reflects the reality that in most teams
the Scrum Master is a hat worn by a team member, not a privileged gatekeeper.
Sprint delete is ADMIN-only because removing a completed sprint destroys velocity
history.

**Scrum Master role decision (see RBAC audit 2026-04-28):** No new role is added
in v1. A dedicated role would require incrementing all higher ordinals in the
`Role(IntegerChoices)` model — a breaking change across every `role >= X` permission
check in the codebase. In v1, a Scrum Master is a project member with write access
(`MEMBER` or above). If VoC surfaces demand for a "delivery lead" role with authority
over sprint state but not full `ADMIN` privileges, that is a v2 RBAC ADR.

### Q6 — Board integration

**The board gains a sprint filter, not a separate "agile mode."** Consistent with
ADR-0013's no-new-endpoint principle — the existing board view fetches tasks with
a query param.

- **Default board view:** all project tasks (current behavior unchanged).
- **Sprint filter:** TopBar control with options "All tasks", "Active sprint",
  "Sprint: <name>". Selecting a sprint adds `?sprint=<id>` to the task fetch.
- **Sprint header:** when sprint mode is active, a slim banner above the board
  shows sprint goal, days remaining, mini burndown sparkline, and a "Close sprint"
  button. Click expands to the full burndown.

**New dedicated views:**
- `/sprints` — Sprint Planning page: backlog (sprint-less tasks) and sprint shelves;
  drag tasks from backlog into the next planned sprint; create/activate/close
  sprints; full burndown chart for the active sprint.
- `/velocity` (or a section on Project Overview) — velocity bar chart across the
  last 8 closed sprints with rolling-average line.

The Kanban board `BoardColumn` accepts the existing `BACKLOG` column. In sprint
mode, BACKLOG shows the sprint's not-yet-started tasks (a subset). In all-tasks
mode, BACKLOG shows the project backlog. This is a serializer-level filter, no
column-config change.

### Q7 — Gantt/CPM integration (v1.1, deferred)

The data model does not foreclose CPM feedback. v1.1 will:
- Read `Sprint.completed_points` for the last N closed sprints → compute team
  point velocity (points/working-day)
- Map each task's `story_points` to estimated `most_likely_duration` via the
  team's calibrated ratio
- Adjust `most_likely_duration` for tasks in upcoming sprints, then enqueue
  CPM recompute via existing `enqueue_recalculate(project_id, changed_task_ids=...)`

No v1 schema decision blocks this. v1.1 is a separate ADR.

### v1 scope boundary

**In scope:** Sprint model, sprint-task FK, story_points, sprint state machine,
velocity snapshots on close, burndown daily snapshots, sprint planning UI, board
sprint filter, velocity chart, REST endpoints, mobile sync of sprint entities.

**Deferred:**
- Server-side WIP limits (frontend-only is acceptable until ADR-0013 amendment; note: WIP limits are Kanban-origin, not Scrum — implementing them creates a Scrumban hybrid, which is a recognised and common pattern but should be documented as such, not presented as a Scrum feature)
- CPM feedback from velocity (v1.1)
- Retrospective action item → backlog pipeline (separate ADR)
- Sprint forecast view ("when will the backlog finish?") — additive once velocity exists
- Multi-team / multiple-active-sprints (requires Team model)
- Schema merge with ADR-0022 `BurnSnapshot` (follow-up ADR)

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Sprint as FK on Task (chosen)** | Simple; matches Jira/Linear; one task in one sprint at a time; carry-over is a single UPDATE | Historical sprint membership requires `HistoricalTask` reads (acceptable; 90-day window covers normal queries) |
| B. Sprint as M2M through table | Captures multi-sprint membership for carry-over | Over-models the common case; complicates "what sprint is this task in?" queries; no real-world need surfaced in VoC |
| C. New `agile` Django app | Clean separation | `Sprint` is so tightly coupled to `Task`/`Project` that the indirection adds nothing; the projects app is the right home (matches `Risk` precedent) |
| D. Compute velocity from `HistoricalTask` only | No new fields | 90-day retention drops old sprints; recompute cost; fragility against history pruning |
| E. Reuse ADR-0022 `BurnSnapshot` | One snapshot model | ADR-0022 not yet accepted; sprint lifecycle differs; would block v1 on dependency churn |
| F. Single state field on Task ("sprint_state") instead of separate Sprint model | No new model | No sprint goal, no sprint dates, no sprint metadata; not a real solution |

## Consequences

**Easier:**
- Hybrid teams can run sprints inside TruePPM without leaving the tool
- Velocity and burndown become first-class data, not spreadsheet exports
- The board grows agile capability without losing its waterfall-friendly view
- Sprint completion data is structurally available for v1.1 CPM feedback
- Mobile sync of sprints follows the existing `VersionedModel` pattern with no new sync work

**Harder:**
- Surface area: every Task mutation must consider sprint membership and burndown
  side effects. Mitigation: encapsulate in `services.py`; signal handlers do
  upserts only.
- Story points adoption: a new field that some teams will never use. Mitigation:
  fully optional; UI hides points columns when project has zero non-null values.
- Sprint vs. non-sprint board cognitive load: users need to understand the toggle.
  Mitigation: default to all-tasks (current behavior); sprint mode is opt-in.

**Risks:**
- Scope creep — "we need sprint reports", "we need standup automation", "we need
  retro tools." Guard: every additional sprint feature must answer "does this
  reduce ceremony, or add to it?" Punted to follow-up ADRs.
- ADR-0022 schema collision — when ADR-0022 lands, two snapshot tables will exist.
  Mitigation: explicit follow-up ADR to converge after both ship.
- Single-active-sprint constraint may bite multi-team projects. Mitigation:
  document as v1 limitation; add Team model in a separate effort if VoC surfaces
  the pain.

## Implementation Notes

- **P3M layer:** Programs and Projects (and Operations execution). Single-project
  feature; no cross-project aggregation. **OSS / Apache 2.0.**
- **Affected packages:** `api` (new model + migrations + endpoints + services +
  tasks), `web` (sprint planning page, velocity chart, board sprint filter,
  burndown chart), `mobile` (sync via `VersionedModel`, sprint list + tasks-by-
  sprint screen — phase 2).
- **Migration required:** yes — new tables `projects_sprint`,
  `projects_sprintburnsnapshot`, `projects_sprintcloserequest`; new fields
  `Task.sprint_id`, `Task.story_points`. Plus a corresponding `HistoricalTask`
  schema bump (django-simple-history).
- **API changes:** yes — new sprint endpoints, modified `Task` serializer,
  velocity and burndown read endpoints.
- **Data backfill:** none required. Existing tasks have `sprint=null` (backlog)
  and `story_points=null`.

### Durable Execution

1. **Broker-down behavior:** Outbox pattern. Sprint close enqueues a
   `SprintCloseRequest` row inside the same DB transaction as the state change
   to `ACTIVE`+`closed_at`. A `transaction.on_commit()` hook attempts
   `.delay()`; if the broker is down, the row remains `PENDING` and is picked up
   by the drain. Sprint **activation** is synchronous (no async work — just a
   single transactional row update + committed_* snapshot computation).
   Burndown daily snapshot is a Beat task (broker-up at scheduled time);
   real-time burndown updates are inline single-row upserts, no broker involved.

2. **Drain task:** New drain `_drain_sprint_close_requests` in
   `apps/projects/tasks.py`. Beat schedule: every 30 s. Decorated
   `@idempotent_task(on_contention="skip")`. Does not reuse an existing drain —
   sprint close has its own state transition semantics that don't match
   `ScheduleRequest` or MS Project import drains.

3. **Orphan window:** 5 minutes. The drain query filters
   `created_at < now() - 5min` to avoid racing with in-flight `transaction.on_commit()`
   callbacks (matches the webhook drain convention).

4. **Service layer:** New `apps/projects/services.py::enqueue_sprint_close(sprint_id, *, carry_over_to, requested_by)`.
   Views never call `.delay()` directly. Existing project services file (if any)
   can absorb this; otherwise create the file.

5. **API response on best-effort dispatch:**
   `POST /api/sprints/{id}/close/` → `202 Accepted {"queued": true, "request_id": "..."}`.
   The frontend polls `GET /api/sprints/{id}/` (or subscribes via WebSocket) to
   observe `state=COMPLETED` and `closed_at` populated.

6. **Outbox cleanup:** Nightly purge of `SprintCloseRequest` rows in `COMPLETED`
   or `FAILED` state older than 7 days. Add `_purge_sprint_close_requests` to
   the existing nightly cleanup beat in `core/tasks.py` (matches the 7-day
   retention convention).

7. **Idempotency:** The outbox row PK is the lock key (`@idempotent_task` keyed on
   request_id). The task body re-checks the sprint state before transitioning:
   - if sprint is already `COMPLETED`, mark request `COMPLETED` and return
     (handles double-dispatch from broker retry)
   - if sprint is `CANCELLED`, mark request `FAILED` with reason
   - if sprint is `ACTIVE`, perform the close transition under
     `select_for_update()` on the Sprint row
   The unique `(sprint, snapshot_date)` constraint on `SprintBurnSnapshot`
   makes burndown writes naturally idempotent (upsert).

8. **Dead-letter / failure handling:** `max_retries=3` with exponential backoff
   on transient errors (DB connection blips, lock timeouts). On exhaustion, the
   `SprintCloseRequest` row enters `FAILED` with `error_message` populated and
   a Sentry alert fires (uses existing `core.alerts.notify_critical_failure`).
   The user sees the sprint stuck in `ACTIVE` with a banner "Close failed —
   retry?" linked to a re-trigger endpoint that resets the request to `PENDING`.
   Burndown daily Beat: failures are logged + Sentry, no DLQ — the next day's
   run heals the gap (snapshots are independent per day; one missing day shows
   as a small visual gap on the chart).

## Open Questions for Implementation

These do not block ADR acceptance but should be resolved at issue-grooming time:

1. Should `Sprint.short_id` use the `SP-` prefix on display, or extend the
   `_next_short_id` mechanism with a per-entity prefix? (Lean toward
   serializer-level prefix; keep storage neutral.)
2. When a task with `story_points` is moved between sprints mid-flight, do we
   record a `scope_change` row in burndown? (Yes — that's the whole point of
   the `scope_change_*` columns. Mid-sprint scope addition is signal, not noise.)
3. Mobile UX for sprint planning — drag-drop on small screens is awkward.
   Defer mobile sprint *planning* to v1.1; mobile shows read-only sprint board
   in v1. (Confirm with mobile lead.)
4. Notification triggers — does sprint activation send a project notification?
   Closure? (Lean: yes for both; reuse existing notification rail.)
5. **Jira sync (VoC 2026-04-28 — Priya, 6/10):** Priya's primary concern is
   duplicate data entry for teams already running sprints in Jira. Confirm before
   issue grooming whether a thin one-way ingest endpoint can ship in v1:
   `POST /api/projects/{id}/sprints/ingest/` — accepts a payload of sprint
   assignments from a Jira automation rule (task external_id → sprint_id mapping),
   creates or updates `Task.sprint` via short-id lookup. No full bidirectional
   sync required in v1; this is a write-only push channel that lets Jira be the
   source of truth for sprint planning while TruePPM owns the velocity and burndown
   output. If this cannot ship in v1, the roadmap commitment should be explicit and
   visible in the UI ("Jira sync — coming in v1.1") so Priya doesn't churn to
   another tool before it lands.
