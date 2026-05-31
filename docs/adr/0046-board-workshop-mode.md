# ADR-0046: Board Workshop Mode

## Status
Accepted (2026-05-31) — implemented in #216

## Context

Wave 9 of the design-aligned UI build (issue #216) adds a toggle-able Workshop mode to the
operating Board. The feature converts the Kanban surface into a live multi-cursor planning
canvas for project kickoff workshops: inline phase rename, drag-to-reorder phases, "+ Add
task" in every board cell, "+ Add phase here" strips between phase rows, PMI starter sets,
and minimal card chrome for rapid idea capture. A companion WebSocket channel broadcasts
cursor presence and edit-in-progress state to all workshop participants.

Ten architectural decisions require resolution before implementation:

1. Multi-cursor presence approach
2. WorkshopSession model placement
3. WebSocket channel separation
4. Phase reorder — data model and API
5. Workshop primitive reuse for Wave 10 Sprints
6. Tablet / touch responsiveness
7. Hybrid-attendee identity (in-room participants)
8. Permission model
9. Inline-edit undo path
10. Resource-allocation digest scope

**P3M layer:** Programs and Projects — a single-project operation. Every persona in scope
(Sarah/PM, Alex/Scrum Master, project team members) operates at this layer. Feature belongs
in OSS (trueppm-suite).

**VoC summary (avg 5.3/10):** Sarah (PM, 9/10) is the primary user — tablet/touch support
is non-negotiable (conference-room kickoffs). Alex (Scrum Master, 7/10) requires the workshop
engine to be built as a reusable primitive for Sprint Planning (Wave 10). David (Resource
Mgr, 2/10) needs a post-workshop allocation digest — deferred to follow-up issue #248.

**Key codebase facts established by architecture research:**

- No `Phase` model exists. Phases = WBS L1 summary tasks (`isSummary=true` in the frontend
  type, depth-1 `wbs_path`). `buildPhases()` in `board/BoardView.tsx:85` computes them
  client-side by grouping leaf tasks by their summary-task parent.
- Board WebSocket: `ProjectConsumer` in `apps/sync/consumers.py`, group `project_{pk}`,
  JWT auth via `?token=` query param, rejects role < MEMBER (role 0).
- `broadcast_board_event(project_id, event_type, payload)` in `sync/broadcast.py`; all
  callers wrap in `transaction.on_commit()`.
- `@dnd-kit/sortable` (`useSortable`) already used in `features/wbs/WbsRow.tsx`.
- `Task.priority_rank` (PositiveIntegerField, nullable) already exists on the Task model;
  currently used for board card ordering.
- No guest/invite token system in OSS code. Membership is admin-managed only.
- `ScheduleRequest` transactional outbox drives CPM recalculation; Beat drain every 30 s.
- No existing `apps/workshops/` Django app.
- Next migration in `apps/projects/`: 0025. New `apps/workshops/` starts at 0001.

## Decision

### 1. Multi-cursor presence — homegrown WebSocket broadcast

Use the existing Django Channels + Redis infrastructure with a lightweight cursor and
edit-state broadcast protocol. Do not introduce Yjs or any CRDT library.

**Rationale:** Yjs solves character-level concurrent document editing. Workshop mode does
not have that problem — the only collaboratively edited text is a short phase name (< 64
chars), and two users renaming the same phase simultaneously is an exceptional case that
last-write-wins (via `server_version` optimistic lock) resolves correctly. The real-time
value is presence awareness ("who is editing what phase"), which maps directly to the
existing `broadcast_*` fan-out pattern.

**Protocol:**

- Client → server while a contentEditable is focused:
  `{"type": "workshop.cursor", "element_id": "<phase_id>", "state": "editing"}`
- Server fans out to the workshop channel group:
  `{"event_type": "cursor_moved", "payload": {"user_id": ..., "element_id": ..., "state": ...}}`
- On commit (PATCH to server) or Escape: client sends `state: "idle"`.
- Conflict handling: PATCH includes `server_version`; server returns HTTP 409 on mismatch;
  client renders "Someone else updated this — click to reload." No automatic merge.

### 2. WorkshopSession model placement — new `apps/workshops/` Django app

Create a new `apps/workshops/` Django app containing: `WorkshopSession` model,
`WorkshopParticipant` model, `WorkshopConsumer` (Channels), views, serializers, and URL
routes. Do not add workshop models to `apps/projects/`.

**Rationale:** Workshop has a distinct lifecycle (start/end/participants), its own
WebSocket consumer, and will grow (session notes, PDF/JSON export). Keeping it separate
avoids expanding the already-large `apps/projects/` app.

**Models:**

```python
class WorkshopSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.CASCADE, related_name="workshop_sessions"
    )
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(ended_at__isnull=True),
                name="unique_active_workshop_per_project",
            )
        ]

class WorkshopParticipant(models.Model):
    session = models.ForeignKey(
        WorkshopSession, on_delete=models.CASCADE, related_name="participants"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+"
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    left_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("session", "user")]
```

`WorkshopSession` does **not** extend `VersionedModel` — workshop sessions are not synced
to mobile. Plain Django model with UUID PK is correct.

**Recovery endpoint:** `POST /api/v1/projects/{id}/workshop/force-end/` (ADMIN only) sets
`ended_at` on any active session for the project, recovering from a crashed session that
never called `/end/`.

### 3. WebSocket channel separation — new WorkshopConsumer

Create `WorkshopConsumer` in `apps/workshops/consumers.py` using channel group
`project_{pk}_workshop`. This is a separate consumer from `ProjectConsumer`
(group `project_{pk}`).

**Rationale:** Workshop cursor broadcasts fire at ~100 ms intervals during active editing
and must not pollute the operating-board channel that regular project sessions keep open.

**Consumer behaviour:**

- Route: `ws/projects/{pk}/workshop/` registered in `routing.py`
- Auth: same JWT `?token=` pattern as `ProjectConsumer`
- Connect gate: user must have role ≥ MEMBER (1); verified on connect via membership lookup
- On connect: upsert `WorkshopParticipant`; broadcast `participant_joined` to group
- On receive: forward `workshop.cursor` events to group; do not write to DB
- On disconnect: set `WorkshopParticipant.left_at`; broadcast `participant_left`
- Broadcast helper: `broadcast_workshop_event(project_id, event_type, payload)` in
  `apps/workshops/broadcast.py`, mirroring `broadcast_board_event` signature

### 4. Phase reorder — priority_rank on summary tasks

Use `Task.priority_rank` (already on the model, nullable) as the phase display order.
`PATCH /api/v1/projects/{id}/phases/reorder/` accepts an ordered list of phase task IDs,
atomically updates `priority_rank` for each, and triggers CPM recalculation via
`enqueue_recalculate()`. The `buildPhases()` client function sorts by
`priority_rank ASC NULLS LAST, wbs_path ASC` (ltree fallback for projects that have
never reordered phases).

**Rationale:** Re-pathing ltree on phase reorder cascades `UPDATE` to all descendant tasks,
holding row locks across potentially hundreds of rows. Using `priority_rank` for display
order decouples the visual ordering concern from the structural ltree hierarchy. CPM
continues to use `wbs_path`; phase order is a board-surface concern only.

**API:**

```
PATCH /api/v1/projects/{project_id}/phases/reorder/
{
  "phases": [
    {"id": "<uuid>", "server_version": 12},
    {"id": "<uuid>", "server_version": 7}
  ]
}
```

- Requires ADMIN (role ≥ 3)
- Verifies all `server_version` values match DB before writing (409 on any mismatch)
- Atomically sets `priority_rank = index` for each phase in `transaction.atomic()`
- Bumps `server_version` on each affected task (F() increment, existing pattern)
- Wraps `broadcast_board_event` + `enqueue_recalculate()` in `transaction.on_commit()`
- Returns updated phase list (200) or 409 on version conflict

**No migration needed** — `Task.priority_rank` already exists in the schema.

### 5. Workshop primitive reuse for Wave 10 Sprints — hooks-first, component-specific

Extract session management and presence logic into generic React hooks not coupled to
phases or the board. The `BoardWorkshopBody` component itself is phase-specific.
Wave 10 Sprints architect review will evaluate reuse.

**Generic hooks extracted in Wave 9:**

- `useWorkshopSession(projectId)` — start/end session, elapsed timer, participant list
- `useWorkshopPresence(projectId, sessionId)` — cursor positions keyed by element ID,
  editing-state map per user

These hooks communicate over `WorkshopConsumer` with no board or phase concepts inside.
`BoardWorkshopBody` consumes them; the hooks themselves have zero dependency on phases,
tasks, or board column structure.

**Not done in Wave 9:** A generic `<WorkshopCanvas>` abstraction. ADR-0037 (Sprint Model)
is still Proposed; abstracting before Sprint Planning requirements are frozen is premature.
Wave 10 architect review specifies whether Sprint Planning wraps these hooks directly.

### 6. Tablet / touch responsiveness

Workshop mode is functional at 768px (md) viewport and above. Below 768px the Workshop
toggle button is `hidden` — a facilitated workshop requires a large enough display to see
phases and cells simultaneously.

- **Drag:** `PointerSensor` (already in `BoardView.tsx`) handles mouse and touch. Add
  `TouchSensor` as secondary sensor for phase-reorder drag. Drag handles are 44×44 px
  touch targets (WCAG rule 5, CLAUDE.md).
- **contentEditable on iOS Safari:** `autocorrect="off"`, `autocapitalize="off"`,
  `spellcheck={false}` on all workshop contentEditable elements. Use `onInput` (not
  `onChange`) for value tracking. Auto-commit on `blur` when draft is non-empty.
- **Layout:** At `md` (768px), LaneMeta column collapses from 200 px to 160 px; cells are
  horizontally scrollable. Workshop banner is 44 px tall (touch-safe).

### 7. Hybrid-attendee identity — project members only (Wave 9)

Workshop participation requires existing authenticated project membership (role ≥ MEMBER).
Guest/invite tokens are not implemented in Wave 9.

**Rationale:** Guest tokens are a new auth surface requiring issuance, expiry, scope
definition, and revocation. The immediate conference-room use case is satisfied if the PM
adds attendees as project members before the session. This is the same constraint that
governs all existing board access.

**Follow-up:** Issue #247 covers guest workshop join tokens (scoped to workshop-session
operations only: add task, add phase, cursor movement — no access to full project data).

### 8. Permission model

| Operation | Required role | Permission class |
|---|---|---|
| Start workshop (POST /workshop/start/) | ADMIN (3) | `IsProjectAdmin` |
| End workshop (POST /workshop/end/) | ADMIN (3) or `started_by` | `IsProjectAdminOrSessionOwner` (new) |
| Force-end (POST /workshop/force-end/) | ADMIN (3) | `IsProjectAdmin` |
| Connect to WorkshopConsumer (WS) | MEMBER (1) | Inline `connect()` check |
| Add task in workshop | MEMBER (1) | `IsProjectMemberWrite` (existing) |
| Add phase | ADMIN (3) | `IsProjectAdmin` |
| Rename phase inline | ADMIN (3) | `IsProjectAdmin` |
| Reorder phases | ADMIN (3) | `IsProjectAdmin` |

MEMBER participants can add tasks (workshop is capture-mode: idea creation requires low
friction). Phase structural changes (add/rename/reorder) are ADMIN-only to prevent
structural chaos during a live session with multiple editors.

`IsProjectAdminOrSessionOwner` is a new permission class in `apps/workshops/permissions.py`
that passes if the requesting user has role ≥ ADMIN **or** is the `WorkshopSession.started_by`
user.

### 9. Inline-edit undo path — Escape reverts local state only

`Escape` discards the local `draft` state and reverts the contentEditable to its pre-edit
value. No server call has been made at that point. Once `Enter` or `blur` commits, the
edit is in the system — no session-scoped undo stack.

**Rationale:** A session undo stack requires a command pattern and server-side mutation log,
which is out of scope for a capture-mode feature. The VoC concern (fat-finger in front of
stakeholders) is fully addressed by `Escape`-to-revert before commit.

**`useEditablePhase` hook pattern:**

```typescript
const [draft, setDraft] = useState<string | null>(null); // null = not editing
// onFocus  → setDraft(phase.name)
// onInput  → setDraft(e.currentTarget.textContent ?? '')
// Escape   → setDraft(null); element.textContent = phase.name
// Enter / blur → if draft !== null && draft.trim() && draft !== phase.name → PATCH
```

Browser native undo (`Cmd+Z`) works within the contentEditable for character-level edits
before commit. No server-side undo is provided.

### 10. Resource-allocation digest — deferred

Out of scope for Wave 9. Filed as issue #248: "Workshop mode: surface resources-requested
digest to Resource Manager on session end." ADR-0031 (Resource Allocation Timeline, Proposed)
must be accepted and implemented first.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Yjs CRDT for multi-cursor | Industry-standard concurrent editing, conflict-free | Heavyweight for short phase names; new Yjs provider dep; adds Yjs server complexity |
| WorkshopSession in `apps/projects/` | No new app; aligns with BoardColumnConfig location | Projects app already large; mixes board-config models with session lifecycle |
| Ltree re-path for phase reorder | Keeps structural ordering in ltree | Heavy cascade UPDATE on all descendants; holds row locks; complex atomic path swap |
| Guest invite tokens in Wave 9 | Supports in-room hybrid participants | New auth surface; no existing guest model in OSS; ADR-0034 guest model not yet built |
| Session-scoped undo stack | Matches Figma/Miro UX expectations | Full command pattern + server mutation log; out of scope for a capture-first feature |

## Consequences

**Easier:**

- Phase ordering becomes a simple integer sort — no ltree path arithmetic or cascade updates
- Cursor broadcast reuses the established `broadcast_*` + `on_commit()` pattern
- Drag-to-reorder phases reuses `@dnd-kit/sortable` already present in the WBS view
- `useWorkshopSession` and `useWorkshopPresence` hooks are Wave 10 Sprint Planning building
  blocks without re-architecting

**Harder:**

- `buildPhases()` must handle `priority_rank=null` gracefully (projects that have never
  reordered phases will have null ranks; fall back to `wbs_path` sort)
- New `apps/workshops/` must be wired into `INSTALLED_APPS`, `routing.py`, and URL conf
- Phase reorder 409 conflicts need a clear client-side recovery flow (reload prompt)
- contentEditable on iOS Safari has historical focus/blur quirks — manual iPad test required
  before merge

**Risks:**

- A crashed workshop session (no `ended_at` set) blocks future sessions for the project;
  mitigated by the `force-end` endpoint
- Phase reorder under a large task tree holds row locks longer than a typical task PATCH;
  cap at 50 phases per reorder call; log a warning if > 10 phases are reordered in one call
- `priority_rank` is also used by board card ordering (issue #105); the reorder endpoint
  must only write to summary tasks (phase rows), never to leaf task cards

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** `api` (new `apps/workshops/`; `apps/projects/` phase reorder view),
  `web` (board feature, new workshop hooks)
- **Migration required:** Yes — `0001_initial.py` in new `apps/workshops/`
  (WorkshopSession, WorkshopParticipant tables). No migration needed in `apps/projects/`
  (`Task.priority_rank` already exists).
- **API changes:** Yes — `POST /api/v1/projects/{id}/workshop/start/`,
  `POST /api/v1/projects/{id}/workshop/end/`,
  `POST /api/v1/projects/{id}/workshop/force-end/`,
  `PATCH /api/v1/projects/{id}/phases/reorder/`,
  WebSocket `ws/projects/{pk}/workshop/`
- **OpenAPI schema:** Must be regenerated after `git merge origin/main` per documentation
  discipline (CLAUDE.md: always merge main before regenerating).
- **OSS or Enterprise:** OSS (trueppm-suite)

### Durable Execution

1. **Broker-down behaviour:** WorkshopSession start/end and phase reorder are synchronous
   ORM operations — no direct `.delay()` calls. Phase reorder writes a `ScheduleRequest`
   outbox row atomically inside `transaction.atomic()` via `enqueue_recalculate()`, so CPM
   recalculation is durable even if Redis is down at commit time. Workshop cursor broadcasts
   are fire-and-forget WebSocket messages; loss during a broker outage is acceptable
   (presence state auto-recovers on the next heartbeat). No new outbox row types needed.

2. **Drain task:** No new drain task required. Phase reorder's CPM trigger reuses the
   existing `drain_schedule_requests` Beat task (every 30 s, `@idempotent_task`).
   WorkshopParticipant tracking is fully synchronous.

3. **Orphan window:** N/A for WorkshopSession CRUD (synchronous). CPM recalculation
   triggered by phase reorder inherits the existing 5-minute orphan filter in the
   `ScheduleRequest` drain.

4. **Service layer:** Phase reorder calls `scheduling/services.py::enqueue_recalculate(project_id)`
   — existing function, unchanged. Workshop session start/end logic lives in
   `apps/workshops/services.py::start_workshop(project, user)` and
   `end_workshop(session, user)` to keep business logic out of views.

5. **API response on best-effort dispatch:** Phase reorder returns 200 with the updated
   phase list synchronously. CPM recalculation is fire-and-forget — consistent with the
   existing task mutation pattern (no 202 "queued" response for phase reorder).
   Workshop start returns 201 with the serialized `WorkshopSession`.

6. **Outbox cleanup:** WorkshopSession and WorkshopParticipant are permanent audit records,
   not outbox rows — no purge schedule. The existing `ScheduleRequest` 7-day purge covers
   any CPM rows triggered by phase reorder.

7. **Idempotency:** Phase reorder checks `server_version` for all phases before writing;
   duplicate requests with the same payload conflict on the second call (409). Workshop
   start is guarded by the `unique_active_workshop_per_project` DB partial-unique constraint
   (IntegrityError → 409 with `"active_workshop_exists"` code). Workshop end is idempotent
   (setting `ended_at` on an already-ended session returns 200 without error).

8. **Dead-letter / failure handling:** Phase reorder failures (409 conflict, DB error) return
   synchronously with a clear error code; no DLQ needed. If `enqueue_recalculate()` raises
   (Redis down), the `ScheduleRequest` row is already committed and the Beat drain recovers
   it within 30 s. Workshop sessions that crash without calling `/end/` are recovered via
   `POST /workshop/force-end/` (ADMIN action); no automated recovery to avoid prematurely
   ending a session that is still live on a flaky connection.

## Tracking

Tracking: implemented in #216. Follow-up promises (session undo stack;
resource-allocation digest) are deferred — not yet filed.
