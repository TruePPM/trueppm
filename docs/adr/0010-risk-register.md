# ADR-0010: Risk Register — Data Model, API, and Integration Design

## Status
Proposed

## Context

TruePPM needs a Risk Register feature scoped to individual projects (OSS community edition,
`trueppm-suite`). A risk register is a foundational P3M artifact — every PM needs to capture
risks, assign owners, score probability and impact, and track mitigation status. This is a
Programs and Projects layer concern (single-project scope) and belongs in OSS.

Enterprise variants are explicitly out of scope here: portfolio risk rollup, cross-project
risk propagation, and risk-triggered approval workflows. OSS must emit an extension point
so Enterprise can attach without modifying OSS code.

## Decision

### Data Model

New Django app: `trueppm_api.apps.risks`

A standalone app preserves domain separation and makes the Enterprise extension point a clean
package boundary.

**`Risk` model** (extends `VersionedModel` for WatermelonDB sync):

| Field | Type | Notes |
|---|---|---|
| `id` | UUIDField PK | `default=uuid.uuid4` |
| `server_version` | BigIntegerField | inherited from `VersionedModel` |
| `is_deleted` | BooleanField | soft-delete tombstone |
| `project` | ForeignKey → `projects.Project` | `on_delete=CASCADE` |
| `title` | CharField(255) | |
| `description` | TextField(blank=True) | |
| `probability` | SmallIntegerField | 1–5 scale |
| `impact` | SmallIntegerField | 1–5 scale |
| `severity` | SmallIntegerField | stored, computed on save as `probability × impact` |
| `owner` | ForeignKey → `access.ProjectMembership` | `null=True, on_delete=SET_NULL` |
| `status` | CharField(20) | `open / mitigated / accepted / closed` |
| `mitigation_plan` | TextField(blank=True) | |
| `contingency_plan` | TextField(blank=True) | |
| `identified_date` | DateField | |
| `review_date` | DateField(null=True, blank=True) | |
| `tasks` | ManyToManyField → `projects.Task` | through `RiskTaskLink` |

**`RiskTaskLink`** through model (not `VersionedModel` — no independent lifecycle):

```python
class RiskTaskLink(models.Model):
    id   = UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    risk = ForeignKey(Risk, on_delete=CASCADE, related_name="task_links")
    task = ForeignKey("projects.Task", on_delete=CASCADE, related_name="risk_links")

    class Meta:
        db_table = "risks_risk_tasks"
        unique_together = [("risk", "task")]
```

**Indexes:**
- `(project,)` — base filter on all risk queries
- `(project, status)` — filtered board by status
- `(project, severity)` — risk matrix aggregation

### API Surface

All endpoints nested under `/api/v1/projects/{project_id}/risks/`, extending
`ProjectScopedViewSet` (IDOR guard inherited).

| Method | URL | Description | Min role |
|---|---|---|---|
| GET | `/projects/{pid}/risks/` | List (filter: `status`, `severity`, `owner`) | Viewer |
| POST | `/projects/{pid}/risks/` | Create a risk | Member |
| GET | `/projects/{pid}/risks/{id}/` | Retrieve | Viewer |
| PATCH | `/projects/{pid}/risks/{id}/` | Update (including status transitions) | Member |
| DELETE | `/projects/{pid}/risks/{id}/` | Soft-delete | Admin |
| GET | `/projects/{pid}/risks/matrix/` | 5×5 cell counts by (probability, impact) | Viewer |
| POST | `/projects/{pid}/risks/{id}/tasks/` | Link a task | Member |
| DELETE | `/projects/{pid}/risks/{id}/tasks/{task_id}/` | Unlink a task | Member |

`/matrix/` returns a sparse dict of cells:
```json
{ "cells": [{"probability": 4, "impact": 5, "count": 2, "severity": 20}] }
```

Status transitions enforced in serializer `validate_status`:
```
open       → mitigated | accepted | closed
mitigated  → open | closed
accepted   → open | closed
closed     → open
```

### Severity Calculation

**Stored field, computed on `Risk.save()`.** `severity = probability × impact` (1–25 range).

Stored (not computed at query time) because:
- The `matrix/` endpoint aggregates by severity — a stored indexed integer enables `GROUP BY`
  without repeating the formula; an annotation cannot be indexed.
- Formula is trivial and deterministic — no deferred computation benefit.

Zone classifications (used by frontend only — not stored):
- 20–25 → CRITICAL
- 12–19 → HIGH
- 6–11 → MEDIUM
- 2–5 → LOW
- 1 → MINIMAL

### Sync

`Risk` extends `VersionedModel` and participates in WatermelonDB sync. Field PMs need offline
access to the risk register (reviewing/updating at job sites without connectivity). The
retrofit cost of adding sync later would require a migration and mobile schema version bump.

`RiskTaskLink` is serialized as a `task_ids` JSON array on the parent `Risk` sync payload —
not as top-level sync records. Expected cardinality is 1–10 tasks per risk; a JSON column on
the WatermelonDB `Risk` record is simpler than a separate M2M sync table.

Sync changes required:
- Add `risks` to `SyncPullView` model registry
- WatermelonDB schema: `Risk` table + `task_ids` JSON column

### OSS Extension Point

`risk_changed` Django signal, emitted from `Risk.save()` and `Risk.soft_delete()`:

```python
# risks/signals.py (OSS)
risk_changed = django.dispatch.Signal()
# payload: risk (Risk instance), action ("saved" | "deleted")
```

Enterprise portfolio rollup receiver connects via:
```python
# trueppm_enterprise/portfolio_risks/apps.py (Enterprise — never imported by OSS)
def ready(self):
    from trueppm_api.apps.risks.signals import risk_changed
    risk_changed.connect(portfolio_risk_rollup_receiver)
```

Signal carries the full `Risk` instance; no extra query needed in the Enterprise receiver.
Guard with `update_fields` check to avoid signal fanout on unrelated saves.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Severity as computed annotation | No stored column | Cannot be indexed; repeated in every matrix query |
| Risk as web-only (no `VersionedModel`) | Two fewer columns | Offline retrofit requires migration + mobile schema bump |
| Separate WatermelonDB table for `RiskTaskLink` | Normalized | Unnecessary complexity at expected cardinality (1–10 links) |
| Status lifecycle via `django-fsm` | Guards, history | New dependency for a 4-state machine; overkill |
| Collocate `Risk` in `projects` app | Fewer files | Couples risk domain to scheduling; harder to isolate extension point |

## Consequences

**Positive:**
- Risk Register participates in offline sync from day one.
- `risk_changed` signal is ready for Enterprise portfolio rollup without future OSS change.
- `severity` index makes the matrix query O(log n) on a project-scoped scan.
- Reuses existing permission classes — RBAC correct by default.

**Negative:**
- `Risk.save()` fires a signal on every save. Guard with `update_fields` check to limit to
  probability, impact, and status changes.
- `ProjectScopedViewSet.get_queryset()` uses field-name inference (`"project" in field_names`).
  The `Risk` model's `project` FK is handled by this branch — no change needed, but this
  coupling is noted as tech debt.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `packages/api` (new `risks` app), `packages/web` (new `features/risks`)
- **Migration required**: yes — new `risks` app, enterprise-only migration (no OSS model changes)
- **API changes**: yes — new endpoints listed above
- **OSS or Enterprise**: OSS (`trueppm-suite`)

**New files:**
- `packages/api/src/trueppm_api/apps/risks/` — `__init__.py`, `apps.py`, `models.py`,
  `signals.py`, `serializers.py`, `views.py`, `urls.py`, `migrations/0001_initial.py`

**Modified files:**
- `packages/api/src/trueppm_api/urls.py` — include `risks.urls`
- `packages/api/src/trueppm_api/settings/base.py` — add to `INSTALLED_APPS`
- `packages/api/src/trueppm_api/apps/sync/views.py` — register `Risk` in sync pull model registry

**Related ADRs to write:**
- ADR-0011: Risk Register — Frontend State and Matrix Visualization
- ADR-0012: Sync Protocol Extension for Risk and RiskTaskLink
- ADR-0013: Django Signal Contract for Enterprise Extension Points
