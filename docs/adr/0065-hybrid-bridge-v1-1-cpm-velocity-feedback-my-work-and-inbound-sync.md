# ADR-0065: Hybrid Bridge v1.1 — CPM Velocity Feedback, "My Work" Contributor Surface, and Inbound Task Sync

## Status
Accepted

## Context

ADR-0036 established the hybrid PM philosophy (sprints and schedule milestones are views of the same task
graph). ADR-0037 implemented Sprint as a first-class model with goal, dates, burndown, velocity tracking,
and CPM outbox integration on sprint close. That work is complete.

Three gaps remain before the hybrid bridge delivers its full value proposition:

1. **CPM velocity feedback (v1.1 — explicitly deferred in ADR-0037)**: Sprint velocity data exists in
   `SprintBurnSnapshot` and the `/velocity/` endpoint, but it does not yet calibrate
   `Task.most_likely_duration`. The three-point estimate inputs (ADR-0032) provide the mechanism — velocity
   closes the loop by auto-suggesting `most_likely_duration` from the team's empirical throughput. Without
   this, the sprint → Gantt propagation is schedule-slip only; it does not use historical sprint performance
   to improve future duration estimates.

2. **"My Work" contributor surface**: The existing My Tasks view (#78) is PM-centric. Contributors
   (Priya persona) need a zero-vocabulary task surface — no CPM language, no WBS, no phase hierarchy. The
   current design requires TruePPM to be the source of truth, which is a hard NO for teams already in Jira.
   The OSS answer is a clean contributor surface compelling enough to compete; the Enterprise answer
   (Jira/GitHub two-way connector) is separate. Both are needed, but they have different urgency: the clean
   surface ships first, the connector is Enterprise scope.

3. **Inbound task-sync protocol**: ADR-0049 defined outbound webhook extension points. No inbound push
   protocol exists. Teams using Linear, GitHub Issues, or Jira should be able to push tasks into TruePPM
   via a lightweight authenticated webhook, with TruePPM creating/updating tasks and assigning them to a
   backlog sprint. This is import-only (one-way push, not two-way sync) — the two-way connector is
   Enterprise.

A fourth gap identified by VoC — **project-level resource allocation with partial percentages** — is
covered by ADR-0031 (Proposed) and ADR-0033 (Proposed). This ADR does not re-design that surface; it
notes that `TaskResource.units` already stores fractional allocation and the conflict detection UI is
the ADR-0031 scope item.

### VoC Signal
Two panels were run. Initial 6-persona panel averaged 4.8/10 against the concept description (before
accurate feature scope was known). Updated 8-persona panel (Jordan/PO and Morgan/Agile Coach added)
against this ADR's precise scope averaged **5.4/10**:

- Janet/Marcus/David: 3/10 each — correctly out of scope (their needs are Enterprise)
- Sarah/Jordan/Alex/Morgan/Priya: 7/10 each — delivery layer aligns with OSS scope
- Key remaining gap: retro-to-backlog (#486, moved to milestone 0.2) is the single change
  that would move Alex and Morgan from 7→9

### What Already Exists (do not re-implement)
- `Sprint` model — first-class entity with goal, dates, state machine, `target_milestone` FK (ADR-0037)
- `Task.story_points`, `Task.remaining_points` — story point fields on tasks
- `SprintBurnSnapshot` — daily burndown rows
- `VelocitySerializer` + `VelocityPanel` — velocity trend with spread/range for forecasting
- `SprintRetro` + `RetroActionItem` — retrospective and action item models (issue #231)
- `BoardColumnConfig.wip_limit` — WIP limits with frontend warnings (ADR-0039)
- `SprintScopeChange` model — mid-sprint scope change audit rows (ADR-0060 / migration 0032)
- `Project.methodology` (WATERFALL/AGILE/HYBRID) — gates tab visibility (ADR-0041)
- `Task.optimistic_duration`, `most_likely_duration`, `pessimistic_duration` — three-point estimates (ADR-0032)
- ADR-0049 outbound webhook extension points
- `ScheduleRequest` outbox wired to sprint close (reason=SPRINT_CLOSED)

---

## Decision

### 1. CPM Velocity Feedback (v1.1)

On sprint close, after the `ScheduleRequest` (reason=SPRINT_CLOSED) commits, compute a velocity
calibration suggestion for tasks assigned to the closing sprint:

```
suggested_most_likely = task.story_points / team_velocity_per_day
```

where `team_velocity_per_day` = rolling 6-sprint average of `completed_points / sprint_working_days`.

This suggestion is **non-destructive**: a new `VelocitySuggestion` model (see below) is created
rather than overwriting `most_likely_duration` directly. The PM sees a "Revise estimate?" prompt
in the Task Detail Drawer (ADR-0032 surface); accepting writes to `most_likely_duration` and
enqueues a CPM + Monte Carlo re-run. Declining marks the suggestion dismissed. All decisions are
auditable.

The sprint-close drain checks `project.estimation_mode` before creating any suggestion:
- `pm_only` → create suggestion only (PM decides)
- `suggest_approve` → create suggestion, flag it for governance review
- `open` → create suggestion (PM decides)
No suggestion is created without PM opt-in path. The agile team never sees CPM fields — suggestions
surface only in the PM's Task Detail Drawer.

```python
class VelocitySuggestion(Model):
    id = UUIDField(PK)
    task = FK(Task, CASCADE, related_name="velocity_suggestions")
    sprint = FK(Sprint, CASCADE)           # which sprint close triggered this
    suggested_duration = IntegerField()    # working days
    team_velocity_per_day = DecimalField(5, 3)
    created_at = DateTimeField(auto_now_add=True)
    accepted_at = DateTimeField(nullable)
    dismissed_at = DateTimeField(nullable)
    accepted_by = FK(User, SET_NULL, nullable)

    class Meta:
        unique_together = [("task", "sprint")]  # one suggestion per task per sprint close
```

Accepting → writes `task.most_likely_duration = suggested_duration`, stamps `accepted_at`,
enqueues `ScheduleRequest`. Dismissing → stamps `dismissed_at` only. The audit trail is
complete: every suggestion, its source sprint, and the PM's decision are persisted.

Velocity lives on the **team / project pairing**, not on individual sprints, to smooth noise.
The existing `VelocitySerializer` returns per-sprint data; add a `team_velocity_per_day` field
to that response derived from the rolling 6-sprint trailing average. Minimum threshold: ≥3
completed sprints before any suggestion is generated.

### 2. "My Work" Contributor Surface

A new endpoint `GET /me/work/` returns the authenticated user's assigned tasks across all projects,
filtered to `status != BACKLOG, is_deleted=False`, ordered by: (1) active sprint first, (2)
`planned_start` or `early_start`, (3) `priority_rank`.

Response shape — deliberately flat, no CPM fields exposed:
```json
{
  "tasks": [
    {
      "id": "...",
      "short_id": "PRJ-04a",
      "name": "...",
      "project_name": "...",
      "sprint_name": "Sprint 12",
      "status": "IN_PROGRESS",
      "story_points": 3,
      "remaining_points": 2,
      "due": "2026-05-30",
      "is_blocked": true,
      "blocking_reason": "...",
      "url": "..."
    }
  ],
  "active_sprints": [...]
}
```

No `early_start`, `late_finish`, `total_float`, `wbs_path`, or CPM fields in this response.
`due` is computed as: `actual_finish ?? planned_start ?? early_finish ?? sprint.finish_date`.
`is_blocked` is **deferred to v1.2** — computing it requires a dependency subquery per task and
is an N+1 risk on a cross-project endpoint without a covering index. The field is omitted from
v1; a `?include=blocking` query parameter will be added in v1.2 once the index strategy is decided.

The web "My Work" page routes to this endpoint. Mobile uses the same endpoint with the existing
JWT auth and **must follow the offline sync contract** — the response must be cacheable for
offline reads (WatermelonDB pull on reconnect). The UI shows: task name, project, sprint, status
chip (tap to update), story points, due date. No Gantt, no WBS, no phase hierarchy visible.

**Status write-back**: status updates from "My Work" write to TruePPM only. They do **not**
propagate back to Jira/Linear/GitHub. Teams using the inbound webhook must designate one source
of truth for task status before setup — this is documented in the setup guide, not enforced by
the system. Two-way status sync is Enterprise connector scope.

### 3. Inbound Task-Sync Protocol

A new endpoint `POST /projects/{id}/task-sync/` accepts a push payload from external tools:

```json
{
  "source": "jira | linear | github | custom",
  "external_id": "PROJ-123",
  "name": "...",
  "description": "...",
  "assignee_email": "...",
  "story_points": 3,
  "labels": ["backend"],
  "external_url": "https://..."
}
```

Behavior:
- If a task with matching `external_id` + `source` + `project` exists → update name, description,
  story_points, and map external status to `TaskStatus` using the token's `status_map` JSONField
  (see `ProjectApiToken` below). Default status map if none configured:
  `{"todo": "NOT_STARTED", "in_progress": "IN_PROGRESS", "done": "COMPLETE"}`.
- If no match → create task in project BACKLOG with `status=BACKLOG`, `sprint=null`.
- Assignee is resolved by email against project members; unmatched assignee is stored in
  `pending_assignee_email` on `InboundTaskLink` and resolved on next project member sync.
- Authentication: project-scoped API token (new `ProjectApiToken` model, 256-bit hex, hashed
  at rest, shown once on creation).
- Epic/story hierarchy: if `parent_external_id` is provided and a matching parent `InboundTaskLink`
  exists, the created task is attached as a subtask (via `is_subtask=True`, `wbs_path` under parent).
  This preserves Jira epic→story hierarchy. If no parent match, task lands as a flat BACKLOG item.

New models:
```python
class InboundTaskLink(Model):
    project = FK(Project, CASCADE)           # direct FK — required for unique_together
    task = FK(Task, CASCADE, related_name="inbound_links")
    source = CharField(32)                   # "jira", "linear", "github", "custom"
    external_id = CharField(255)
    external_url = URLField(nullable)
    parent_external_id = CharField(255, nullable)  # for epic→story hierarchy
    pending_assignee_email = EmailField(nullable)
    last_synced_at = DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("project", "source", "external_id")]

class ProjectApiToken(Model):
    id = UUIDField(PK)
    project = FK(Project, CASCADE)
    name = CharField(128)
    token_hash = CharField(64)               # SHA-256 hex; raw token shown once on creation
    status_map = JSONField(default=dict)     # source status → TaskStatus mapping
    created_by = FK(User, SET_NULL, nullable)
    created_at = DateTimeField(auto_now_add=True)
    last_used_at = DateTimeField(nullable)
    revoked_at = DateTimeField(nullable)
```

`InboundTaskLink` is persisted synchronously on the push request (status 201). The task create/update
itself is also synchronous (no queue) since the payload is small and the caller expects confirmation.
The endpoint returns `{"task_id": "...", "short_id": "PRJ-0ab", "created": true/false}`.

This is **import-only**: TruePPM does not write back to the external source. Two-way sync with
conflict resolution is Enterprise scope (bidirectional connector, OAuth, webhook subscription on
the external side, conflict resolution UI).

---

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Velocity auto-writes `most_likely_duration` directly | Zero PM interaction needed | Destroys PM-committed baselines silently; violates estimation governance modes (`pm_only`, `suggest_approve`) |
| `velocity_suggested_duration` field on Task (rejected) | Simpler schema | Stale values linger after tasks complete; no per-sprint auditability; accept/dismiss state awkward as booleans on Task |
| Team velocity on a `Team` model (separate from project) | Cleaner multi-project teams | Adds a Team entity not needed yet; teams are project-scoped in v1 |
| "My Work" as a frontend-only filter on existing task endpoints | No new endpoint | Leaks CPM fields to the response; no control over field exposure; harder to optimize |
| Full Jira two-way sync in OSS | Priya's 10/10 anchor | Two-way sync requires OAuth dance, conflict resolution, webhook subscription management — Enterprise complexity at OSS cost; Apache 2.0 boundary risk if connector code is proprietary |
| Queue inbound sync requests | Decoupled, durable | Caller cannot confirm task creation synchronously; small payloads don't justify queue overhead |

---

## Consequences

**Easier:**
- PM gets data-driven estimate revision suggestions without manual research
- Contributors can see all their work in one clean surface across projects
- External teams (Jira, Linear, GitHub) can push tasks without abandoning their tool
- Sprint velocity accumulates as living calibration data for Monte Carlo simulation

**Harder:**
- `GET /me/work/` must be performant across many projects (index on `Task.assignee` + `status` needed)
- `InboundTaskLink.external_id` deduplication must handle external ID collisions across different sources
- `ProjectApiToken` requires a token management UI (create, revoke, copy-once) in project settings

**Risks:**
- Velocity calibration suggestions may be noisy for teams with highly variable sprint scope — add a
  minimum sprint sample threshold (≥3 completed sprints) before surfacing suggestions
- Inbound sync with no rate limiting is a DoS vector — add per-project rate limit (100 req/min) on the
  sync endpoint

---

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project scope throughout) — **OSS**
- **Affected packages**: `api` (all three gaps), `web` (gaps 1 and 2), `mobile` (gap 2 via existing
  `/me/work/` once shipped)
- **Migration required**: yes — new `VelocitySuggestion` model, `InboundTaskLink`, `ProjectApiToken`;
  covering index on `Task(assignee, status, is_deleted)` for `GET /me/work/` query performance;
  `is_blocked` index deferred to v1.2
- **API changes**: yes — `GET /me/work/`, `POST /projects/{id}/task-sync/`, `GET /me/work/` mobile,
  `POST /projects/{id}/api-tokens/`, `DELETE /projects/{id}/api-tokens/{token_id}/`,
  `velocity` endpoint gains `team_velocity_per_day` field
- **OSS or Enterprise**: OSS. The two-way connector (Jira/GitHub bidirectional) is Enterprise.

### Tracking Issues (milestone 0.2)

- Gap 1 — CPM velocity feedback: #498
- Gap 2 — "My Work" contributor surface: #499
- Gap 3 — Inbound task-sync protocol: #500
- Related — retro → backlog pipeline: #486

### Durable Execution

1. **Broker-down behaviour**: Velocity calibration suggestion is computed synchronously on sprint close
   (small calculation, bounded by 6-sprint window). No separate Celery task needed; it runs inside the
   `SprintCloseRequest` drain task that already exists. N/A for `GET /me/work/` (pure read). Inbound
   sync endpoint is synchronous; no outbox needed for the task create/update path.

2. **Drain task**: Reuses the existing `SprintCloseRequest` drain task for velocity calibration.
   No new drain required.

3. **Orphan window**: N/A — velocity calibration runs inside the existing sprint-close drain, which
   already has a 10-minute orphan window filter.

4. **Service layer**: New `services.py` functions needed:
   - `scheduling/services.py::compute_velocity_suggestions(sprint_id)` — called from sprint close drain
   - `projects/services.py::apply_inbound_task_sync(project, payload, source)` — called from sync endpoint

5. **API response on best-effort dispatch**: Inbound sync endpoint is synchronous → 201 with task ID.
   Velocity suggestion is a side effect of sprint close → no new API response shape needed.

6. **Outbox cleanup**: N/A — no new outbox rows created by these three features.

7. **Idempotency**: Inbound sync is idempotent by `(project, source, external_id)` unique constraint
   on `InboundTaskLink`. Velocity suggestions are idempotent by `(task, sprint)` unique constraint on
   `VelocitySuggestion` — a duplicate sprint-close drain run upserts the row (no duplicate prompts shown
   to the PM).

8. **Dead-letter / failure handling**: Velocity calibration failure is non-blocking — log the error,
   leave `velocity_suggested_duration` null. Sprint close still completes. Inbound sync failure returns
   4xx/5xx to the caller synchronously; no retry needed (caller retries on their side).

---

## Open Questions / ADR Candidates

1. **Retro → backlog pipeline** (issue #486, moved to milestone 0.2): `RetroActionItem` exists but
   there is no "promote to task" flow. One-click action in `RetroPanel` → creates BACKLOG task (do not
   auto-promote without explicit action, to avoid noise). Both Alex (Scrum Master) and Morgan (Agile
   Coach) independently called this the single feature that moves them from 7→9/10. Warrants a small
   follow-up ADR when #486 is implemented.

2. **PO-facing velocity forecast** (follow-up ADR candidate): Jordan (PO, 7/10) needs
   "epic X ships in ~sprint N ± 1" in product language, not CPM language. Currently
   `VelocityPanel` shows trend to the team; the CPM feedback loop is PM-only. A separate
   read endpoint `GET /sprints/{id}/forecast/` returning `{epic_id, estimated_sprints_remaining,
   confidence_range}` would close this gap without exposing CPM fields to the board.
   Defer to a follow-up ADR — this is a v1.2 item.

3. **`is_blocked` in `GET /me/work/`** (deferred to v1.2): Computing blocker state requires a
   dependency subquery per task. Risk of N+1 on a cross-project endpoint without a covering index
   on `Dependency(successor, predecessor)` combined with `Task(status)`. Defer; add
   `?include=blocking` query parameter in v1.2 once the index strategy is validated in production.

4. **`ProjectApiToken` RBAC**: Who can create tokens? Recommend: role ≥ 3 (Admin/PM) only.
   Confirm with `rbac-check` agent before implementation.

5. **WIP limit server-side enforcement**: ADR-0039 stores `wip_limit` in `BoardColumnConfig`
   (frontend warnings only). VoC panel (Alex, Morgan) expects warnings — not hard blocks. No change
   to server-side enforcement in v1.1; revisit if teams request hard enforcement.

6. **Two-way status sync for Priya** (Enterprise connector scope): Import-only sync means Priya's
   status taps in "My Work" do not flow back to Jira. Teams must choose one source of truth at
   setup. Full bidirectional status sync is Enterprise. Document explicitly in the webhook setup
   guide — this is the most likely source of support tickets post-launch.

---

## Addendum — Gap 2 Implementation Refinements (2026-05-17)

Refinements adopted during the implementation of issue #499. The original Gap 2
design remains correct; this addendum documents decisions made between the
parent ADR's acceptance and the actual implementation MR, after a VoC review
(panel average 5.25 — pulled down by non-target personas; target personas
Morgan 8🟢 / Sarah 7 / Alex 7 / Priya 6 all in the adoption band).

### Response shape additions

Beyond the fields listed in §"My Work Contributor Surface", the response now
also carries:

- `is_critical: bool` — coerced from `Task.is_critical` (nullable in the model;
  null → false in the serializer). Sarah's field crew needs to know which
  status updates matter to the schedule end date; a single boolean rendered as
  a `⚠` icon with a plain-English tooltip ("delays here delay the project end
  date") satisfies WCAG 1.4.1 (color-plus-text) without leaking the words
  "critical path" into the contributor surface.
- `due_source: "actual" | "planned" | "estimated" | "sprint" | null` — labels
  which step of the four-way cascade produced `due`. Resolves the "Due Oct 14
  vs Ends with Sprint 12" ambiguity Sarah and Morgan flagged in VoC. Null when
  no candidate is present.
- `server_version: int` — needed for mobile delta sync (`?since=` cursor).
- `project_id` and `sprint_id` — needed for URL construction and client-side
  grouping; not strictly new since the ADR allowed implementation freedom,
  but documented here for clarity.

The endpoint also returns top-level `due_today_count: int` which drives the
Sidebar "My Work" badge (rendered only when > 0 — see UX spec in MR #499).

### Pagination

DRF `LimitOffsetPagination`, default 100 / max 200. Initial design called for
cursor pagination, but DRF's `CursorPagination` filters subsequent pages on
the *leading* ordering field only — with a binary leading field
(`_in_active_sprint` ∈ {0, 1}) the filter `_in_active_sprint > 1` returns zero
rows, silently truncating page 2 to empty. Limit/offset preserves the
multi-key sort `(_in_active_sprint, _sort_date, priority_rank, id)` intact
across pages.

The trade-off — concurrent inserts can shift offsets and produce duplicates
or skips at page boundaries — is acceptable for this surface: Priya's task
list rarely changes mid-scroll, and the sort that matches the UI's group
rendering is more valuable than absolute pagination stability.

### RBAC enforcement (Morgan's 🔴)

The endpoint is hard-scoped to `assignee=request.user` in the viewset's
`get_queryset`. There is **no `?user=` query escape hatch** — any such param
is silently ignored. The queryset also re-checks
`project__memberships__user=request.user, project__memberships__is_deleted=False`
to defend against the "user removed from project but assignee FK still set"
edge case. PMO-role callers get a 200 with their own tasks (which may be
empty), not a tenant-wide read. Test: `test_no_user_query_escape_hatch`.

### `X-Source` audit header

The existing `PATCH /api/v1/tasks/{id}/` path now reads an optional `X-Source`
request header and propagates the value (default `"unknown"`) into the
`task.updated` webhook payload's `source` field. The /me/work surface sends
`X-Source: my_work`; the schedule canvas and board surfaces continue to
default to `unknown` until they're updated in follow-up issues.

The header value is validated against an allow-list pattern (`[a-z_]{1,64}`)
before reaching the stored webhook payload — third-party consumers receive
either a recognizable surface tag or the literal string `"unknown"`, never
arbitrary user-controlled text. This is the minimum viable answer to
Morgan's surface-source audit concern — full historical-record source
tracking is deferred (would require a Task field).

### Mobile

`packages/mobile/` does not yet exist. The endpoint is built mobile-ready
(cacheable shape, cursor pagination, `server_version_high_water`) but the
React Native client is deferred to a follow-up issue when ADR-0026 lands.

### Zero state

The /me/work page distinguishes two empty states:
- **Flavor A** — user has no project memberships at all: a friendly empty
  state with a "Load demo data" CTA (gated on the demo-seed endpoint
  permitting non-admin callers) and a docs link.
- **Flavor B** — user has memberships but no current assignments: docs-link
  only, no demo CTA.

The "Jira/Linear/GitHub sync coming soon" affordance lives in the docs page
(`docs/features/my-work.md`) until Gap 3 (#500) ships.

### Index strategy

Partial composite index `task_assignee_status_idx` on
`(assignee, status) WHERE NOT is_deleted` — added to `Task.Meta.indexes` and
materialized by migration `projects.0033`. No existing Task index covers this
access pattern; without it a cross-project My Work scan would be a sequential
scan on the full task table.

### Deferred follow-ups (file as separate issues post-merge)

- `GET /sprints/{id}/team-work/` for Alex (Scrum Master view of one sprint
  across the whole team) — same query shape, different scoping
- Manager rollup for David (cross-project utilization by team member)
- React Native client for #499 once `packages/mobile/` lands
- Full historical-record source tracking (add `source` field to Task model)
- `is_blocked` and `?include=blocking` query param (v1.2, per parent ADR)
