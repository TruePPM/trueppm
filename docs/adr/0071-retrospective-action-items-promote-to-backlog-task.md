# ADR-0071: Retrospective Action Items — Promote to Project Backlog

## Status
Accepted (2026-05-31) — implemented in #486. Implements the deferred "RetroPanel → BACKLOG task" promotion named in
ADR-0065. Aligns with ADR-0036 (Hybrid PM philosophy), ADR-0037 (Sprint Model),
ADR-0047 (BACKLOG boundary), ADR-0057 (`Task.committed` manager), and ADR-0069
(dual-level backlog; sprint sovereignty).

## Context

`SprintRetro` and `RetroActionItem` already exist in OSS (migration 0027,
issue #231 — 2026-05-02). The `RetroPanel` UI surface and the
`POST /sprints/{id}/retrospective/` endpoint already create retros and capture
free-text action items. `RetroActionItem.promoted_task_id` is in the schema as
the join column to a created `Task`.

What is missing — and what #486 ships:

1. The **promote-to-task action** that converts a `RetroActionItem` into a
   project-backlog `Task` (`status=BACKLOG`, `sprint=NULL`), wires
   `promoted_task_id`, broadcasts the create, enqueues CPM recompute, and
   surfaces the new Task on the assignee's My Work view.
2. **Sprint-sovereignty enforcement at the API surface** — the promote action
   must not be able to express "assign to a sprint." ADR-0069 establishes the
   structural rule (Morgan's 🔴 blocker); #486 must respect it in the new endpoint.
3. **Continuity loop** — when opening the next retrospective for the same
   project, the panel surfaces prior `to_improve` items + status of every prior
   action item (open / committed / done / abandoned). Without this, retros are
   amnesiac and the team raises the same problems sprint after sprint.
4. **Psych-safety visibility refinement** — current `retro` GET allows any
   `IsProjectMember` (Viewer+) to read raw `notes` / `action_items`. The VoC
   panel (Alex, Morgan, Priya) unanimously requires that raw retro content be
   visible to **sprint participants and Project Editors+ only** — never to
   external stakeholders, PMs not on the project, or the Enterprise PMO surface.
5. **Owner soft-suggestion** at retro time — assigning someone else creates a
   suggestion that the assignee must explicitly accept on their My Work surface
   before becoming binding. Self-claim is binding immediately.

**P3M layer**: Operations (sprint-internal artifact) bridging into Programs/Projects
(promoted action items become project-backlog Tasks). Both layers are OSS per the
persona resonance rule: this feature is loved primarily by Alex, Morgan, Jordan,
Priya — all operations-layer personas. Marcus/Janet's portfolio rollup of retro
metrics is explicitly out of scope and tracked separately in `trueppm-enterprise`.

**VoC panel** (8 personas, parallel): Janet 3 🔴 (out of scope — Enterprise),
Marcus 4 🟡 (out of scope — Enterprise), David 4 🟡, Sarah 6 🟡, Jordan 5 🟡,
Alex 8 🟡, Morgan 6 🟡, Priya 6 🟡. Average 5.25 / 10 — below the 6-threshold
heuristic. The 🔴 from Janet is misaligned scope, not a design failure; the OSS
target (Alex) scored 8. The 🟡 concerns from the four sprint-team personas are
addressed in the Decision section below.

## Decision

### 1. Intake — confirm Option B (project backlog)

Promoted action items become a `Task` with `status=BACKLOG, sprint=NULL` — the
project backlog. The architectural choice between **A** (program-level
`BacklogItem`) and **B** (project-level `Task` BACKLOG) was already settled in
ADR-0065's deferral wording, and is now consistent with ADR-0069's two-tier
hierarchy: project backlog is the right destination for sprint-team-generated
work.

**Migration path to A is intentionally out of scope.** Once `BacklogItem` from
ADR-0069 ships, retro action items remain Tasks in the project backlog —
program-level intake (`BacklogItem`) is fed by PM/PO planning, not by sprint
retros. The two flows are distinct (see ADR-0068 / ADR-0069 separation).

### 2. Promote-to-task service and endpoint

**Service**: new function `projects/retro_services.py::promote_retro_action_item(
    action_item: RetroActionItem, actor: User) -> Task`.

**Endpoint**: `POST /api/v1/sprints/{sprint_pk}/retrospective/action-items/{item_pk}/promote/`

**Permissions**: `IsProjectMemberWrite` (Role ≥ MEMBER). Same gate as creating
the retro itself per ADR-0037's existing `SprintViewSet.retro` mutating-action
rule.

**Behaviour** (atomic, mirroring ADR-0069's `pull_to_project_backlog`):

1. `SELECT FOR UPDATE` on the `RetroActionItem` row. Assert `promoted_task_id IS NULL`;
   if non-null → return `409 Conflict { "error": "already_promoted",
   "task_id": "..." }`.
2. Create `Task(project=action_item.retro.sprint.project, name=action_item.text,
   status=BACKLOG, sprint=None, assignee=action_item.assignee,
   story_points=action_item.story_points, notes="(from retro)" + retro short_id,
   ...)`. The Task's `notes` carries a `source: "retrospective"` marker for
   future Enterprise reporting (see §6).
3. Set `action_item.promoted_task_id = task.id`. `save()`.
4. In `transaction.on_commit`: call `enqueue_recalculate(reason="RETRO_PROMOTE")`
   (ADR-0027) and `broadcast_board_event(project_id, "task_created",
   {"task_id": ..., "source": "retrospective", "retro_id": ...,
   "action_item_id": ...})`.
5. Return `201 Created { "task": <TaskSerializer> }`.

**No new outbox category.** The CPM recompute reuses the existing
`drain_schedule_requests` Beat (ADR-0027). The Task create itself is synchronous
within the request.

**Rollback**: if the resulting Task is soft-deleted, a `post_delete` signal on
`Task` resets `RetroActionItem.promoted_task_id = NULL` so the action item can
be re-promoted. This matches ADR-0069 §4 ("Rollback") and is implemented in the
same signal handler.

**Why no separate `promote_at` or `promoted_by` field**: `Task.created_at` and
the existing `task_created` history record carry that information. Action items
have no audit-trail compliance requirement in OSS (Marcus's SOC 2 requirement is
explicitly Enterprise scope).

### 3. Visibility — team-only by default with explicit opt-in toggle (v1 scope)

Three-tier visibility model on `SprintRetro`, controlled by a new enum:

```python
class RetroVisibility(models.TextChoices):
    TEAM_ONLY = "team_only"  # MEMBER+ on the project can read raw notes / action item text
    PROJECT   = "project"    # VIEWER+ on the project can read raw notes
    ORG       = "org"        # Any authenticated user on any project in the same program can read (future-proof; Program entity from ADR-0070 not yet implemented — ORG behaves as PROJECT until then)
```

**Default**: `TEAM_ONLY`. The opt-in toggle is settable only by the retro's
`created_by` user or any Project ADMIN+; once set to `PROJECT` or `ORG` it can
be tightened back to `TEAM_ONLY` only by Project ADMIN+ (avoid social-pressure
unwinding by the original author).

**Serializer split**:
- `SprintRetroSerializer` — full content (raw `notes`, action item `text`, per-item assignees). Reachable only when the requesting user's project role meets the threshold defined by `team_visibility`.
- `SprintRetroSummarySerializer` — counts only (`action_items_count`, `promoted_count`, `created_at`, `created_by`). Always returned when the requesting user falls below the visibility threshold.

`SprintViewSet.retrieve_retro()` picks the serializer at view-body time based
on the requesting user's project role and the retro's `team_visibility`. **The
full-content serializer must not be reachable below the threshold** — enforced
in the view, not via ordering convention. See §9 for the IDOR test plan.

**Enterprise rollup (out of scope here, tracked in trueppm-enterprise#105)** is
allowed to read only aggregate counts (`action_items_count`, `closure_rate`)
per program — never `notes` or per-item text, regardless of `team_visibility`.
The psych-safety wall is structural at the OSS API layer; enterprise consumes
the summary endpoint only.

**Migration**: adds `team_visibility CharField(choices=RetroVisibility, default="team_only", max_length=12)` to `SprintRetro`. Existing rows backfill to `TEAM_ONLY` (the conservative default; opt-in is explicit).

### 4. Continuity loop (v1 ships Prior-retro + Planning carryover lane + My Work badge)

**(a) Prior-retro panel section**
- Next retro's `RetroPanel` shows a collapsible "Prior retro" section with the
  previous retro's `to_improve` notes (subject to `team_visibility` per §3) and
  a table of prior action items (`text`, `assignee`, `promoted` status, current
  `Task.status` if promoted).
- New endpoint `GET /api/v1/sprints/{pk}/retrospective/prior/` returns the most
  recent prior retro for the same project (ordered by `Sprint.finish_date`,
  filtered to `Sprint.state = COMPLETED` so CANCELLED sprints do not become the
  "prior" context). Same visibility model as `retro` GET — VIEWER below the
  retro's `team_visibility` threshold gets summary serializer.

**(b) Sprint Planning carryover lane** (Jordan's request)
- New endpoint `GET /api/v1/projects/{pk}/retrospective/carryover/` returns
  unresolved retro action items from the last 1–2 completed retros for the
  project — items where `promoted_task_id IS NULL` OR
  `promoted_task.status IN (BACKLOG, NOT_STARTED, IN_PROGRESS, REVIEW)`.
- Response shape:
  ```json
  {
    "items": [
      { "action_item_id": "...", "text": "...", "from_retro_short_id": "...",
        "from_sprint_short_id": "...", "promoted_task_id": "..." | null,
        "promoted_task_status": "BACKLOG" | ... | null, "age_days": 14,
        "assignee": "..." | null }
    ]
  }
  ```
- Surfaced in `SprintBacklogTable` (for `PLANNED` sprints only) as a new
  "From last retro" lane above the standard backlog rows. Each row has an
  inline "Pull to this sprint" action (PO/SM gated, Role ≥ SCHEDULER) which
  promotes the action item (if not already promoted) and assigns the resulting
  Task to this sprint atomically. **This is the only path by which a retro
  action item can be assigned to a sprint** — it requires an explicit PO/SM
  decision in Sprint Planning, preserving sprint sovereignty.
- Permission: read = MEMBER+ on the project (raw text further gated by §3
  visibility for the source retro). Write (pull-to-sprint) = SCHEDULER+ on the
  project.
- Implementation extends `projects/retro_services.py` with
  `pull_carryover_item_to_sprint(action_item, target_sprint, actor) -> Task`
  that internally calls `promote_retro_action_item` then sets
  `task.sprint = target_sprint`; the entire flow is a single atomic
  transaction with one `transaction.on_commit` broadcast.

**(c) My Work "unresolved retro actions" badge** (Morgan's request)
- Extend `GET /me/work/` (#499) response with a `retro_action_items` array:
  unresolved action items owned by, suggested for, or unassigned for the
  requesting user across all their projects.
- Shape mirrors carryover-lane items above, plus a `suggestion_state` field
  (`owned` | `suggested` | `none`) so the UI can split owned vs suggested.
- The MyWorkPage renders a "From retros" section if `retro_action_items` is
  non-empty. Items support three actions:
  - Accept (suggested → owner): only when `suggestion_state == "suggested"`;
    binds via the `TaskSuggestedAssignee` flow per §5.
  - Decline: only when `suggestion_state == "suggested"`; clears the
    suggestion.
  - Open: navigates to the source retro (if visibility permits) or to the
    promoted Task.

All three sub-features ship in v1 per the user's chosen scope.

### 5. Owner soft-suggestion flow — TaskSuggestedAssignee model (v1 scope)

New first-class model in OSS:

```python
class TaskSuggestedAssignee(VersionedModel):
    """One open suggestion at a time per (task, suggested_user) pair.
    A Task can carry zero or many suggestions; the suggested_user accepts at
    most one (binding becomes Task.assignee). Declined or expired suggestions
    are soft-deleted via VersionedModel.soft_delete().
    """
    task            = ForeignKey(Task, CASCADE, related_name="suggested_assignees")
    suggested_user  = ForeignKey(AUTH_USER_MODEL, CASCADE, related_name="task_suggestions")
    suggested_by    = ForeignKey(AUTH_USER_MODEL, SET_NULL, null=True, related_name="suggestions_made")
    reason          = TextField(blank=True, default="")  # optional context ("from retro of Sprint S5")
    source          = CharField(max_length=24, choices=SuggestionSource, default="retrospective")
    state           = CharField(max_length=12, choices=SuggestionState, default="pending", db_index=True)
    created_at      = DateTimeField(auto_now_add=True)
    accepted_at     = DateTimeField(null=True, blank=True)
    declined_at     = DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            UniqueConstraint(
                fields=["task", "suggested_user"],
                condition=Q(state="pending", is_deleted=False),
                name="unique_pending_suggestion_per_user_per_task",
            ),
        ]
        indexes = [
            Index(fields=["suggested_user", "state"], name="suggestion_user_state_idx"),
            Index(fields=["task", "state"], name="suggestion_task_state_idx"),
        ]


class SuggestionSource(models.TextChoices):
    RETROSPECTIVE = "retrospective"  # action item promote with non-self assignee
    OTHER         = "other"          # reserved for future suggestion sources


class SuggestionState(models.TextChoices):
    PENDING  = "pending"   # waiting for suggested_user to accept/decline
    ACCEPTED = "accepted"  # suggested_user accepted; Task.assignee = suggested_user
    DECLINED = "declined"  # suggested_user declined; no binding
    REVOKED  = "revoked"   # suggested_by withdrew the suggestion before action
```

**Promote-to-task behaviour with suggestion**:
- If `RetroActionItem.assignee IS NULL`: Task is created with `assignee=None`.
  No suggestion is created.
- If `RetroActionItem.assignee == action_item.retro.created_by` (self-claim):
  Task is created with `assignee = action_item.assignee`. No suggestion is
  created — this is the binding self-claim path.
- If `RetroActionItem.assignee != action_item.retro.created_by` (assigning
  someone else): Task is created with `assignee=None`. A
  `TaskSuggestedAssignee` row is created with `state=PENDING`,
  `suggested_user = action_item.assignee`, `suggested_by =
  action_item.retro.created_by`, `source=RETROSPECTIVE`, `reason="from retro
  of Sprint <short_id>"`.

**Accept/decline endpoints**:
- `POST /api/v1/tasks/{task_pk}/suggestions/{pk}/accept/` — only the
  `suggested_user` may call. Atomic: assert `state == PENDING`, set
  `Task.assignee = suggested_user` (only if `Task.assignee IS NULL` to avoid
  race), set suggestion `state=ACCEPTED`, `accepted_at=now()`. Fires
  `broadcast_board_event("task_updated", ...)` on commit.
- `POST /api/v1/tasks/{task_pk}/suggestions/{pk}/decline/` — only the
  `suggested_user` may call. Sets `state=DECLINED`, `declined_at=now()`. No
  broadcast (declines are private).
- `POST /api/v1/tasks/{task_pk}/suggestions/{pk}/revoke/` — only the
  `suggested_by` may call (or Project ADMIN+). Sets `state=REVOKED`.

**Permission**: `IsProjectMember` for read; specific user-match enforced at
view-body for state transitions (the suggested user accepts/declines;
suggested_by or ADMIN revokes).

**Why a model and not `Task.notes` text**: Priya's hard veto on silent
assignment requires a structural object the UI can render explicitly, the API
can permission-gate per-user, and audit can query directly. Storing
suggestions in `Task.notes` would have been a stopgap; the v1 scope decision
is to do it properly so future suggestion sources (peer suggestions, mention
suggestions in comments) plug into the same model without re-architecting.

**Out of scope for v1**: inline capacity warning when assigning at retro time
(David's request). Filed as follow-up — depends on extending the sprint
capacity endpoint to support pre-commit dry-run queries.

### 6. Enterprise hook (OSS data shape that supports portfolio rollup)

To support the Marcus/Janet portfolio rollup without re-architecting later:

- Every Task created via promote-to-task carries a `source` marker in `notes`
  (`source: "retrospective"`). Enterprise can query
  `Task.objects.filter(notes__icontains='source: "retrospective"')` cleanly.
- `RetroActionItem.promoted_task_id` is the join column for action-item
  completion rate: `completed = items with promoted_task_id != NULL AND
  promoted_task.status = COMPLETE; total = all items; rate = completed / total`.
- `RetroActionItem.created_at` is the age column.
- All three columns are on existing OSS schema; **no schema changes are needed
  to support the Enterprise rollup**.

The Enterprise rollup itself (cross-program completion rates, recurring
"to_improve" theme detection) is filed in `trueppm-enterprise` and consumes
only the aggregate counts (`action_items_count`, `closure_rate`) — never the
raw text.

### 7. Sprint sovereignty (structural enforcement)

The promote endpoint **cannot** be passed a `sprint_id` parameter. The new
Task is unconditionally created with `sprint=None`. Sprint assignment is a
separate PO/SM-gated action in Sprint Planning per ADR-0069.

**Test plan** (see §9): integration test that sends `{ "sprint_id": "..." }`
to the promote endpoint and asserts it is **silently ignored** (not 400; the
field is not in the serializer at all) and the resulting Task has
`sprint=None`. This is the structural test that resolves Morgan's prior 🔴
blocker.

### 8. Frontend changes

- **`RetroPanel.tsx`** — add a "Promote to backlog" button per action item
  (disabled if `promoted_task_id != NULL`; shows "→ #SHORT_ID" link to the
  created Task). Calls a new `usePromoteRetroActionItem` mutation hook.
- **`RetroPanel.tsx`** — add the "Prior retro" collapsible section consuming
  `useSprintRetroPrior(sprintId)` hook.
- **`MyWorkPage.tsx`** — extend (in a separate small follow-up) to show
  suggested-but-not-accepted action items in a "Suggested for you" subsection.
  Stub only in v1 — full implementation deferred per §5.
- **Visibility gate** — Viewer-role users see the summary-only variant of
  `RetroPanel` (counts and promote status, no `notes` or action-item text).
  Implementation: split into `RetroPanel` (MEMBER+) and `RetroPanelSummary`
  (VIEWER); `useSprintRetro` returns whichever payload the server sends.

### 9. Test plan (mandatory three layers)

**pytest** (`packages/api/tests/apps/projects/test_retro_promote.py`):
- Golden path: promote returns 201, Task created with `status=BACKLOG, sprint=NULL`,
  `promoted_task_id` set, broadcast fired on commit.
- Idempotency: second promote on same action item returns 409.
- Sprint-sovereignty IDOR: POST with `{ "sprint_id": "..." }` ignores it.
- Permission: VIEWER role gets 403 on promote; MEMBER+ allowed.
- Visibility: VIEWER on `GET retro/` receives summary serializer only (no `notes`).
- Rollback: soft-delete the promoted Task → `promoted_task_id` is cleared.
- Continuity: `GET retro/prior/` returns the most recent prior retro for the
  same project; returns 404 if none.

**vitest** (`packages/web/src/features/sprints/RetroPanel.test.tsx`):
- "Promote to backlog" button renders for non-promoted items.
- "Promote to backlog" button disabled + shows task short_id for promoted items.
- "Prior retro" section renders when prior retro exists.
- Viewer role sees summary view only.

**Playwright** (`packages/web/e2e/sprint-retro-promote.spec.ts`):
- Open retro panel on closed sprint, type action item, save, click "Promote",
  navigate to project backlog, verify the new Task is present with `BACKLOG` status.
- Verify the new Task is not in any sprint (board sprint filter).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — Promote to `BacklogItem` (program backlog)** | Aligns with ADR-0069 program-level intake; preferred by 4 of 8 VoC personas | `BacklogItem` not yet implemented; blocks #486 on a much larger scope. Action items are project-scope (retro is one team's experience), not program-scope (cross-project intake) — wrong semantic level |
| **B — Promote to Task (project backlog) (chosen)** | Already the path ADR-0065 deferred to this issue; preserves sprint sovereignty per ADR-0069; ships in 0.2 without prerequisite work | One row per action item duplicates the action item row + its Task row until reconciled — acceptable since the two states are semantically distinct |
| **C — Auto-assign to next Sprint** | Lowest friction at retro time | Violates ADR-0069 sprint sovereignty (Morgan 🔴, Priya hard veto, Alex hard NO, Jordan hard NO) — unanimous panel rejection |
| **D — Per-item selectable A/B/C at retro time** | Maximum flexibility | Decision paralysis at 5pm Friday; collapses to C if SM picks for the team (Priya); too much ceremony for the value (Alex) |
| **E — No promotion (keep action items inside `SprintRetro` forever)** | Smallest implementation | Defeats the entire point of #486 — action items must land somewhere a PO or SM can prioritize them; otherwise they die in the retro the same way they die in Confluence today |

## Consequences

**Easier**:
- Alex's 10/10 anchor ("retro action items flow into next Sprint's backlog
  automatically") is finally addressable in a way that respects sprint sovereignty.
- Morgan's prior 🔴 (sprint sovereignty) is resolved by structural enforcement,
  not convention.
- The data shape supports the Enterprise portfolio rollup as a clean read
  (joining on `notes ILIKE 'source: "retrospective"'` and `promoted_task_id`)
  without any OSS schema changes when Enterprise builds the dashboard.

**Harder**:
- Two rows per action item (the `RetroActionItem` + its promoted `Task`) until
  the Task is closed. Acceptable — they are semantically distinct (the action
  item is the *commitment from the retro*, the Task is the *work in the backlog*).
- The "suggested assignee" stored in `Task.notes` rather than a structured
  field is a stopgap. If adoption data shows >20% of action items use suggested
  (not self-claimed) assignees, file a follow-up to introduce a proper
  `TaskSuggestedAssignee` model.
- Tighter VIEWER visibility on `retro` GET is a backwards-incompatible API
  change for any existing VIEWER clients reading `notes`. Acceptable — this is
  a security-correctness fix, and the OSS API is pre-1.0; no external clients
  documented to read this.

**Risks**:
- If Sprint Planning ever introduces a "bulk-assign BACKLOG tasks to next
  Sprint" affordance (none exists today), it must respect the same sovereignty
  rule that promote-to-task enforces — i.e. require explicit PO/SM action.
  Document this in ADR-0072 (if Sprint Planning gets bulk-assign) so the
  invariant cannot regress.
- The continuity loop's `prior` endpoint joins `Sprint.finish_date` and could
  return a CANCELLED sprint's retro if one exists. **Filter to `state IN
  (COMPLETED)`** in the `prior` query to avoid surfacing cancelled-sprint
  retros as the "prior" context.
- `Sprint.short_id` appears in the promoted Task's `notes` for cross-reference.
  If `Sprint.short_id` is ever renamed, the cross-reference becomes lossy
  (text-only, not a FK). Acceptable — `promoted_task_id` on the action item
  carries the authoritative link in the other direction.

## Implementation Notes

- **P3M layer**: Operations (retro is sprint-internal) → Programs and Projects
  (promoted Task lands at project level)
- **Affected packages**: `api` (new service + endpoints + serializer split +
  view permission gate + new `TaskSuggestedAssignee` model + WatermelonDB sync
  extension), `web` (RetroPanel promote button + Prior retro section +
  SprintBacklogTable carryover lane + MyWorkPage "From retros" section + new
  visibility toggle UI). **Mobile**: v1 ships VersionedModel uplift for both
  retro models so they sync via WatermelonDB; React Native UI for retro read
  is in scope of a follow-up mobile MR (data plumbing lands here).
- **Migration required**: yes — three migrations in this MR:
  1. **`AddField`** on `SprintRetro`: `team_visibility CharField(choices=RetroVisibility, default="team_only", max_length=12)`. Backfills to `TEAM_ONLY`.
  2. **`VersionedModel` uplift** on `SprintRetro` and `RetroActionItem`:
     adds `server_version BigIntegerField(default=0)`, `is_deleted
     BooleanField(default=False, db_index=True)`, `deleted_version
     BigIntegerField(null=True)`. All defaults are non-null safe; the
     `id UUIDField` PK is already in place from migration 0027 so the model
     bases can switch from `models.Model` to `VersionedModel` without
     re-keying. Also adds `created_by` FK to `RetroActionItem` (currently
     stored only on `SprintRetro.created_by`); needed so the suggestion-vs-
     self-claim check in §5 can be made per-item.
  3. **`CreateModel`** for `TaskSuggestedAssignee` (new) with its indexes and
     constraint per §5.
  None of the three migrations is destructive. All are reversible.
- **API changes**: yes —
  - `POST /sprints/{pk}/retrospective/action-items/{item_pk}/promote/` (new)
  - `GET /sprints/{pk}/retrospective/prior/` (new)
  - `GET /projects/{pk}/retrospective/carryover/` (new)
  - `POST /sprints/{pk}/retrospective/action-items/{item_pk}/pull-to-sprint/` (new — the SCHEDULER+ promote+assign in one transaction; the only path that puts a retro action item into a sprint)
  - `POST /tasks/{task_pk}/suggestions/{pk}/{accept,decline,revoke}/` (new)
  - `PATCH /sprints/{pk}/retrospective/` — extend to accept `team_visibility`
  - `GET /me/work/` — extend response with `retro_action_items` array (per #499 follow-up wiring)
  - `retro` GET response shape changes by retro `team_visibility` × requesting user role.
- **OSS or Enterprise**: OSS — operations + project-layer feature; Alex (target)
  + Morgan + Jordan + Priya are all OSS personas. The Enterprise rollup of
  retro metrics is filed separately in `trueppm-enterprise`.
- **Apache 2.0 boundary**: clean. OSS remains fully functional without
  `trueppm-enterprise`. The Enterprise rollup is a separate package that reads
  OSS data only.

### Durable Execution

1. **Broker-down behaviour**: `promote_retro_action_item()` is **synchronous**
   within the request. The only async side effect is the CPM recompute
   triggered by `enqueue_recalculate()` after Task create — that path is
   already protected by the outbox per ADR-0027 (`ScheduleRequest` row written
   atomically before `.delay()`). No new outbox category is introduced.

2. **Drain task**: reuses `drain_schedule_requests` Beat (ADR-0027). No new
   drain needed; promote-to-task fires the same recompute outbox row any other
   Task create does.

3. **Orphan window**: N/A for promote itself (synchronous). CPM recompute
   inherits ADR-0027's 10-minute window.

4. **Service layer**: new `projects/retro_services.py::promote_retro_action_item()`
   (atomic transaction, `SELECT FOR UPDATE` on action item, Task create,
   `on_commit` broadcast + recompute). The `prior` GET is a thin queryset on
   the view, no service-layer extraction needed.

5. **API response on best-effort dispatch**: synchronous `201 Created
   { "task": <TaskSerializer> }`. **No `{"queued": true}`** — the Task is
   created in the request; CPM recompute is best-effort background under the
   existing pattern.

6. **Outbox cleanup**: N/A — no new outbox category. ADR-0027's nightly
   `drain_schedule_requests` purge applies.

7. **Idempotency**: `RetroActionItem.promoted_task_id` is the idempotency key.
   `SELECT FOR UPDATE` on the action item row, assert `promoted_task_id IS NULL`
   before creating the Task. Concurrent or duplicate promote attempts receive
   `409 Conflict` with the existing `promoted_task_id` in the response payload
   so the client can no-op rather than retry.

8. **Dead-letter / failure handling**: synchronous. If Task create fails, the
   database transaction rolls back and `promoted_task_id` remains NULL — no
   dead-letter needed. CPM recompute failure handling inherits ADR-0027's
   retry/DLQ policy unchanged.

## Scope decisions resolved (2026-05-18)

User selected the maximalist option on all four §3–§5 + Mobile decisions:

1. **§3 Visibility** — ship `team_visibility` enum + opt-in toggle in v1
   (TEAM_ONLY default, PROJECT, ORG; backwards-compat-safe migration with
   defaults).
2. **§4 Continuity** — ship Prior-retro panel section **and** Sprint Planning
   carryover lane **and** My Work "From retros" section in v1.
3. **§5 Owner soft-suggestion** — ship the full `TaskSuggestedAssignee` model
   with accept/decline/revoke endpoints in v1.
4. **Mobile** — lift `SprintRetro` and `RetroActionItem` to `VersionedModel`
   in v1 so retro data syncs via WatermelonDB; React Native UI remains a
   follow-up but the data plumbing ships here.

This raises the v1 MR scope to: three migrations, six new endpoints, two new
models, four extended frontend surfaces. Acceptable per user direction. UX
design proceeds against this scope.
