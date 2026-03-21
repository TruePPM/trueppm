---
name: migration-check
description: >
  Django migration safety audit for TruePPM. Use whenever a models.py file is
  modified to catch missing migrations, destructive operations, and NOT NULL columns
  without defaults before CI or, worse, production.
---

# Migration Check Skill

You are auditing Django migrations for a TruePPM branch before merge.

## Checklist

### Migration Exists
- [ ] Every model change has a corresponding migration (`makemigrations --check` passes)
- [ ] The migration file is committed on the same branch as the model change
- [ ] Migration is in the correct app directory (`apps/<app>/migrations/`)

### Destructive Operations
- [ ] No column removed (`RemoveField`) without a prior deprecation cycle
  - Correct process: deprecate in release N (null=True), remove in release N+1
- [ ] No table renamed or dropped without a data migration preserving existing data
- [ ] No index removed that active queries depend on (check `wbs_path` GiST, all FK indexes)

### NOT NULL Safety
- [ ] Every new non-nullable column has a `default=` in the migration
  - If no sensible default exists, the column must be `null=True` until backfilled
- [ ] `server_version` default is `0` or `1` (never null, never missing)
- [ ] UUID primary keys have `default=uuid.uuid4` (Django handles this automatically)

### Reversibility
- [ ] The migration is reversible: `migrate <app> <prev_migration>` succeeds
  - `RunSQL` operations must include a `reverse_sql` argument
  - `RunPython` operations must include a `reverse` function
  - Exception: `CreateExtension` (ltree) is non-reversible but acceptable; document why
- [ ] Data migrations do not assume a fixed data state that may not hold on all envs

### ltree / Custom Fields
- [ ] Any migration adding `wbs_path` (LtreeField) includes `CREATE EXTENSION IF NOT EXISTS ltree`
  as the first operation (idempotent)
- [ ] The GiST index on `wbs_path` is created via `RunSQL`, not `AddIndex` (ltree requires it)
- [ ] New custom field types have `db_type()` returning the correct PostgreSQL type

### Multi-Table / Cross-App
- [ ] ForeignKey additions use `on_delete=PROTECT` (default for TruePPM) unless
  cascade semantics are explicitly intended and documented
- [ ] ForeignKeys across apps use string references (`"projects.Task"`), not direct imports
- [ ] `unique_together` → `UniqueConstraint` (the modern Django form); no new `unique_together`

### Migration Squashing
- [ ] Do not squash migrations that are already applied in any live environment
- [ ] Squash only unapplied migrations on a feature branch, or do a full squash on a
  dedicated `chore/squash-migrations` branch after a major release

## How to Verify Locally

```bash
# Check no missing migrations
cd packages/api
PYTHONPATH=src DJANGO_SETTINGS_MODULE=trueppm_api.settings.dev \
  python manage.py makemigrations --check --dry-run

# Verify forward migration applies
PYTHONPATH=src DJANGO_SETTINGS_MODULE=trueppm_api.settings.dev \
  python manage.py migrate

# Verify reversibility (replace app/0001 with actual target)
PYTHONPATH=src DJANGO_SETTINGS_MODULE=trueppm_api.settings.dev \
  python manage.py migrate <app> <previous_migration_number>
```

## Output Format

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each issue:
```
### [CRITICAL|HIGH|MEDIUM|LOW] Issue Title
**Migration**: apps/<app>/migrations/<file>.py : line
**Problem**: e.g., "NOT NULL column added without default"
**Risk**: e.g., "Will fail on production deploy if table has existing rows"
**Fix**: Exact change needed
```

If all checks pass: confirm migration name, operations performed, and reversibility status.
