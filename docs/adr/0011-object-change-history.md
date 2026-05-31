# ADR-0011: Object Change History

## Status
Accepted (2026-05-31) — implemented in #12

## Context

TruePPM users need a reliable, queryable audit trail of user-initiated mutations on core
planning objects (Task, Project, Dependency). The primary drivers are:

- **Accountability and debugging**: PMs and team leads want to understand who changed what
  and when on a task or project, without relying on informal communication.
- **Compliance readiness**: Regulated industries (construction, defense, public sector)
  require documented change history with configurable retention. A hard 90-day cap was
  identified as a blocker for compliance-oriented users in the VoC panel (Marcus, 6/10).
- **Portfolio visibility**: Portfolio managers need aggregate mutation signals to detect
  schedule instability. The VoC panel identified the absence of a summary signal as a
  blocker for Janet and David personas.
- **Offline-first integrity**: TruePPM supports offline mutations via WatermelonDB sync.
  History records must carry the originating client timestamp, not the server receipt time,
  to preserve an accurate causal record.

Issue #12 (custom `ChangeLogEntry` model) is superseded by this ADR. `django-simple-history`
provides tested, Django-native historical record tables, field-level diffing, and middleware
for `history_user` population at no meaningful extra cost.

**VoC panel average: 6.2 / 10.** Panel scores and key blockers are incorporated into this
decision (configurable retention, portfolio summary endpoint, pull-only access).

## Decision

### Library

Use `django-simple-history` to record field-level history on `Task`, `Project`, and
`Dependency` models. Each tracked model gets a generated `HistoricalTask`,
`HistoricalProject`, and `HistoricalDependency` table in PostgreSQL.

### New Django app

Create `packages/api/src/trueppm_api/apps/history/` to own all history-related views,
serializers, URL routing, signals, and the Celery purge task. The tracked models remain
in their existing apps; the `history/` app is purely a service layer.

### Tracked models and excluded fields

Track `Task`, `Project`, and `Dependency`. Exclude all CPM output fields:

```python
HISTORY_EXCLUDED_FIELDS = [
    "early_start", "early_finish", "late_start", "late_finish",
    "total_float", "free_float", "is_critical",
    "server_version", "deleted_version",
]
```

Configuration via `excluded_fields` on each model's `HistoricalRecords(...)` declaration.

### history_user population

Register `HistoryRequestMiddleware` from `django-simple-history`. For offline-originated
mutations arriving via the sync endpoint, the sync view must supply `_history_date` (the
client's originating timestamp) when calling `.save()` on tracked models.

### Retention

Introduce `HISTORY_RETENTION_DAYS` setting (default: `90`). A nightly Celery beat task
in `history/tasks.py` purges records with `history_date < now() - timedelta(days=HISTORY_RETENTION_DAYS)`.
Setting `HISTORY_RETENTION_DAYS = None` disables automatic purge (enterprise unlimited
retention). Cold-storage export before purge is deferred to the enterprise extension.

### API surface

**Per-object history** (paginated, newest-first, cursor-based, `page_size=50`):

```
GET /api/v1/projects/{pid}/tasks/{task_id}/history/
GET /api/v1/projects/{pid}/history/
```

Response record shape:
```json
{
  "id": "<history_pk>",
  "history_date": "2026-03-24T14:22:00Z",
  "history_type": "+|~|-",
  "history_user": { "id": "<uuid>", "display_name": "Sarah Chen" },
  "history_change_reason": "string or null",
  "diff": [
    { "field": "duration", "old": 5, "new": 10 }
  ]
}
```

Diff computed by comparing each record against `prev_record`. Empty diffs are omitted.
CPM-excluded fields never appear in diff. `history_user` details visible to Owner/Admin
only; other roles see `null`.

**Portfolio summary** (mutation counts by field type and time window, cached 5 min in Redis):

```
GET /api/v1/projects/{pid}/history/summary/?window=7d
```

Supported windows: `1d`, `7d`, `30d`, `90d`. Response:
```json
{
  "project_id": "<pid>",
  "window": "7d",
  "total_mutations": 142,
  "by_object_type": { "task": 130, "project": 8, "dependency": 4 },
  "by_field": [
    { "field": "duration", "count": 47 },
    { "field": "planned_finish", "count": 31 }
  ],
  "generated_at": "2026-03-25T00:00:00Z"
}
```

History endpoints are **pull-only** — no WebSocket push, no notification triggers.

### Enterprise extension point

After each `HistoricalRecord` save, fire:

```python
# history/signals.py (OSS)
history_record_created = django.dispatch.Signal()
# providing: instance (original model), history_instance (HistoricalRecord), history_type
```

The enterprise package registers a receiver for unlimited retention, cold-storage export,
and immutable audit stamping. The OSS core has zero dependency on enterprise.

### Out of scope

- WatermelonDB sync of history records
- Notifications or WebSocket push on history creation
- Cold-storage export (enterprise tier)
- History for models outside Task, Project, Dependency

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Custom `ChangeLogEntry` model (Issue #12) | Full schema control | Reimplements django-simple-history; no built-in diff; higher maintenance |
| PostgreSQL audit trigger (pgaudit) | DB-level, catches ORM bypasses | No Django-layer user attribution; hard to exclude fields; not portable |
| Event sourcing | Perfect trail, replay capable | Architectural overcommit; no ROI at current scale |
| django-auditlog | Simpler API | Weaker field-level diff; less active maintenance |
| Status quo | Zero cost | Fails compliance requirements; closes off enterprise upsell |

## Consequences

**Positive:**
- Configurable retention unblocks regulated-industry customers (direct path to Marcus 8+/10).
- Portfolio summary endpoint gives PMs a schedule stability signal without BI tooling.
- Signal extension point gives enterprise a clean hook without touching OSS.
- Offline timestamps preserved correctly, maintaining sync integrity.
- Pull-only access avoids notification fatigue (Priya concern).

**Negative:**
- Three new `HistoricalXxx` tables add write amplification. At ~10k mutations/day this is
  manageable but should be monitored; bulk-import paths must bypass history explicitly.
- `django-simple-history` becomes a transitive dependency and risk surface.
- Nightly purge task adds a beat schedule entry operators must be aware of.
- Summary endpoint has 5-minute staleness window (acceptable for portfolio-level aggregate).
- Issue #12 is closed as superseded.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS)
- **Affected packages**: `packages/api` only
- **Migration required**: Yes — three new `Historical*` tables via `makemigrations`
- **API changes**: Two new endpoint groups under `/api/v1/projects/{pid}/`; no changes to existing endpoints
- **OSS or Enterprise**: OSS; enterprise hooks only via `history_record_created` signal
- **Dependency confirmed**: `Task`, `Project`, `Dependency` all in `projects/models.py` ✓

## Open Questions

**BQ-1 🔴 — Offline timestamp authority** *(deferred to architect during sync ADR)*
When an offline mutation arrives via the WatermelonDB sync endpoint, which field on the
sync payload is the canonical "user performed this action at" timestamp? Deferred — to be
resolved in the WatermelonDB sync protocol ADR. Step 3 of the implementation plan is
blocked until that ADR lands.

**BQ-2 ✅ — history_user for CPM-originated writes** *(resolved)*
The CPM Celery task must use queryset `.update()` (not model `.save()`) when writing back
computed fields. `django-simple-history` only intercepts `.save()` signals; a queryset
`.update()` bypasses it entirely. This produces zero history rows from scheduler runs, no
null-user noise, and no tagging logic. Any CPM write path using `.save()` on a tracked
model must be refactored to `.update()` during Step 2.

**BQ-3 ✅ — Summary endpoint cache TTL and UX** *(resolved — UX + VoC panel)*
5-minute Redis cache is acceptable for both the PMO Director (Marcus) and PM (Sarah)
personas — this is a trend/digest widget, not a live operational feed. UI must show a
muted "last updated X ago" label and a discreet manual refresh button (critical for Marcus
before leadership presentations). Do not auto-refresh on a timer. Do not show a spinner on
every page load. A "Updated just now" confirmation after a manual refresh is expected by
Marcus. Cache invalidation on `history_record_created` is not warranted — event-driven
complexity with no user-perceivable value at 7-day aggregate granularity.
