---
name: data-model
model: sonnet
description: >
  Design Django data models for TruePPM. Use when adding new entities, modifying
  existing models, planning migrations, or optimizing query patterns. Enforces
  TruePPM conventions: UUID PKs, server_version for sync, ltree for WBS hierarchy,
  proper indexing, and the OSS/Enterprise model boundary.
---

# Data Model Skill

Design Django models following TruePPM conventions.

## Model Conventions
- All models: `id = models.UUIDField(primary_key=True, default=uuid.uuid4)`
- All models: `created_at = models.DateTimeField(auto_now_add=True)`
- All models: `updated_at = models.DateTimeField(auto_now=True)`
- Synced models: `server_version = models.BigIntegerField(default=0)` with signal auto-increment
- WBS hierarchy: `wbs_path` using django-ltree or raw ltree with GiST index
- Metadata: `metadata = models.JSONField(default=dict, blank=True)` for extensibility
- Soft delete: `is_archived = models.BooleanField(default=False)` (never hard delete projects)

## Index Strategy
- Every FK gets an index (Django default)
- Composite indexes for common query patterns (e.g., `(project_id, wbs_order)`)
- GiST index on ltree columns
- `server_version` index on all synced models (critical for sync/pull performance)
- Partial indexes where appropriate (e.g., `is_critical=True` tasks)

## Migration Rules
- Never rename columns — add new, migrate data, drop old
- Never make nullable columns non-nullable in one step
- Always test migrations forward AND backward (reversible migrations)
- Large tables: use `AddField` + `RunSQL` for index creation (avoid lock contention)

## Output Format
For each model, produce:
1. Django model class with all fields, indexes, and constraints
2. DRF serializer (read + write versions if different)
3. Migration considerations (data migration needed? backward compatible?)
4. Query patterns this model supports (with ORM examples)
5. OSS or Enterprise? (which repo does this model live in?)
