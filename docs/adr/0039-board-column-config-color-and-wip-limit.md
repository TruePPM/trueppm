# ADR-0039: Board Column Config — Color and WIP Limit Persistence

## Status
Accepted

## Context

Issue #170 ("Configurable columns") asks for per-project board column customization
covering rename, color, position, and WIP limits. The original issue text proposes
a new `BoardColumn` model with FK from `Task.status`, allowing teams to invent
arbitrary column states beyond the canonical five.

Two prior decisions constrain this:

- **ADR-0013 (Board / Kanban View)** introduced `BoardColumnConfig` as a
  per-project JSON config (`OneToOneField → Project`, `columns: JSONField`)
  storing `[{status, label, visible}, …]` for the **five canonical**
  `TaskStatus` values (`BACKLOG, NOT_STARTED, IN_PROGRESS, REVIEW, COMPLETE`).
  WIP limits and column color were noted as *future additive* fields on the
  existing JSON shape — not new tables.
- **ADR-0037 (Sprint Model)** explicitly flagged `BoardColumnConfig.wip_limit`
  as frontend-only (lives in `useBoardConfig.ts`, never persisted) and stated
  the API addition should be additive.

A six-persona Voice-of-Customer panel scored the FK-replacement design at
**5.2/10**:

| Persona | Score | Position |
|---------|-------|----------|
| Marcus (PMO) | 6 | Hard veto on FK — breaks portfolio rollup |
| Priya (Engineer) | 4 | Worried about cross-project label drift |
| Janet (COO) | 3 | Worried about state-truth manipulation |
| Sarah (PM) | 5 | Only needs label rename |
| David (Resource Mgr) | 5 | Neutral |
| Alex (Scrum Master) | 8 | Hero — wants server-persisted `wip_limit` and color |

Four of six personas reject the FK approach. The hero persona (Alex) accepts
the hybrid: canonical enum at the data layer, color and `wip_limit` as
per-column metadata.

## Decision

### 1. Hybrid model — extend the existing JSON, no FK migration

`Task.status` keeps its canonical 5-value `TextChoices` enum. The existing
`BoardColumnConfig.columns` JSONField shape is extended with two optional keys
per column entry:

```jsonc
{
  "status":    "IN_PROGRESS",     // canonical TaskStatus, immutable
  "label":     "In Progress",     // user-renamable, ≤ 32 chars
  "visible":   true,              // boolean, hidden columns still hold tasks
  "color":     "#7DD3FC",         // optional, "#RRGGBB" lower or upper hex, or null
  "wip_limit": 5                  // optional, positive integer, or null
}
```

Existing rows remain valid — `color` and `wip_limit` are absent in stored
rows until first re-save. The serializer treats absent keys as `null`.

### 2. Canonical-five rule preserved

All five canonical statuses must appear exactly once in `columns`. Hide via
`visible: false`; do not delete. **User-defined column states beyond the five
canonical are out of scope** for this batch and are not in the OSS roadmap —
deferred to enterprise `WorkflowState` (TBD).

### 3. WIP limit is advisory, not blocking

When `len(tasks_in_column) > wip_limit`, the UI renders an amber over-limit
chip on the column header. The API does **not** reject `PATCH /tasks/{id}/`
mutations that would push a column over its limit. Rationale:

- Hard rejection without context is frustrating; the user has no way to recover
  except by cleaning up another card first.
- ADR-0013 explicitly framed WIP limits as a soft signal.
- Alex (hero persona) asked for "a warning when exceeded," not enforcement.

A future blocking-mode toggle is additive (per-project boolean), and is
not in v1 scope.

### 4. Endpoints — reuse existing, no new surface

Existing endpoints already cover the full feature:

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/projects/{pk}/board-config/` | GET | `IsAuthenticated + IsProjectMember` | Returns saved config or `_DEFAULT_COLUMNS` |
| `/projects/{pk}/board-config/` | PUT | `IsAuthenticated + IsProjectScheduler` | Validates and replaces full `columns` array |

**No POST/PATCH/DELETE per-column endpoints.** A board has exactly one config;
PUT replaces the whole array. This matches the issue #170 acceptance criteria
and avoids ordering/concurrency hazards of per-column CRUD.

### 5. Server-side defaults updated

`_DEFAULT_COLUMNS` in `serializers.py` gains color and `wip_limit` defaults so
new projects inherit reasonable values on first GET (before any PUT):

```python
_DEFAULT_COLUMNS = [
    {"status": "BACKLOG",     "label": "Backlog",     "visible": True, "color": "#94A3B8", "wip_limit": None},
    {"status": "NOT_STARTED", "label": "To Do",       "visible": True, "color": "#64748B", "wip_limit": None},
    {"status": "IN_PROGRESS", "label": "In Progress", "visible": True, "color": "#3B82F6", "wip_limit": 5},
    {"status": "REVIEW",      "label": "Review",      "visible": True, "color": "#A855F7", "wip_limit": 3},
    {"status": "COMPLETE",    "label": "Done",        "visible": True, "color": "#22C55E", "wip_limit": None},
]
```

Defaults match the brand semantic palette and the WIP defaults already used
in `useBoardConfig.ts` (5 IN_PROGRESS, 3 REVIEW).

### 6. Validation

`BoardColumnConfigSerializer.validate_columns` extensions:

- `color`: optional. If present, must be a string matching `^#[0-9A-Fa-f]{6}$`
  (6-digit hex with leading `#`). Nulls accepted (means "no rail color").
- `wip_limit`: optional. If present, must be `int >= 1` or `null`. Zero or
  negative values rejected with `"wip_limit must be a positive integer or null"`.
- Existing validations (canonical-five present, label ≤ 32, visible bool) unchanged.

### 7. Broadcast on update

`BoardColumnConfigView.put` currently does **not** broadcast. We add:

```python
transaction.on_commit(
    lambda: broadcast_board_event(project_id, "board_config.updated", {"columns": columns})
)
```

…so other connected clients see column rename / color / wip_limit changes in
real time. This matches the broadcast pattern used by `task_updated` and
`baseline_activated`.

### 8. Frontend changes

`packages/web/src/hooks/useBoardConfig.ts` no longer hardcodes
`wipLimit` or `color` defaults. The full shape comes from the GET response.
`BoardColumnDef` TypeScript shape gains `color?: string | null`.

A new `BoardSettingsPanel` component (right-side drawer or modal — see UX
design output) provides the rename + color picker + WIP limit edit interface.
PUT issues a single full-array update; React-Query invalidates the cache.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Hybrid: extend JSON (chosen)** | Tiny diff, zero migration, preserves portfolio queries, ADR-0013 alignment | Cannot add user-defined column states |
| B. New `BoardColumn` model + Task.status FK | Custom column states; matches issue #170 text | Destructive migration; breaks portfolio rollup; rejected 4-of-6 by VoC |
| C. New `BoardColumn` model with FK + keep canonical Task.status | Custom display names per column; status enum preserved | Column ↔ status indirection; no clear win over JSON; harder to validate canonical-five rule |
| D. Defer wip_limit/color to enterprise | Smallest scope | Disappoints Alex (hero persona), leaves ADR-0037 gap unaddressed |

## Consequences

**Easier**
- One-line JSON shape change; no Django migration
- Existing tests (8 cases) require only minor extension
- Frontend `useBoardConfig` shape converges with API shape
- Real-time sync of board settings between clients
- ADR-0037's frontend-only `wip_limit` gap closed

**Harder**
- Future "user-defined column states" is now a separate, larger project (acceptable — VoC says don't do it in OSS)
- JSON shape evolution still means we lack column-level history (not in scope; `BoardColumnConfig` was never `VersionedModel`)

**Risks**
- A client persisting an unknown extra key in the JSON would silently survive (DRF DictField permissive). Mitigated by serializer rebuilding the dict from validated keys only.
- Color hex validation must reject bad input firmly — XSS via reflected color value is a frontend concern (use CSS variable injection through known-safe channels only).

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project board config)
- **Affected packages**: `api` (serializer + view), `web` (hook + new settings panel)
- **Migration required**: NO (JSON shape extension only)
- **API changes**: additive; `color` and `wip_limit` keys appear in GET response
- **OSS or Enterprise**: OSS

### Durable Execution

1. **Broker-down behaviour**: N/A — no Celery dispatch. Endpoint is synchronous PUT; broadcast is best-effort and tolerates broker absence (Channels group_send catches ConnectionError silently in dev; in production, a missing broadcast is non-critical because clients refetch on focus).
2. **Drain task**: N/A — no outbox row created.
3. **Orphan window**: N/A.
4. **Service layer**: No new service function — `broadcast_board_event` already exists in `apps/sync/broadcast.py`. Called inline within the view on `transaction.on_commit`.
5. **API response on best-effort dispatch**: Synchronous 200 with serialized config payload; broadcast is fire-and-forget.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: PUT is idempotent by nature — full-replacement semantics. Same payload twice yields same row state.
8. **Dead-letter / failure handling**: A failed broadcast is logged but does not fail the request. Client refetch on focus + WebSocket reconnect handler reconcile state.

## References

- Issue #170 — feat(api+web): Kanban board — configurable columns
- ADR-0013 — Board / Kanban View (BoardColumnConfig original definition)
- ADR-0037 — Sprint Model (flagged frontend-only `wip_limit` gap)
- VoC panel 2026-04-28 — six-persona evaluation, average 5.2/10
