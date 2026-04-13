# ADR-0023: Actual Start and Finish Dates on Tasks

## Status
Proposed

## Context

TruePPM tracks planned and CPM-computed dates (`planned_start`, `early_start`,
`early_finish`) but has no way to record when work actually began or ended. This
prevents schedule variance analysis, earned value metrics, and meaningful
planned-vs-actual comparisons in the Gantt chart.

**P3M layer**: Programs and Projects / Operations (single-project scope).

**VoC summary** (avg 6.8/10): PM (Sarah) 9/10 — hero feature for daily
planned-vs-actual tracking. PMO Director (Marcus) 8/10 — foundation for SPI/CPI.
Team Member (Priya) 6/10 — fine if auto-set is seamless. Key inputs: auto-set on
status change must be the default path; manual override for PMs only; data must
aggregate for future portfolio variance.

## Decision

Add two nullable `DateField` columns to the `Task` model:

```python
actual_start = models.DateField(null=True, blank=True, db_index=True)
actual_finish = models.DateField(null=True, blank=True, db_index=True)
```

### Auto-set behavior

Auto-set logic lives in `TaskSerializer.update()`, triggered on status transitions:

| Transition | Effect |
|-----------|--------|
| Any → `IN_PROGRESS` | Set `actual_start = today()` if currently null |
| Any → `COMPLETE` | Set `actual_finish = today()`; also set `actual_start = today()` if null |
| `COMPLETE` → reopened | Clear `actual_finish` (keep `actual_start`) |

Rules:
- `today()` uses `django.utils.timezone.localdate()`
- If the PATCH payload includes an explicit `actual_start` or `actual_finish` value, that value takes precedence over auto-set (PM override)
- Auto-set never overwrites a non-null `actual_start` — "first started" is preserved
- Transitioning to `ON_HOLD` does not clear or set any actual dates
- `server_version` is bumped on any actual date change (existing `VersionedModel` behavior)

### Audit trail

The `Task` model already has `HistoricalRecords` (django-simple-history). Both
`actual_start` and `actual_finish` are included in history tracking (they are not
excluded like CPM fields). This satisfies Marcus's compliance requirement with no
additional work.

### Baseline snapshot

`BaselineTask` gains two new nullable fields:

```python
actual_start = models.DateField(null=True, blank=True)
actual_finish = models.DateField(null=True, blank=True)
```

Captured at snapshot time by `BaselineViewSet.perform_create()` alongside existing
`start`/`finish` values.

### Schedule variance

No stored `schedule_variance` field. Variance is derivable:
- `schedule_variance_days = actual_finish - early_finish` (negative = early, positive = late)
- Exposed as a read-only `SerializerMethodField` on `TaskSerializer` when both values are non-null, else `null`
- Frontend can also compute this client-side from the two date fields

### API surface

`TaskSerializer` changes:
- Add `actual_start` (read-write, nullable)
- Add `actual_finish` (read-write, nullable)
- Add `schedule_variance_days` (read-only, computed, nullable)

No new endpoints. No new permissions — same `TaskViewSet` RBAC applies.

### Gantt visual

Defer detailed visual design to `ux-design` agent. The data contract to the
frontend is: `actual_start` and `actual_finish` are nullable ISO date strings on
the Task API response. The `useGanttTasks` hook maps them to the frontend `Task`
type. Visual treatment (marker lines, overlay bars, etc.) is a presentation
decision.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| A: Auto-set in serializer (chosen) | Co-located with status transition logic; testable; explicit | Bypassed by bulk imports or management commands |
| B: Auto-set in model `save()` | Catches all code paths | Fires on every save, not just status transitions; harder to test; no access to "old" status without extra query |
| C: Auto-set via Django signal | Decoupled | Hidden side effects; harder to reason about ordering; signals are already used for enterprise hooks |
| D: Store schedule_variance as a field | Fast queries | Goes stale if early_finish changes after CPM re-run; extra migration on every CPM schema change |

## Consequences

- **Easier**: Planned-vs-actual analysis, earned value foundation, MS Project round-trip (ADR-0021 already maps these fields from MPXJ)
- **Harder**: Nothing significant — two nullable columns with no schema constraints beyond nullability
- **Risks**: Bulk import paths (management commands, MS Project import) must also set actuals. The MS Project importer (ADR-0021) should map MPXJ `actualStart`/`actualFinish` to these fields.

## Implementation Notes

- P3M layer: Programs and Projects / Operations
- Affected packages: `api` (model, serializer, migration), `web` (hook, Gantt visual)
- Migration required: yes — `0016_task_actual_dates.py`
- API changes: yes — two new writable fields + one computed read-only field on TaskSerializer
- OSS or Enterprise: **OSS** (single-project scope, no cross-project aggregation)
- Durable execution: not applicable — no async dispatch, no background work. Actual dates are set synchronously in the serializer during the PATCH request.
