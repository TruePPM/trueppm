# ADR-0044: Wave 8 — Risk Register UX: Row Quick-Edit Affordance and Risk Comments

## Status
Accepted

## Context

Two UX friction points surfaced in user research (VoC panel, 2026-04-29):

**Friction 1 — Edit flow** (panel avg: 4.2/10 for current flow)
Clicking a risk row opens a read-only detail view; the user must then click "Edit" to
modify anything. Power users with edit-intent find this indirect. However, read-only
users (Viewer/Executive) depend on the detail view — forcing direct-to-edit on row
click would be a regression for them.

**Friction 2 — No discussion thread** (panel avg: 6.0/10)
There is no way to leave a contextual note on a risk without editing its `description`
field, which conflates permanent risk definition with living discussion (escalation notes,
status updates, decisions made in meetings). Marcus (PMO Director) specifically cited the
need for an immutable audit trail of risk discussions.

VoC key blockers:
- Do NOT remove the read-only detail view — read-only users (Janet/Marcus) require it
- Comments must be immutable in v1 — no edit/delete satisfies audit requirement
- Separate POST endpoint for comments — PATCH on Risk would bump `server_version`,
  trigger `broadcast_board_event("risk_updated")`, and pollute risk change history

## Decision

### Fix 1 — Row-level quick-edit affordance (pure frontend, no API changes)

Add a `✎` pencil icon to each risk table row that appears on hover/focus-within.
Clicking it opens `RiskDrawer` with `isEditing: true`, bypassing the detail view.
Regular row click continues to open the read-only detail view unchanged.

This is a single surgical hover affordance — no drawer pattern change (rule 89
remains intact), no model change, no new endpoint.

### Fix 2 — Risk comments/notes thread (new model + endpoint + UI)

Introduce an append-only `RiskComment` model with author attribution and timestamp.
Two new nested endpoints (`GET` / `POST`) under the existing risk URL hierarchy.
Comments are displayed in the `RiskDrawer` detail view in a collapsible "Notes (N)"
section, below the risk framework fields. Comments are immutable in v1.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Direct-to-edit on row click | Fewer clicks for PMs | Removes read-only path — VoC blocker |
| Modal for edit | Familiar desktop pattern | Violates rule 89; loses list context |
| Inline row expansion | No drawer required | Jarring row height change; poor mobile story |
| Tabs in drawer (Details / Edit) | Explicit separation | Extra nav layer; doesn't solve comments |
| **Row-level ✎ icon (chosen)** | Surgical; preserves detail view | Hover-only — keyboard `focus-visible` handles it |
| Comments in description field | No new model | Conflates risk definition with discussion |
| `HistoricalRecords` on Risk | No new model; reuses ADR-0011 | Field diffs, not free-form messages; wrong UX |
| **Separate `RiskComment` model (chosen)** | Clean separation; audit-ready | One extra model/migration |

## Consequences

- PMs and Scrum Masters eliminate one click from the edit flow
- Viewer/Executive read-only users are unaffected
- Marcus's audit requirement is satisfied: comments are immutable once posted
- `RiskComment` does NOT inherit `VersionedModel` — it is not synced to mobile
  WatermelonDB and immutability makes server_version unnecessary
- `RiskComment` has no `HistoricalRecords` — immutable by design, nothing to diff
- CSV export does not include comments (v1) — they are a thread, not a scalar field
- WebSocket broadcast on comment creation keeps open drawers live for other viewers

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: api, web
- **Migration required**: yes — `0024_riskcomment`
- **API changes**: yes — new nested endpoints under `/risks/{risk_pk}/comments/`
- **OSS or Enterprise**: OSS (basic text notes; @mentions, threading, and
  comment-level CSV export push toward Enterprise)

### Data Model

```python
class RiskComment(models.Model):
    """
    Append-only discussion note on a Risk.

    Deliberately plain models.Model (not VersionedModel) — comments are not
    synced to mobile and immutability makes server_version unnecessary.
    No HistoricalRecords — there are no field-level diffs to track.
    """
    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    risk       = models.ForeignKey("Risk", on_delete=models.CASCADE, related_name="comments")
    author     = models.ForeignKey(
                     settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                     null=True, related_name="risk_comments"
                 )
    message    = models.TextField()   # non-blank enforced in serializer
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]   # chronological; newest append scrolls into view
```

### API

```
GET  /api/v1/projects/{project_pk}/risks/{risk_pk}/comments/
     → 200  { count, next, previous, results: [{ id, author, message, created_at }] }

POST /api/v1/projects/{project_pk}/risks/{risk_pk}/comments/
     Body:  { "message": "..." }
     → 201  { id, author, message, created_at }

# No PUT / PATCH / DELETE — comments are immutable.
```

`author` in responses is a nested object `{ id, display_name }` so the frontend
can render initials + name without a second request.

RBAC:
- GET: VIEWER+ (role ≥ 0)
- POST: MEMBER+ (role ≥ 1) — same threshold as risk create/update

ViewSet inherits from `ProjectScopedViewSet` and uses the existing `IsProjectMemberWrite`
permission class for writes (no new permission class needed).

Broadcast on create (same `transaction.on_commit` pattern as `RiskViewSet`):
```python
transaction.on_commit(
    lambda: broadcast_board_event(
        project_id, "comment_created", {"risk_id": risk_id, "id": comment_id}
    )
)
```

### Frontend

**Row quick-edit affordance (`RiskRegisterView.tsx` / risk table row):**
```tsx
// On each row, inside a `group` container:
<button
  type="button"
  aria-label={`Edit risk: ${risk.title}`}
  onClick={(e) => { e.stopPropagation(); openDrawer(risk, true); }}
  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100
             h-7 w-7 flex items-center justify-center rounded
             text-neutral-text-secondary hover:text-neutral-text-primary
             focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-brand-primary focus-visible:ring-offset-1"
>
  ✎
</button>
```

**Comments section (`RiskDrawer.tsx` detail view):**
- New `useRiskComments(riskId)` hook — TanStack Query key `['risk-comments', riskId]`
- New `useCreateRiskComment()` mutation with optimistic list append
- Loaded when drawer opens (separate query, not bundled with risk)
- Position: below the risk framework fields, above the "Updated at" footer
- Collapsed when 0 comments; expanded when ≥ 1
- Each comment: initials avatar circle + author name + `.tppm-mono` timestamp + message
- Input: `<textarea>` + "Add note" button; Cmd/Ctrl+Enter also submits
- Offline: textarea disabled, inline hint "Notes require a connection"
- Error: toast on POST failure; remove optimistic row from list

### Durable Execution

1. **Broker-down behaviour**: `broadcast_board_event` is a Redis pub/sub call inside
   `transaction.on_commit`. If Redis is unavailable the comment is persisted in
   Postgres but the WS event is lost. Acceptable — comments are advisory; a client
   refresh will surface the new comment. No outbox needed.
2. **Drain task**: N/A — no async work is triggered by comment creation.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: No new `services.py` function needed. `RiskCommentViewSet.perform_create`
   handles write + broadcast directly, identical to the `RiskViewSet` pattern.
5. **API response on best-effort dispatch**: 201 synchronous — the comment is created in
   the request transaction.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: N/A — synchronous write; duplicate HTTP requests would create
   duplicate comments (acceptable; UI prevents double-submit via loading-state disable).
8. **Dead-letter / failure handling**: N/A — synchronous write with standard DRF error
   response on failure.

## Tracking

Tracking: implemented in #243 (row-level quick-edit affordance) and #244 (risk
comments / notes thread).
